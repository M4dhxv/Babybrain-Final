/**
 * Behaviour tests for 00271_monthly_billing_optional.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00271_monthly_billing_optional.test.mjs
 *
 * Loads 00268, then 00271 over the same stand-ins, and checks that monthly billing is a
 * choice: a parent who has not enrolled books the ordinary way, an enrolled one books on
 * account, and an overdue invoice blocks both.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (n) => readFileSync(fileURLToPath(new URL(`../migrations/${n}`, import.meta.url)), 'utf8');
const db = new PGlite();

const stub = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $$;

create table public.providers (id uuid primary key default gen_random_uuid(), business_name text, status text default 'active');
create table public.provider_members (user_id uuid, provider_id uuid, role text default 'owner', status text default 'active');
create table public.parent_profiles (id uuid primary key, full_name text, email text);
create table public.activities (
  id uuid primary key default gen_random_uuid(), provider_id uuid, title text, slug text, price numeric,
  wix_service_id text, wix_event_id text, wix_service_type text, terms_enabled boolean not null default false);
create table public.activity_sessions (
  id uuid primary key default gen_random_uuid(), activity_id uuid references public.activities(id),
  starts_at timestamptz not null, ends_at timestamptz, capacity int default 10, price numeric);
create table public.bookings (
  id uuid primary key default gen_random_uuid(), user_id uuid, session_id uuid references public.activity_sessions(id),
  status text default 'pending', payment_status text default 'none', amount numeric,
  package_purchase_id uuid, guest_name text, waitlist_position int, stripe_payment_intent text,
  cancel_refund_mode text, cancel_reason text, cancelled_by uuid);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid, type text, title text, body text, data jsonb,
  created_at timestamptz default now());
create table public.provider_earnings (
  id uuid primary key default gen_random_uuid(), provider_id uuid,
  source text not null check (source in ('booking', 'package')));

create function public.user_provider_ids() returns setof uuid language sql stable as $$
  select provider_id from public.provider_members where user_id = auth.uid() and status = 'active' $$;
create function public.user_manage_provider_ids() returns setof uuid language sql stable as $$
  select provider_id from public.provider_members where user_id = auth.uid() and status = 'active' and role in ('owner','manager') $$;
create function public.session_price(p_session uuid) returns numeric language sql stable as $$
  select coalesce(s.price, a.price) from public.activity_sessions s join public.activities a on a.id = s.activity_id where s.id = p_session $$;

-- The two triggers that run before ours, as they behave in production: capacity, then 'pending' for a priced seat.
create function public.handle_booking_insert() returns trigger language plpgsql as $$
declare cap int; taken int;
begin
  select s.capacity into cap from public.activity_sessions s where s.id = new.session_id for update;
  select count(*) into taken from public.bookings b where b.session_id = new.session_id and b.status in ('pending','confirmed');
  if cap is not null and taken >= cap then new.status := 'waitlisted'; end if;
  return new;
end $$;
create trigger before_booking_insert before insert on public.bookings for each row execute function public.handle_booking_insert();
create function public.enforce_booking_insert_defaults() returns trigger language plpgsql as $$
declare v_price numeric;
begin
  if auth.role() = 'service_role' then return new; end if;
  select public.session_price(new.session_id) into v_price;
  new.payment_status := 'none'; new.amount := null;
  if new.status is distinct from 'waitlisted' then
    new.status := case when coalesce(v_price, 0) = 0 then 'confirmed' else 'pending' end;
  end if;
  return new;
end $$;
create trigger booking_insert_defaults before insert on public.bookings for each row execute function public.enforce_booking_insert_defaults();
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
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); };


await db.exec(stub);
// make-up tokens exist in the real schema; the gate does not need them, the stand-in does not either
await ok('00268 then 00271 apply', async () => {
  await db.exec(file('00268_monthly_billing.sql'));
  await db.exec(file('00271_monthly_billing_optional.sql'));
});
await ok('00271 is idempotent (second run)', async () => { await db.exec(file('00271_monthly_billing_optional.sql')); });

const VENDOR = '11111111-1111-1111-1111-111111111111';
const PA = '22222222-2222-2222-2222-222222222222';
const PB = '33333333-3333-3333-3333-333333333333';
const P = (await one(`insert into providers (business_name) values ('Little Fish Swim') returning id`)).id;
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
await db.query(`insert into parent_profiles (id, full_name) values ($1, 'Vendor Vic'), ($2, 'Alice Parent'), ($3, 'Bob Parent')`, [VENDOR, PA, PB]);
await db.query(`insert into auth.users (id) values ($1)`, [VENDOR]);
const A = (await one(`insert into activities (provider_id, title, slug, price, monthly_billing_enabled) values ($1, 'Swim', 'swim', 40, true) returning id`, [P])).id;
const PLAIN = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Plain', 'plain', 40) returning id`, [P])).id;
const session = async (activity, startsSql) => (await one(`insert into activity_sessions (activity_id, starts_at) values ($1, ${startsSql}) returning id`, [activity])).id;
const lastMonth = (day) => `(date_trunc('month', now() at time zone 'Asia/Singapore') - interval '1 month' + interval '${day - 1} days' + interval '10 hours') at time zone 'Asia/Singapore'`;
const book = async (user, sess, cols = '', vals = '') => {
  await asUser(user);
  return one(`insert into bookings (user_id, session_id${cols}) values ($1, $2${vals}) returning id, status, payment_status, monthly_enrolment_id`, [user, sess]);
};
const daily = async () => { await asUser(null, 'service_role'); return (await one(`select monthly_billing_daily() r`)).r; };
const soon = () => session(A, `now() + interval '20 days'`);

// ---- not enrolled: an ordinary booking, whichever way it is paid
await ok('a parent who has not enrolled books the ordinary way (pending, unpaid, not on a monthly invoice)', async () => {
  const b = await book(PA, await soon());
  eq(b.status, 'pending', 'status'); eq(b.payment_status, 'none', 'payment'); eq(b.monthly_enrolment_id, null, 'enrolment');
});
await ok('...and can use a package credit', async () => {
  const b = await book(PA, await soon(), ', package_purchase_id', ', gen_random_uuid()');
  eq(b.monthly_enrolment_id, null, 'enrolment');
});
await ok('an activity without monthly billing is untouched', async () => {
  const b = await book(PA, await session(PLAIN, `now() + interval '20 days'`));
  eq(b.monthly_enrolment_id, null, 'enrolment');
});

// ---- enrolled: on account
let ENR;
await ok('enrolling is still the parent\'s choice', async () => { await asUser(PA); ENR = (await one(`select monthly_enrol($1) id`, [A])).id; });
let b1;
await ok('an enrolled parent\'s booking is confirmed unpaid and tied to the enrolment', async () => {
  b1 = await book(PA, await session(A, lastMonth(3)));
  eq(b1.status, 'confirmed', 'status'); eq(b1.monthly_enrolment_id, ENR, 'enrolment');
});
await rejects('an enrolled parent cannot use a package credit (it would be paid twice)', async () => { await book(PA, await soon(), ', package_purchase_id', ', gen_random_uuid()'); }, 'package credits');
await ok('another parent in the same activity is not affected by that enrolment', async () => {
  const b = await book(PB, await soon());
  eq(b.status, 'pending', 'status'); eq(b.monthly_enrolment_id, null, 'enrolment');
});

// ---- overdue blocks everything in that activity
await ok('the daily run invoices last month, which then goes overdue', async () => {
  await daily();
  await db.query(`update monthly_invoices set due_at = now() - interval '1 hour' where user_id = $1`, [PA]);
  eq((await one(`select count(*)::int n from monthly_invoices where user_id = $1 and status = 'open'`, [PA])).n, 1, 'open invoices');
});
await rejects('overdue blocks a monthly booking', async () => { await book(PA, await soon()); }, 'overdue');
await rejects('overdue blocks a pay-now booking too', async () => { await book(PA, await soon(), ', package_purchase_id', ', gen_random_uuid()'); }, 'overdue');
await ok('...but not in another activity', async () => { await book(PA, await session(PLAIN, `now() + interval '21 days'`)); });
await ok('paying lifts it', async () => {
  const inv = await one(`select id from monthly_invoices where user_id = $1 and status = 'open'`, [PA]);
  await asUser(null, 'service_role');
  await db.query(`select monthly_mark_invoice_paid($1, 'pi_1', 'cs_1')`, [inv.id]);
  await book(PA, await soon());
});

// ---- leaving returns the parent to paying per booking
await ok('after giving notice, sessions inside the notice period are still monthly', async () => {
  await asUser(PA);
  await db.query(`select monthly_give_notice($1)`, [ENR]);
  const b = await book(PA, await session(A, `now() + interval '5 days'`));
  eq(b.monthly_enrolment_id, ENR, 'enrolment');
});
await rejects('...and sessions after the last day cannot be booked while the notice runs', async () => { await book(PA, await session(A, `now() + interval '40 days'`)); }, 'ends on');
await ok('once the enrolment has ended the parent books the ordinary way again', async () => {
  await db.query(`update monthly_enrolments set ends_at = now() - interval '1 hour' where id = $1`, [ENR]);
  await daily();
  eq((await one(`select status from monthly_enrolments where id = $1`, [ENR])).status, 'ended', 'status');
  const b = await book(PA, await session(A, `now() + interval '45 days'`));
  eq(b.status, 'pending', 'status'); eq(b.monthly_enrolment_id, null, 'enrolment');
});
await ok('a vendor\'s own manual booking is never billed to a parent', async () => {
  await asUser(VENDOR);
  const r = await one(`insert into bookings (user_id, session_id, guest_name) values (null, $1, 'Walk-in') returning monthly_enrolment_id`, [await soon()]);
  eq(r.monthly_enrolment_id, null, 'enrolment');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
