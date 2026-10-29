/**
 * Behaviour tests for 00260_term_place_waitlist.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00260_term_place_waitlist.test.mjs
 *
 * Loads 00256 (terms), the 00257 pieces it builds on, 00259 and 00260 over small
 * stand-ins for the booking triggers and tables they lean on. "Paying" is a
 * direct update to confirmed/paid, as the Stripe webhook does. It is not a
 * substitute for running the real migration chain on the test database.
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

create table public.providers (id uuid primary key default gen_random_uuid());
create table public.provider_members (user_id uuid, provider_id uuid, role text default 'owner', status text default 'active');
create table public.parent_profiles (id uuid primary key);
create table public.children (id uuid primary key default gen_random_uuid(), parent_id uuid references public.parent_profiles(id), name text);
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
await ok('00256 + 00257 pieces + 00259 apply', async () => {
  await db.exec(file('00256_term_enrolment.sql'));
  await db.exec(stub257);
  await db.exec(file('00259_term_single_waitlist.sql'));
});
await ok('00260 applies', async () => { await db.exec(file('00260_term_place_waitlist.sql')); });
await ok('00260 is idempotent (second run)', async () => { await db.exec(file('00260_term_place_waitlist.sql')); });

// --- fixtures: one place per session, so one family fills the term
const P = (await one(`insert into providers default values returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const [PA, PB, PC, PD] = ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555'];
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
await db.query(`insert into parent_profiles (id) values ($1), ($2), ($3), ($4)`, [PA, PB, PC, PD]);
const kid = async (parent, name) => (await one(`insert into children (parent_id, name) values ($1, $2) returning id`, [parent, name])).id;
const [CA, CB, CC, CD] = [await kid(PA, 'Ava'), await kid(PB, 'Ben'), await kid(PC, 'Cal'), await kid(PD, 'Dee')];
const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
await db.query(`update activities set terms_enabled = true where id = $1`, [A]);
const startDate = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const pattern = (days) => JSON.stringify({ days, time: '09:00', duration: 45, start: startDate, weeks: 4, skip: [], perDay: false, dayTimes: {} });
await asUser(VENDOR);
const T = (await one(
  `insert into terms (provider_id, activity_id, name, price_cents, reduce_enabled, reduce_by_cents, allow_singles, single_price_cents)
   values ($1, $2, 'Term 4', 40000, true, 4000, true, 5000) returning id`, [P, A])).id;
const S = (await one(`insert into term_slots (term_id, position, capacity, pattern) values ($1, 0, 1, $2) returning id`, [T, pattern([6])])).id;
const S2 = (await one(`insert into term_slots (term_id, position, capacity, pattern) values ($1, 1, 5, $2) returning id`, [T, pattern([0])])).id;
await one(`select publish_term($1) as n`, [T]);

// --- 1. a full slot, and joining its waitlist
await asUser(PA);
const AE = await enrol(S, CA);
await pay(AE.group_id);
await ok('the slot is full: no term places free', async () => {
  const n = (await one(`select term_slot_free_places($1) n`, [S])).n;
  if (n !== 0) throw new Error(`free ${n}`);
});
await asUser(PB);
let BW;
await ok('joining a full slot puts the child on its waitlist', async () => {
  BW = await join(S, CB);
  const e = await entry(BW);
  if (e.status !== 'waiting' || e.position !== 1) throw new Error(JSON.stringify(e));
  const n = await one(`select type, data->>'term_name' t from notifications where user_id = $1`, [PB]);
  if (n?.type !== 'term_waitlist_joined' || n.t !== 'Term 4') throw new Error(JSON.stringify(n));
});
await ok('joining again returns the same entry', async () => {
  if ((await join(S, CB)) !== BW) throw new Error('second entry');
});
await asUser(PC);
const CW = await join(S, CC);
await asUser(PB);
await rejects('a waiting family enrolling into a full slot stays listed', async () => { await enrol(S, CB); }, "still on the waitlist");
await asUser(PD);
await rejects('anyone else gets the ordinary "full" message', async () => { await enrol(S, CD); }, 'This slot is full');

// --- 2. a whole place frees: a withdrawal tells everyone waiting, once each
await asUser(PA);
await ok('a withdrawal tells every waiting family, with a link to the slot', async () => {
  await db.query(`select withdraw_from_term($1)`, [AE.enrolment_id]);
  const n = await one(`select data->>'url' url, body from notifications where user_id = $1 and type = 'term_waitlist_place_open'`, [PB]);
  if (!n || !n.url.includes(`term_slot=${S}`) || !n.url.includes('mode=term') || !n.url.includes(`child=${CB}`)) throw new Error(JSON.stringify(n));
  if ((await placeOpen(PC)) !== 1) throw new Error('Cal not told');
  return n.body;
});
await asUser(PD);
await rejects('a new family cannot join while a place is free', async () => { await join(S, CD); }, 'A place is free');

// --- 3. first to enrol holds it; the hold lapses; the next family takes it
await asUser(PB);
let BE;
await ok('the first waiting family to enrol holds the place', async () => {
  BE = await enrol(S, CB);
  const e = await entry(BW);
  if (e.status !== 'holding' || e.hold_enrolment_id !== BE.enrolment_id) throw new Error(JSON.stringify(e));
  return `${BE.sessions} sessions, ${BE.price_cents} cents`;
});
await asUser(PC);
await rejects('the second family is told it has gone, still waiting', async () => { await enrol(S, CC); }, "still on the waitlist");
await ok('an unpaid hold that lapses goes back to waiting and the place is offered again', async () => {
  await db.query(`update bookings set status = 'cancelled' where booking_group_id = $1 and status = 'pending'`, [BE.group_id]);
  const e = await entry(BW);
  if (e.status !== 'waiting' || e.hold_enrolment_id !== null) throw new Error(JSON.stringify(e));
  if ((await placeOpen(PC)) !== 2) throw new Error(`Cal told ${await placeOpen(PC)} times`);
});
let CE;
await ok('paying turns a hold into an enrolment', async () => {
  CE = await enrol(S, CC);
  await pay(CE.group_id);
  const e = await entry(CW);
  if (e.status !== 'enrolled') throw new Error(JSON.stringify(e));
});

// --- 4. decision 2: one session's seat is not a term place
await ok('a seat freeing on one session does not tell term waiters', async () => {
  const before = await placeOpen(PB);
  const seat = (await one(`select id from bookings where booking_group_id = $1 order by created_at limit 1`, [CE.group_id])).id;
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [seat]);
  if ((await placeOpen(PB)) !== before) throw new Error('Ben was told');
});

// --- 5. a bigger slot is a whole new place
await asUser(VENDOR);
await ok('raising the slot capacity tells everyone waiting', async () => {
  const before = await placeOpen(PB);
  await db.query(`update term_slots set capacity = 2 where id = $1`, [S]);
  if ((await placeOpen(PB)) !== before + 1) throw new Error('Ben not told');
});

// --- 6. leaving
await asUser(PB);
await ok('a parent can leave the waitlist', async () => {
  await db.query(`select leave_term_waitlist_entry($1)`, [BW]);
  if ((await entry(BW)).status !== 'left') throw new Error('not left');
});
await rejects('leaving twice is refused', async () => { await db.query(`select leave_term_waitlist_entry($1)`, [BW]); }, 'no longer on this waitlist');
await asUser(PC);
await rejects("a parent cannot leave someone else's entry", async () => {
  await db.query(`select leave_term_waitlist_entry($1)`, [BW]);
}, 'no longer on this waitlist');

// --- 7. no double booking: a session the child already holds is left out
await asUser(PD);
await ok('enrolling skips a session the child already booked as a single, and charges for the rest', async () => {
  const second = (await one(`select id from activity_sessions where term_slot_id = $1 order by term_session_no offset 1 limit 1`, [S2])).id;
  const r = await one(`select * from book_term_class($1, 'single', $2)`, [second, CD]);
  if (r.status !== 'pending') throw new Error(JSON.stringify(r));
  const e = await enrol(S2, CD);
  const n = await one(`select count(*)::int seats, count(distinct session_id)::int sessions from bookings where term_enrolment_id = $1`, [e.enrolment_id]);
  const dup = (await one(`select count(*)::int n from bookings where session_id = $1 and child_id = $2 and status <> 'cancelled'`, [second, CD])).n;
  if (!(e.sessions === 4 && n.seats === 3 && dup === 1)) throw new Error(JSON.stringify({ e, n, dup }));
  return `enrolment counts ${e.sessions} sessions, holds ${n.seats} seats, the single stays`;
});

// --- 8. the parent's list
await asUser(PB);
await ok("my_term_waitlist shows a live entry, the place count, and a child enrolled in another group", async () => {
  // Ben gets into the Sunday group, Dee takes the Saturday group's spare
  // place, and Ben waits for Saturday.
  await db.query(`select enrol_in_term($1, $2)`, [S2, CB]);
  await asUser(PD);
  await db.query(`select enrol_in_term($1, $2)`, [S, CD]);
  await asUser(PB);
  const id = await join(S, CB);
  const r = await one(`select * from my_term_waitlist() where id = $1`, [id]);
  if (!(r && r.status === 'waiting' && r.free_places === 0 && r.enrolled_elsewhere === true && r.term_name === 'Term 4')) throw new Error(JSON.stringify(r));
  return `free ${r.free_places}, enrolled elsewhere ${r.enrolled_elsewhere}, ${r.sessions_left} sessions, ${r.price_cents} cents`;
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
