/**
 * One-off: hard-reset the Wix integration for a single vendor account back to
 * a never-connected state, so a fresh link can be tested from scratch.
 *
 *   - deletes provider_wix_credentials + clears providers.wix_site_id
 *     (same as the /api/vendor/wix-integration DELETE route)
 *   - HARD-deletes every Wix-imported activity (both Bookings-linked
 *     `wix_service_id` rows and the Events mirror `wix_event_id` /
 *     wix_service_type='EVENT' rows), along with their activity_sessions and
 *     bookings (FK cascade on activities), plus event_ticket_orders and
 *     wix_events / event_ticket_types.
 *
 * Unlike scripts/reset-wix-demo-vendor.mjs this does NOT leave soft
 * wix_missing_since / wix_removed_at tombstones — it removes the rows.
 *
 * Also deletes any provider_locations row this provider only has because a
 * past Wix sync find-or-created it (wix_location_id set); activities.location_id
 * is ON DELETE SET NULL, so a surviving hand-made activity keeps its address
 * text but loses the structured link (reported before it happens).
 *
 * Run: node scripts/_clean-wix-for-account.mjs <email>            (dry run)
 *      node scripts/_clean-wix-for-account.mjs <email> --execute  (apply)
 */
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const EMAIL = process.argv.find((a) => a.includes('@'));
if (!EMAIL) throw new Error('Usage: node scripts/_clean-wix-for-account.mjs <email> [--execute]');
const EXECUTE = process.argv.includes('--execute');

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const tag = EXECUTE ? '[EXECUTE]' : '[DRY RUN]';
console.log(`${tag} Cleaning Wix integration for ${EMAIL}\n`);

// 1. Auth user.
const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listErr) throw listErr;
const user = list.users.find((u) => u.email === EMAIL);
if (!user) throw new Error(`No auth user found for ${EMAIL}`);
console.log(`Auth user: ${user.id}`);

// 2. Provider(s) — owner first, else active membership.
const { data: owned, error: ownedErr } = await admin
  .from('providers')
  .select('id, business_name, wix_site_id')
  .eq('owner_id', user.id);
if (ownedErr) throw ownedErr;

let providers = owned ?? [];
if (providers.length === 0) {
  const { data: members, error: membersErr } = await admin
    .from('provider_members')
    .select('providers(id, business_name, wix_site_id)')
    .eq('user_id', user.id)
    .eq('status', 'active');
  if (membersErr) throw membersErr;
  providers = (members ?? []).map((r) => r.providers).filter(Boolean);
}
if (providers.length === 0) throw new Error(`No provider linked to ${EMAIL}`);
console.log(`Provider(s): ${providers.map((p) => `${p.business_name} (${p.id})`).join(', ')}\n`);

const summary = [];

for (const provider of providers) {
  console.log(`--- ${provider.business_name} (${provider.id}) ---`);
  const s = { provider: provider.business_name };

  // ---- Wix-imported activities (Bookings-linked + Events mirror) ----
  const { data: acts, error: actsErr } = await admin
    .from('activities')
    .select('id, title, slug, wix_service_id, wix_event_id, wix_service_type')
    .eq('provider_id', provider.id)
    .or('wix_service_id.not.is.null,wix_event_id.not.is.null,wix_service_type.eq.EVENT');
  if (actsErr) throw actsErr;
  const activityIds = (acts ?? []).map((a) => a.id);
  console.log(`  Wix-imported activities: ${activityIds.length}`);
  for (const a of acts ?? []) {
    const kind = a.wix_service_id ? 'BOOKINGS' : a.wix_event_id ? 'EVENT' : a.wix_service_type;
    console.log(`    - [${kind}] "${a.title}" (${a.id})`);
  }

  let sessionIds = [];
  if (activityIds.length) {
    const { data: sess } = await admin
      .from('activity_sessions')
      .select('id')
      .in('activity_id', activityIds);
    sessionIds = (sess ?? []).map((r) => r.id);
  }
  let bookingCount = 0;
  if (sessionIds.length) {
    const { count } = await admin
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .in('session_id', sessionIds);
    bookingCount = count ?? 0;
  }
  console.log(`  Dependent activity_sessions: ${sessionIds.length}, bookings: ${bookingCount}`);

  // ---- Wix events cache ----
  const { data: wixEvents } = await admin
    .from('wix_events')
    .select('id, title')
    .eq('provider_id', provider.id);
  const eventIds = (wixEvents ?? []).map((e) => e.id);
  let ticketTypeCount = 0;
  let orderCount = 0;
  if (eventIds.length) {
    const { count: tt } = await admin
      .from('event_ticket_types')
      .select('id', { count: 'exact', head: true })
      .in('event_id', eventIds);
    ticketTypeCount = tt ?? 0;
    const { count: oc } = await admin
      .from('event_ticket_orders')
      .select('id', { count: 'exact', head: true })
      .in('event_id', eventIds);
    orderCount = oc ?? 0;
  }
  console.log(`  wix_events: ${eventIds.length}, event_ticket_types: ${ticketTypeCount}, event_ticket_orders: ${orderCount}`);

  // ---- Wix-created provider_locations ----
  const { data: wixLocs } = await admin
    .from('provider_locations')
    .select('id, name, address, wix_location_id')
    .eq('provider_id', provider.id)
    .not('wix_location_id', 'is', null);
  const wixLocIds = (wixLocs ?? []).map((l) => l.id);
  console.log(`  Wix-created provider_locations: ${wixLocIds.length}`);
  let locRefs = [];
  if (wixLocIds.length) {
    for (const l of wixLocs) console.log(`    - "${l.name}" (${l.address ?? 'no address'})`);
    // Surviving activities that will have location_id nulled (SET NULL).
    const { data: refs } = await admin
      .from('activities')
      .select('id, title, is_published, location_id')
      .in('location_id', wixLocIds);
    locRefs = refs ?? [];
    for (const r of locRefs) {
      console.log(`    ! activity "${r.title}" (${r.is_published ? 'published' : 'draft'}) -> location_id will become null`);
    }
  }

  // ---- Credentials ----
  const { count: credCount } = await admin
    .from('provider_wix_credentials')
    .select('provider_id', { count: 'exact', head: true })
    .eq('provider_id', provider.id);
  console.log(`  provider_wix_credentials rows: ${credCount ?? 0}  |  providers.wix_site_id: ${provider.wix_site_id ?? 'null'}`);

  Object.assign(s, {
    activities: activityIds.length,
    activity_sessions: sessionIds.length,
    bookings: bookingCount,
    wix_events: eventIds.length,
    event_ticket_types: ticketTypeCount,
    event_ticket_orders: orderCount,
    wix_locations: wixLocIds.length,
    locs_nulled: locRefs.length,
    credentials: credCount ?? 0,
  });

  if (EXECUTE) {
    console.log('  ...applying');

    // bookings.session_id -> activity_sessions has NO cascade, and bookings
    // has no activity_id column, so deleting an activity cascades to its
    // sessions and then trips bookings_session_id_fkey. Delete bottom-up:
    // bookings -> activity_sessions -> activities. (Tables referencing
    // bookings.id are all ON DELETE CASCADE / SET NULL, so removing the
    // bookings rows is safe.)
    if (sessionIds.length) {
      const { error: bErr } = await admin.from('bookings').delete().in('session_id', sessionIds);
      if (bErr) throw bErr;
      console.log(`  deleted ${bookingCount} bookings`);
      const { error: sErr } = await admin.from('activity_sessions').delete().in('id', sessionIds);
      if (sErr) throw sErr;
      console.log(`  deleted ${sessionIds.length} activity_sessions`);
    }
    if (activityIds.length) {
      const { error } = await admin.from('activities').delete().in('id', activityIds);
      if (error) throw error;
      console.log(`  deleted ${activityIds.length} activities`);
    }
    if (eventIds.length) {
      const { error: oErr } = await admin.from('event_ticket_orders').delete().in('event_id', eventIds);
      if (oErr) throw oErr;
      const { error: eErr } = await admin.from('wix_events').delete().in('id', eventIds);
      if (eErr) throw eErr;
      console.log(`  deleted ${orderCount} event_ticket_orders, ${eventIds.length} wix_events (+ cascaded ticket_types)`);
    }
    if (wixLocIds.length) {
      const { error: lErr } = await admin.from('provider_locations').delete().in('id', wixLocIds);
      if (lErr) throw lErr;
      console.log(`  deleted ${wixLocIds.length} Wix-created provider_locations (${locRefs.length} activity link(s) nulled)`);
    }
    const { error: cErr } = await admin
      .from('provider_wix_credentials')
      .delete()
      .eq('provider_id', provider.id);
    if (cErr) throw cErr;
    const { error: pErr } = await admin
      .from('providers')
      .update({ wix_site_id: null })
      .eq('id', provider.id);
    if (pErr) throw pErr;
    console.log('  cleared provider_wix_credentials + providers.wix_site_id');
  }

  summary.push(s);
  console.log('');
}

console.log('--- Summary ---');
console.table(summary);
if (!EXECUTE) console.log('\nDry run only. Re-run with --execute to apply.');
else console.log('\nDone. Account is back to a never-connected Wix state.');
