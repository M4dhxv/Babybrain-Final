#!/usr/bin/env node
/**
 * Collapse the duplicate `activity_sessions` rows that lib/wix/events-sync.ts
 * used to stack onto a Wix Event–backed activity.
 *
 * A Wix event has exactly one occurrence, so its mirrored activity should
 * carry exactly one session. The old sync located that row with
 * `.eq('activity_id', …).maybeSingle()`, which returns an error (not a row)
 * the moment there is more than one match — and with the error unchecked,
 * every subsequent scheduled sync inserted another copy. Activities that ran
 * through that for a while ended up with a handful of identical sessions
 * (e.g. "6-18 Month Playgroup" had 1 real + 7 duplicate rows), and because
 * the booking page pins an event to sessions[0] a parent could only ever
 * reach the earliest one.
 *
 * The code path is fixed going forward; this unwinds the rows already there.
 * For each EVENT activity with >1 session it keeps ONE canonical row —
 * whichever already has a live (non-cancelled) booking on it, so a sold
 * ticket is never stranded; otherwise the one nearest the linked event's
 * real start date, falling back to the earliest — points it at that date,
 * and deletes the other rows that carry no booking. A row with a booking on
 * it is always left alone and reported, never deleted.
 *
 * Usage:
 *   node scripts/dedupe-wix-event-sessions.mjs           # report only
 *   node scripts/dedupe-wix-event-sessions.mjs --apply   # collapse the duplicates
 */
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const APPLY = process.argv.includes('--apply');

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const iso = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

const { data: activities, error: actErr } = await admin
  .from('activities')
  .select('id, title, wix_event_id, wix_events(start_date, end_date)')
  .eq('wix_service_type', 'EVENT');
if (actErr) throw actErr;

console.log(`Checking ${activities.length} Wix Event activit${activities.length === 1 ? 'y' : 'ies'}\n`);

let affected = 0;
let deleted = 0;
let strandedKept = 0;

for (const a of activities) {
  const { data: sessions, error: sErr } = await admin
    .from('activity_sessions')
    .select('id, starts_at, ends_at')
    .eq('activity_id', a.id)
    .order('starts_at', { ascending: true });
  if (sErr) throw sErr;
  if (!sessions || sessions.length <= 1) continue;

  affected++;
  const ids = sessions.map((s) => s.id);

  const { data: bookedRows, error: bErr } = await admin
    .from('bookings')
    .select('session_id')
    .in('session_id', ids)
    .neq('status', 'cancelled');
  if (bErr) throw bErr;
  const booked = new Set((bookedRows ?? []).map((b) => b.session_id));

  // Canonical row: prefer one that already has a booking; otherwise the row
  // closest to the event's real start date; otherwise the earliest.
  const eventStart = a.wix_events?.start_date ? new Date(a.wix_events.start_date).getTime() : null;
  const bySold = sessions.find((s) => booked.has(s.id));
  const byDate =
    eventStart != null
      ? [...sessions].sort(
          (x, y) =>
            Math.abs(new Date(x.starts_at).getTime() - eventStart) -
            Math.abs(new Date(y.starts_at).getTime() - eventStart)
        )[0]
      : null;
  const canonical = bySold ?? byDate ?? sessions[0];

  const stale = sessions.filter((s) => s.id !== canonical.id && !booked.has(s.id));
  const strandedDupes = sessions.filter((s) => s.id !== canonical.id && booked.has(s.id));

  console.log(`${a.title}  (${sessions.length} sessions)`);
  console.log(
    `  keep    ${canonical.id}  ${iso(canonical.starts_at)}` +
      `${booked.has(canonical.id) ? '  [has bookings]' : ''}` +
      (a.wix_events?.start_date ? `  → event date ${iso(a.wix_events.start_date)}` : '')
  );
  for (const s of stale) console.log(`  delete  ${s.id}  ${iso(s.starts_at)}`);
  for (const s of strandedDupes) {
    console.log(`  KEEP*   ${s.id}  ${iso(s.starts_at)}  [has bookings — left in place, resolve by hand]`);
    strandedKept++;
  }

  if (APPLY) {
    if (a.wix_events?.start_date) {
      const { error } = await admin
        .from('activity_sessions')
        .update({
          starts_at: a.wix_events.start_date,
          ...(a.wix_events.end_date ? { ends_at: a.wix_events.end_date } : {}),
        })
        .eq('id', canonical.id);
      if (error) throw error;
    }
    if (stale.length > 0) {
      const { error } = await admin.from('activity_sessions').delete().in('id', stale.map((s) => s.id));
      if (error) throw error;
      deleted += stale.length;
    }
    console.log(`  → collapsed to 1 session${stale.length ? `, removed ${stale.length}` : ''}`);
  }
  console.log('');
}

console.log(`${affected} activit${affected === 1 ? 'y' : 'ies'} with duplicate sessions.`);
if (strandedKept > 0) {
  console.log(
    `${strandedKept} duplicate row(s) had bookings and were left in place — reschedule or cancel those bookings, then re-run.`
  );
}
if (!APPLY && affected > 0) {
  console.log('Report only. Re-run with --apply to collapse them.');
}
if (APPLY) console.log(`Deleted ${deleted} duplicate session row(s).`);
