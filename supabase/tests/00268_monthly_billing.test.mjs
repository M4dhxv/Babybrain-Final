/**
 * Behaviour tests for 00268_monthly_billing.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00268_monthly_billing.test.mjs
 *
 * Stand-ins for the tables and triggers it builds on, then the whole life of a
 * monthly enrolment: enrol, book (nothing to pay), the invoice on the 1st, the
 * reminder, overdue, paying, giving and taking back notice. "Last month" is
 * made by moving a session's date, since the gate does not look at the clock.
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
await ok('00268 applies', async () => { await db.exec(file('00268_monthly_billing.sql')); });
await ok('00268 is idempotent (second run)', async () => { await db.exec(file('00268_monthly_billing.sql')); });

const VENDOR = '11111111-1111-1111-1111-111111111111';
const PA = '22222222-2222-2222-2222-222222222222';
const PB = '33333333-3333-3333-3333-333333333333';
const STRANGER = '44444444-4444-4444-4444-444444444444';
const P = (await one(`insert into providers (business_name) values ('Little Fish Swim') returning id`)).id;
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
await db.query(`insert into parent_profiles (id, full_name) values ($1, 'Vendor Vic'), ($2, 'Alice Parent'), ($3, 'Bob Parent'), ($4, 'Stranger')`, [VENDOR, PA, PB, STRANGER]);
await db.query(`insert into auth.users (id) values ($1)`, [VENDOR]);

const A = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Swim', 'swim', 40) returning id`, [P])).id;
const W = (await one(`insert into activities (provider_id, title, slug, price, wix_service_id) values ($1, 'Wix class', 'wix', 40, 'abc') returning id`, [P])).id;
const T = (await one(`insert into activities (provider_id, title, slug, price, terms_enabled) values ($1, 'Term class', 'term', 40, true) returning id`, [P])).id;

// A session `offset` from now, or on a given day of last month.
const session = async (activity, startsSql, price = null) =>
  (await one(`insert into activity_sessions (activity_id, starts_at, price) values ($1, ${startsSql}, $2) returning id`, [activity, price])).id;
const lastMonth = (day, hour = 10) =>
  `(date_trunc('month', now() at time zone 'Asia/Singapore') - interval '1 month' + interval '${day - 1} days' + interval '${hour} hours') at time zone 'Asia/Singapore'`;
const book = async (user, sess, extra = '') => {
  await asUser(user);
  return one(`insert into bookings (user_id, session_id${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2${extra ? ', ' + extra.split('=')[1] : ''}) returning id, status, payment_status, monthly_enrolment_id`, [user, sess]);
};
const seat = async (id) => one(`select status, payment_status, amount, monthly_invoice_id from bookings where id = $1`, [id]);
const notes = async (user, type) => (await one(`select count(*)::int n from notifications where user_id = $1 and type = $2`, [user, type])).n;
const daily = async () => { await asUser(null, 'service_role'); return (await one(`select monthly_billing_daily() r`)).r; };

// ---- the switch
await ok('monthly billing can be switched on for a native activity', async () => {
  await db.query(`update activities set monthly_billing_enabled = true where id = $1`, [A]);
});
await rejects('...not for a Wix-synced activity', () => db.query(`update activities set monthly_billing_enabled = true where id = $1`, [W]), 'Wix');
await rejects('...not alongside terms', () => db.query(`update activities set monthly_billing_enabled = true where id = $1`, [T]), 'terms');
await rejects('...and terms cannot be switched on under it (constraint)', () => db.query(`update activities set terms_enabled = true where id = $1`, [A]));

// ---- enrolling and booking
const S1 = await session(A, lastMonth(3));
const S2 = await session(A, lastMonth(10));
const S3 = await session(A, lastMonth(17));
const SFREE = await session(A, lastMonth(20), 0);
const SNOW = await session(A, `now()`);
const SFUT = await session(A, `now() + interval '45 days'`);

await rejects('booking a monthly class before enrolling is refused', () => book(PA, S1), 'billed monthly');
await asUser(PA);
let ENR;
await ok('a parent enrols', async () => { ENR = (await one(`select monthly_enrol($1) id`, [A])).id; if (!ENR) throw new Error('no id'); });
await ok('enrolling again returns the same enrolment', async () => {
  eq((await one(`select monthly_enrol($1) id`, [A])).id, ENR, 'id');
});
await rejects('an anonymous caller cannot enrol', async () => { await asUser(null); await db.query(`select monthly_enrol($1)`, [A]); }, 'log in');
await rejects('a monthly_enrol on a non-monthly activity is refused', async () => {
  await asUser(PA);
  const plain = (await one(`insert into activities (provider_id, title, price) values ($1, 'Plain', 10) returning id`, [P])).id;
  await db.query(`select monthly_enrol($1)`, [plain]);
}, 'not billed monthly');

let b1, b2, b3, bfree, bnow;
await ok('a booking is confirmed straight away, unpaid, and tied to the enrolment', async () => {
  b1 = await book(PA, S1);
  eq(b1.status, 'confirmed', 'status'); eq(b1.payment_status, 'none', 'payment'); eq(b1.monthly_enrolment_id, ENR, 'enrolment');
});
await ok('any number of sessions can be booked', async () => {
  b2 = await book(PA, S2); b3 = await book(PA, S3); bfree = await book(PA, SFREE); bnow = await book(PA, SNOW);
  for (const b of [b2, b3, bfree, bnow]) eq(b.status, 'confirmed', 'status');
});
await rejects('a package credit cannot be used on a monthly class', async () => {
  await asUser(PA);
  await db.query(`insert into bookings (user_id, session_id, package_purchase_id) values ($1, $2, gen_random_uuid())`, [PA, SFUT]);
}, 'package credits');
await ok('a vendor\'s own manual booking is not billed to a parent', async () => {
  await asUser(VENDOR);
  const r = await one(`insert into bookings (user_id, session_id, guest_name) values (null, $1, 'Walk-in') returning monthly_enrolment_id`, [SFUT]);
  eq(r.monthly_enrolment_id, null, 'enrolment');
});
await ok('a seat on a full session still waitlists (and is not billed)', async () => {
  const tiny = (await one(`insert into activity_sessions (activity_id, starts_at, capacity) values ($1, ${lastMonth(24)}, 1) returning id`, [A])).id;
  await book(PA, tiny);
  const w = await book(PB, tiny).catch(() => null);
  // PB is not enrolled, so this is refused; enrol them and try again.
  eq(w, null, 'unenrolled parent');
  await asUser(PB);
  await db.query(`select monthly_enrol($1)`, [A]);
  const second = await book(PB, tiny);
  eq(second.status, 'waitlisted', 'status');
});

// ---- what is owed so far
await ok('monthly_unbilled shows last month and this month', async () => {
  await asUser(PA);
  const rows = (await db.query(`select * from monthly_unbilled($1)`, [ENR])).rows;
  eq(rows.length, 2, 'months');
  eq(rows[0].sessions, 4, 'priced sessions last month (the free one is left out)');
  eq(rows[0].amount_cents, 16000, 'cents last month');
  eq(rows[1].sessions, 1, 'sessions this month');
});

// ---- the invoice on the 1st
let INV;
await ok('the daily run invoices last month: priced, non-cancelled seats only', async () => {
  const r = await daily();
  const inv = await one(`select * from monthly_invoices where enrolment_id = $1`, [ENR]);
  if (!inv) throw new Error('no invoice ' + JSON.stringify(r));
  INV = inv;
  eq(inv.session_count, 4, 'sessions'); eq(inv.amount_cents, 16000, 'cents'); eq(inv.status, 'open', 'status');
  return `${r.issued} issued, ${inv.session_count} sessions, ${inv.amount_cents}c`;
});
await ok('the invoice is due 00:00 on the 6th, Singapore', async () => {
  const r = await one(`select (due_at at time zone 'Asia/Singapore')::text as d from monthly_invoices where id = $1`, [INV.id]);
  const now = await one(`select (now() at time zone 'Asia/Singapore')::date as today`);
  const sixth = await one(`select (date_trunc('month', now() at time zone 'Asia/Singapore') + interval '5 days')::text as d`);
  // A normal run is due on the 6th at 00:00; a run after the 5th gives five days instead.
  const late = new Date(now.today).getUTCDate() >= 6;
  if (!late) eq(r.d, sixth.d, 'due_at');
  return r.d;
});
await ok('the seats are stamped with a price and the invoice', async () => {
  const s = await seat(b1.id);
  eq(Number(s.amount), 40, 'amount'); eq(s.monthly_invoice_id, INV.id, 'invoice');
  eq(Number((await seat(bfree.id)).amount), 0, 'free session priced at 0');
  eq((await seat(bfree.id)).monthly_invoice_id, null, 'free session not on the invoice');
  eq((await seat(bnow.id)).amount, null, 'this month not priced yet');
});
await ok('the parent is told', async () => { eq(await notes(PA, 'monthly_invoice_issued'), 1, 'notifications'); });
await ok('running it again issues nothing new', async () => {
  const r = await daily();
  eq(r.issued, 0, 'issued');
  eq((await one(`select count(*)::int n from monthly_invoices where enrolment_id = $1`, [ENR])).n, 1, 'invoices');
  eq(await notes(PA, 'monthly_invoice_issued'), 1, 'notifications');
});
await ok('a cancelled seat is not billed', async () => {
  await asUser(PA);
  const extra = await session(A, lastMonth(26));
  const bx = await book(PA, extra);
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [bx.id]);
  await daily();
  eq((await seat(bx.id)).monthly_invoice_id, null, 'invoice');
});

// ---- reminder, overdue, paying
await ok('two days before the deadline a reminder goes out, once', async () => {
  // Issued on the 4th or 5th (a late catch-up run) the reminder already fired with the invoice, so start clean.
  await db.query(`update monthly_invoices set due_at = now() + interval '30 hours', reminder_sent_at = null where id = $1`, [INV.id]);
  const before = await notes(PA, 'monthly_invoice_reminder');
  const r1 = await daily(); const r2 = await daily();
  eq(r1.reminded, 1, 'first run'); eq(r2.reminded, 0, 'second run');
  eq(await notes(PA, 'monthly_invoice_reminder'), before + 1, 'one new reminder');
});
await ok('before the deadline the parent can still book', async () => { await book(PA, SFUT); });
await ok('past the deadline the parent and the vendor are told, once', async () => {
  await db.query(`update monthly_invoices set due_at = now() - interval '1 hour' where id = $1`, [INV.id]);
  const r1 = await daily(); const r2 = await daily();
  eq(r1.overdue, 1, 'first run'); eq(r2.overdue, 0, 'second run');
  eq(await notes(PA, 'monthly_invoice_overdue'), 1, 'parent');
  eq(await notes(VENDOR, 'provider_monthly_invoice_overdue'), 1, 'vendor');
});
await rejects('an overdue parent cannot book more sessions', async () => { await book(PA, await session(A, `now() + interval '50 days'`)); }, 'overdue');
await ok('...but another parent in the same activity can', async () => { await book(PB, await session(A, `now() + interval '51 days'`)); });
await ok('a vendor can still add a manual booking', async () => {
  await asUser(VENDOR);
  await db.query(`insert into bookings (user_id, session_id, guest_name) values (null, $1, 'Walk-in 2')`, [SFUT]);
});
await ok('paying marks it paid once, and the seats paid', async () => {
  await asUser(null, 'service_role');
  const first = (await one(`select monthly_mark_invoice_paid($1, 'pi_123', 'cs_123') r`, [INV.id])).r;
  const second = (await one(`select monthly_mark_invoice_paid($1, 'pi_123', 'cs_123') r`, [INV.id])).r;
  eq(first, true, 'first'); eq(second, false, 'second');
  eq((await seat(b1.id)).payment_status, 'paid', 'seat payment');
  eq(await notes(PA, 'monthly_invoice_paid'), 1, 'receipt');
});
await ok('once paid the parent can book again', async () => { await book(PA, await session(A, `now() + interval '52 days'`)); });

// ---- giving notice
let ENRB;
await ok('giving notice ends the enrolment after 14 more days', async () => {
  await asUser(PB);
  ENRB = (await one(`select id from monthly_enrolments where user_id = $1`, [PB])).id;
  const inside = await book(PB, await session(A, `now() + interval '10 days'`));
  const outside = await book(PB, await session(A, `now() + interval '30 days'`));
  const ends = (await one(`select monthly_give_notice($1) e`, [ENRB])).e;
  const e = await one(`select status, (ends_at at time zone 'Asia/Singapore')::text as ends, (ends_at at time zone 'Asia/Singapore')::date - (now() at time zone 'Asia/Singapore')::date as days from monthly_enrolments where id = $1`, [ENRB]);
  eq(e.status, 'ending', 'status'); eq(e.days, 15, 'ends_at is the start of day 15 (last day is day 14)');
  eq((await seat(inside.id)).status, 'confirmed', 'a session inside the notice period stays');
  eq((await seat(outside.id)).status, 'cancelled', 'a session beyond it is released');
  eq(await notes(VENDOR, 'provider_monthly_notice_given'), 1, 'vendor told');
  eq(await notes(PB, 'monthly_notice_given'), 1, 'parent told');
  return String(ends);
});
await rejects('after notice a session beyond the end date cannot be booked', async () => { await book(PB, await session(A, `now() + interval '40 days'`)); }, 'ends on');
await ok('...but one inside the notice period can', async () => { await book(PB, await session(A, `now() + interval '12 days'`)); });
await rejects('notice cannot be given twice', async () => { await asUser(PB); await db.query(`select monthly_give_notice($1)`, [ENRB]); }, 'already given');
await rejects('re-enrolling during notice points at taking it back', async () => { await asUser(PB); await db.query(`select monthly_enrol($1)`, [A]); }, 'notice back');
await rejects('nobody else can give notice for this enrolment', async () => { await asUser(STRANGER); await db.query(`select monthly_give_notice($1)`, [ENRB]); }, 'does not exist');
await ok('notice can be taken back', async () => {
  await asUser(PB);
  await db.query(`select monthly_withdraw_notice($1)`, [ENRB]);
  const e = await one(`select status, ends_at from monthly_enrolments where id = $1`, [ENRB]);
  eq(e.status, 'active', 'status'); eq(e.ends_at, null, 'ends_at');
  await book(PB, await session(A, `now() + interval '60 days'`));
});
await ok('once notice has run out the enrolment ends and the last invoice follows', async () => {
  await asUser(PB);
  await db.query(`select monthly_give_notice($1)`, [ENRB]);
  const lastMonthSess = await session(A, lastMonth(5));
  await db.query(`insert into bookings (user_id, session_id, status, monthly_enrolment_id) values ($1, $2, 'confirmed', $3)`, [PB, lastMonthSess, ENRB]);
  await db.query(`update monthly_enrolments set ends_at = now() - interval '1 hour' where id = $1`, [ENRB]);
  const r = await daily();
  eq(r.ended, 1, 'ended');
  eq((await one(`select status from monthly_enrolments where id = $1`, [ENRB])).status, 'ended', 'status');
  eq((await one(`select count(*)::int n from monthly_invoices where enrolment_id = $1`, [ENRB])).n >= 1, true, 'final invoice');
  eq(await notes(PB, 'monthly_enrolment_ended'), 1, 'parent told');
});
await rejects('an ended enrolment cannot book', async () => { await book(PB, await session(A, `now() + interval '5 days'`)); }, 'Enrol first');
await rejects('...and leaving does not clear what is owed: re-enrolling is blocked while overdue', async () => {
  await db.query(`update monthly_invoices set due_at = now() - interval '1 day' where enrolment_id = $1`, [ENRB]);
  await asUser(PB);
  await db.query(`select monthly_enrol($1)`, [A]);
}, 'overdue');

// ---- vendor settles outside the app
await ok('a vendor can mark an invoice paid by bank transfer', async () => {
  await asUser(VENDOR);
  const inv = await one(`select id from monthly_invoices where enrolment_id = $1 and status = 'open' limit 1`, [ENRB]);
  await db.query(`select monthly_settle_invoice($1, 'paid', 'PayNow 3 Nov')`, [inv.id]);
  const r = await one(`select status, paid_manually, settle_note from monthly_invoices where id = $1`, [inv.id]);
  eq(r.status, 'paid', 'status'); eq(r.paid_manually, true, 'manual');
});
await rejects('a parent cannot settle an invoice', async () => {
  await asUser(PA);
  await db.query(`select monthly_settle_invoice($1, 'void')`, [INV.id]);
}, 'does not exist');
await rejects('a settled invoice cannot be settled again', async () => {
  await asUser(VENDOR);
  await db.query(`select monthly_settle_invoice($1, 'void')`, [INV.id]);
}, 'already paid');

// ---- what the vendor sees
await ok('the vendor sees enrolments and invoices, with parent names', async () => {
  await asUser(VENDOR);
  const en = (await db.query(`select * from monthly_provider_enrolments($1)`, [P])).rows;
  const inv = (await db.query(`select * from monthly_provider_invoices($1)`, [P])).rows;
  if (!en.some((r) => r.parent_name === 'Alice Parent')) throw new Error(JSON.stringify(en));
  if (!inv.some((r) => r.parent_name === 'Alice Parent' && r.status === 'paid')) throw new Error(JSON.stringify(inv));
  return `${en.length} enrolments, ${inv.length} invoices`;
});
await ok('someone outside the provider sees nothing', async () => {
  await asUser(PA);
  const en = (await db.query(`select * from monthly_provider_enrolments($1)`, [P])).rows;
  eq(en.length, 0, 'enrolments');
});

// ---- the switch cannot be turned off under live billing
await rejects('monthly billing cannot be turned off while parents are enrolled', () => db.query(`update activities set monthly_billing_enabled = false where id = $1`, [A]), 'still enrolled');

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
