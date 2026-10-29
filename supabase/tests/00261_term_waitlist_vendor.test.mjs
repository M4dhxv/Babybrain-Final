/**
 * Behaviour tests for 00261_term_waitlist_vendor.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00261_term_waitlist_vendor.test.mjs
 *
 * Loads 00256, the 00257 pieces it builds on, 00259, 00260 and 00261 over the
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
await ok('00256 + 00257 pieces + 00259 + 00260 apply', async () => {
  await db.exec(file('00256_term_enrolment.sql'));
  await db.exec(stub257);
  await db.exec(file('00259_term_single_waitlist.sql'));
  await db.exec(file('00260_term_place_waitlist.sql'));
});
await ok('00261 applies', async () => { await db.exec(file('00261_term_waitlist_vendor.sql')); });
await ok('00261 is idempotent (second run)', async () => { await db.exec(file('00261_term_waitlist_vendor.sql')); });

const P = (await one(`insert into providers (business_name) values ('Little Fish Swim') returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const [PA, PB, PC] = ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'];
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
await db.query(`insert into parent_profiles (id, full_name, email) values ($1, 'Pat A', 'a@example.com'), ($2, 'Pat B', 'b@example.com'), ($3, 'Pat C', 'c@example.com')`, [PA, PB, PC]);
const kid = async (parent, name) => (await one(`insert into children (parent_id, name, date_of_birth) values ($1, $2, '2024-05-01') returning id`, [parent, name])).id;
const [CA, CB, CB2, CC] = [await kid(PA, 'Ava'), await kid(PB, 'Ben'), await kid(PB, 'Bea'), await kid(PC, 'Cal')];
const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
await db.query(`update activities set terms_enabled = true where id = $1`, [A]);
const startDate = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const pattern = JSON.stringify({ days: [6], time: '09:00', duration: 45, start: startDate, weeks: 4, skip: [], perDay: false, dayTimes: {} });
await asUser(VENDOR);
const T = (await one(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'Term 4', 40000) returning id`, [P, A])).id;
const S = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 1, $2) returning id`, [T, pattern])).id;
await one(`select publish_term($1) as n`, [T]);
const capacities = async () => (await db.query(`select capacity from activity_sessions where term_slot_id = $1 order by starts_at`, [S])).rows.map((r) => r.capacity).join(',');
const notes = async (user, type) => (await one(`select count(*)::int n from notifications where user_id = $1 and type = $2`, [user, type])).n;

await asUser(PA);
await pay((await enrol(S, CA)).group_id);

// --- 1. the vendor hears when a family joins, once per family
await asUser(PB);
const BW = await join(S, CB);
await join(S, CB2);
await asUser(PC);
const CW = await join(S, CC);
await ok('the vendor is told once per family that joins', async () => {
  const n = await notes(VENDOR, 'provider_term_waitlist_joined');
  if (n !== 2) throw new Error(`${n} notifications`);
});

// --- 2. what the vendor sees
await asUser(VENDOR);
await ok('counts: 3 waiting, no place free', async () => {
  const r = await one(`select * from term_waitlist_counts($1)`, [T]);
  if (!(r.waiting === 3 && r.free_places === 0)) throw new Error(JSON.stringify(r));
});
await ok('roster lists each waiting child with the parent', async () => {
  const rows = (await db.query(`select * from term_waitlist_roster($1)`, [T])).rows;
  const ben = rows.find((r) => r.id === BW);
  if (!(rows.length === 3 && ben.kind === 'term' && ben.status === 'waiting' && ben.parent_email === 'b@example.com')) throw new Error(JSON.stringify(rows));
});
await asUser(PB);
await rejects('a parent cannot read the roster', async () => { await db.query(`select * from term_waitlist_roster($1)`, [T]); }, 'not authorized');
await rejects('a parent cannot make offers', async () => { await db.query(`select vendor_offer_term_place($1)`, [CW]); }, 'not authorized');

// --- 3. a personal offer, over capacity
await asUser(VENDOR);
await ok('the vendor offers Ben a place; the family gets a link that says so', async () => {
  await db.query(`select vendor_offer_term_place($1)`, [BW]);
  const n = await one(`select title, data->>'url' url from notifications where user_id = $1 and type = 'term_waitlist_offer'`, [PB]);
  if (!n || !n.url.includes('offered=1') || !n.title.startsWith('Little Fish Swim')) throw new Error(JSON.stringify(n));
  return n.title;
});
await asUser(PB);
let BE;
await ok('Ben enrols over capacity: every session grows by one', async () => {
  BE = await enrol(S, CB);
  const caps = await capacities();
  if (BE.status !== 'pending' || caps !== '2,2,2,2') throw new Error(`${BE.status} ${caps}`);
  if ((await entry(BW)).status !== 'holding') throw new Error('not holding');
});
await asUser(PC);
await rejects('Cal, not offered, still cannot get in', async () => { await enrol(S, CC); }, 'still on the waitlist');
await ok("Ben's unpaid hold lapses: the extra seats go back, nobody else is told", async () => {
  const before = await placeOpen(PC);
  await db.query(`update bookings set status = 'cancelled' where booking_group_id = $1 and status = 'pending'`, [BE.group_id]);
  const caps = await capacities();
  if (caps !== '1,1,1,1') throw new Error(caps);
  if ((await entry(BW)).status !== 'waiting') throw new Error('not waiting');
  if ((await placeOpen(PC)) !== before) throw new Error('Cal was told');
});
await asUser(PB);
await ok('Ben enrols again on the offer and pays', async () => {
  BE = await enrol(S, CB);
  await pay(BE.group_id);
  if ((await entry(BW)).status !== 'enrolled' || (await capacities()) !== '2,2,2,2') throw new Error('not enrolled');
});

// --- 4. telling everyone about a place nobody announced
await asUser(VENDOR);
await rejects('"tell everyone" needs a free place', async () => { await db.query(`select vendor_tell_term_waitlist($1)`, [S]); }, 'no free place');
await ok('a place opened by hand is announced when the vendor asks', async () => {
  await db.query(`update activity_sessions set capacity = 3 where term_slot_id = $1`, [S]);
  const before = await placeOpen(PC);
  const n = (await one(`select vendor_tell_term_waitlist($1) n`, [S])).n;
  if (n !== 2 || (await placeOpen(PC)) !== before + 1) throw new Error(`told ${n}`);
  return `${n} families told`;
});

// --- 5. removing a family
await ok('removing Cal tells the family, with the reason', async () => {
  await db.query(`select vendor_remove_from_term_waitlist($1, 'This group is for older children.')`, [CW]);
  const n = await one(`select body from notifications where user_id = $1 and type = 'term_waitlist_removed'`, [PC]);
  if ((await entry(CW)).status !== 'removed' || !n?.body.includes('older children')) throw new Error(JSON.stringify(n));
  return n.body;
});

// --- 6. the parent's card
await asUser(PB);
await ok("Bea's card: waiting, not offered, a place free", async () => {
  const r = await one(`select * from my_term_waitlist()`);
  if (!(r.child_name === 'Bea' && r.vendor_offered === false && r.free_places === 1)) throw new Error(JSON.stringify(r));
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
