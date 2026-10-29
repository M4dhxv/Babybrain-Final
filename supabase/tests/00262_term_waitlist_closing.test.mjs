/**
 * Behaviour tests for 00262_term_waitlist_closing.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00262_term_waitlist_closing.test.mjs
 *
 * Loads 00256, the 00257 pieces it builds on, and 00259-00262 over the
 * same stand-ins as the 00260 tests. "Paying" is a direct update to
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
await ok('00256 + 00257 pieces + 00259 + 00260 + 00261 apply', async () => {
  await db.exec(file('00256_term_enrolment.sql'));
  await db.exec(stub257);
  await db.exec(file('00259_term_single_waitlist.sql'));
  await db.exec(file('00260_term_place_waitlist.sql'));
  await db.exec(file('00261_term_waitlist_vendor.sql'));
});
await ok('00262 applies', async () => { await db.exec(file('00262_term_waitlist_closing.sql')); });
await ok('00262 is idempotent (second run)', async () => { await db.exec(file('00262_term_waitlist_closing.sql')); });

const P = (await one(`insert into providers (business_name) values ('Little Fish Swim') returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const PARENTS = ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
  '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666'];
const [PA, PB, PC, PD, PE] = PARENTS;
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
for (const id of PARENTS) await db.query(`insert into parent_profiles (id) values ($1)`, [id]);
const kid = async (parent, name) => (await one(`insert into children (parent_id, name) values ($1, $2) returning id`, [parent, name])).id;
const [CA, CB, CC, CD, CE] = [await kid(PA, 'Ava'), await kid(PB, 'Ben'), await kid(PC, 'Cal'), await kid(PD, 'Dee'), await kid(PE, 'Eli')];
const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
await db.query(`update activities set terms_enabled = true where id = $1`, [A]);
const startDate = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const pattern = (days) => JSON.stringify({ days, time: '09:00', duration: 45, start: startDate, weeks: 4, skip: [], perDay: false, dayTimes: {} });
const notes = async (user, type) => (await one(`select count(*)::int n from notifications where user_id = $1 and type = $2`, [user, type])).n;
const sweep = async () => { await asUser(null, 'service_role'); await db.query(`select close_term_waitlists()`); };

// Term 4: one place a session, joining closes with 3 sessions left, singles on.
await asUser(VENDOR);
const T = (await one(
  `insert into terms (provider_id, activity_id, name, price_cents, min_left, allow_singles, single_price_cents)
   values ($1, $2, 'Term 4', 40000, 3, true, 5000) returning id`, [P, A])).id;
const S = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 1, $2) returning id`, [T, pattern([6])])).id;
await one(`select publish_term($1) as n`, [T]);
const sessions = (await db.query(`select id from activity_sessions where term_slot_id = $1 order by starts_at`, [S])).rows.map((r) => r.id);

await asUser(PA);
await pay((await enrol(S, CA)).group_id);
await asUser(PB);
const BW = await join(S, CB);

// --- 1. the term stays open: nothing closes
await ok('a sweep while the term is open closes nothing', async () => {
  await sweep();
  if ((await entry(BW)).status !== 'waiting' || (await notes(PB, 'term_waitlist_closed')) !== 0) throw new Error('closed early');
});

// --- 2. single waits: a single on session 3 (full), and one on session 4
await asUser(PC);
await ok('Cal waits for a single on session 3', async () => {
  const r = await one(`select * from book_term_class($1, 'single', $2)`, [sessions[2], CC]);
  if (r.status !== 'waitlisted') throw new Error(JSON.stringify(r));
});
await asUser(PD);
await one(`select * from book_term_class($1, 'single', $2)`, [sessions[3], CD]);
await ok("a single wait closes once its session's booking window shuts", async () => {
  await asUser(null, 'service_role');
  await db.query(`update activity_sessions set starts_at = now() + interval '10 minutes', ends_at = now() + interval '55 minutes' where id = $1`, [sessions[2]]);
  await sweep();
  const s = (await one(`select status from bookings where session_id = $1 and child_id = $2`, [sessions[2], CC])).status;
  if (s !== 'cancelled' || (await notes(PC, 'term_session_waitlist_closed')) !== 1) throw new Error(s);
});
await ok('switching singles off closes the remaining single waits', async () => {
  await db.query(`update terms set allow_singles = false where id = $1`, [T]);
  await sweep();
  const s = (await one(`select status from bookings where session_id = $1 and child_id = $2`, [sessions[3], CD])).status;
  if (s !== 'cancelled' || (await notes(PD, 'term_session_waitlist_closed')) !== 1) throw new Error(s);
  await db.query(`update terms set allow_singles = true where id = $1`, [T]);
});

// --- 3. decision 4: too few sessions left for new families
await ok('once the term closes to new families, the waiting family is told and their entry closes', async () => {
  // Session 3's booking window has shut (above), so it counts as run: 3 left,
  // and joining stays open down to 3 (min_left).
  await sweep();
  if ((await entry(BW)).status !== 'waiting') throw new Error('closed with 3 left');
  // Session 1 runs too: 2 left, closed to new families.
  await asUser(null, 'service_role');
  await db.query(`update activity_sessions set starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '45 minutes' where id = $1`, [sessions[0]]);
  await sweep();
  const n = await one(`select body, data->>'url' url from notifications where user_id = $1 and type = 'term_waitlist_closed'`, [PB]);
  if ((await entry(BW)).status !== 'closed' || !n?.body.includes('single sessions') || !n.url.includes('mode=single')) throw new Error(JSON.stringify(n));
  return n.body;
});
await ok('a second sweep tells nobody twice', async () => {
  await sweep();
  if ((await notes(PB, 'term_waitlist_closed')) !== 1) throw new Error('told twice');
});

// --- 4. an archived term closes its waitlist too
await asUser(VENDOR);
const T2 = (await one(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'Holiday camp', 20000) returning id`, [P, A])).id;
const S2 = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 1, $2) returning id`, [T2, pattern([0])])).id;
await one(`select publish_term($1) as n`, [T2]);
await asUser(PA);
await pay((await enrol(S2, CA)).group_id);
await asUser(PE);
const EW = await join(S2, CE);
await ok('an archived term closes its waitlist', async () => {
  await asUser(null, 'service_role');
  await db.query(`update terms set status = 'archived' where id = $1`, [T2]);
  await sweep();
  if ((await entry(EW)).status !== 'closed' || (await notes(PE, 'term_waitlist_closed')) !== 1) throw new Error('not closed');
});

// --- 5. decision 6: the next term opens to everyone
await asUser(VENDOR);
const T3 = (await one(
  `insert into terms (provider_id, activity_id, name, price_cents, previous_term_id) values ($1, $2, 'Term 5', 40000, $3) returning id`, [P, A, T])).id;
await db.query(`insert into term_slots (term_id, capacity, pattern) values ($1, 5, $2)`, [T3, pattern([6])]);
await one(`select publish_term($1) as n`, [T3]);
await ok('during the priority window, nobody waiting is told yet', async () => {
  await asUser(null, 'service_role');
  await db.query(`update terms set priority_until = now() + interval '3 days' where id = $1`, [T3]);
  await sweep();
  if ((await notes(PB, 'term_next_open')) !== 0) throw new Error('told too early');
});
await ok('when it opens to everyone, the earlier term\'s waiting family is told once', async () => {
  await db.query(`update terms set priority_until = now() - interval '1 minute' where id = $1`, [T3]);
  await sweep();
  await sweep();
  const n = await one(`select title, data->>'url' url from notifications where user_id = $1 and type = 'term_next_open'`, [PB]);
  if ((await notes(PB, 'term_next_open')) !== 1 || !n.url.includes('mode=term')) throw new Error(JSON.stringify(n));
  if ((await notes(PA, 'term_next_open')) !== 0) throw new Error('an enrolled family was told');
  return n.title;
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
