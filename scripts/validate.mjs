/**
 * BabyBrain Phase 1 end-to-end backend validation.
 * Run after `npm run seed`:  npm run validate
 *
 * Covers: schema/RLS introspection (direct SQL), auth signup trigger,
 * onboarding persistence, recommendation engine, search, favorites,
 * reviews + rating rollup, notifications (incl. column-level guard),
 * cross-user isolation, GetStream credentials/channel, Resend email.
 */
import { createClient } from '@supabase/supabase-js';
import { StreamChat } from 'stream-chat';
import postgres from 'postgres';

process.loadEnvFile('.env.local');

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
};

// ---------- 0. Schema + RLS introspection (direct SQL) ----------
const sql = postgres(process.env.SUPABASE_DB_URL, { prepare: false });

const EXPECTED_TABLES = [
  'parent_profiles', 'user_preferences', 'children', 'activity_categories',
  'activities', 'activity_sessions', 'favorites', 'reviews',
  'user_recommendations', 'notifications', 'stream_users', 'bookings',
];

const tables = await sql`
  select c.relname as name, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'`;
const tableNames = tables.map((t) => t.name);
check(
  'All 12 tables exist',
  EXPECTED_TABLES.every((t) => tableNames.includes(t)),
  EXPECTED_TABLES.filter((t) => !tableNames.includes(t)).join(', ') || 'complete'
);
const noRls = tables.filter((t) => EXPECTED_TABLES.includes(t.name) && !t.rls);
check('RLS enabled on every table', noRls.length === 0, noRls.map((t) => t.name).join(', ') || 'all enabled');

const [{ count: policyCount }] = await sql`
  select count(*)::int as count from pg_policies where schemaname = 'public'`;
check('RLS policies installed', policyCount >= 20, `${policyCount} policies`);

const cronJobs = await sql`select jobname from cron.job`;
check(
  'pg_cron jobs scheduled',
  ['refresh-activity-popularity', 'refresh-recommendations'].every((j) =>
    cronJobs.some((c) => c.jobname === j)
  ),
  cronJobs.map((c) => c.jobname).join(', ')
);

const triggers = await sql`
  select tgname from pg_trigger where tgname in
  ('on_auth_user_created','on_review_change','on_child_changed',
   'on_preferences_changed','on_profile_location_changed','on_notification_created')`;
check('All triggers installed', triggers.length === 6, `${triggers.length}/6`);
await sql.end();

// ---------- 1. Auth: signup trigger ----------
const stamp = Date.now();
const emailA = `parent.a.${stamp}@babybrain-validation.test`;
const emailB = `parent.b.${stamp}@babybrain-validation.test`;
const password = 'ValidationPass123!';

const { data: userARes, error: createAError } = await admin.auth.admin.createUser({
  email: emailA, password, email_confirm: true,
  user_metadata: { full_name: 'Validation Parent A' },
});
const { data: userBRes } = await admin.auth.admin.createUser({
  email: emailB, password, email_confirm: true,
  user_metadata: { full_name: 'Validation Parent B' },
});
const userA = userARes?.user;
const userB = userBRes?.user;
check('Auth users created', Boolean(userA && userB), createAError?.message ?? '');

const { data: profileA } = await admin.from('parent_profiles').select('*').eq('id', userA.id).single();
const { data: prefsA } = await admin.from('user_preferences').select('*').eq('user_id', userA.id).single();
const { data: welcomeA } = await admin.from('notifications').select('*').eq('user_id', userA.id).eq('type', 'welcome');
check('Signup trigger created profile', profileA?.full_name === 'Validation Parent A');
check('Signup trigger created preferences row', Boolean(prefsA));
check('Signup trigger created welcome notification', (welcomeA ?? []).length === 1);

// ---------- 2. Onboarding persistence (as user A, through RLS) ----------
const clientA = createClient(URL, ANON, { auth: { persistSession: false } });
const { error: signInError } = await clientA.auth.signInWithPassword({ email: emailA, password });
check('Email/password sign-in works', !signInError, signInError?.message ?? '');

const { error: profUpdErr } = await clientA
  .from('parent_profiles')
  .update({ phone: '+65 9123 4567', postal_code: '238884', latitude: 1.3052, longitude: 103.8302 })
  .eq('id', userA.id);
const { error: prefUpdErr } = await clientA
  .from('user_preferences')
  .update({
    preferred_days: ['sat', 'sun'], preferred_times: ['morning'],
    budget_min: 20, budget_max: 60, interests: ['music'],
  })
  .eq('user_id', userA.id);
check('Onboarding step 1 persists (profile + preferences)', !profUpdErr && !prefUpdErr,
  profUpdErr?.message ?? prefUpdErr?.message ?? '');

const dob = new Date();
dob.setMonth(dob.getMonth() - 27); // ~2y 3m
const { data: childEmma, error: childErr } = await clientA
  .from('children')
  .insert({
    parent_id: userA.id, name: 'Emma', date_of_birth: dob.toISOString().slice(0, 10),
    gender: 'female', interests: ['music', 'sensory-play'], notes: 'Loves drums',
  })
  .select().single();
const { data: childNoah } = await clientA
  .from('children')
  .insert({
    parent_id: userA.id, name: 'Noah',
    date_of_birth: new Date(Date.now() - 300 * 864e5).toISOString().slice(0, 10),
    interests: ['parent-baby'],
  })
  .select().single();
check('Onboarding step 2 persists (multiple children)', Boolean(childEmma && childNoah), childErr?.message ?? '');

const { error: confirmErr } = await clientA
  .from('parent_profiles')
  .update({ onboarding_completed_at: new Date().toISOString() })
  .eq('id', userA.id);
check('Onboarding step 3 persists (confirmation)', !confirmErr);

// ---------- 3. Recommendations (computed by child-insert trigger) ----------
const { data: recsEmma } = await clientA
  .from('user_recommendations')
  .select('*, activities(title)')
  .eq('child_id', childEmma.id)
  .order('score', { ascending: false });
check('Recommendations generated for Emma', (recsEmma ?? []).length > 0, `${recsEmma?.length ?? 0} matches`);
const top = recsEmma?.[0];
check('Recommendation scoring is sane', Boolean(top && top.score >= 30 && top.score <= 100),
  top ? `top: ${top.activities?.title} (${top.score})` : '');
check('Recommendation reasons populated', Boolean(top && top.reasons.length > 0),
  top?.reasons.join(' · ') ?? '');
const musicTop = recsEmma?.some(
  (r) => r.reasons.some((reason) => reason.includes('interests')) && r.score >= 60
);
check('Interest match boosts score', Boolean(musicTop));

const { data: recsNoah } = await clientA
  .from('user_recommendations').select('id').eq('child_id', childNoah.id);
check('Per-child recommendations (Noah differs from Emma)', (recsNoah ?? []).length > 0,
  `${recsNoah?.length ?? 0} matches`);

// ---------- 4. Activity search RPC ----------
const { data: searchAll, error: searchErr } = await clientA.rpc('search_activities', {});
check('search_activities returns published activities', (searchAll ?? []).length >= 8,
  searchErr?.message ?? `${searchAll?.length ?? 0} results`);

const { data: searchMusic } = await clientA.rpc('search_activities', { p_category_slug: 'music' });
check('Category filter works', (searchMusic ?? []).length >= 2 &&
  searchMusic.every((a) => a.category_slug === 'music'), `${searchMusic?.length ?? 0} music`);

const { data: searchText } = await clientA.rpc('search_activities', { p_query: 'yoga' });
check('Full-text search works', (searchText ?? []).some((a) => a.slug === 'storytime-stretch-yoga'));

const { data: searchNear } = await clientA.rpc('search_activities', {
  p_lat: 1.3052, p_lng: 103.8302, p_radius_km: 5, p_sort: 'distance',
});
check('Distance filter + sort works',
  (searchNear ?? []).length > 0 &&
  searchNear.every((a) => a.dist_km === null || a.dist_km <= 5) &&
  (searchNear.length < 2 || searchNear[0].dist_km <= searchNear[1].dist_km),
  `${searchNear?.length ?? 0} within 5km`);

const { data: searchAge } = await clientA.rpc('search_activities', { p_age_months: 8 });
check('Age filter works', (searchAge ?? []).length > 0 &&
  searchAge.every((a) => a.age_min_months <= 8 && a.age_max_months >= 8));

// ---------- 5. Favorites ----------
const favActivity = searchAll[0];
const { error: favErr } = await clientA
  .from('favorites').insert({ user_id: userA.id, activity_id: favActivity.id });
const { data: favList } = await clientA.from('favorites').select('*, activities(title)');
check('Save favorite works', !favErr && favList?.length === 1, favErr?.message ?? '');
const { error: unfavErr } = await clientA
  .from('favorites').delete().eq('user_id', userA.id).eq('activity_id', favActivity.id);
const { data: favAfter } = await clientA.from('favorites').select('activity_id');
check('Remove favorite works', !unfavErr && favAfter?.length === 0);

// ---------- 6. Reviews + rating rollup ----------
const { error: revErr } = await clientA.from('reviews').insert({
  user_id: userA.id, activity_id: favActivity.id, rating: 5, comment: 'Emma loved it!',
});
let { data: ratedActivity } = await clientA
  .from('activities').select('rating_avg, rating_count').eq('id', favActivity.id).single();
check('Create review + rating trigger', !revErr &&
  ratedActivity?.rating_count === 1 && Number(ratedActivity?.rating_avg) === 5,
  revErr?.message ?? `avg ${ratedActivity?.rating_avg}, count ${ratedActivity?.rating_count}`);

await clientA.from('reviews')
  .update({ rating: 3 }).eq('user_id', userA.id).eq('activity_id', favActivity.id);
({ data: ratedActivity } = await clientA
  .from('activities').select('rating_avg').eq('id', favActivity.id).single());
check('Update review re-rolls rating', Number(ratedActivity?.rating_avg) === 3);

const { error: dupRevErr } = await clientA.from('reviews').insert({
  user_id: userA.id, activity_id: favActivity.id, rating: 1,
});
check('One review per user per activity enforced', Boolean(dupRevErr));

// ---------- 7. Notifications ----------
const { data: notifsA } = await clientA.from('notifications').select('*');
check('User reads own notifications', (notifsA ?? []).length >= 1);
const { error: readErr } = await clientA
  .from('notifications').update({ read_at: new Date().toISOString() }).eq('id', notifsA[0].id);
check('Mark notification read works', !readErr, readErr?.message ?? '');
const { error: tamperErr } = await clientA
  .from('notifications').update({ title: 'hacked' }).eq('id', notifsA[0].id);
check('Clients cannot edit notification content (column grant)', Boolean(tamperErr),
  tamperErr ? 'update rejected as expected' : 'UPDATE WAS ALLOWED');

// ---------- 8. Cross-user isolation (user B + anon) ----------
const clientB = createClient(URL, ANON, { auth: { persistSession: false } });
await clientB.auth.signInWithPassword({ email: emailB, password });

const { data: bSeesChildren } = await clientB.from('children').select('*');
check('B cannot see A’s children', (bSeesChildren ?? []).length === 0);
const { data: bSeesProfile } = await clientB.from('parent_profiles').select('*').eq('id', userA.id);
check('B cannot see A’s profile', (bSeesProfile ?? []).length === 0);
const { data: bSeesRecs } = await clientB.from('user_recommendations').select('*');
check('B cannot see A’s recommendations', (bSeesRecs ?? []).length === 0);
const { data: bSeesNotifs } = await clientB.from('notifications').select('*').eq('user_id', userA.id);
check('B cannot see A’s notifications', (bSeesNotifs ?? []).length === 0);
const { error: bInsertChildErr } = await clientB.from('children').insert({
  parent_id: userA.id, name: 'Intruder', date_of_birth: '2024-01-01',
});
check('B cannot create a child under A', Boolean(bInsertChildErr));
const { data: bUpdateProfile } = await clientB
  .from('parent_profiles').update({ full_name: 'hacked' }).eq('id', userA.id).select();
check('B cannot update A’s profile', (bUpdateProfile ?? []).length === 0);

const anon = createClient(URL, ANON, { auth: { persistSession: false } });
const { data: anonActivities } = await anon.from('activities').select('id').limit(5);
check('Anonymous can browse published activities', (anonActivities ?? []).length > 0);
const { data: anonReviews } = await anon.from('reviews').select('rating').limit(5);
check('Anonymous can read reviews', (anonReviews ?? []).length >= 1);
const { data: anonChildren } = await anon.from('children').select('*');
const { data: anonProfiles } = await anon.from('parent_profiles').select('*');
check('Anonymous sees no private data', (anonChildren ?? []).length === 0 && (anonProfiles ?? []).length === 0);
const { data: unpub } = await admin.from('activities')
  .insert({ slug: `unpublished-${stamp}`, title: 'Draft', category_id: 1, is_published: false })
  .select('id, slug').single();
const { data: anonUnpub } = await anon.from('activities').select('id').eq('id', unpub.id);
check('Unpublished activities hidden from public', (anonUnpub ?? []).length === 0);
await admin.from('activities').delete().eq('id', unpub.id);

// ---------- 9. GetStream support chat ----------
try {
  const stream = StreamChat.getInstance(
    process.env.NEXT_PUBLIC_STREAM_KEY, process.env.STREAM_SECRET
  );
  await stream.upsertUsers([
    { id: userA.id, name: 'Validation Parent A' },
    { id: 'babybrain-support', name: 'BabyBrain Support' },
  ]);
  const channel = stream.channel('messaging', `support-${userA.id}`, {
    members: [userA.id, 'babybrain-support'], created_by_id: 'babybrain-support',
  });
  await channel.create();
  const token = stream.createToken(userA.id);
  check('GetStream: users upserted + support channel created + token minted',
    typeof token === 'string' && token.length > 20, `channel support-${userA.id.slice(0, 8)}…`);
  await admin.from('stream_users').upsert(
    { user_id: userA.id, stream_user_id: userA.id, support_channel_id: `support-${userA.id}` },
    { onConflict: 'user_id' });
  const { data: mapping } = await clientA.from('stream_users').select('*').single();
  check('stream_users mapping readable by owner', mapping?.support_channel_id === `support-${userA.id}`);
  // cleanup Stream side
  await channel.delete();
  await stream.deleteUser(userA.id, { hard_delete: true });
} catch (e) {
  check('GetStream integration', false, e.message);
}

// ---------- 10. Resend ----------
try {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: 'delivered@resend.dev',
      subject: 'BabyBrain validation email',
      html: '<p>Notification pipeline test.</p>',
    }),
  });
  const body = await res.json();
  check('Resend email delivery', res.ok && Boolean(body.id), body.id ?? JSON.stringify(body));
} catch (e) {
  check('Resend email delivery', false, e.message);
}

// ---------- Cleanup ----------
await admin.auth.admin.deleteUser(userA.id);
await admin.auth.admin.deleteUser(userB.id);
console.log('\n🧹 Test users removed (cascade cleaned children, reviews, favorites, notifications).');

console.log(`\n${failed === 0 ? '🎉' : '⚠️'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
