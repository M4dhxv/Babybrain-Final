/**
 * Tests for 00277_term_function_order_guard.sql, run against an in-process Postgres (PGlite).
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00277_term_function_order_guard.test.mjs
 *
 * Reproduces the production order: the full term chain, then 00274 and 00275. Then it puts the OLD
 * withdraw_from_term (00264) and term_session_gate (00259) back, exactly as a late apply of the older
 * files would, and checks that 00277 restores the 00274 / 00275 versions.
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
async function ok(name, fn) {
  try { const v = await fn(); results.push(`PASS  ${name}${v ? '  -> ' + v : ''}`); pass++; }
  catch (e) { results.push(`FAIL  ${name}  -> ${e.message}`); fail++; }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); };
// Line endings differ between files (00274 is CRLF); only the code matters.
const body = async (fn) => (await one(`select md5(replace(prosrc, chr(13), '')) m from pg_proc where proname = $1`, [fn])).m;
// The first "create or replace function public.<name>" block in a migration, up to its closing $$;
const block = (sql, name) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end + 4);
};

await db.exec(stub);
await ok('00256 to 00269, 00274 and 00275 apply', async () => {
  await db.exec(file('00256_term_enrolment.sql'));
  await db.exec(stub257);
  for (const n of ['00259_term_single_waitlist', '00260_term_place_waitlist', '00261_term_waitlist_vendor', '00262_term_waitlist_closing',
    '00263_term_withdraw_reschedule_leave', '00264_term_slot_groups', '00269_term_waitlist_pairs_and_used_trials',
    '00274_term_withdrawal_policy', '00275_term_group_offers']) {
    await db.exec(file(`${n}.sql`));
  }
});

const newWithdraw = await body('withdraw_from_term');
const newGate = await body('term_session_gate');

await ok('00277 applies and changes nothing when the newest versions are already in place', async () => {
  await db.exec(file('00277_term_function_order_guard.sql'));
  eq(await body('withdraw_from_term'), newWithdraw, 'withdraw_from_term');
  eq(await body('term_session_gate'), newGate, 'term_session_gate');
});

await ok('00277 is idempotent (second run)', async () => { await db.exec(file('00277_term_function_order_guard.sql')); });

await ok('a late apply of the older files really does overwrite both functions', async () => {
  await db.exec(block(file('00264_term_slot_groups.sql'), 'withdraw_from_term'));
  await db.exec(block(file('00259_term_single_waitlist.sql'), 'term_session_gate'));
  if ((await body('withdraw_from_term')) === newWithdraw) throw new Error('withdraw_from_term was not overwritten');
  if ((await body('term_session_gate')) === newGate) throw new Error('term_session_gate was not overwritten');
});

await ok('00277 puts the 00274 and 00275 versions back', async () => {
  await db.exec(file('00277_term_function_order_guard.sql'));
  eq(await body('withdraw_from_term'), newWithdraw, 'withdraw_from_term');
  eq(await body('term_session_gate'), newGate, 'term_session_gate');
});

await ok('the restored withdraw_from_term has the policy branch and the gate asks the group', async () => {
  const w = (await one(`select prosrc from pg_proc where proname = 'withdraw_from_term'`)).prosrc;
  const g = (await one(`select prosrc from pg_proc where proname = 'term_session_gate'`)).prosrc;
  if (!w.includes('withdraw_allowed')) throw new Error('no policy branch');
  if (!g.includes('term_slot_offer')) throw new Error('gate does not ask the group');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
