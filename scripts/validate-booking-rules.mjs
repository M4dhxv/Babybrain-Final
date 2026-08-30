/**
 * Booking-rule validation for migration 00074: the booking cut-off, the
 * per-session price override, the per-session venue, and the bespoke
 * information request.
 *
 *   node scripts/validate-booking-rules.mjs
 *
 * Talks to the database directly as a parent (RLS + triggers), because all
 * four rules are enforced in the booking-insert trigger rather than in a
 * route. Also re-checks that ORDINARY booking still works — 00074 rebuilds
 * enforce_booking_insert_defaults(), so a mistake there would break every
 * booking on the platform.
 *
 * Creates a throwaway provider/activity/sessions/parent and cleans up.
 */
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };

const stamp = Date.now();
const parentEmail = `rules.parent.${stamp}@babybrain-validation.test`;
const PASSWORD = 'RulesTest12345!';

const { data: parent } = await admin.auth.admin.createUser({
  email: parentEmail, password: PASSWORD, email_confirm: true,
});
const { data: signIn } = await anon.auth.signInWithPassword({ email: parentEmail, password: PASSWORD });
if (!signIn?.session) { console.error('could not sign the test parent in'); process.exit(1); }
const asParent = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  auth: { persistSession: false },
});

const { data: provider } = await admin
  .from('providers')
  .insert({ business_name: `Rules Test Co ${stamp}`, status: 'active', description: 'validation fixture' })
  .select().single();

const { data: venueA } = await admin.from('provider_locations')
  .insert({ provider_id: provider.id, name: 'Venue A', address: '1 Orchard Rd', is_primary: true })
  .select().single();
const { data: venueB } = await admin.from('provider_locations')
  .insert({ provider_id: provider.id, name: 'Venue B', address: '2 Marina Blvd' })
  .select().single();

const { data: category } = await admin.from('activity_categories').select('id').limit(1).single();

const mkActivity = (extra = {}) => admin.from('activities').insert({
  provider_id: provider.id,
  slug: `rules-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
  title: `Rules Test Activity ${stamp}`,
  category_id: category.id,
  is_published: true,
  price: 40,
  location_id: venueA.id,
  ...extra,
}).select().single();

const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const mkSession = (activityId, startsInHours, extra = {}) => admin.from('activity_sessions').insert({
  activity_id: activityId,
  starts_at: hoursFromNow(startsInHours),
  ends_at: hoursFromNow(startsInHours + 1),
  capacity: 10,
  ...extra,
}).select().single();

const bookAs = (sessionId, extra = {}) =>
  asParent.from('bookings').insert({ user_id: parent.user.id, session_id: sessionId, ...extra }).select().maybeSingle();

const createdActivityIds = [];
try {
  // ---------- Ordinary booking still works (regression guard) ----------
  const { data: normal } = await mkActivity();
  createdActivityIds.push(normal.id);
  const { data: farSession } = await mkSession(normal.id, 48);
  const ok = await bookAs(farSession.id);
  check('A normal booking well before the class still works', Boolean(ok.data) && !ok.error, ok.error?.message ?? '');
  check('…and a paid class lands as pending for Stripe', ok.data?.status === 'pending', ok.data?.status);
  if (ok.data) await admin.from('bookings').delete().eq('id', ok.data.id);

  const { data: freeAct } = await mkActivity({ price: 0 });
  createdActivityIds.push(freeAct.id);
  const { data: freeSession } = await mkSession(freeAct.id, 48);
  const freeBooking = await bookAs(freeSession.id);
  check('A free class is still auto-confirmed', freeBooking.data?.status === 'confirmed', freeBooking.data?.status);
  if (freeBooking.data) await admin.from('bookings').delete().eq('id', freeBooking.data.id);

  // ---------- 1. Booking cut-off ----------
  const { data: cutoffAct } = await mkActivity(); // default 15 minutes
  createdActivityIds.push(cutoffAct.id);
  const { data: cutDefault } = await admin.from('activities')
    .select('booking_cutoff_minutes').eq('id', cutoffAct.id).single();
  check('New activities default to a 15-minute cut-off', cutDefault.booking_cutoff_minutes === 15, String(cutDefault.booking_cutoff_minutes));

  const { data: soonSession } = await mkSession(cutoffAct.id, 0.1); // 6 minutes away
  const tooLate = await bookAs(soonSession.id);
  check('Booking inside the cut-off is refused', Boolean(tooLate.error), tooLate.error?.message ?? 'was accepted');
  check('…with a message naming the window', /close 15 minutes before/i.test(tooLate.error?.message ?? ''), tooLate.error?.message ?? '');

  const { data: okSession } = await mkSession(cutoffAct.id, 1); // an hour away
  const inTime = await bookAs(okSession.id);
  check('Booking outside the cut-off is allowed', Boolean(inTime.data) && !inTime.error, inTime.error?.message ?? '');
  if (inTime.data) await admin.from('bookings').delete().eq('id', inTime.data.id);

  // A vendor-set cut-off is honoured.
  await admin.from('activities').update({ booking_cutoff_minutes: 240 }).eq('id', cutoffAct.id);
  const { data: threeHours } = await mkSession(cutoffAct.id, 3);
  const insideCustom = await bookAs(threeHours.id);
  check('A vendor-set 4-hour cut-off blocks a booking 3 hours out', Boolean(insideCustom.error), insideCustom.error?.message ?? 'was accepted');
  check('…and names the vendor\'s own window', /close 240 minutes before/i.test(insideCustom.error?.message ?? ''), insideCustom.error?.message ?? '');

  // 0 means "right up to the start time".
  await admin.from('activities').update({ booking_cutoff_minutes: 0 }).eq('id', cutoffAct.id);
  const { data: minutesAway } = await mkSession(cutoffAct.id, 0.05); // ~3 minutes
  const zeroCutoff = await bookAs(minutesAway.id);
  check('A 0-minute cut-off lets a booking through minutes before', Boolean(zeroCutoff.data) && !zeroCutoff.error, zeroCutoff.error?.message ?? '');
  if (zeroCutoff.data) await admin.from('bookings').delete().eq('id', zeroCutoff.data.id);

  const { data: started } = await mkSession(cutoffAct.id, -1); // already started
  const afterStart = await bookAs(started.id);
  check('…but never after the class has started', /already started/i.test(afterStart.error?.message ?? ''), afterStart.error?.message ?? 'was accepted');

  const bad = await admin.from('activities').update({ booking_cutoff_minutes: -5 }).eq('id', cutoffAct.id);
  check('A negative cut-off is rejected by the constraint', Boolean(bad.error), bad.error?.message ?? 'was accepted');

  // ---------- 2. Per-session price ----------
  const { data: priceAct } = await mkActivity({ price: 40 });
  createdActivityIds.push(priceAct.id);
  const { data: inherits } = await mkSession(priceAct.id, 48);
  const { data: overrides } = await mkSession(priceAct.id, 49, { price: 65 });
  const { data: freeOverride } = await mkSession(priceAct.id, 50, { price: 0 });

  const priceOf = async (id) => (await admin.rpc('session_price', { p_session: id })).data;
  check('A session with no price inherits the activity price', Number(await priceOf(inherits.id)) === 40, String(await priceOf(inherits.id)));
  check('A session price overrides the activity price', Number(await priceOf(overrides.id)) === 65, String(await priceOf(overrides.id)));
  check('A session priced 0 overrides a paid activity', Number(await priceOf(freeOverride.id)) === 0, String(await priceOf(freeOverride.id)));

  // And the override decides whether Stripe is involved.
  const freeBySession = await bookAs(freeOverride.id);
  check('A session priced 0 books as confirmed, not pending', freeBySession.data?.status === 'confirmed', freeBySession.data?.status);
  if (freeBySession.data) await admin.from('bookings').delete().eq('id', freeBySession.data.id);

  const negative = await admin.from('activity_sessions').update({ price: -1 }).eq('id', inherits.id);
  check('A negative session price is rejected', Boolean(negative.error), negative.error?.message ?? 'was accepted');

  // ---------- 3. Per-session venue ----------
  const { data: venueSession } = await mkSession(priceAct.id, 51, { location_id: venueB.id });
  const { data: venueRow } = await admin
    .from('activity_sessions')
    .select('location_id, activities(location_id)')
    .eq('id', venueSession.id).single();
  check('A session can sit at a different venue from its activity',
    venueRow.location_id === venueB.id && venueRow.activities.location_id === venueA.id,
    `${venueRow.location_id === venueB.id} / activity ${venueRow.activities.location_id === venueA.id}`);
  check('…and one activity can now cover both venues',
    venueB.id !== venueA.id && venueRow.activities.location_id === venueA.id);

  // ---------- 4. Bespoke information request ----------
  const { data: infoAct } = await mkActivity({
    price: 0,
    info_request_enabled: true,
    info_request_prompt: 'Which condo is the class at, and the unit number?',
  });
  createdActivityIds.push(infoAct.id);
  const { data: infoSession } = await mkSession(infoAct.id, 48);

  const missing = await bookAs(infoSession.id);
  check('Booking without the requested information is refused', Boolean(missing.error), missing.error?.message ?? 'was accepted');
  const blank = await bookAs(infoSession.id, { info_response: '   ' });
  check('…and whitespace does not count as an answer', Boolean(blank.error), blank.error?.message ?? 'was accepted');

  const answered = await bookAs(infoSession.id, { info_response: 'The Sail @ Marina Bay, #12-34' });
  check('Booking with the information goes through', Boolean(answered.data) && !answered.error, answered.error?.message ?? '');
  check('…and the answer is stored for the vendor to read',
    answered.data?.info_response === 'The Sail @ Marina Bay, #12-34', answered.data?.info_response ?? '');
  if (answered.data) await admin.from('bookings').delete().eq('id', answered.data.id);

  // Off by default: an activity that asks nothing still books with no answer.
  const { data: noAsk } = await mkActivity({ price: 0 });
  createdActivityIds.push(noAsk.id);
  const { data: noAskSession } = await mkSession(noAsk.id, 48);
  const noAskBooking = await bookAs(noAskSession.id);
  check('An activity that asks for nothing books without an answer', Boolean(noAskBooking.data) && !noAskBooking.error, noAskBooking.error?.message ?? '');
  if (noAskBooking.data) await admin.from('bookings').delete().eq('id', noAskBooking.data.id);

  // ---------- 5. Content fields are writable and readable ----------
  await admin.from('activities').update({
    what_to_bring: 'Bring socks and a water bottle.',
    confirmation_message: 'Park in the basement and take lift lobby B.',
  }).eq('id', noAsk.id);
  const { data: content } = await admin.from('activities')
    .select('what_to_bring, confirmation_message').eq('id', noAsk.id).single();
  check('Vendor booking copy round-trips',
    content.what_to_bring === 'Bring socks and a water bottle.' &&
    content.confirmation_message === 'Park in the basement and take lift lobby B.');

  await admin.from('providers').update({
    gallery_urls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    video_urls: ['https://youtu.be/abc123'],
  }).eq('id', provider.id);
  const { data: media } = await admin.from('providers')
    .select('gallery_urls, video_urls').eq('id', provider.id).single();
  check('Provider gallery and videos round-trip',
    media.gallery_urls.length === 2 && media.video_urls.length === 1,
    `${media.gallery_urls.length} photos / ${media.video_urls.length} videos`);
} finally {
  for (const id of createdActivityIds) {
    const { data: sess } = await admin.from('activity_sessions').select('id').eq('activity_id', id);
    for (const s of sess ?? []) await admin.from('bookings').delete().eq('session_id', s.id);
    await admin.from('activity_sessions').delete().eq('activity_id', id);
    await admin.from('activities').delete().eq('id', id);
  }
  await admin.from('provider_locations').delete().eq('provider_id', provider.id);
  await admin.from('providers').delete().eq('id', provider.id);
  await admin.auth.admin.deleteUser(parent.user.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
