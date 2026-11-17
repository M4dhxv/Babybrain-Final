/**
 * Behaviour tests for 00274_term_withdrawal_policy.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00274_term_withdrawal_policy.test.mjs
 *
 * Uses the same stand-in tables as the 00263 test (read from that file so the
 * two never drift), loads the term migrations 00256-00269, then 00274, and
 * checks: the three policies (money / credit / none), "no withdrawal once the
 * term has started", the old behaviour for a term with no policy, manual refund
 * processing, and spending credit (hold, settle, expiry).
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
// What the Stripe webhook does for a paid checkout, then what the checkout route stamped on each seat ($ per seat).
const pay = async (group, perSeat) => {
  await db.query(`update bookings set status = 'confirmed', payment_status = 'paid' where booking_group_id = $1 and status = 'pending'`, [group]);
  await db.query(`update bookings set amount = $2 where booking_group_id = $1`, [group, perSeat]);
};
const policy = (T, allowed, mode, days = 365) =>
  db.query(`update terms set withdraw_allowed = $2, withdraw_refund_mode = $3, credit_valid_days = $4 where id = $1`, [T, allowed, mode, days]);
const wd = async (enrolment) => one(`select * from term_withdrawals where enrolment_id = $1`, [enrolment]);
const bookingModes = async (enrolment) => (await db.query(`select distinct cancel_refund_mode m from bookings where term_enrolment_id = $1 and status = 'cancelled'`, [enrolment])).rows.map((r) => r.m).join(',');
const balance = async (activity, user) => { await asUser(user); return (await one(`select balance_cents b from term_credit_balance($1)`, [activity])).b; };

await db.exec(stub);
await ok('00256 to 00269 apply', async () => {
  await db.exec(file('00256_term_enrolment.sql'));
  await db.exec(stub257);
  for (const n of ['00259_term_single_waitlist', '00260_term_place_waitlist', '00261_term_waitlist_vendor', '00262_term_waitlist_closing',
    '00263_term_withdraw_reschedule_leave', '00264_term_slot_groups', '00269_term_waitlist_pairs_and_used_trials']) {
    await db.exec(file(`${n}.sql`));
  }
});
await ok('00274 applies', async () => { await db.exec(file('00274_term_withdrawal_policy.sql')); });
await ok('00274 is idempotent (second run)', async () => { await db.exec(file('00274_term_withdrawal_policy.sql')); });

const P = (await one(`insert into providers (business_name) values ('Little Fish Swim') returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const [PA, PB, PC, PD] = ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555'];
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
for (const id of [PA, PB, PC, PD]) await db.query(`insert into parent_profiles (id) values ($1)`, [id]);
const kid = async (parent, name) => (await one(`insert into children (parent_id, name) values ($1, $2) returning id`, [parent, name])).id;
const [CA, CB, CC, CD] = [await kid(PA, 'Ava'), await kid(PB, 'Ben'), await kid(PC, 'Cal'), await kid(PD, 'Dee')];
const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
await db.query(`update activities set terms_enabled = true where id = $1`, [A]);
const startDate = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const pattern = JSON.stringify({ days: [6], time: '09:00', duration: 45, start: startDate, weeks: 4, skip: [], perDay: false, dayTimes: {} });
await asUser(VENDOR);
const T = (await one(`insert into terms (provider_id, activity_id, name, price_cents, allow_singles, single_price_cents) values ($1, $2, 'Term 4', 40000, true, 5000) returning id`, [P, A])).id;
const S = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 6, $2) returning id`, [T, pattern])).id;
await one(`select publish_term($1) as n`, [T]);
const sessions = (await db.query(`select id from activity_sessions where term_slot_id = $1 order by starts_at`, [S])).rows.map((r) => r.id);

// ---- the policy columns
await rejects('withdrawals cannot be allowed without saying what is given back', () => policy(T, true, null), 'terms_withdraw_policy_complete');
await rejects('a refund mode must be money, credit or none', () => policy(T, true, 'voucher'), 'terms_withdraw_refund_mode_check');

// ---- no policy yet: the activity's own rule, as before (00263/00264)
await asUser(PA);
const E1 = await enrol(S, CA);
await pay(E1.group_id, 100);
await ok('with no policy set, withdrawing follows the activity rule (refund mode, make-up route)', async () => {
  await db.query(`select withdraw_from_term($1)`, [E1.enrolment_id]);
  eq(await bookingModes(E1.enrolment_id), 'refund', 'mode');
  eq((await one(`select count(*)::int n from term_withdrawals`)).n, 0, 'withdrawal rows');
});

// ---- withdrawals not allowed
await policy(T, false, null);
await asUser(PB);
const E2 = await enrol(S, CB);
await pay(E2.group_id, 100);
await rejects('policy: withdrawals not allowed', () => db.query(`select withdraw_from_term($1)`, [E2.enrolment_id]), 'does not allow withdrawals');

// ---- no refund
await policy(T, true, 'none');
await ok('policy none: no refund, no make-up token, recorded as such', async () => {
  const n = (await one(`select withdraw_from_term($1) n`, [E2.enrolment_id])).n;
  const w = await wd(E2.enrolment_id);
  eq(n, 4, 'sessions cancelled');
  eq(await bookingModes(E2.enrolment_id), 'none', 'mode');
  eq(w.status, 'no_refund', 'status');
  eq(w.paid_cents, 40000, 'paid');
  eq(w.credit_cents, 0, 'credit');
  eq((await one(`select count(*)::int n from term_credits`)).n, 0, 'credits issued');
});

// ---- money, processed by hand
await policy(T, true, 'money');
await asUser(PC);
const E3 = await enrol(S, CC);
await pay(E3.group_id, 100);
await ok('policy money: the refund is recorded as due, nothing is paid out by the database', async () => {
  await db.query(`select withdraw_from_term($1)`, [E3.enrolment_id]);
  const w = await wd(E3.enrolment_id);
  eq(w.status, 'refund_due', 'status');
  eq(w.paid_cents, 40000, 'paid');
  eq(w.refund_cents, null, 'refund not yet decided');
  eq(await bookingModes(E3.enrolment_id), 'none', 'mode');
});
const w3 = await wd(E3.enrolment_id);
await asUser(PC);
await rejects('a parent cannot mark their own refund processed', () => db.query(`select vendor_mark_term_refund($1, 1000, null)`, [w3.id]), 'not authorized');
await asUser(VENDOR);
await rejects('the fee cannot exceed what was paid', () => db.query(`select vendor_mark_term_refund($1, 99999, null)`, [w3.id]), 'between 0 and what was paid');
await ok('the vendor records the refund: paid less the processing fee', async () => {
  await db.query(`select vendor_mark_term_refund($1, 1560, 'Stripe refund 1')`, [w3.id]);
  const w = await wd(E3.enrolment_id);
  eq(w.status, 'refund_done', 'status');
  eq(w.fee_cents, 1560, 'fee');
  eq(w.refund_cents, 38440, 'refund');
  eq((await one(`select count(*)::int n from notifications where user_id = $1 and type = 'term_refund_processed'`, [PC])).n, 1, 'parent told');
});
await rejects('a processed refund cannot be processed twice', () => db.query(`select vendor_mark_term_refund($1, 0, null)`, [w3.id]), 'no refund waiting');

// ---- credit
await policy(T, true, 'credit', 90);
await asUser(PD);
const E4 = await enrol(S, CD);
await pay(E4.group_id, 100);
await ok('policy credit: the payment comes back as dollar credit with the vendor, expiring in the vendor\'s days', async () => {
  await db.query(`select withdraw_from_term($1)`, [E4.enrolment_id]);
  const w = await wd(E4.enrolment_id);
  const c = await one(`select amount_cents, remaining_cents, round(extract(epoch from (expires_at - now())) / 86400)::int days from term_credits where id = $1`, [w.credit_id]);
  eq(w.status, 'credit_issued', 'status');
  eq(w.credit_cents, 40000, 'credit');
  eq(c.amount_cents, 40000, 'amount'); eq(c.remaining_cents, 40000, 'remaining'); eq(c.days, 90, 'days valid');
});
await ok('the parent sees the credit on that vendor\'s activity, and nobody else does', async () => {
  eq(await balance(A, PD), 40000, 'PD balance');
  eq(await balance(A, PC), 0, 'PC balance');
});

// ---- spending it
await asUser(PD);
const E5 = await enrol(S, CD);          // a second enrolment, unpaid, to pay for with the credit
const hold = async (group, total) => { await asUser(null, 'service_role'); return (await one(`select term_credit_hold($1, $2, $3) n`, [PD, group, total])).n; };
await ok('a hold sets credit aside, never more than the total', async () => {
  eq(await hold(E5.group_id, 30000), 30000, 'applied');
  eq(await balance(A, PD), 10000, 'balance while held');
});
await ok('holding again for the same checkout replaces the hold, not stacks it', async () => {
  eq(await hold(E5.group_id, 30000), 30000, 'applied');
  eq(await balance(A, PD), 10000, 'balance while held');
});
await ok('an abandoned hold frees itself after it expires', async () => {
  await db.query(`update term_credit_holds set expires_at = now() - interval '1 minute' where group_id = $1`, [E5.group_id]);
  eq(await balance(A, PD), 40000, 'balance after expiry');
  eq(await hold(E5.group_id, 30000), 30000, 'applied again');
});
await ok('settling spends the credit once the seats are paid', async () => {
  await asUser(null, 'service_role');
  const n = (await one(`select term_credit_settle($1) n`, [E5.group_id])).n;
  eq(n, 30000, 'spent');
  eq((await one(`select term_credit_settle($1) n`, [E5.group_id])).n, 0, 'second settle is a no-op');
  eq(await balance(A, PD), 10000, 'balance after');
});
await ok('credit that has expired cannot be spent or shown', async () => {
  await db.query(`update term_credits set expires_at = now() - interval '1 day' where user_id = $1`, [PD]);
  eq(await balance(A, PD), 0, 'balance');
  eq(await hold(E5.group_id, 5000), 0, 'applied');
  await db.query(`update term_credits set expires_at = now() + interval '30 days' where user_id = $1`, [PD]);
});

// ---- withdrawing from a term paid partly with credit
await policy(T, true, 'money');
await db.query(`update bookings set payment_status = 'paid', status = 'confirmed' where booking_group_id = $1`, [E5.group_id]);
await db.query(`update bookings set amount = 25 where booking_group_id = $1`, [E5.group_id]);   // $100 cash of a $400 term; $300 was credit
await ok('withdrawing: cash refunds as money (by hand), the credit that was spent comes back as credit', async () => {
  await asUser(PD);
  await db.query(`select withdraw_from_term($1)`, [E5.enrolment_id]);
  const w = await wd(E5.enrolment_id);
  eq(w.paid_cents, 10000, 'cash paid');
  eq(w.credit_cents, 30000, 'credit returned');
  eq(w.status, 'refund_due', 'status');
});

// ---- once the term has started
await policy(T, true, 'credit');
await asUser(PA);
const E6 = await enrol(S, CA);
await pay(E6.group_id, 100);
await asUser(null, 'service_role');
await db.query(`update activity_sessions set starts_at = now() - interval '1 day', ends_at = now() - interval '1 day' + interval '45 minutes' where id = $1`, [sessions[0]]);
await asUser(PA);
await rejects('after the term has started a parent cannot withdraw online, whatever the policy', () => db.query(`select withdraw_from_term($1)`, [E6.enrolment_id]), 'has started');
await asUser(VENDOR);
await ok('the vendor can still withdraw them', async () => {
  const n = (await one(`select vendor_withdraw_from_term($1, 'none', 'Moved away') n`, [E6.enrolment_id])).n;
  if (n < 1) throw new Error('nothing withdrawn');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
