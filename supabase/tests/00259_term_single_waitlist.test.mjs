/**
 * Behaviour tests for 00259_term_single_waitlist.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00259_term_single_waitlist.test.mjs
 *
 * Loads 00256 (terms) and then 00259 over small stand-ins for the tables and
 * functions they lean on: the capacity and defaults triggers, book_party,
 * claim_waitlist_seats (00197), notifications, and the two 00257 pieces the
 * booking gate reads (the re-enrolment priority columns). It checks the trial /
 * single waitlist rules themselves. It is not a substitute for running the real
 * migration chain on the test database before it ships.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TERMS = fileURLToPath(new URL('../migrations/00256_term_enrolment.sql', import.meta.url));
const MIGRATION = fileURLToPath(new URL('../migrations/00259_term_single_waitlist.sql', import.meta.url));
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
  wix_service_id text, wix_event_id text, wix_series_id text, wix_service_type text);

create table public.activity_sessions (
  id uuid primary key default gen_random_uuid(), activity_id uuid references public.activities(id),
  starts_at timestamptz not null, ends_at timestamptz not null, capacity int, price numeric,
  location_id uuid, status text default 'scheduled', booking_cutoff_minutes int);
create table public.bookings (
  id uuid primary key default gen_random_uuid(), user_id uuid, session_id uuid references public.activity_sessions(id),
  child_id uuid, status text default 'pending', payment_status text default 'none', amount numeric,
  package_purchase_id uuid, booking_group_id uuid, policies_accepted uuid[], medical_disclosure text,
  info_response text, guest_name text, waitlist_position int, pending_since timestamptz,
  waitlist_pay_invited boolean not null default false, cancel_refund_mode text,
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
begin
  update public.activity_sessions set status = 'cancelled' where id = p_session_id;
  return 0;
end $$;

-- 00197, verbatim in substance.
create function public.claim_waitlist_seats(p_seat_ids uuid[]) returns void language plpgsql security definer as $$
declare v_session uuid; v_cap int; v_taken int; r record;
begin
  select b.session_id into v_session from public.bookings b where b.id = p_seat_ids[1];
  if v_session is null then raise exception 'Booking not found'; end if;
  perform 1 from public.activity_sessions s where s.id = v_session for update;
  select s.capacity into v_cap from public.activity_sessions s where s.id = v_session;
  select count(*) into v_taken from public.bookings b where b.session_id = v_session and b.status in ('pending', 'confirmed');
  for r in select b.id, b.waitlist_pay_invited from public.bookings b
           where b.id = any(p_seat_ids) and b.status = 'waitlisted' order by b.waitlist_position nulls last, b.created_at
  loop
    if v_cap is null or v_taken < v_cap or r.waitlist_pay_invited then
      update public.bookings set status = 'pending', pending_since = now() where id = r.id;
      v_taken := v_taken + 1;
    else
      raise exception 'That spot has been taken — you''re still on the waitlist.';
    end if;
  end loop;
end $$;
`;

// The 00257 pieces the booking gate reads.
const stub257 = `
alter table public.terms
  add column if not exists previous_term_id uuid references public.terms (id) on delete set null,
  add column if not exists priority_until timestamptz;
create or replace function public.term_has_returning_family(p_prev_term uuid, p_user uuid) returns boolean
  language sql stable as $$ select false $$;
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
const book = async (session, kind, child) =>
  one(`select * from book_term_class($1, $2, $3)`, [session, kind, child]);
const seat = async (session, child) =>
  one(`select id, status, waitlist_position, pending_since from bookings where session_id = $1 and child_id = $2 and status <> 'cancelled'`, [session, child]);

await db.exec(stub);
await ok('00256 applies', async () => { await db.exec(readFileSync(TERMS, 'utf8')); await db.exec(stub257); });
await ok('00259 applies', async () => { await db.exec(readFileSync(MIGRATION, 'utf8')); });
await ok('00259 is idempotent (second run)', async () => { await db.exec(readFileSync(MIGRATION, 'utf8')); });

// --- fixtures
const P = (await one(`insert into providers default values returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const PA = '22222222-2222-2222-2222-222222222222';
const PB = '33333333-3333-3333-3333-333333333333';
const PC = '44444444-4444-4444-4444-444444444444';
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
await db.query(`insert into parent_profiles (id) values ($1), ($2), ($3)`, [PA, PB, PC]);
const CA = (await one(`insert into children (parent_id, name) values ($1, 'Ava') returning id`, [PA])).id;
const CB = (await one(`insert into children (parent_id, name) values ($1, 'Ben') returning id`, [PB])).id;
const CC = (await one(`insert into children (parent_id, name) values ($1, 'Cal') returning id`, [PC])).id;
const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
await db.query(`update activities set terms_enabled = true where id = $1`, [A]);
// An ordinary class next to it, one place.
const O = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Music', 'music', 30) returning id`, [P])).id;
const O1 = (await one(
  `insert into activity_sessions (activity_id, starts_at, ends_at, capacity) values ($1, now() + interval '5 days', now() + interval '5 days 1 hour', 1) returning id`, [O])).id;

const startDate = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const pattern = { days: [6], time: '09:00', duration: 45, start: startDate, weeks: 4, skip: [], perDay: false, dayTimes: {} };
await asUser(VENDOR);
const T = (await one(
  `insert into terms (provider_id, activity_id, name, price_cents, allow_singles, single_price_cents, allow_trial, trial_price_cents, trial_limit)
   values ($1, $2, 'Term 4', 40000, true, 5000, true, 2000, 1) returning id`, [P, A])).id;
// Two places a session, one of them for a single or trial booking.
const S = (await one(`insert into term_slots (term_id, capacity, single_cap, pattern) values ($1, 2, 1, $2) returning id`, [T, JSON.stringify(pattern)])).id;
await one(`select publish_term($1) as n`, [T]);
const [X, Y, Z] = (await db.query(`select id from activity_sessions where term_slot_id = $1 order by term_session_no limit 3`, [S])).rows.map((r) => r.id);

// --- 1. single places used up -> waitlist, not an error
await asUser(PA);
await ok('a trial takes the one single place', async () => {
  const r = await book(X, 'trial', CA);
  if (r.status !== 'pending') throw new Error(JSON.stringify(r));
});
await asUser(PB);
await ok('single places used up: the next trial joins the waitlist', async () => {
  const r = await book(X, 'trial', CB);
  const s = await seat(X, CB);
  if (r.status !== 'waitlisted' || s.status !== 'waitlisted' || s.waitlist_position !== 1) throw new Error(JSON.stringify({ r, s }));
  return `status ${r.status}, position ${s.waitlist_position}, seat still free on the session`;
});
await rejects('the same child cannot join the same waitlist twice', async () => { await book(X, 'trial', CB); }, 'already on the waitlist');
await ok('term_single_places_full: true here, false for an ordinary class', async () => {
  const r = await one(`select term_single_places_full($1) a, term_single_places_full($2) b`, [X, O1]);
  if (!(r.a === true && r.b === false)) throw new Error(JSON.stringify(r));
});

// --- 2. a free seat but no single place: single / trial waiters are not told
await ok('a free seat with the single places used up tells nobody', async () => {
  await db.query(`select notify_waitlist_all_open($1)`, [X]);
  const n = (await one(`select count(*)::int n from notifications where user_id = $1`, [PB])).n;
  if (n !== 0) throw new Error(`${n} notifications`);
});
await asUser(VENDOR);
await ok('raising the single places tells them, with a trial-mode link', async () => {
  await db.query(`update term_slots set single_cap = 2 where id = $1`, [S]);
  const n = await one(`select type, data->>'url' url from notifications where user_id = $1`, [PB]);
  if (!n || n.type !== 'waitlist_available' || n.url !== `/book?slug=swim&session=${X}&mode=trial`) throw new Error(JSON.stringify(n));
  return n.url;
});

// --- 3. "Pay now": claim_term_waitlist_seats
await asUser(null, 'service_role');
await ok('claim holds the seat (pending, hold started)', async () => {
  const s = await seat(X, CB);
  await db.query(`select claim_term_waitlist_seats($1)`, [[s.id]]);
  const after = await seat(X, CB);
  if (after.status !== 'pending' || !after.pending_since) throw new Error(JSON.stringify(after));
});

// Cal waits for a trial on the (now full) X, then uses a trial on Y.
await asUser(PC);
await ok('a full session still takes a trial waiter', async () => {
  const r = await book(X, 'trial', CC);
  if (r.status !== 'waitlisted') throw new Error(JSON.stringify(r));
});
await ok('Cal uses a trial on another date', async () => {
  const r = await book(Y, 'trial', CC);
  if (r.status !== 'pending') throw new Error(JSON.stringify(r));
  await db.query(`update bookings set status = 'confirmed' where session_id = $1 and child_id = $2`, [Y, CC]);
});
await asUser(PA);
await db.query(`update bookings set status = 'cancelled' where session_id = $1 and child_id = $2`, [X, CA]);
await asUser(null, 'service_role');
await rejects('claim refuses a trial once the child has used theirs', async () => {
  const s = await seat(X, CC);
  await db.query(`select claim_term_waitlist_seats($1)`, [[s.id]]);
}, 'already used their trial');

// Single places used up while a seat is free: claim is refused before payment.
await asUser(VENDOR);
await db.query(`update term_slots set single_cap = 1 where id = $1`, [S]);
await asUser(PB);
await ok('Ben (trial used) books a single on Z', async () => {
  const r = await book(Z, 'single', CB);
  if (r.status !== 'pending') throw new Error(JSON.stringify(r));
});
await asUser(PA);
await ok('Ava waits for a trial on Z (single places used up)', async () => {
  const r = await book(Z, 'trial', CA);
  if (r.status !== 'waitlisted') throw new Error(JSON.stringify(r));
});
await asUser(null, 'service_role');
await rejects('claim is refused while the single places are used up', async () => {
  const s = await seat(Z, CA);
  await db.query(`select claim_term_waitlist_seats($1)`, [[s.id]]);
}, 'taken');
await ok('a vendor offer (Promote) skips the single-place check', async () => {
  const s = await seat(Z, CA);
  await db.query(`update bookings set waitlist_pay_invited = true where id = $1`, [s.id]);
  await db.query(`select claim_term_waitlist_seats($1)`, [[s.id]]);
  const after = await seat(Z, CA);
  if (after.status !== 'pending') throw new Error(JSON.stringify(after));
});

// --- 4. leaving a term session's waitlist
await db.query(`update activities set allow_cancellation = false where id = $1`, [A]);
await asUser(PB);
await rejects("a parent cannot leave someone else's waitlist place", async () => {
  const s = await seat(X, CC);
  await db.query(`select leave_term_waitlist($1)`, [s.id]);
}, "can't be left online");
await asUser(PC);
await ok('leaving works with cancellations switched off', async () => {
  const s = await seat(X, CC);
  const r = await one(`select leave_term_waitlist($1) n`, [s.id]);
  const after = (await one(`select status from bookings where id = $1`, [s.id])).status;
  if (r.n !== 1 || after !== 'cancelled') throw new Error(JSON.stringify({ r, after }));
});
await asUser(PB);
await rejects('a held (not waitlisted) place cannot be left this way', async () => {
  const s = await seat(X, CB);
  await db.query(`select leave_term_waitlist($1)`, [s.id]);
}, "can't be left online");

// --- 5. ordinary classes are unchanged
await asUser(PA);
await db.query(`insert into bookings (user_id, session_id, child_id) values ($1, $2, $3)`, [PA, O1, CA]);
await asUser(PB);
await db.query(`insert into bookings (user_id, session_id, child_id) values ($1, $2, $3)`, [PB, O1, CB]);
await ok('an ordinary waitlist link has no mode', async () => {
  const s = await seat(O1, CB);
  if (s.status !== 'waitlisted') throw new Error(JSON.stringify(s));
  await db.query(`select notify_waitlist_spot_open($1)`, [s.id]);
  const n = await one(`select data->>'url' url from notifications where user_id = $1 and data->>'session_id' = $2`, [PB, O1]);
  if (n.url !== `/book?slug=music&session=${O1}`) throw new Error(n.url);
  return n.url;
});
await ok('an ordinary class: a freed seat tells its waiters as before', async () => {
  await db.query(`update bookings set status = 'cancelled' where session_id = $1 and child_id = $2`, [O1, CA]);
  await db.query(`delete from notifications`);
  await db.query(`select notify_waitlist_all_open($1)`, [O1]);
  const n = (await one(`select count(*)::int n from notifications where user_id = $1`, [PB])).n;
  if (n !== 1) throw new Error(`${n} notifications`);
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
