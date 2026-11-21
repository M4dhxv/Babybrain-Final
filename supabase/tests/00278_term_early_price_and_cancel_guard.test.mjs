/**
 * Behaviour tests for 00278_term_early_price_and_cancel_guard.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00278_term_early_price_and_cancel_guard.test.mjs
 *
 * Uses the same stand-in tables as the 00263 test, loads the term migrations 00256-00277, then 00278.
 * Checks: the early price (quote, pair quote, enrolment stamp, headline, its last day, slot own prices,
 * the constraints), and the cancel guard (a parent cannot cancel an enrolment's sessions once the term has
 * started; the vendor, the service role and unpaid or single seats still can).
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
const pay = async (group, perSeat) => {
  await db.query(`update bookings set status = 'confirmed', payment_status = 'paid' where booking_group_id = $1 and status = 'pending'`, [group]);
  await db.query(`update bookings set amount = $2 where booking_group_id = $1`, [group, perSeat]);
};
const quote = async (slot) => (await one(`select * from term_quote($1)`, [slot])).price_cents;
const sgDate = (offsetDays) =>
  one(`select to_char((now() at time zone 'Asia/Singapore')::date + $1::int, 'YYYY-MM-DD') as d`, [offsetDays]).then((r) => r.d);

await db.exec(stub);
// What the real tables have that the shared stand-ins leave out.
await db.exec(`
  alter table public.activity_sessions
    add column if not exists allow_cancellation boolean, add column if not exists cancellation_refund_mode text,
    add column if not exists allow_rescheduling boolean, add column if not exists reschedule_cutoff_hours int;
  alter table public.activities add column if not exists monthly_billing_enabled boolean not null default false;
  alter table public.activities add column if not exists terms_enabled boolean not null default false;
`);
await ok('00256 to 00277 and 00278 apply', async () => {
  await db.exec(file('00256_term_enrolment.sql'));
  await db.exec(stub257);
  for (const n of ['00259_term_single_waitlist', '00260_term_place_waitlist', '00261_term_waitlist_vendor', '00262_term_waitlist_closing',
    '00263_term_withdraw_reschedule_leave', '00264_term_slot_groups', '00269_term_waitlist_pairs_and_used_trials',
    '00274_term_withdrawal_policy', '00275_term_group_offers', '00277_term_function_order_guard', '00278_term_early_price_and_cancel_guard']) {
    await db.exec(file(`${n}.sql`));
  }
});
await ok('00278 is idempotent (second run)', async () => { await db.exec(file('00278_term_early_price_and_cancel_guard.sql')); });

const P = (await one(`insert into providers (business_name) values ('Little Fish Swim') returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const [PA, PB, PC] = ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'];
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
for (const id of [PA, PB, PC]) await db.query(`insert into parent_profiles (id) values ($1)`, [id]);
const kid = async (parent, name) => (await one(`insert into children (parent_id, name) values ($1, $2) returning id`, [parent, name])).id;
const [CA, CB, CC] = [await kid(PA, 'Ava'), await kid(PB, 'Ben'), await kid(PC, 'Cal')];
const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
await db.query(`update activities set terms_enabled = true where id = $1`, [A]);
const startDate = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const pattern = JSON.stringify({ days: [6], time: '09:00', duration: 45, start: startDate, weeks: 4, skip: [], perDay: false, dayTimes: {} });
await asUser(VENDOR);
const T = (await one(`insert into terms (provider_id, activity_id, name, price_cents, allow_singles, single_price_cents) values ($1, $2, 'Term 4', 40000, true, 5000) returning id`, [P, A])).id;
const S = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 6, $2) returning id`, [T, pattern])).id;
await one(`select publish_term($1) as n`, [T]);
const sessions = (await db.query(`select id from activity_sessions where term_slot_id = $1 order by starts_at`, [S])).rows.map((r) => r.id);
const setEarly = (cents, until) => db.query(`update terms set early_price_cents = $2, early_price_until = $3 where id = $1`, [T, cents, until]);

// ---- row 25: early price
await rejects('an early price needs a last day', () => setEarly(30000, null), 'terms_early_price_complete');
await rejects('a last day needs an early price', () => setEarly(null, '2030-01-01'), 'terms_early_price_complete');
await rejects('the early price must be below the term price', () => setEarly(40000, '2030-01-01'), 'terms_early_price_below_price');
await rejects('the early price cannot be negative', () => setEarly(-1, '2030-01-01'), 'terms_early_price_below_price');

await ok('with no early price the quote is the term price', async () => { eq(await quote(S), 40000, 'price'); });

const tomorrow = await sgDate(1);
const today = await sgDate(0);
const yesterday = await sgDate(-1);

await setEarly(30000, tomorrow);
await ok('before the last day the quote is the early price', async () => { eq(await quote(S), 30000, 'price'); });
await ok('on the last day itself the early price still applies (the whole day)', async () => {
  await setEarly(30000, today);
  eq(await quote(S), 30000, 'price');
});
await ok('the day after, the term price is back', async () => {
  await setEarly(30000, yesterday);
  eq(await quote(S), 40000, 'price');
});

await setEarly(30000, tomorrow);
await ok('a slot with its own price keeps its difference ($10 off whatever it costs)', async () => {
  await db.query(`update term_slots set price_cents = 50000 where id = $1`, [S]);
  eq(await quote(S), 40000, 'price');
  await db.query(`update term_slots set price_cents = null where id = $1`, [S]);
});
await ok('a combination quote (term_combo_quote) takes the early price off too', async () => {
  eq((await one(`select price_cents from term_combo_quote(array[$1::uuid])`, [S])).price_cents, 30000, 'combo price');
  await setEarly(30000, yesterday);
  eq((await one(`select price_cents from term_combo_quote(array[$1::uuid])`, [S])).price_cents, 40000, 'combo price after');
  await setEarly(30000, tomorrow);
});
await ok('the mid-term reduction still counts on top of the early price', async () => {
  await db.query(`update terms set reduce_enabled = true, reduce_by_cents = 1000 where id = $1`, [T]);
  eq(await quote(S), 30000, 'no sessions run yet');
  await db.query(`update terms set reduce_enabled = false where id = $1`, [T]);
});
await ok('the headline price follows the early price while it runs', async () => {
  await db.query(`update terms set allow_singles = false where id = $1`, [T]);
  await db.query(`update term_slots set offer_single = false where id = $1`, [S]).catch(() => {});
  const r = await one(`select * from term_headline_prices(array[$1::uuid]) where activity_id = $1`, [A]);
  eq(r?.kind, 'term', 'kind');
  eq(r?.price_cents, 30000, 'price');
});
await ok('a family who enrols while it runs has the early price stamped on their enrolment', async () => {
  await asUser(PA);
  const E = await enrol(S, CA);
  eq(E.price_cents, 30000, 'price returned');
  eq((await one(`select price_cents from term_enrolments where id = $1`, [E.enrolment_id])).price_cents, 30000, 'stamped');
  await pay(E.group_id, 75);
  globalThis.E1 = E;
});
await ok('the early price can be removed again', async () => {
  await asUser(VENDOR);
  await setEarly(null, null);
  eq(await quote(S), 40000, 'price');
});

// ---- row 20: a parent cannot cancel an enrolment's sessions once the term has started
const E1 = globalThis.E1;
const seatOf = async (enrolment, n) => (await one(`select id from bookings where term_enrolment_id = $1 order by created_at, id limit 1 offset $2`, [enrolment, n])).id;
const cancelAs = async (uid, bookingId, role = 'authenticated') => {
  await asUser(uid, role);
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [bookingId]);
};

await ok('the seats of an enrolment are term-kind and confirmed', async () => {
  const r = await one(`select count(*)::int n, bool_and(term_booking_kind = 'term') k, bool_and(status = 'confirmed') c from bookings where term_enrolment_id = $1`, [E1.enrolment_id]);
  eq(r.k, true, 'kind'); eq(r.c, true, 'confirmed');
  if (r.n < 2) throw new Error('need at least two seats');
});
await ok('before the term has started a parent can still cancel one session (the activity rules apply)', async () => {
  await cancelAs(PA, await seatOf(E1.enrolment_id, 0));
});

// The term starts: its first session has run.
await asUser(VENDOR);
await db.query(`update activity_sessions set starts_at = now() - interval '1 day', ends_at = now() - interval '1 day' + interval '45 minutes' where id = $1`, [sessions[0]]);

await ok('term_sessions_started says so for every session of the term', async () => {
  const r = await db.query(`select session_id from term_sessions_started($1::uuid[])`, [[sessions[1], sessions[2]]]);
  eq(r.rows.length, 2, 'sessions');
});
await rejects('once the term has started, the parent cannot cancel an enrolment session', async () => cancelAs(PA, await seatOf(E1.enrolment_id, 2)), 'has started');
await rejects('nor through another seat', async () => cancelAs(PA, await seatOf(E1.enrolment_id, 1)), 'has started');
await ok('the vendor can cancel it (and so choose the make-up token in the Bookings drawer)', async () => {
  await cancelAs(VENDOR, await seatOf(E1.enrolment_id, 2));
});
await ok('the service role can cancel it', async () => {
  await cancelAs(null, await seatOf(E1.enrolment_id, 1), 'service_role');
});
await ok('a seat that is not confirmed (unpaid) can still be released by the parent', async () => {
  await asUser(PB);
  const E2 = await enrol(S, CB);
  const id = await seatOf(E2.enrolment_id, 0);
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [id]);
});
await ok('a single or trial session bought in the term follows the activity rules, not this guard', async () => {
  await asUser(PC);
  const E3 = await enrol(S, CC);
  await pay(E3.group_id, 75);
  await db.query(`update bookings set term_booking_kind = 'single' where term_enrolment_id = $1`, [E3.enrolment_id]).catch(async () => {
    await asUser(VENDOR);
    await db.query(`update bookings set term_booking_kind = 'single' where term_enrolment_id = $1`, [E3.enrolment_id]);
  });
  await cancelAs(PC, await seatOf(E3.enrolment_id, 0));
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
