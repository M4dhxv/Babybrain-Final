/**
 * Behaviour tests for 00276_term_group_offers.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00276_term_group_offers.test.mjs
 *
 * Same stand-in tables as the 00263 test (read from that file), the term
 * migrations 00256-00269, then 00276. Checks: each group's own offers and
 * prices, the rules they must satisfy, the booking gate per group, the booking
 * policy following onto sessions, and terms switching themselves on.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const file = (n) => read(`../migrations/${n}`);
const src = read('./00263_term_withdraw_reschedule_leave.test.mjs');
const stub = src.match(/const stub = `([\s\S]*?)`;\r?\n/)[1];
const stub257 = src.match(/const stub257 = `([\s\S]*?)`;\r?\n/)[1];
const db = new PGlite();

let pass = 0, fail = 0;
const results = [];
const asUser = async (uid, role = 'authenticated') => {
  await db.query(`select set_config('test.uid', $1, false), set_config('test.role', $2, false)`, [uid ?? '', role]);
};
async function ok(name, fn) {
  try { const v = await fn(); results.push(`PASS  ${name}${v ? '  -> ' + v : ''}`); pass++; }
  catch (e) { results.push(`FAIL  ${name}  -> ${e.message}`); fail++; }
}
async function rejects(name, fn, match) {
  try { await fn(); results.push(`FAIL  ${name}  -> did not raise`); fail++; }
  catch (e) {
    if (match && !String(e.message).includes(match)) { results.push(`FAIL  ${name}  -> wrong error: ${e.message}`); fail++; }
    else { results.push(`PASS  ${name}  -> ${e.message}`); pass++; }
  }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); };
const enrol = async (slot, child) => one(`select * from enrol_in_term($1, $2)`, [slot, child]);
const pay = async (group) => db.query(`update bookings set status = 'confirmed', payment_status = 'paid' where booking_group_id = $1 and status = 'pending'`, [group]);
const bookClass = async (session, kind, child) => one(`select * from book_term_class($1, $2, $3)`, [session, kind, child]);

await db.exec(stub);
// What the real tables have that the shared stand-ins leave out.
await db.exec(`
  alter table public.activity_sessions
    add column if not exists allow_cancellation boolean, add column if not exists cancellation_refund_mode text,
    add column if not exists allow_rescheduling boolean, add column if not exists reschedule_cutoff_hours int;
  alter table public.activities add column if not exists monthly_billing_enabled boolean not null default false;
  alter table public.activities add column if not exists terms_enabled boolean not null default false;
`);
await ok('00256 to 00274 and 00276 apply', async () => {
  await db.exec(file('00256_term_enrolment.sql'));
  await db.exec(stub257);
  for (const n of ['00259_term_single_waitlist', '00260_term_place_waitlist', '00261_term_waitlist_vendor', '00262_term_waitlist_closing',
    '00263_term_withdraw_reschedule_leave', '00264_term_slot_groups', '00269_term_waitlist_pairs_and_used_trials', '00274_term_withdrawal_policy', '00276_term_group_offers']) {
    await db.exec(file(`${n}.sql`));
  }
});
await ok('00276 is idempotent (second run)', async () => { await db.exec(file('00276_term_group_offers.sql')); });

const P = (await one(`insert into providers (business_name) values ('Little Fish Swim') returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const [PA, PB, PC] = ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'];
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
for (const id of [PA, PB, PC]) await db.query(`insert into parent_profiles (id) values ($1)`, [id]);
const kid = async (parent, name) => (await one(`insert into children (parent_id, name) values ($1, $2) returning id`, [parent, name])).id;
const [CA, CB, CC] = [await kid(PA, 'Ava'), await kid(PB, 'Ben'), await kid(PC, 'Cal')];
const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
const startDate = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const pattern = (time) => JSON.stringify({ days: [6], time, duration: 45, start: startDate, weeks: 4, skip: [], perDay: false, dayTimes: {} });

// ---- a term switches the activity's terms on by itself
await asUser(VENDOR);
await ok('creating a term switches the activity on, with no switch for the vendor', async () => {
  eq((await one(`select terms_enabled t from activities where id = $1`, [A])).t, false, 'before');
  await db.query(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'Probe', 100)`, [P, A]);
  eq((await one(`select terms_enabled t from activities where id = $1`, [A])).t, true, 'after');
  await db.query(`delete from terms where name = 'Probe'`);
});
const M = (await one(`insert into activities (provider_id, title, slug, price, monthly_billing_enabled) values ($1, 'Gym', 'gym', 30, true) returning id`, [P])).id;
await rejects('...but not for an activity that bills monthly', () => db.query(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'T', 100)`, [P, M]), 'bills monthly');

// ---- one term, two groups: Saturday 9:00 offers everything, Saturday 10:30 only the term and singles
const T = (await one(`insert into terms (provider_id, activity_id, name, price_cents, allow_singles, single_price_cents, allow_trial, trial_price_cents, trial_limit, allow_packages)
  values ($1, $2, 'Term 4', 40000, true, 5000, true, 2000, 1, true) returning id`, [P, A])).id;
const S1 = (await one(`insert into term_slots (term_id, capacity, pattern, price_cents, offer_single, offer_trial, offer_package, single_price_cents, trial_price_cents)
  values ($1, 6, $2, 40000, true, true, true, 6000, 1500) returning id`, [T, pattern('09:00')])).id;
const S2 = (await one(`insert into term_slots (term_id, capacity, pattern, price_cents, offer_single, offer_trial, offer_package)
  values ($1, 6, $2, 36000, true, false, false) returning id`, [T, pattern('10:30')])).id;

// ---- the rules
await rejects('a group must offer at least one way in', () =>
  db.query(`insert into term_slots (term_id, capacity, pattern, offer_term, offer_single, offer_trial, offer_package) values ($1, 4, $2, false, false, false, false)`, [T, pattern('12:00')]),
  'at least one way in');
await rejects('a trial needs the term or single sessions on', () =>
  db.query(`insert into term_slots (term_id, capacity, pattern, offer_term, offer_single, offer_trial, offer_package) values ($1, 4, $2, false, false, true, false)`, [T, pattern('12:00')]),
  'trial needs');
await ok('a group can offer only single sessions', async () => {
  const id = (await one(`insert into term_slots (term_id, capacity, pattern, offer_term, offer_single, offer_trial, offer_package) values ($1, 4, $2, false, true, false, false) returning id`, [T, pattern('12:00')])).id;
  await db.query(`delete from term_slots where id = $1`, [id]);
});
await ok('a group with nothing set follows the term (older rows keep working)', async () => {
  const id = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 4, $2) returning id`, [T, pattern('13:00')])).id;
  const o = await one(`select * from term_slot_offer($1)`, [id]);
  eq(o.offer_single, true, 'single'); eq(o.offer_trial, true, 'trial'); eq(o.single_price_cents, 5000, 'single price'); eq(o.trial_price_cents, 2000, 'trial price');
  await db.query(`delete from term_slots where id = $1`, [id]);
});

// ---- each group's own price
await ok("a group's own single and trial price win over the term's", async () => {
  const o = await one(`select * from term_slot_offer($1)`, [S1]);
  eq(o.single_price_cents, 6000, 'single'); eq(o.trial_price_cents, 1500, 'trial');
  const p = await one(`select * from term_slot_offer($1)`, [S2]);
  eq(p.single_price_cents, 5000, 'S2 single (inherits)'); eq(p.offer_trial, false, 'S2 trial');
});

// ---- policy, before publishing
await db.query(`update term_slots set allow_cancellation = true, cancellation_cutoff_hours = 48, cancellation_refund_mode = 'none', booking_cutoff_minutes = 60 where id = $1`, [S1]);
await one(`select publish_term($1) as n`, [T]);
const sessions = async (slot) => (await db.query(`select id, allow_cancellation, cancellation_cutoff_hours, cancellation_refund_mode, booking_cutoff_minutes from activity_sessions where term_slot_id = $1 order by starts_at`, [slot])).rows;
await ok("publishing stamps a group's booking policy onto its sessions; another group is untouched", async () => {
  const a = await sessions(S1); const b = await sessions(S2);
  eq(a.length, 4, 'sessions'); eq(a[0].cancellation_cutoff_hours, 48, 'cutoff'); eq(a[0].cancellation_refund_mode, 'none', 'mode'); eq(a[3].booking_cutoff_minutes, 60, 'booking cutoff');
  eq(b[0].cancellation_cutoff_hours, null, 'S2 inherits');
});
await ok("changing a group's policy updates its sessions still to come; null puts them back to inheriting", async () => {
  await db.query(`update term_slots set cancellation_cutoff_hours = 12 where id = $1`, [S1]);
  eq((await sessions(S1))[0].cancellation_cutoff_hours, 12, 'changed');
  await db.query(`update term_slots set allow_cancellation = null, cancellation_cutoff_hours = null, cancellation_refund_mode = null, booking_cutoff_minutes = null where id = $1`, [S1]);
  const a = await sessions(S1);
  eq(a[0].cancellation_cutoff_hours, null, 'cleared'); eq(a[0].booking_cutoff_minutes, null, 'cleared booking cutoff');
});

// ---- the gate, per group
const s1 = await sessions(S1); const s2 = await sessions(S2);
await asUser(PA);
await ok('a trial on a group that offers one works', async () => { await bookClass(s1[0].id, 'trial', CA); });
await asUser(PB);
await rejects('a trial on a group that does not offer one is refused', () => bookClass(s2[0].id, 'trial', CB), 'no trial session for this group');
await ok('a single session on a group that offers them works', async () => { await bookClass(s2[1].id, 'single', CB); });
await asUser(null, 'service_role');
await db.query(`update term_slots set offer_single = false where id = $1`, [S2]);
await asUser(PC);
await rejects('single sessions on a group that switched them off are refused', () => bookClass(s2[2].id, 'single', CC), 'not offered for this group');
await asUser(null, 'service_role');
await db.query(`update term_slots set offer_single = true where id = $1`, [S2]);

await asUser(VENDOR);
await db.query(`update term_slots set offer_term = false where id = $1`, [S2]);
await asUser(PC);
await rejects('enrolling in a group that does not offer the whole term is refused', () => enrol(S2, CC), 'not offered for this group');
await asUser(VENDOR);
await db.query(`update term_slots set offer_term = true where id = $1`, [S2]);
await asUser(PC);
const EC = await enrol(S2, CC);
await pay(EC.group_id);
await asUser(VENDOR);
await rejects('enrolment cannot be turned off once families are enrolled in the group', () => db.query(`update term_slots set offer_term = false where id = $1`, [S2]), 'enrolled');

// ---- packages
await asUser(PA);
await db.query(`insert into make_up_tokens (id) values (gen_random_uuid())`);
await rejects('a package credit on a group that does not accept packs is refused', () =>
  db.query(`insert into bookings (user_id, session_id, child_id, package_purchase_id) values ($1, $2, $3, gen_random_uuid())`, [PA, s2[3].id, CA]), 'does not accept package credits');
await ok('...and is allowed where the group accepts packs', async () => {
  await db.query(`insert into bookings (user_id, session_id, child_id, package_purchase_id) values ($1, $2, $3, gen_random_uuid())`, [PA, s1[3].id, CA]);
});

// ---- what Explore leads with, and whether packs make sense
await ok('the headline price reads the groups: trial price of the group that offers a trial', async () => {
  const h = await one(`select * from term_headline_prices(array[$1]::uuid[])`, [A]);
  eq(h.kind, 'trial', 'kind'); eq(h.price_cents, 1500, 'price');
});
await ok('with no group offering a trial, it falls back to the cheapest single price', async () => {
  await db.query(`update term_slots set offer_trial = false where id = $1`, [S1]);
  const h = await one(`select * from term_headline_prices(array[$1]::uuid[])`, [A]);
  eq(h.kind, 'single', 'kind'); eq(h.price_cents, 5000, 'price');
});
await ok('packs are closed for an activity only when no live group accepts them', async () => {
  eq((await db.query(`select * from activity_packages_closed(array[$1]::uuid[])`, [A])).rows.length, 0, 'open while S1 accepts');
  await db.query(`update term_slots set offer_package = false where id = $1`, [S1]);
  eq((await db.query(`select * from activity_packages_closed(array[$1]::uuid[])`, [A])).rows.length, 1, 'closed when none does');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
