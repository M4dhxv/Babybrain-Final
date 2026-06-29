/**
 * Phase 2 vendor backend validation. Run: node scripts/validate-vendor.mjs
 * Covers: schema, provider creation trigger (owner member + free sub),
 * staff-role RLS (owner/manager/staff), activity ownership, capacity→waitlist,
 * auto-promote on cancel, attendance, review response RPC, analytics, isolation.
 */
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

process.loadEnvFile('.env.local');
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };
const stamp = Date.now();

// ---- schema present ----
const sql = postgres(process.env.SUPABASE_DB_URL, { prepare: false });
const tables = (await sql`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r'`).map(r => r.relname);
check('New vendor tables exist',
  ['providers','provider_members','provider_locations','attendance','make_up_tokens','subscriptions','listing_events'].every(t => tables.includes(t)));
const cols = (await sql`select column_name from information_schema.columns where table_name='bookings'`).map(r => r.column_name);
check('bookings extended (provider_id, payment_status, waitlist_position)',
  ['provider_id','payment_status','waitlist_position'].every(c => cols.includes(c)));
await sql.end();

// ---- make an owner + two staff users ----
const mk = async (tag, name) => {
  const email = `${tag}.${stamp}@babybrain-validation.test`;
  const { data } = await admin.auth.admin.createUser({ email, password: 'VendorTest123!', email_confirm: true, user_metadata: { full_name: name } });
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password: 'VendorTest123!' });
  return { id: data.user.id, email, client };
};
const owner = await mk('owner', 'Owner Olive');
const manager = await mk('manager', 'Manager Max');
const staff = await mk('staff', 'Staff Sam');
const outsider = await mk('outsider', 'Outsider Odette');

// ---- provider creation (as owner, through RLS) ----
const { data: prov, error: provErr } = await owner.client.from('providers')
  .insert({ owner_id: owner.id, business_name: 'Tiny Tunes Studio', vendor_category: 'baby-toddler-classes', status: 'active' })
  .select().single();
check('Owner can create provider', !provErr && !!prov, provErr?.message);

const { data: ownerMember } = await admin.from('provider_members').select('role').eq('provider_id', prov.id).eq('user_id', owner.id).single();
check('Trigger created owner membership', ownerMember?.role === 'owner');
const { data: sub } = await admin.from('subscriptions').select('plan').eq('provider_id', prov.id).single();
check('Trigger created free subscription', sub?.plan === 'free');
check('Provider got a slug', !!prov.slug, prov.slug);

// ---- owner invites manager + staff ----
await admin.from('provider_members').insert([
  { provider_id: prov.id, user_id: manager.id, role: 'manager', status: 'active' },
  { provider_id: prov.id, user_id: staff.id, role: 'staff', status: 'active' },
]);

// ---- activity management: manager can, staff cannot ----
const { data: act, error: actErr } = await manager.client.from('activities').insert({
  slug: `vendor-music-${stamp}`, title: 'Baby Beats (vendor)', category_id: 1,
  provider_id: prov.id, vendor_category: 'baby-toddler-classes', is_published: true, age_min_months: 6, age_max_months: 24,
}).select().single();
check('Manager can create activity', !actErr && !!act, actErr?.message);

const { error: staffActErr } = await staff.client.from('activities').insert({
  slug: `staff-cant-${stamp}`, title: 'Should fail', category_id: 1, provider_id: prov.id,
}).select().single();
check('Staff CANNOT create activity (role RLS)', !!staffActErr, staffActErr ? 'blocked' : 'WRONGLY ALLOWED');

const { data: outsiderActErr } = await outsider.client.from('activities').update({ title: 'hacked' }).eq('id', act.id).select();
check('Outsider CANNOT edit provider activity', (outsiderActErr ?? []).length === 0);

// ---- session with capacity 1 → second booking waitlisted ----
const { data: sess } = await admin.from('activity_sessions').insert({
  activity_id: act.id, starts_at: new Date(Date.now() + 7 * 864e5).toISOString(),
  ends_at: new Date(Date.now() + 7 * 864e5 + 36e5).toISOString(), capacity: 1,
}).select().single();

// two parents book (reuse admin to create parents quickly)
const parentA = await mk('parentA', 'Parent A');
const parentB = await mk('parentB', 'Parent B');
const { data: bookA } = await parentA.client.from('bookings').insert({ user_id: parentA.id, session_id: sess.id }).select().single();
const { data: bookB } = await parentB.client.from('bookings').insert({ user_id: parentB.id, session_id: sess.id }).select().single();
check('Booking stamped with provider_id (trigger)', bookA?.provider_id === prov.id);
check('Over-capacity booking auto-waitlisted', bookB?.status === 'waitlisted', `B status=${bookB?.status}`);

// confirm A then cancel → B auto-promoted
await manager.client.from('bookings').update({ status: 'confirmed' }).eq('id', bookA.id);
await manager.client.from('bookings').update({ status: 'cancelled' }).eq('id', bookA.id);
const { data: bookBAfter } = await admin.from('bookings').select('status').eq('id', bookB.id).single();
check('Cancel auto-promotes waitlist', bookBAfter?.status === 'confirmed', `B now=${bookBAfter?.status}`);

// ---- attendance: staff CAN mark ----
const { error: attErr } = await staff.client.from('attendance').insert({ booking_id: bookB.id, session_id: sess.id, status: 'present', marked_by: staff.id });
check('Staff can mark attendance', !attErr, attErr?.message);

// ---- vendor sees provider bookings; outsider does not ----
const { data: mgrBookings } = await manager.client.from('bookings').select('id').eq('provider_id', prov.id);
check('Manager sees provider bookings', (mgrBookings ?? []).length >= 1);
const { data: outBookings } = await outsider.client.from('bookings').select('id').eq('provider_id', prov.id);
check('Outsider sees NO provider bookings', (outBookings ?? []).length === 0);

// ---- review response RPC ----
const { error: revErr } = await admin.from('reviews').insert({ user_id: parentA.id, activity_id: act.id, rating: 5, comment: 'Loved it' });
const { data: rev } = await admin.from('reviews').select('id').eq('activity_id', act.id).single();
const { error: respErr } = await manager.client.rpc('respond_to_review', { p_review_id: rev.id, p_response: 'Thank you!' });
const { data: revAfter } = await admin.from('reviews').select('provider_response').eq('id', rev.id).single();
check('Manager can respond to review (RPC)', !respErr && revAfter?.provider_response === 'Thank you!', respErr?.message);
const { error: outRespErr } = await outsider.client.rpc('respond_to_review', { p_review_id: rev.id, p_response: 'hacked' });
check('Outsider CANNOT respond to review', !!outRespErr);

// ---- analytics ----
const { data: overview, error: ovErr } = await manager.client.rpc('provider_overview', { p_provider: prov.id });
check('provider_overview returns KPIs', !ovErr && Array.isArray(overview) && overview.length === 1, ovErr?.message ?? JSON.stringify(overview?.[0]));
const { data: analytics, error: anErr } = await manager.client.rpc('provider_analytics', { p_provider: prov.id });
check('provider_analytics returns sections', !anErr && analytics && 'top_age_group' in analytics, anErr?.message);
const { error: outAnErr } = await outsider.client.rpc('provider_analytics', { p_provider: prov.id });
check('Outsider CANNOT read analytics', !!outAnErr);

// ---- subscription readable by member only ----
const { data: subRead } = await manager.client.from('subscriptions').select('plan').eq('provider_id', prov.id);
check('Member reads subscription', (subRead ?? []).length === 1);
const { data: outSub } = await outsider.client.from('subscriptions').select('plan').eq('provider_id', prov.id);
check('Outsider CANNOT read subscription', (outSub ?? []).length === 0);

// ---- cleanup ----
for (const u of [owner, manager, staff, outsider, parentA, parentB]) await admin.auth.admin.deleteUser(u.id);
await admin.from('providers').delete().eq('id', prov.id);
console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
