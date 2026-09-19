/**
 * Proves migration 00146 (cancel_wix_session + hiding + booking guard) does what
 * it says, end to end, against the real database schema and triggers — without
 * leaving a trace and without emailing anybody.
 *
 *   node scripts/validate-wix-session-cancel.mjs
 *
 * Everything runs in ONE transaction that is ALWAYS rolled back (the migration
 * body is re-applied inside it first, so this works before AND after 00146 has
 * landed). notifications rows are inserted but the transaction never commits,
 * so the pg_net email webhook they queue is discarded with it.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';

process.loadEnvFile('.env.local');
const migration = readFileSync('supabase/migrations/00146_cancel_wix_dropped_session.sql', 'utf8')
  .replace(/^\s*begin\s*;/im, '')
  .replace(/\bcommit\s*;\s*$/i, '');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};

class Rollback extends Error {}
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require', max: 1 });
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(migration);

    // Borrow real rows for the FKs; everything we insert dies with the rollback.
    const [prov] = await tx`select p.id, p.owner_id from public.providers p where p.owner_id is not null limit 1`;
    const [cat] = await tx`select id from public.activity_categories limit 1`;
    // Plain parents only: a provider owner/member sees ALL their own sessions via
    // the vendor RLS policy, which would mask the parent-side hiding under test.
    const parents = await tx`
      select id from public.parent_profiles
      where id not in (select owner_id from public.providers where owner_id is not null)
        and id not in (select user_id from public.provider_members)
      limit 3`;
    if (!prov || !cat || parents.length < 3) throw new Error('need a provider, a category and 3 non-vendor parents in the database');
    const [p1, p2, p3] = parents.map((p) => p.id);

    const [act] = await tx`
      insert into public.activities (provider_id, category_id, title, slug, is_published, price, age_min_months, age_max_months)
      values (${prov.id}, ${cat.id}, 'ZZ cancel test', ${'zz-cancel-test-' + Date.now()}, true, 0, 0, 72) returning id`;
    const mk = async (offsetH) => (await tx`
      insert into public.activity_sessions (activity_id, starts_at, ends_at, capacity)
      values (${act.id}, now() + ${offsetH + ' hours'}::interval, now() + ${offsetH + 1 + ' hours'}::interval, 1) returning id`)[0].id;
    const dead = await mk(48);
    const live = await mk(72);

    const ins = async (sess, user, status) => (await tx`
      insert into public.bookings (session_id, user_id, status) values (${sess}, ${user}, ${status}) returning id, status`)[0];
    const b1 = await ins(dead, p1, 'confirmed');
    const b2 = await ins(dead, p2, 'confirmed'); // over capacity -> the insert trigger waitlists it
    const b3 = await ins(live, p3, 'confirmed'); // a booking on a DIFFERENT session must be untouched
    const [b2now] = await tx`select status from public.bookings where id = ${b2.id}`;
    check('setup: over-capacity 2nd booking was waitlisted', b2now.status === 'waitlisted', b2now.status);

    await tx`delete from public.notifications where user_id in (${p1}, ${p2}, ${p3})`;
    const cancelled = (await tx`select public.cancel_wix_session(${dead}) as n`)[0].n;
    check('cancel_wix_session returns the number of bookings cancelled', cancelled === 2, `got ${cancelled}`);

    const rows = await tx`select id, status, cancelled_by, cancel_refund_mode from public.bookings where id in (${b1.id}, ${b2.id}, ${b3.id})`;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    check('confirmed booking is cancelled', by[b1.id].status === 'cancelled');
    check('waitlisted booking is cancelled (not promoted)', by[b2.id].status === 'cancelled');
    check('cancelled as a VENDOR cancellation (cancelled_by set)', !!by[b1.id].cancelled_by && !!by[b2.id].cancelled_by);
    check('booking on another session is untouched', by[b3.id].status === 'confirmed');

    const [sess] = await tx`select status from public.activity_sessions where id = ${dead}`;
    check('session is marked cancelled', sess.status === 'cancelled');

    const notes = await tx`select user_id, type, email_status from public.notifications where user_id in (${p1}, ${p2}, ${p3})`;
    const cc = notes.filter((n) => n.type === 'class_cancelled');
    check('each cancelled parent got a class_cancelled notification (=> branded email)', cc.length === 2 && cc.every((n) => n.email_status !== 'skipped'), `${cc.length} found`);
    check('the parent on the other session got nothing', !notes.some((n) => n.user_id === p3));
    check('no bogus waitlist_promoted / spot-open notice', !notes.some((n) => /waitlist/.test(n.type)), notes.map((n) => n.type).join(','));

    check('calling it again is a harmless no-op', (await tx`select public.cancel_wix_session(${dead}) as n`)[0].n === 0);

    // ---- hiding: act as an authenticated parent (RLS applies) ----------------
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: p3, role: 'authenticated' })}, true)`;
    const seenByOther = await tx`select id from public.activity_sessions where id in (${dead}, ${live})`;
    check('a parent with no booking on it cannot see the cancelled session', !seenByOther.some((r) => r.id === dead));
    check('...but still sees the healthy session', seenByOther.some((r) => r.id === live));
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: p1, role: 'authenticated' })}, true)`;
    const seenByOwner = await tx`select id from public.activity_sessions where id = ${dead}`;
    check('even a parent who booked it no longer sees it in listings/search', seenByOwner.length === 0);
    const lookup = await tx`select slug, title from public.my_booking_activities(${[b1.id, b3.id]}::uuid[])`;
    check('my_booking_activities still names the class for their own cancelled booking', lookup.length === 1 && lookup[0].title === 'ZZ cancel test');
    const found = await tx`select next_session_at from public.search_activities(null, null, null, null, null, null, null, 'popular', 500, 0) where id = ${act.id}`;
    const [liveRow] = await tx`select starts_at from public.activity_sessions where id = ${live}`;
    check("search 'next session' skips the cancelled one",
      found.length === 1 && new Date(found[0].next_session_at).getTime() === new Date(liveRow.starts_at).getTime());
    await tx`reset role`;

    // ---- the guard -----------------------------------------------------------
    let blocked = false;
    await tx`savepoint g`;
    try {
      await tx`insert into public.bookings (session_id, user_id, status) values (${dead}, ${p3}, 'confirmed')`;
    } catch (e) {
      blocked = /cancelled/i.test(e.message);
    }
    await tx`rollback to savepoint g`;
    check('a new booking on the cancelled session is refused', blocked);

    // ---- the function is not callable by ordinary roles ----------------------
    await tx`set local role authenticated`;
    let denied = false;
    await tx`savepoint h`;
    try {
      await tx`select public.cancel_wix_session(${live})`;
    } catch (e) {
      denied = /permission denied/i.test(e.message);
    }
    await tx`rollback to savepoint h`;
    await tx`reset role`;
    check('cancel_wix_session is not callable by an authenticated user', denied);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error('ERROR:', e.message);
    fail++;
  }
} finally {
  await sql.end();
}
console.log(`\n${pass} passed, ${fail} failed (transaction rolled back, nothing persisted)`);
process.exit(fail ? 1 : 0);
