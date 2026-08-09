#!/usr/bin/env node
/**
 * Keep the [DEMO] listings bookable.
 *
 *   node scripts/seed-demo-sessions.mjs            # dry run
 *   node scripts/seed-demo-sessions.mjs --live     # write
 *   WEEKS=8 node scripts/seed-demo-sessions.mjs --live
 *
 * The database holds 230 sessions and every one is in the past, so nothing on
 * the site is bookable: "Starting soonest" has nothing to sort, and the booking,
 * package, cancellation and calendar flows can't be exercised at all. This tops
 * the demo listings back up with a rolling few weeks of future slots.
 *
 * Deliberately limited to the [DEMO] activities owned by BabyBrain Demo Studio.
 * Inventing sessions for real businesses would let a parent book a class that
 * doesn't exist — the vendor has to publish their own.
 *
 * Idempotent: only fills weeks that have no session yet, so it's safe to re-run
 * (and worth re-running whenever the demo slots age out).
 */
import postgres from 'postgres';

process.loadEnvFile('.env.local');
const LIVE = process.argv.includes('--live');
const WEEKS = Number(process.env.WEEKS || 6);
const sql = postgres(process.env.SUPABASE_DB_URL, { prepare: false });

/** Each demo class gets its own weekly slot so the timetable looks plausible. */
const SLOTS = [
  { slug: 'demo-music-babybeats', dow: 2, hour: 10, mins: 45, capacity: 12 }, // Tue 10:00
  { slug: 'demo-sensory-splash', dow: 3, hour: 9, mins: 45, capacity: 10 },   // Wed 09:00
  { slug: 'demo-art-tinyhands', dow: 4, hour: 15, mins: 60, capacity: 8 },    // Thu 15:00
  { slug: 'demo-move-groove', dow: 5, hour: 10, mins: 45, capacity: 14 },     // Fri 10:00
  { slug: 'demo-learn-explorers', dow: 6, hour: 9, mins: 60, capacity: 10 },  // Sat 09:00
];

/** Singapore is UTC+8 and has no DST, so the offset is a constant. */
const SGT_OFFSET_H = 8;

/** The next `count` occurrences of `dow` at `hour` SGT, as UTC instants. */
function upcoming(dow, hour, count) {
  const out = [];
  const now = new Date();
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = 0; i < count * 7 + 7 && out.length < count; i++) {
    const d = new Date(cursor.getTime() + i * 864e5);
    if (d.getUTCDay() !== dow) continue;
    const start = new Date(d.getTime() + (hour - SGT_OFFSET_H) * 3600e3);
    if (start > now) out.push(start);
  }
  return out;
}

const acts = await sql`
  select a.id, a.slug, a.title from activities a
   where a.slug = any(${SLOTS.map((s) => s.slug)}) and a.is_published`;
const bySlug = new Map(acts.map((a) => [a.slug, a]));

console.log(`${acts.length} demo listing(s) found · seeding ${WEEKS} week(s)\n`);

const rows = [];
for (const slot of SLOTS) {
  const act = bySlug.get(slot.slug);
  if (!act) {
    console.log(`  – ${slot.slug}: not published, skipped`);
    continue;
  }
  const existing = await sql`
    select starts_at from activity_sessions
     where activity_id = ${act.id} and starts_at > now()`;
  const have = new Set(existing.map((e) => new Date(e.starts_at).toISOString()));

  const starts = upcoming(slot.dow, slot.hour, WEEKS).filter((d) => !have.has(d.toISOString()));
  for (const s of starts) {
    rows.push({
      activity_id: act.id,
      starts_at: s.toISOString(),
      ends_at: new Date(s.getTime() + slot.mins * 60e3).toISOString(),
      capacity: slot.capacity,
    });
  }
  console.log(
    `  ${act.title}: ${existing.length} future already · adding ${starts.length}` +
      (starts[0] ? ` (first ${starts[0].toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} SGT)` : '')
  );
}

if (!rows.length) {
  console.log('\nNothing to add — every demo listing already has future sessions.');
} else if (LIVE) {
  await sql`insert into activity_sessions ${sql(rows, 'activity_id', 'starts_at', 'ends_at', 'capacity')}`;
  console.log(`\nInserted ${rows.length} session(s).`);
} else {
  console.log(`\nDRY RUN — would insert ${rows.length} session(s). Re-run with --live.`);
}

const after = await sql`select count(*) n from activity_sessions where starts_at > now()`;
console.log(`future sessions in database: ${after[0].n}`);
await sql.end();
