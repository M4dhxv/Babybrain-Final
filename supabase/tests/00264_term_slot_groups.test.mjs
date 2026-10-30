/**
 * Behaviour tests for 00264_term_slot_groups.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00264_term_slot_groups.test.mjs
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

// ---- rules of a combination
await asUser(PA);
await rejects('the one-slot enrol is refused for a two-group term', async () => { await enrol(A3, CA); }, 'one slot from each group');
await rejects('a combination missing a group is refused', async () => { await combo([A3], CA); }, 'nothing picked in: Thu & Fri');
await rejects('two slots from one group are refused', async () => { await combo([A3, A4, B3], CA); }, 'only one slot from each group');
await rejects('slots running at the same time are refused', async () => { await combo([A1, BX], CA); }, 'at the same time');
await rejects('the same slot twice is refused', async () => { await combo([A3, A3], CA); }, 'twice');

await ok('the combination price is the term price, whatever slots are picked', async () => {
  const q = await one(`select * from term_combo_quote($1::uuid[])`, [[A3, B1]]);
  if (q.price_cents !== 40000 || q.sessions_left !== 8 || !q.joinable) throw new Error(JSON.stringify(q));
});

// ---- enrolling
let PAE;
await ok('a parent enrols a child in one slot from each group', async () => {
  PAE = await combo([A3, B2], CA);
  const rows = (await db.query(`select e.slot_id, e.price_cents, e.booking_group_id from term_enrolments e where e.combo_id = $1`, [PAE.combo_id])).rows;
  if (rows.length !== 2) throw new Error(`${rows.length} enrolments`);
  if (rows.reduce((s, r) => s + r.price_cents, 0) !== 40000 || PAE.price_cents !== 40000) throw new Error('price ' + PAE.price_cents);
  if (new Set(rows.map((r) => r.booking_group_id)).size !== 1 || rows[0].booking_group_id !== PAE.group_id) throw new Error('not one checkout');
  if (PAE.sessions !== 8 || PAE.status !== 'pending') throw new Error(JSON.stringify(PAE));
  return `8 sessions, ${PAE.price_cents}, status ${PAE.status}`;
});
await ok('retrying the same combination hands back the same unpaid one', async () => {
  const again = await combo([B2, A3], CA);
  if (again.combo_id !== PAE.combo_id || again.group_id !== PAE.group_id) throw new Error('new combo made');
  const n = (await one(`select count(*)::int n from term_enrolments where combo_id = $1`, [PAE.combo_id])).n;
  if (n !== 2) throw new Error(n + ' enrolments');
});
const firstAttempt = PAE;
await ok('choosing a different combination lets the abandoned one go', async () => {
  PAE = await combo([A4, B3], CA);                  // B3 has one place: PA now holds it
  const b = await bookingsOf(firstAttempt.enrolment_ids);
  if (b.n === 0 || b.n !== b.cancelled) throw new Error(JSON.stringify(b));
  if (PAE.status !== 'pending') throw new Error(PAE.status);
});
await ok('the odd cents of an uneven split land on the last slot', async () => {
  await asUser(PD);
  const e = await combo([A2, BS], CD);              // 4 + 3 sessions
  const rows = (await db.query(`select slot_id, price_cents, sessions from term_enrolments where combo_id = $1 order by slot_id`, [e.combo_id])).rows;
  const sum = rows.reduce((s, r) => s + r.price_cents, 0);
  await asUser(null, 'service_role');
  await db.query(`update bookings set status = 'cancelled' where booking_group_id = $1`, [e.group_id]);
  await asUser(PA);
  if (sum !== 40000) throw new Error(`shares add to ${sum}`);
  return rows.map((r) => `${r.sessions} sessions -> ${r.price_cents}`).join(' + ');
});
await pay(PAE.group_id);
await rejects('a child already in the term cannot enrol in a second combination', async () => { await combo([A2, B1], CA); }, 'already enrolled in this term');

// ---- fullness is all or nothing
await asUser(PB);
const PBE = await combo([A1, B1], CB);          // takes A1's one place
await pay(PBE.group_id);
await asUser(PC);
await ok('a full slot stops the whole combination, and nothing is half-booked', async () => {
  try { await combo([A1, B2], CC); } catch (e) {
    if (!e.message.includes('slot is full')) throw e;
    const n = (await one(`select count(*)::int n from term_enrolments where user_id = $1`, [PC])).n;
    const b = (await one(`select count(*)::int n from bookings where user_id = $1`, [PC])).n;
    if (n !== 0 || b !== 0) throw new Error(`${n} enrolments, ${b} bookings left behind`);
    return e.message;
  }
  throw new Error('enrolled');
});

// ---- waiting for a combination
let waitC;
await ok('a family joins the waitlist for a combination: one entry per full slot', async () => {
  waitC = await joinCombo([A1, B2], CC);
  const rows = (await db.query(`select slot_id, combo_slot_ids from term_waitlist where combo_id = $1`, [waitC])).rows;
  if (rows.length !== 1 || rows[0].slot_id !== A1 || rows[0].combo_slot_ids.length !== 2) throw new Error(JSON.stringify(rows));
  const v = (await one(`select count(*)::int n from notifications where type = 'provider_term_waitlist_joined'`)).n;
  if (v !== 1) throw new Error(v + ' vendor messages');
});
await ok('joining again with the same combination is the same entry', async () => {
  const again = await joinCombo([B2, A1], CC);
  if (again !== waitC) throw new Error('new entry');
});
await rejects('a different combination needs the first to be left', async () => { await joinCombo([A1, B4], CC); }, 'different combination');
await asUser(PD);
await rejects('when every slot has a place there is nothing to wait for', async () => { await joinCombo([A2, B2], CD); }, 'Enrol now');
await rejects('the one-slot waitlist is refused in a two-group term', async () => {
  await db.query(`select join_term_waitlist($1, $2)`, [A1, CD]);
}, 'full combination');
await asUser(PC);
await ok('the Bookings tab shows the combination as one card', async () => {
  const rows = (await db.query(`select * from my_term_waitlist()`)).rows;
  if (rows.length !== 1 || rows[0].combo_slot_ids.length !== 2 || rows[0].sessions_left !== 8 || rows[0].price_cents !== 40000) throw new Error(JSON.stringify(rows));
});

// the family holding A1 withdraws: the whole combination goes, and the place opens
await asUser(PB);
await ok('withdrawing cancels the whole combination and offers the free place', async () => {
  await db.query(`select withdraw_from_term($1)`, [PBE.enrolment_ids[0]]);
  const b = await bookingsOf(PBE.enrolment_ids);
  if (b.n !== b.cancelled || b.n === 0) throw new Error(JSON.stringify(b));
  const told = (await one(`select data from notifications where user_id = $1 and type = 'term_waitlist_place_open'`, [PC]));
  if (!told || !told.data.combo_id || told.data.slot_ids.length !== 2) throw new Error(JSON.stringify(told));
  if (!String(told.data.url).includes('term_slots=')) throw new Error(told.data.url);
});

// the waiting family takes the combination: their entry is held, then enrolled
await asUser(PC);
let PCE;
await ok('the waiting family enrols the combination; their entry is held, then enrolled once paid', async () => {
  PCE = await combo([A1, B2], CC);
  const h = (await one(`select status from term_waitlist where combo_id = $1`, [waitC])).status;
  if (h !== 'holding') throw new Error(h);
  await pay(PCE.group_id);
  const e = (await one(`select status from term_waitlist where combo_id = $1`, [waitC])).status;
  if (e !== 'enrolled') throw new Error(e);
});

// ---- told only when EVERY slot has a place
await asUser(PD);
let waitD;
await ok('waiting on two full slots: one entry each', async () => {
  waitD = await joinCombo([A1, B3], CD);        // A1 is held by PC, B3 by PA
  const n = (await one(`select count(*)::int n from term_waitlist where combo_id = $1 and status = 'waiting'`, [waitD])).n;
  if (n !== 2) throw new Error(n + ' entries');
});
await asUser(PC);
await ok('one slot opening is not enough to tell them', async () => {
  await db.query(`select withdraw_from_term($1)`, [PCE.enrolment_ids[0]]);
  if ((await placeOpen(PD)) !== 0) throw new Error('told too early');
});
await asUser(PA);
await ok('they are told once, when the last full slot opens', async () => {
  await db.query(`select withdraw_from_term($1)`, [PAE.enrolment_ids[0]]);
  const n = await placeOpen(PD);
  if (n !== 1) throw new Error(n + ' messages');
});
await asUser(PD);
await ok('leaving the waitlist ends every entry of the combination', async () => {
  const id = (await one(`select id from term_waitlist where combo_id = $1 limit 1`, [waitD])).id;
  await db.query(`select leave_term_waitlist_entry($1)`, [id]);
  const n = (await one(`select count(*)::int n from term_waitlist where combo_id = $1 and status = 'waiting'`, [waitD])).n;
  if (n !== 0) throw new Error(n + ' still waiting');
});

// ---- the vendor swaps a family to another slot of the same group
await asUser(PA);
const SW = await combo([A3, B1], CA);
await pay(SW.group_id);
const eOf = async (slot) => (await one(`select id from term_enrolments where combo_id = $1 and slot_id = $2`, [SW.combo_id, slot])).id;
await rejects('a parent cannot swap a slot', async () => { await db.query(`select vendor_swap_term_slot($1, $2)`, [await eOf(A3), A4]); }, 'not authorized');
await asUser(VENDOR);
await rejects('a swap to another group is refused', async () => { await db.query(`select vendor_swap_term_slot($1, $2)`, [await eOf(A3), B2]); }, 'same group');
await ok('the vendor moves a family from Tue 9:30 to Tue 13:30, with their paid seats', async () => {
  const before = (await one(`select count(*)::int n from bookings where term_enrolment_id = $1 and status = 'confirmed'`, [await eOf(A3)])).n;
  const moved = (await one(`select vendor_swap_term_slot($1, $2) n`, [await eOf(A3), A4])).n;
  const rows = (await db.query(`select distinct s.term_slot_id from bookings b join activity_sessions s on s.id = b.session_id where b.term_enrolment_id = $1 and b.status = 'confirmed'`, [await eOf(A4)])).rows;
  const note = (await one(`select count(*)::int n from notifications where user_id = $1 and type = 'term_slot_changed'`, [PA])).n;
  if (moved !== before || rows.length !== 1 || rows[0].term_slot_id !== A4 || note !== 1) throw new Error(`${moved}/${before} ${JSON.stringify(rows)} ${note}`);
  return `${moved} sessions moved`;
});
await ok('the swapped family now counts against the new slot, not the old', async () => {
  const left = (await one(`select term_slot_free_places($1) n`, [A3])).n;
  const right = (await one(`select term_slot_free_places($1) n`, [A4])).n;
  if (left !== 3 || right !== 2) throw new Error(`A3 ${left}, A4 ${right}`);
});
await asUser(PD);
const DE = await combo([A1, B2], CD);            // Mon 9:30 + Thu 13:30
await asUser(VENDOR);
await rejects('a swap to a slot that clashes with the rest of their combination is refused', async () => {
  const e2 = (await one(`select id from term_enrolments where combo_id = $1 and slot_id = $2`, [DE.combo_id, B2])).id;
  await db.query(`select vendor_swap_term_slot($1, $2)`, [e2, BX]);      // BX is Monday 9:30, like A1
}, 'same time');
await asUser(PB);
await combo([A2, B3], CB);                       // takes B3's one place
await asUser(VENDOR);
await rejects('a swap into a full slot is refused', async () => {
  await db.query(`select vendor_swap_term_slot($1, $2)`, [await eOf(B1), B3]);
}, 'is full');

// ---- the vendor withdrawing a family takes the whole combination too
await ok('the vendor withdrawing one slot of a combination withdraws all of it', async () => {
  const n = (await one(`select vendor_withdraw_from_term($1, 'refund', 'test') n`, [DE.enrolment_ids[0]])).n;
  const b = await bookingsOf(DE.enrolment_ids);
  if (b.n !== b.cancelled || n === 0) throw new Error(JSON.stringify(b));
});

// ---- the mid-term reduction counts sessions run in every chosen slot
await db.query(`update terms set reduce_enabled = true, reduce_by_cents = 1000 where id = $1`, [T]);
await asUser(null, 'service_role');
await db.query(`update activity_sessions set starts_at = now() - interval '1 day', ends_at = now() - interval '1 day' + interval '45 minutes' where id = (select id from activity_sessions where term_slot_id = $1 order by starts_at limit 1)`, [B4]);
await db.query(`update activity_sessions set starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '45 minutes' where id = (select id from activity_sessions where term_slot_id = $1 order by starts_at limit 1)`, [A2]);
await asUser(PD);
await ok('two sessions already run (one in each slot) take $20 off the combination', async () => {
  const q = await one(`select * from term_combo_quote($1::uuid[])`, [[A2, B4]]);
  if (q.sessions_passed !== 2 || q.price_cents !== 38000) throw new Error(JSON.stringify(q));
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
