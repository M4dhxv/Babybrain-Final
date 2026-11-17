/**
 * The admin "book a customer with a make-up token" tool, after 00276 turned tokens into money
 * (00270 loaded first, then 00276 on top). PGlite, nothing touches a real database.
 *
 *   node supabase/tests/00276_admin_token.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (n) => readFileSync(fileURLToPath(new URL(`../migrations/${n}`, import.meta.url)), 'utf8');
const db = new PGlite();

const stub = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.role() returns text language sql stable as $$ select 'service_role' $$;

create table public.providers (id uuid primary key default gen_random_uuid(), business_name text, logo_url text, status text default 'active');
create table public.parent_profiles (id uuid primary key default gen_random_uuid(), full_name text, email text);
create table public.children (id uuid primary key default gen_random_uuid(), parent_id uuid, name text, created_at timestamptz default now());
create table public.activities (id uuid primary key default gen_random_uuid(), provider_id uuid, title text, slug text, price numeric,
  is_published boolean default true, archived_at timestamptz, wix_missing_since timestamptz, wix_removed_at timestamptz,
  cancellation_refund_mode text default 'refund', wix_service_id text, wix_service_type text, wix_event_id text);
create table public.activity_sessions (id uuid primary key default gen_random_uuid(), activity_id uuid references public.activities(id),
  starts_at timestamptz not null, capacity int, price numeric, wix_slot_key text, term_slot_id uuid);
create table public.packages (id uuid primary key default gen_random_uuid(), provider_id uuid, name text, activity_ids uuid[],
  allowed_weekday int, allowed_start_time time);
create table public.package_purchases (id uuid primary key default gen_random_uuid(), user_id uuid, package_id uuid, provider_id uuid,
  credits_total int, credits_remaining int, status text default 'active', expires_at timestamptz);
create table public.bookings (id uuid primary key default gen_random_uuid(), user_id uuid, session_id uuid references public.activity_sessions(id),
  child_id uuid, provider_id uuid, status text default 'pending', payment_status text default 'none', amount numeric(10,2),
  package_purchase_id uuid, cancel_refund_mode text, guest_name text, guest_contact text, policies_accepted uuid[], waitlist_position int,
  created_at timestamptz default now());
create table public.make_up_tokens (id uuid primary key default gen_random_uuid(), provider_id uuid not null references public.providers(id) on delete cascade,
  user_id uuid, child_id uuid, origin_booking_id uuid, redeemed_booking_id uuid, status text not null default 'issued',
  issued_by uuid, created_at timestamptz not null default now(), expires_at timestamptz, auto_issued boolean not null default false);
create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, type text, title text, body text, data jsonb);
create table public.booking_addons (id uuid primary key default gen_random_uuid(), booking_id uuid, user_id uuid, provider_id uuid,
  unit_price_cents int, quantity int default 1, payment_status text not null default 'pending');
create function public.user_provider_ids() returns setof uuid language sql stable as $$ select null::uuid where false $$;
create function public.session_price(p_session uuid) returns numeric language sql stable as $$
  select coalesce(s.price, a.price) from public.activity_sessions s join public.activities a on a.id = s.activity_id where s.id = p_session $$;

create function public.handle_booking_insert() returns trigger language plpgsql as $$
declare cap int; taken int; prov uuid;
begin
  select s.capacity, a.provider_id into cap, prov from public.activity_sessions s join public.activities a on a.id = s.activity_id where s.id = new.session_id for update of s;
  new.provider_id := prov;
  if cap is not null then
    select count(*) into taken from public.bookings b where b.session_id = new.session_id and b.status in ('pending','confirmed');
    if taken >= cap then new.status := 'waitlisted'; end if;
  end if;
  return new;
end $$;
create trigger before_booking_insert before insert on public.bookings for each row execute function public.handle_booking_insert();
`;

let pass = 0, fail = 0;
const results = [];
async function ok(name, fn) {
  try { const v = await fn(); results.push(`PASS  ${name}${v ? '  -> ' + v : ''}`); pass++; }
  catch (e) { results.push(`FAIL  ${name}  -> ${e.message}`); fail++; }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const assert = (c, m) => { if (!c) throw new Error(m); };

await db.exec(stub);
await db.exec(file('00270_admin_create_booking.sql'));
await db.exec(file('00276_make_up_credit.sql'));

const vA = (await one(`insert into providers (business_name) values ('Vendor A') returning id`)).id;
const vB = (await one(`insert into providers (business_name) values ('Vendor B') returning id`)).id;
const mum = (await one(`insert into parent_profiles (full_name) values ('Mum') returning id`)).id;
const kid = (await one(`insert into children (parent_id, name) values ($1, 'Kid') returning id`, [mum])).id;
const actA = (await one(`insert into activities (provider_id, title, price) values ($1, 'A class', 25) returning id`, [vA])).id;
const actB = (await one(`insert into activities (provider_id, title, price) values ($1, 'B class', 25) returning id`, [vB])).id;
const sess = async (act) =>
  (await one(`insert into activity_sessions (activity_id, starts_at, capacity) values ($1, now() + interval '2 days', 10) returning id`, [act])).id;
const lot = async (user, prov, cents, expires = null) =>
  (await one(`insert into make_up_tokens (user_id, provider_id, child_id, status, expires_at, auto_issued, amount_cents, balance_cents)
              values ($1,$2,$3,'issued',$4,true,$5,$5) returning id`, [user, prov, kid, expires, cents])).id;
const checks = async (...a) => (await one(`select admin_booking_checks($1,$2,$3,$4,$5,$6,$7) r`, a)).r;
const create = async (a) => (await one(`select admin_create_booking($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r`, a)).r;
const failing = (r) => r.checks.filter((c) => !c.ok).map((c) => c.key);
const bal = async (prov) => (await one(`select make_up_credit_balance($1,$2) b`, [mum, prov])).b;

const sA = await sess(actA);
const sB = await sess(actB);

await ok('token: a balance that covers the class passes every check', async () => {
  const t = await lot(mum, vA, 3000);
  const r = await checks(mum, sA, 'token', null, t, kid, false);
  assert(r.ok, 'failing: ' + failing(r));
});
await ok('token: a balance that does not cover the class is refused', async () => {
  const lean = (await one(`insert into parent_profiles (full_name) values ('Lean') returning id`)).id;
  const t = (await one(`insert into make_up_tokens (user_id, provider_id, status, auto_issued, amount_cents, balance_cents) values ($1,$2,'issued',true,1000,1000) returning id`, [lean, vA])).id;
  const r = await checks(lean, sA, 'token', null, t, null, false);
  assert(failing(r).includes('active'), 'expected the balance check to fail, got ' + failing(r));
});
await ok('token: create spends the class price from the vendor balance and marks the seat paid by credit', async () => {
  const before = await bal(vA);
  const r = await create([mum, sA, 'token', null, (await one(`select id from make_up_tokens where provider_id = $1 limit 1`, [vA])).id, kid, null, null, false, false]);
  assert(before - (await bal(vA)) === 2500, 'balance should drop by $25, dropped ' + (before - (await bal(vA))));
  const b = await one(`select status, paid_by_credit, credit_cents from bookings where id = $1`, [r.booking_id]);
  assert(b.status === 'confirmed' && b.paid_by_credit === true && b.credit_cents === 2500, JSON.stringify(b));
});
await ok('token: vendor A balance on a vendor B class is refused and nothing is spent', async () => {
  const t = await lot(mum, vA, 5000);
  const before = await bal(vA);
  let raised = false;
  try { await create([mum, sB, 'token', null, t, kid, null, null, false, false]); } catch { raised = true; }
  assert(raised, 'should refuse');
  assert((await bal(vA)) === before, 'balance changed');
});
await ok('token: an expired lot cannot fund a booking', async () => {
  const gone = (await one(`insert into parent_profiles (full_name) values ('Gone') returning id`)).id;
  const t = (await one(`insert into make_up_tokens (user_id, provider_id, status, auto_issued, amount_cents, balance_cents, expires_at)
                        values ($1,$2,'issued',true,5000,5000,'2020-01-01') returning id`, [gone, vA])).id;
  const r = await checks(gone, sA, 'token', null, t, null, false);
  assert(failing(r).includes('active'), 'expired lot should not count');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
