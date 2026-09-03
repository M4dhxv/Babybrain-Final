/**
 * Read-only validation for the vendor booking rules on Wix-sourced bookings,
 * and for the Wix staff-name import — both against the live
 * indsg.kidscenter Wix account and the real database, exercising the shipped
 * code (lib/wix/client.ts, lib/wix/sync.ts).
 *
 * Creates NO Wix booking and NO `bookings` row. It does write
 * `activity_sessions.teacher_name` (that is the feature under test) and may
 * materialise a local session anchor via reserveWixSlotForCheckout, which is
 * deleted again at the end.
 *
 * Why this exists: enforce_booking_insert_defaults (00074) opens with
 * `if auth.role() = 'service_role' then return new`, and every Wix booking
 * route inserts through the service-role admin client — so paused, the
 * booking cut-off and the required-information answer are enforced in
 * TypeScript for these paths, not by the trigger. That makes them worth a
 * test.
 *
 * Run: npx tsx scripts/validate-wix-booking-gates.mts
 */
process.loadEnvFile('.env.local');
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';
import {
  getProviderWixCredentials,
  fetchWixResources,
  fetchWixClassSessions,
  fetchWixAvailability,
  selectNonOverlappingSlots,
  encodeWixSlotKey,
  formatWixStaffNames,
  wixSlotStaff,
} from '../lib/wix/client';
import { checkWixBookingGates, importWixSessionStaff, reserveWixSlotForCheckout } from '../lib/wix/sync';

const admin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
  ok ? pass++ : fail++;
};

console.log('\n--- Wix booking-gate + staff-import validation ---\n');

// ---------------------------------------------------------------------------
// 1. checkWixBookingGates — pure, so every branch is cheap to cover
// ---------------------------------------------------------------------------
const open = { bookings_paused: false, info_request_enabled: false, booking_cutoff_minutes: 15 };

check('An open class with nothing asked for passes', checkWixBookingGates(open, undefined).ok);
{
  const r = checkWixBookingGates({ ...open, bookings_paused: true }, undefined);
  check('A paused class is refused', !r.ok, r.ok ? '' : `${r.status} ${r.error}`);
  check('…as a 409, not a 500', !r.ok && r.status === 409);
}
{
  const r = checkWixBookingGates({ ...open, info_request_enabled: true }, undefined);
  check('An activity that asks for information refuses a booking without it', !r.ok, r.ok ? '' : `${r.status} ${r.error}`);
}
check(
  'Whitespace is not an answer',
  !checkWixBookingGates({ ...open, info_request_enabled: true }, '   ').ok
);
check(
  'A real answer is accepted',
  checkWixBookingGates({ ...open, info_request_enabled: true }, 'unit 12-34').ok
);
check(
  'Nulls from the database read as "no rule set", not as paused',
  checkWixBookingGates({ bookings_paused: null, info_request_enabled: null, booking_cutoff_minutes: null }, undefined).ok
);

// ---------------------------------------------------------------------------
// 2. The cut-off, through the real slot resolver
// ---------------------------------------------------------------------------
const { data: provider } = await admin
  .from('providers')
  .select('id, business_name')
  .eq('id', 'a64b081d-476c-4530-b342-1276ca5c2002')
  .single();
const creds = await getProviderWixCredentials(admin, provider!.id);
if (!creds) {
  console.error('No Wix credentials on this provider — cannot run the live half.');
  process.exit(1);
}
console.log(`\nProvider: ${provider!.business_name}\n`);

const { data: activities } = await admin
  .from('activities')
  .select('id, title, wix_service_id, wix_service_type, wix_resource_id')
  .eq('provider_id', provider!.id)
  .not('wix_service_id', 'is', null);

const klass = (activities ?? []).find((a) => a.wix_service_type === 'CLASS');
const appointment = (activities ?? []).find((a) => a.wix_service_type === 'APPOINTMENT');
const course = (activities ?? []).find((a) => a.wix_service_type === 'COURSE');

const madeSessions: string[] = [];
async function resolve(activity: NonNullable<typeof klass>, slotId: string, cutoffMinutes: number | null | undefined) {
  const r = await reserveWixSlotForCheckout(
    admin,
    creds!,
    {
      id: activity.id,
      wix_service_id: activity.wix_service_id!,
      wix_resource_id: activity.wix_resource_id,
      wix_service_type: activity.wix_service_type,
    },
    slotId,
    1,
    cutoffMinutes === undefined ? null : { cutoffMinutes }
  );
  if (r.ok) madeSessions.push(r.sessionId);
  return r;
}

if (klass) {
  const sessions = await fetchWixClassSessions(creds, klass.wix_service_id!, 60);
  const next = sessions.find((s) => s.remainingCapacity > 0);
  if (!next) {
    check('A bookable CLASS occurrence exists to test against', false, 'none with capacity in the next 60 days');
  } else {
    const slotId = `wix:${encodeWixSlotKey({ kind: 'class', sessionId: next.id })}`;
    const minutesAway = Math.round((new Date(next.start).getTime() - Date.now()) / 60000);

    const ok = await resolve(klass, slotId, 15);
    check(`CLASS ${minutesAway} min away resolves under a 15-min cut-off`, ok.ok, ok.ok ? '' : ok.error);

    // A cut-off wider than the gap to the session must refuse it.
    const wide = minutesAway + 60;
    const late = await resolve(klass, slotId, wide);
    check(
      `The same occurrence is refused once the cut-off (${wide} min) covers it`,
      !late.ok,
      late.ok ? 'accepted — the cut-off is not being applied' : `${late.status} ${late.error}`
    );
    check('…as a 409 with the vendor’s own wording', !late.ok && late.status === 409 && /close \d+ minutes before/.test(late.error));

    const ungated = await resolve(klass, slotId, undefined);
    check(
      'With no gate (the post-payment finalize path) the same slot still resolves',
      ungated.ok,
      ungated.ok ? '' : ungated.error
    );
  }
}

if (course) {
  const sessions = await fetchWixClassSessions(creds, course.wix_service_id!, 60);
  const next = sessions.find((s) => s.remainingCapacity > 0);
  if (next) {
    const slotId = `wix:${encodeWixSlotKey({ kind: 'class', sessionId: next.id })}`;
    const minutesAway = Math.round((new Date(next.start).getTime() - Date.now()) / 60000);
    // A course is one enrolment in a whole run that a parent may join
    // part-way through, so no cut-off should apply to it.
    const r = await resolve(course, slotId, minutesAway + 60);
    check('A COURSE is never closed by the cut-off (mid-run enrolment stays possible)', r.ok, r.ok ? '' : r.error);
  }
}

if (appointment) {
  const raw = await fetchWixAvailability(creds, appointment.wix_service_id!, 14, [appointment.wix_resource_id]);
  const slot = selectNonOverlappingSlots(raw).find((s) => s.bookable);
  if (slot) {
    const slotId = `wix:${encodeWixSlotKey({ kind: 'appointment', s: slot.localStartDate, e: slot.localEndDate })}`;
    const ok = await resolve(appointment, slotId, 15);
    check('An APPOINTMENT slot resolves under a 15-min cut-off', ok.ok, ok.ok ? '' : ok.error);
    const late = await resolve(appointment, slotId, 60 * 24 * 365);
    check('An APPOINTMENT is refused once the cut-off covers it', !late.ok, late.ok ? 'accepted' : late.error);
  }
}

// ---------------------------------------------------------------------------
// 3. Staff import
// ---------------------------------------------------------------------------
console.log('');
const resources = await fetchWixResources(creds);
const staffIds = new Set(resources.filter((r) => r.bookable).map((r) => r.id));
check('The Wix account exposes at least one bookable staff resource', staffIds.size > 0, `${staffIds.size} found`);

check('formatWixStaffNames names one person plainly', formatWixStaffNames([{ id: 'a', name: 'Madhav' }]) === 'Madhav');
check(
  'Two names are joined, not truncated',
  formatWixStaffNames([{ id: 'a', name: 'Madhav' }, { id: 'b', name: 'Anita' }]) === 'Madhav & Anita'
);
check(
  'Three or more collapse rather than becoming a list',
  formatWixStaffNames([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]) === 'A +2 more'
);
check('Nobody named returns null (callers must leave the stored name alone)', formatWixStaffNames([]) === null);
check(
  'A calendar that is not a known bookable staff member is filtered out',
  formatWixStaffNames([{ id: 'room-1', name: 'Studio B' }], new Set(['staff-1'])) === null
);
check('Duplicate names are not repeated', formatWixStaffNames([{ id: 'a', name: 'Madhav' }, { id: 'b', name: 'Madhav' }]) === 'Madhav');

for (const activity of activities ?? []) {
  const isClass = activity.wix_service_type === 'CLASS' || activity.wix_service_type === 'COURSE';
  let byKey: Map<string, string | null>;
  if (isClass) {
    const sessions = await fetchWixClassSessions(creds, activity.wix_service_id!, 60);
    byKey = new Map(
      sessions.map((s) => [
        encodeWixSlotKey({ kind: 'class', sessionId: s.id }),
        formatWixStaffNames(s.staff, staffIds),
      ])
    );
  } else {
    const raw = await fetchWixAvailability(creds, activity.wix_service_id!, 14, [activity.wix_resource_id]);
    byKey = new Map(
      selectNonOverlappingSlots(raw).map((s) => [
        encodeWixSlotKey({ kind: 'appointment', s: s.localStartDate, e: s.localEndDate }),
        formatWixStaffNames(wixSlotStaff(s), staffIds),
      ])
    );
  }
  const named = [...byKey.values()].filter(Boolean);
  check(
    `${activity.title}: Wix names a staff member on every slot`,
    named.length === byKey.size && byKey.size > 0,
    `${named.length}/${byKey.size}`
  );

  await importWixSessionStaff(admin, activity.id, byKey);
  const again = await importWixSessionStaff(admin, activity.id, byKey);
  check(`${activity.title}: re-importing an unchanged schedule writes nothing`, again === 0, `${again} rows`);

  const { data: stored } = await admin
    .from('activity_sessions')
    .select('wix_slot_key, teacher_name')
    .eq('activity_id', activity.id)
    .in('wix_slot_key', [...byKey.keys()]);
  const wrong = (stored ?? []).filter((r) => r.teacher_name !== byKey.get(r.wix_slot_key as string));
  check(
    `${activity.title}: every stored session carries the name Wix gave it`,
    wrong.length === 0,
    `${(stored ?? []).length} rows checked`
  );
}

// A null must never blank a name a vendor (or an earlier sync) already set.
if (klass) {
  const { data: one } = await admin
    .from('activity_sessions')
    .select('id, wix_slot_key, teacher_name')
    .eq('activity_id', klass.id)
    .not('wix_slot_key', 'is', null)
    .limit(1)
    .maybeSingle();
  if (one?.wix_slot_key && one.teacher_name) {
    await importWixSessionStaff(admin, klass.id, new Map([[one.wix_slot_key, null]]));
    const { data: after } = await admin
      .from('activity_sessions')
      .select('teacher_name')
      .eq('id', one.id)
      .single();
    check(
      'Wix naming nobody leaves an existing teacher alone rather than blanking it',
      after?.teacher_name === one.teacher_name,
      `${one.teacher_name} → ${after?.teacher_name}`
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- Cleaning up ---');
// Only the anchor rows this run created, and only if nothing booked them.
for (const id of [...new Set(madeSessions)]) {
  const { count } = await admin.from('bookings').select('id', { count: 'exact', head: true }).eq('session_id', id);
  if ((count ?? 0) > 0) continue;
  // Sessions that already existed (the resolver find-or-creates) are left
  // alone — deleting them would strip real availability off the calendar.
  const { data: row } = await admin.from('activity_sessions').select('wix_slot_key').eq('id', id).maybeSingle();
  if (row?.wix_slot_key?.startsWith('wixcourse:')) {
    await admin.from('activity_sessions').delete().eq('id', id);
    console.log(`Removed course anchor row ${id}`);
  }
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
