/**
 * Behaviour tests for 00269_term_waitlist_pairs_and_used_trials.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00269_term_waitlist_pairs_and_used_trials.test.mjs
 *
 * Loads 00256, the 00257 pieces it builds on, and 00259-00264 over the same
 * stand-ins as the 00260-00263 tests. "Paying" is a direct update to
 * confirmed/paid, as the Stripe webhook does.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (n) => readFileSync(fileURLToPath(new URL(`../migrations/${n}`, import.meta.url)), 'utf8');
const db = new PGlite();

const stub = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $$;
create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create table public.providers (id uuid primary key default gen_random_uuid(), business_name text);
create table public.provider_members (user_id uuid, provider_id uuid, role text default 'owner', status text default 'active');
create table public.parent_profiles (id uuid primary key, full_name text, email text);
create table public.children (id uuid primary key default gen_random_uuid(), parent_id uuid references public.parent_profiles(id), name text, date_of_birth date);
create table public.provider_locations (id uuid primary key default gen_random_uuid(), provider_id uuid);
create table public.activities (
  id uuid primary key default gen_random_uuid(), provider_id uuid, title text, slug text, price numeric,
  bookings_paused boolean default false, booking_cutoff_minutes int default 15, allow_cancellation boolean default true,
  cancellation_cutoff_hours int default 0, cancellation_refund_mode text default 'refund',
  wix_service_id text, wix_event_id text, wix_series_id text, wix_service_type text);
create table public.activity_sessions (
  id uuid primary key default gen_random_uuid(), activity_id uuid references public.activities(id),
  starts_at timestamptz not null, ends_at timestamptz not null, capacity int, price numeric,
  location_id uuid, status text default 'scheduled', booking_cutoff_minutes int, cancellation_cutoff_hours int);
create table public.bookings (
  id uuid primary key default gen_random_uuid(), user_id uuid, session_id uuid references public.activity_sessions(id),
  child_id uuid, status text default 'pending', payment_status text default 'none', amount numeric,
  package_purchase_id uuid, booking_group_id uuid, policies_accepted uuid[], medical_disclosure text,
  info_response text, guest_name text, waitlist_position int, pending_since timestamptz,
  waitlist_pay_invited boolean not null default false, cancel_refund_mode text, cancel_reason text, cancelled_by uuid,
  checkout_started_at timestamptz, created_at timestamptz default now());
create table public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid, type text, title text, body text,
  data jsonb, created_at timestamptz default now());
create table public.make_up_tokens (id uuid primary key default gen_random_uuid(), redeemed_booking_id uuid, status text);

create function public.user_provider_ids() returns setof uuid language sql stable as $$
  select provider_id from public.provider_members where user_id = auth.uid() $$;
create function public.user_manage_provider_ids() returns setof uuid language sql stable as $$
  select provider_id from public.provider_members where user_id = auth.uid() and role in ('owner','manager') $$;
create function public.session_email_details(p_session uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('session_id', p_session) $$;

create function public.handle_booking_insert() returns trigger language plpgsql as $$
declare cap int; taken int;
begin
  select s.capacity into cap from public.activity_sessions s where s.id = new.session_id for update;
  if cap is not null then
    select count(*) into taken from public.bookings b where b.session_id = new.session_id and b.status in ('pending','confirmed');
    if taken >= cap then
      new.status := 'waitlisted';
      select coalesce(max(waitlist_position), 0) + 1 into new.waitlist_position
      from public.bookings where session_id = new.session_id and status = 'waitlisted';
    end if;
  end if;
  return new;
end $$;
create trigger before_booking_insert before insert on public.bookings for each row execute function public.handle_booking_insert();

create function public.enforce_booking_insert_defaults() returns trigger language plpgsql as $$
declare v_price numeric;
begin
  if auth.role() = 'service_role' then return new; end if;
  select coalesce(s.price, a.price) into v_price from public.activity_sessions s join public.activities a on a.id = s.activity_id where s.id = new.session_id;
  new.payment_status := 'none'; new.amount := null;
  if new.status is distinct from 'waitlisted' then
    new.status := case when coalesce(v_price, 0) = 0 then 'confirmed' else 'pending' end;
  end if;
  return new;
end $$;
create trigger booking_insert_defaults before insert on public.bookings for each row execute function public.enforce_booking_insert_defaults();

create function public.book_party(p_session_id uuid, p_child_id uuid default null, p_guest_names text[] default '{}',
  p_policies uuid[] default '{}', p_medical text default null, p_info text default null)
returns table (group_id uuid, status text, waitlisted_count int) language plpgsql security definer as $$
#variable_conflict use_column
declare g uuid := gen_random_uuid(); st text;
begin
  insert into public.bookings (user_id, session_id, child_id, booking_group_id) values (auth.uid(), p_session_id, p_child_id, g)
  returning bookings.status into st;
  return query select g, st, case when st = 'waitlisted' then 1 else 0 end;
end $$;

create function public.vendor_cancel_session(p_session_id uuid) returns integer language plpgsql security definer as $$
begin update public.activity_sessions set status = 'cancelled' where id = p_session_id; return 0; end $$;

create function public.claim_waitlist_seats(p_seat_ids uuid[]) returns void language plpgsql security definer as $$
begin update public.bookings set status = 'pending', pending_since = now() where id = any(p_seat_ids) and status = 'waitlisted'; end $$;
`;

// The 00257 pieces 00259/00260 build on.
const stub257 = `
alter table public.terms
  add column if not exists sibling_discount_pct int not null default 0,
  add column if not exists previous_term_id uuid references public.terms (id) on delete set null,
  add column if not exists priority_until timestamptz;
create or replace function public.term_has_returning_family(p_prev_term uuid, p_user uuid) returns boolean
  language sql stable as $$ select false $$;
drop function if exists public.enrol_in_term(uuid, uuid, uuid[], text, text);
`;

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
const enrol = async (slot, child) => one(`select * from enrol_in_term($1, $2)`, [slot, child]);
const join = async (slot, child) => (await one(`select join_term_waitlist($1, $2) id`, [slot, child])).id;
const entry = async (id) => one(`select status, position, hold_enrolment_id, last_told_at from term_waitlist where id = $1`, [id]);
const placeOpen = async (user) => (await one(`select count(*)::int n from notifications where user_id = $1 and type = 'term_waitlist_place_open'`, [user])).n;
// What the Stripe webhook does for a paid checkout.
const pay = async (group) => db.query(`update bookings set status = 'confirmed', payment_status = 'paid' where booking_group_id = $1 and status = 'pending'`, [group]);

await db.exec(stub);
await ok('00256 + 00257 pieces + 00259 to 00262 apply', async () => {
  await db.exec(file('00256_term_enrolment.sql'));
  await db.exec(stub257);
  for (const n of ['00259_term_single_waitlist', '00260_term_place_waitlist', '00261_term_waitlist_vendor', '00262_term_waitlist_closing']) {
    await db.exec(file(`${n}.sql`));
  }
});
await ok('00263 applies', async () => { await db.exec(file('00263_term_withdraw_reschedule_leave.sql')); });
await ok('00263 is idempotent (second run)', async () => { await db.exec(file('00263_term_withdraw_reschedule_leave.sql')); });

// ---- fixtures that exist BEFORE 00264 (so the backfill has something to do)
const P = (await one(`insert into providers (business_name) values ('Little Fish Swim') returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const [PA, PB, PC, PD] = ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555'];
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
for (const id of [PA, PB, PC, PD]) await db.query(`insert into parent_profiles (id) values ($1)`, [id]);
const kid = async (parent, name) => (await one(`insert into children (parent_id, name) values ($1, $2) returning id`, [parent, name])).id;
const [CA, CB, CC, CD] = [await kid(PA, 'Ava'), await kid(PB, 'Ben'), await kid(PC, 'Cal'), await kid(PD, 'Dee')];
const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
await db.query(`update activities set terms_enabled = true where id = $1`, [A]);
const nextDate = async (dow) => (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((${dow} - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const monday = await nextDate(1);
const pat = (days, time, weeks = 4, start = monday) => JSON.stringify({ days, time, duration: 45, start, weeks, skip: [], perDay: false, dayTimes: {} });

await asUser(VENDOR);
const T0 = (await one(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'Legacy term', 30000) returning id`, [P, A])).id;
const L1 = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 5, $2) returning id`, [T0, pat([1], '08:00')])).id;
await one(`select publish_term($1) as n`, [T0]);

await ok('00264 applies', async () => { await db.exec(file('00264_term_slot_groups.sql')); });
await ok('00264 is idempotent (second run)', async () => { await db.exec(file('00264_term_slot_groups.sql')); });
await ok('00269 applies', async () => { await db.exec(file('00269_term_waitlist_pairs_and_used_trials.sql')); });
await ok('00269 is idempotent (second run)', async () => { await db.exec(file('00269_term_waitlist_pairs_and_used_trials.sql')); });

await ok('a pre-existing slot is put in one default group', async () => {
  const r = await one(`select g.name, (select count(*)::int from term_slot_groups x where x.term_id = $2) n from term_slots ts join term_slot_groups g on g.id = ts.group_id where ts.id = $1`, [L1, T0]);
  if (!r || r.n !== 1) throw new Error(JSON.stringify(r));
  return r.name;
});
await asUser(PA);
await ok('a single-group term still enrols the old way, at the term price', async () => {
  const e = await enrol(L1, CA);
  if (e.price_cents !== 30000) throw new Error(JSON.stringify(e));
  return `${e.sessions} sessions, ${e.price_cents}`;
});
await asUser(VENDOR);
await ok('a slot inserted without a group joins the term\'s first group', async () => {
  const id = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 5, $2) returning id`, [T0, pat([1], '10:00')])).id;
  const r = await one(`select (group_id is not null) ok from term_slots where id = $1`, [id]);
  if (!r.ok) throw new Error('no group');
});

// ---- Simple and Flexible
await ok('every existing term is Simple', async () => {
  const r = await one(`select slot_mode from terms where id = $1`, [T0]);
  if (r.slot_mode !== 'simple') throw new Error(r.slot_mode);
});
await ok('a Simple term refuses a second group', async () => {
  const S = (await one(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'Simple draft', 1000) returning id`, [P, A])).id;
  await db.query(`insert into term_slots (term_id, capacity, pattern) values ($1, 5, $2)`, [S, pat([1], '10:00')]);
  try { await db.query(`insert into term_slot_groups (term_id, name) values ($1, 'Extra')`, [S]); } catch (e) {
    if (!e.message.includes('Switch it to Flexible')) throw e; return e.message;
  }
  throw new Error('added');
});
await ok('a draft can switch to Flexible, take a second group, and go back once combined', async () => {
  const D = (await one(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'Mode test', 1000) returning id`, [P, A])).id;
  await db.query(`update terms set slot_mode = 'flexible' where id = $1`, [D]);
  await db.query(`insert into term_slot_groups (term_id, name) values ($1, 'One'), ($1, 'Two')`, [D]);
  try { await db.query(`update terms set slot_mode = 'simple' where id = $1`, [D]); } catch (e) {
    if (!e.message.includes('Combine the groups')) throw e;
    await db.query(`delete from term_slot_groups where term_id = $1 and name = 'Two'`, [D]);
    await db.query(`update terms set slot_mode = 'simple' where id = $1`, [D]);
    return 'refused until combined';
  }
  throw new Error('switched with two groups');
});
await ok('the mode of a published term is fixed', async () => {
  try { await db.query(`update terms set slot_mode = 'flexible' where id = $1`, [T0]); } catch (e) {
    if (!e.message.includes('mode is fixed')) throw e; return e.message;
  }
  throw new Error('changed');
});

// ---- the two-group term (the client's example)
// Group 1: Mon and Tue, 9:30 and 13:30. Group 2: Thu and Fri, 9:30 and 13:30.
const T = (await one(`insert into terms (provider_id, activity_id, name, price_cents, allow_singles, single_price_cents, slot_mode) values ($1, $2, 'Term 4 · 2 a week', 40000, true, 5000, 'flexible') returning id`, [P, A])).id;
const G1 = (await one(`insert into term_slot_groups (term_id, name, position) values ($1, 'Mon & Tue', 0) returning id`, [T])).id;
const G2 = (await one(`insert into term_slot_groups (term_id, name, position) values ($1, 'Thu & Fri', 1) returning id`, [T])).id;
const mk = async (group, days, time, cap = 3, weeks = 4) =>
  (await one(`insert into term_slots (term_id, group_id, capacity, pattern) values ($1, $2, $3, $4) returning id`, [T, group, cap, pat(days, time, weeks)])).id;
const A1 = await mk(G1, [1], '09:30', 1);   // Mon 9:30, one place
const A2 = await mk(G1, [1], '13:30');
const A3 = await mk(G1, [2], '09:30');
const A4 = await mk(G1, [2], '13:30');
const B1 = await mk(G2, [4], '09:30');
const B2 = await mk(G2, [4], '13:30');
const B3 = await mk(G2, [5], '09:30', 1);   // Fri 9:30, one place
const B4 = await mk(G2, [5], '13:30');
const BX = await mk(G2, [1], '09:30');       // clashes with A1 (Mon 9:30) on purpose
const BS = await mk(G2, [4], '17:00', 3, 3); // only 3 weeks, for the uneven split

await ok('a term with an empty group cannot be published', async () => {
  const T2 = (await one(`insert into terms (provider_id, activity_id, name, price_cents, slot_mode) values ($1, $2, 'Empty group', 100, 'flexible') returning id`, [P, A])).id;
  await db.query(`insert into term_slot_groups (term_id, name) values ($1, 'Full'), ($1, 'Empty')`, [T2]);
  const g = (await one(`select id from term_slot_groups where term_id = $1 and name = 'Full'`, [T2])).id;
  await db.query(`insert into term_slots (term_id, group_id, capacity, pattern) values ($1, $2, 2, $3)`, [T2, g, pat([1], '09:00')]);
  try { await db.query(`select publish_term($1)`, [T2]); } catch (e) { if (!e.message.includes('Every group needs at least one slot')) throw e; return e.message; }
  throw new Error('published');
});

await one(`select publish_term($1) as n`, [T]);

await ok('publishing splits the session price across the groups', async () => {
  const r = await one(`select price from activity_sessions where term_slot_id = $1 limit 1`, [A1]);
  // 400.00 / 4 sessions = 100 per session in a slot; two groups -> 50 each.
  if (Number(r.price) !== 50) throw new Error(String(r.price));
});
await ok('groups cannot be added after publishing', async () => {
  try { await db.query(`insert into term_slot_groups (term_id, name) values ($1, 'Late')`, [T]); } catch (e) { return e.message; }
  throw new Error('added');
});
await ok('a group can still be renamed after publishing', async () => {
  await db.query(`update term_slot_groups set name = 'Mon and Tue' where id = $1`, [G1]);
});
await rejects('a published slot cannot change group', async () => {
  await db.query(`update term_slots set group_id = $1 where id = $2`, [G2, A2]);
}, 'groups are fixed');

const combo = async (slots, child, group = null) => one(`select * from enrol_in_term_combo($1::uuid[], $2, '{}', null, null, $3)`, [slots, child, group]);
const joinCombo = async (slots, child) => (await one(`select join_term_combo_waitlist($1::uuid[], $2) id`, [slots, child])).id;
const bookingsOf = async (enrolmentIds) => (await one(`select count(*)::int n, count(*) filter (where status = 'cancelled')::int cancelled from bookings where term_enrolment_id = any($1::uuid[])`, [enrolmentIds]));


// ======================================================================
// 00269: several pairs per family, and trial waits closing once a trial is used
// ======================================================================
const myWaits = async () => (await db.query(`select * from my_term_waitlist()`)).rows;
const entryStatus = async (combo) => (await one(`select status from term_waitlist where combo_id = $1 limit 1`, [combo])).status;

await asUser(PB);
const PBE = await combo([A1, B1], CB);           // Mon 9:30 has one place: B takes it
await pay(PBE.group_id);

await asUser(PA);
let w1, w2;
await ok('a family can wait for two different pairs at once', async () => {
  w1 = await joinCombo([A1, B2], CA);
  w2 = await joinCombo([A1, B4], CA);
  const n = (await one(`select count(*)::int n from term_waitlist where user_id = $1 and status = 'waiting'`, [PA])).n;
  if (w1 === w2 || n !== 2) throw new Error(`${n} entries`);
});
await ok('joining the same pair again is still the same entry', async () => {
  const again = await joinCombo([B2, A1], CA);
  if (again !== w1) throw new Error('new entry');
});
await ok('the Bookings tab shows one card for each pair', async () => {
  const rows = await myWaits();
  if (rows.length !== 2 || rows.some((r) => !r.combo_id)) throw new Error(JSON.stringify(rows.map((r) => r.combo_id)));
});

await asUser(PB);
await ok('when the shared full slot frees, the family is told once (not once per pair)', async () => {
  const before = await placeOpen(PA);
  await db.query(`select withdraw_from_term($1)`, [PBE.enrolment_ids[0]]);
  const n = (await placeOpen(PA)) - before;
  if (n !== 1) throw new Error(`${n} messages`);
});

await asUser(PA);
let AE;
await ok("enrolling one pair holds that pair's waiting entry, not the other pair's", async () => {
  AE = await combo([A1, B2], CA);
  const s1 = await entryStatus(w1), s2 = await entryStatus(w2);
  if (s1 !== 'holding' || s2 !== 'waiting') throw new Error(`${s1} / ${s2}`);
});
await pay(AE.group_id);
await ok('the other pair\'s card now asks "stay on this waitlist?" (enrolled elsewhere)', async () => {
  const rows = await myWaits();
  const other = rows.find((r) => r.combo_id === w2);
  if (!other || other.enrolled_elsewhere !== true) throw new Error(JSON.stringify(rows.map((r) => ({ c: r.combo_id === w2, e: r.enrolled_elsewhere }))));
});
await rejects('a pair with a slot the child already has a place in cannot be joined', async () => {
  await joinCombo([A1, B3], CA);
}, 'already has a place');
await rejects('nor enrolled in', async () => { await combo([A1, B3], CA); }, 'already enrolled in this slot');
await ok('a second pair with no shared slot can be taken, as two slots of a Simple term can', async () => {
  const e = await combo([A2, B3], CA);
  if (!e?.combo_id || e.combo_id === AE.combo_id) throw new Error(JSON.stringify(e));
  await asUser(null, 'service_role');
  await db.query(`update bookings set status = 'cancelled' where booking_group_id = $1`, [e.group_id]);
  await asUser(PA);
});
await ok('leaving the other pair ends that pair only', async () => {
  const id = (await one(`select id from term_waitlist where combo_id = $1 limit 1`, [w2])).id;
  await db.query(`select leave_term_waitlist_entry($1)`, [id]);
  if ((await entryStatus(w2)) === 'waiting') throw new Error('still waiting');
  if ((await entryStatus(w1)) !== 'enrolled') throw new Error('the enrolled pair changed');
});

await asUser(PD);
await ok('an unpaid attempt at a pair is kept unless the new pair shares a slot with it', async () => {
  const p1 = await combo([A3, B2], CD);
  const p2 = await combo([A4, B4], CD);          // shares nothing with p1
  const kept = (await bookingsOf(p1.enrolment_ids)).cancelled === 0;
  const p3 = await combo([A3, B4], CD);          // shares Tue 9:30 with p1 and Fri 1:30 with p2
  const b1 = await bookingsOf(p1.enrolment_ids), b2 = await bookingsOf(p2.enrolment_ids);
  if (!kept || b1.cancelled !== b1.n || b2.cancelled !== b2.n || !p3?.combo_id) throw new Error(JSON.stringify({ kept, b1, b2 }));
  await asUser(null, 'service_role');
  await db.query(`update bookings set status = 'cancelled' where booking_group_id = $1`, [p3.group_id]);
});

// A family whose first pair is still blocked hears about another pair of theirs that is ready.
await asUser(PB);
const PB2 = await combo([A2, B3], CB);           // fills Fri 9:30 (one place)
await pay(PB2.group_id);
await asUser(PD);
const p1 = await joinCombo([A1, B3], CD);        // Mon 9:30 and Fri 9:30 both full
const p2 = await joinCombo([A1, B2], CD);        // only Mon 9:30 full
await asUser(PA);
await ok('when Mon 9:30 frees, the family is told about the pair that is ready, though their first pair is still blocked', async () => {
  const before = await placeOpen(PD);
  await db.query(`select withdraw_from_term($1)`, [AE.enrolment_ids[0]]);
  const msgs = (await db.query(`select data from notifications where user_id = $1 and type = 'term_waitlist_place_open'`, [PD])).rows;
  const newOnes = msgs.length - before;
  if (newOnes !== 1 || !msgs.some((m) => m.data.combo_id === p2) || msgs.some((m) => m.data.combo_id === p1)) {
    throw new Error(`${newOnes} new, ${JSON.stringify(msgs.map((m) => m.data.combo_id === p2 ? 'p2' : m.data.combo_id === p1 ? 'p1' : '?'))}`);
  }
});

// ---- trials
const trialTerm = async (name, singles) => {
  await asUser(VENDOR);
  const id = (await one(`insert into terms (provider_id, activity_id, name, price_cents, allow_trial, trial_price_cents, trial_limit, allow_singles, single_price_cents)
                         values ($1, $2, $3, 30000, true, 2000, 1, $4, 3000) returning id`, [P, A, name, singles])).id;
  const slot = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 1, $2) returning id`, [id, pat([3], singles ? '11:00' : '10:00', 2)])).id;
  await one(`select publish_term($1) n`, [id]);
  return (await db.query(`select id from activity_sessions where term_slot_id = $1 order by starts_at`, [slot])).rows.map((r) => r.id);
};
const trial = async (session, child) => one(`select * from book_term_class($1, 'trial', $2)`, [session, child]);
const seat = async (session, child) => one(`select id, status, cancel_reason from bookings where session_id = $1 and child_id = $2 order by created_at desc limit 1`, [session, child]);

const [s1, s2] = await trialTerm('Trial term, no singles', false);
await asUser(PB);
await trial(s1, CB);                             // takes the first session's only seat
await asUser(PC);
const waitT = await trial(s1, CC);
await ok('a trial on a full session goes on that session\'s waitlist', async () => {
  if (waitT.status !== 'waitlisted') throw new Error(waitT.status);
});
const otherT = await trial(s2, CC);              // a trial on the next session, which has room
await ok('the trial wait stays open while the other trial is still unpaid', async () => {
  const b = await seat(s1, CC);
  if (b.status !== 'waitlisted') throw new Error(b.status);
});
await rejects('"Pay now" on the trial place meanwhile says this term has no single sessions', async () => {
  await asUser(null, 'service_role');
  await db.query(`update bookings set status = 'cancelled' where session_id = $1 and child_id = $2`, [s1, CB]);
  await asUser(PC);
  await db.query(`select claim_term_waitlist_seats($1::uuid[])`, [[(await seat(s1, CC)).id]]);
}, 'no single sessions');
await ok('once the other trial is paid, the trial wait closes and the family is pointed to the whole term', async () => {
  await db.query(`update bookings set status = 'confirmed', payment_status = 'paid' where booking_group_id = $1`, [otherT.group_id]);
  const b = await seat(s1, CC);
  const n = await one(`select body, data from notifications where user_id = $1 and type = 'term_trial_waitlist_closed' order by created_at desc limit 1`, [PC]);
  if (b.status !== 'cancelled' || b.cancel_reason !== 'Trial already used' || !n || !/whole term/.test(n.body) || n.data.singles_offered !== false) {
    throw new Error(JSON.stringify({ b, n }));
  }
  return n.body;
});

const [u1, u2] = await trialTerm('Trial term, with singles', true);
await asUser(PA);
await trial(u1, CA);
await asUser(PD);
await trial(u1, CD);
const dT = await trial(u2, CD);
await ok('with single sessions on, the family is pointed to booking that session as a single', async () => {
  await db.query(`update bookings set status = 'confirmed', payment_status = 'paid' where booking_group_id = $1`, [dT.group_id]);
  const b = await seat(u1, CD);
  const n = await one(`select body, data from notifications where user_id = $1 and type = 'term_trial_waitlist_closed' order by created_at desc limit 1`, [PD]);
  if (b.status !== 'cancelled' || !/single session/.test(n?.body ?? '') || !String(n?.data?.url).includes('mode=single')) throw new Error(JSON.stringify({ b, n }));
});
await ok("another child's trial wait in the same family is left alone", async () => {
  const b = await seat(u1, CA);
  if (b.status === 'cancelled') throw new Error('closed');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
