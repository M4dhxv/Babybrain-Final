/**
 * Behaviour tests for 00276_make_up_credit.sql, run against an in-process Postgres (PGlite):
 * no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00276_make_up_credit.test.mjs
 *
 * Focus: the money. Credit is scoped to one vendor, spent soonest-expiry first, never negative, never
 * double-spent, handed back exactly once on a cancel, and a vendor cannot type an amount.
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
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.role', true), ''), 'service_role') $$;

create table public.providers (id uuid primary key default gen_random_uuid(), business_name text, logo_url text, status text default 'active');
create table public.parent_profiles (id uuid primary key default gen_random_uuid(), full_name text, email text);
create table public.children (id uuid primary key default gen_random_uuid(), parent_id uuid, name text, created_at timestamptz default now());
create table public.activities (id uuid primary key default gen_random_uuid(), provider_id uuid, title text, slug text, price numeric,
  is_published boolean default true, archived_at timestamptz, wix_missing_since timestamptz, wix_removed_at timestamptz,
  cancellation_refund_mode text default 'refund');
create table public.activity_sessions (id uuid primary key default gen_random_uuid(), activity_id uuid references public.activities(id),
  starts_at timestamptz not null, capacity int, price numeric, term_slot_id uuid);
create table public.packages (id uuid primary key default gen_random_uuid(), provider_id uuid, name text, activity_ids uuid[]);
create table public.package_purchases (id uuid primary key default gen_random_uuid(), user_id uuid, package_id uuid, provider_id uuid,
  credits_total int, credits_remaining int, status text default 'active', expires_at timestamptz);
create table public.bookings (id uuid primary key default gen_random_uuid(), user_id uuid, session_id uuid references public.activity_sessions(id),
  child_id uuid, provider_id uuid, status text default 'pending', payment_status text default 'none', amount numeric(10,2),
  package_purchase_id uuid, cancel_refund_mode text, policies_accepted uuid[], medical_disclosure text, info_response text,
  waitlist_position int, created_at timestamptz default now());
create table public.make_up_tokens (id uuid primary key default gen_random_uuid(), provider_id uuid not null references public.providers(id) on delete cascade,
  user_id uuid, child_id uuid, origin_booking_id uuid, redeemed_booking_id uuid, status text not null default 'issued',
  issued_by uuid, created_at timestamptz not null default now(), expires_at timestamptz, auto_issued boolean not null default false);
create table public.booking_addons (id uuid primary key default gen_random_uuid(), booking_id uuid, user_id uuid, provider_id uuid,
  unit_price_cents int, quantity int default 1, payment_status text not null default 'pending');
create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, type text, title text, body text, data jsonb);

create function public.user_provider_ids() returns setof uuid language sql stable as $$
  select nullif(current_setting('test.provider', true), '')::uuid where nullif(current_setting('test.provider', true), '') is not null $$;
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

-- Pre-existing token data the migration has to convert.
`;

let pass = 0, fail = 0;
const results = [];
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
const all = async (sql, params) => (await db.query(sql, params)).rows;
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m}: expected ${b}, got ${a}`);
const as = async (uid, role = 'authenticated', provider = '') => {
  await db.exec(`select set_config('test.uid', '${uid ?? ''}', false), set_config('test.role', '${role}', false), set_config('test.provider', '${provider}', false)`);
};
const server = () => as('', 'service_role');

await db.exec(stub);

// ---- legacy fixtures (before the migration) ----
const vA = (await one(`insert into providers (business_name) values ('Vendor A') returning id`)).id;
const vB = (await one(`insert into providers (business_name) values ('Vendor B') returning id`)).id;
const mum = (await one(`insert into parent_profiles (full_name, email) values ('Mum', 'mum@x.sg') returning id`)).id;
const dad = (await one(`insert into parent_profiles (full_name, email) values ('Dad', 'dad@x.sg') returning id`)).id;
const actA = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'A class', 'a-class', 25) returning id`, [vA])).id;
const actB = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'B class', 'b-class', 30) returning id`, [vB])).id;
const actFree = (await one(`insert into activities (provider_id, title, slug, price) values ($1, 'Free', 'free', 0) returning id`, [vA])).id;
const sess = async (act, cap = 10, hours = 48) =>
  (await one(`insert into activity_sessions (activity_id, starts_at, capacity) values ($1, now() + make_interval(hours => $2), $3) returning id`, [act, hours, cap])).id;
const sA = await sess(actA);
const legacyBooking = async (user, session, status, payment, amount) =>
  (await one(`insert into bookings (user_id, session_id, status, payment_status, amount) values ($1,$2,$3,$4,$5) returning id`, [user, session, status, payment, amount])).id;

const oldPaid = await legacyBooking(mum, sA, 'cancelled', 'paid', 20);
const oldNoAmount = await legacyBooking(mum, sA, 'cancelled', 'paid', null);
const oldUsedOn = await legacyBooking(mum, sA, 'confirmed', 'none', null);
const oldOrigin = await legacyBooking(dad, sA, 'cancelled', 'paid', 18);
const legacyTok = async (user, prov, origin, status, red = null) =>
  (await one(`insert into make_up_tokens (user_id, provider_id, origin_booking_id, status, redeemed_booking_id) values ($1,$2,$3,$4,$5) returning id`, [user, prov, origin, status, red])).id;
const tPaid = await legacyTok(mum, vA, oldPaid, 'issued');
const tNoAmt = await legacyTok(mum, vA, oldNoAmount, 'issued');
const tUsed = await legacyTok(dad, vA, oldOrigin, 'redeemed', oldUsedOn);
const tNoOrigin = await legacyTok(mum, vA, null, 'issued');

await db.exec(file('00276_make_up_credit.sql'));
await db.exec(`
create trigger compensate_on_cancel after update of status on public.bookings
  for each row execute function public.compensate_cancelled_booking();
create trigger on_make_up_token_issued_manual after insert on public.make_up_tokens
  for each row execute function public.notify_manual_make_up_token();
`);

const bal = async (user, prov) => (await one(`select make_up_credit_balance($1,$2) b`, [user, prov])).b;
const lot = async (id) => one(`select amount_cents, balance_cents, status, expires_at from make_up_tokens where id = $1`, [id]);

// ---- backfill ----
await ok('backfill: token priced from the booking it replaced', async () => {
  const t = await lot(tPaid); eq(t.amount_cents, 2000, 'amount'); eq(t.balance_cents, 2000, 'balance');
});
await ok('backfill: no booking amount falls back to the class price', async () => {
  const t = await lot(tNoAmt); eq(t.amount_cents, 2500, 'amount');
});
await ok('backfill: a spent token keeps its value, balance 0, and a spend row on its booking', async () => {
  const t = await lot(tUsed); eq(t.amount_cents, 1800, 'amount'); eq(t.balance_cents, 0, 'balance');
  const s = await one(`select amount_cents, status from make_up_token_spends where token_id = $1`, [tUsed]);
  eq(s.amount_cents, 1800, 'spend'); eq(s.status, 'applied', 'status');
  const b = await one(`select credit_cents, paid_by_credit from bookings where id = $1`, [oldUsedOn]);
  eq(b.credit_cents, 1800, 'booking credit'); eq(b.paid_by_credit, true, 'paid_by_credit');
});
await ok('backfill: an unpriceable token is worth 0, not guessed', async () => {
  eq((await lot(tNoOrigin)).amount_cents, 0, 'amount');
});
await ok('balance is per vendor and ignores spent / zero lots', async () => {
  eq(await bal(mum, vA), 4500, 'mum with A');
  eq(await bal(mum, vB), 0, 'mum with B');
  eq(await bal(dad, vA), 0, 'dad with A');
});

// ---- the brief's scenario ----
// Start clean for the scenario: a fresh parent with $40 as two lots.
const eve = (await one(`insert into parent_profiles (full_name) values ('Eve') returning id`)).id;
const addLot = async (user, prov, cents, expires = null, auto = true) =>
  (await one(`insert into make_up_tokens (user_id, provider_id, status, expires_at, auto_issued, amount_cents, balance_cents)
              values ($1,$2,'issued',$3,$4,$5,$5) returning id`, [user, prov, expires, auto, cents])).id;
const lotLate = await addLot(eve, vA, 1500, null);
const lotSoon = await addLot(eve, vA, 2500, new Date(Date.now() + 5 * 864e5).toISOString());
const newBooking = async (user, prov, session, status = 'pending', payment = 'none', amount = null) =>
  (await one(`insert into bookings (user_id, session_id, status, payment_status, amount) values ($1,$2,$3,$4,$5) returning id`, [user, session, status, payment, amount])).id;

await server();
await ok('scenario: $40 balance, buy a $25 class -> $15 left, soonest-expiring lot used first', async () => {
  eq(await bal(eve, vA), 4000, 'start');
  const b = await newBooking(eve, vA, sA);
  const r = (await one(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb) r`, [eve, vA, JSON.stringify([{ booking_id: b, cents: 2500 }])])).r;
  eq(r.total, 2500, 'reserved');
  eq(await bal(eve, vA), 1500, 'balance');
  eq((await lot(lotSoon)).balance_cents, 0, 'soon lot drained first');
  eq((await lot(lotSoon)).status, 'redeemed', 'soon lot status');
  eq((await lot(lotLate)).balance_cents, 1500, 'late lot untouched');
  eq((await one(`select credit_cents from bookings where id = $1`, [b])).credit_cents, 2500, 'booking credit');
  globalThis.scenarioBooking = b;
});
await ok('scenario: confirming the seat settles the held credit', async () => {
  const b = globalThis.scenarioBooking;
  const r = await all(`select * from confirm_credit_booking_seats($1::uuid[])`, [[b]]);
  eq(r[0].confirmed, true, 'confirmed');
  const bk = await one(`select status, payment_status, paid_by_credit from bookings where id = $1`, [b]);
  eq(bk.status, 'confirmed', 'status'); eq(bk.payment_status, 'none', 'payment_status'); eq(bk.paid_by_credit, true, 'paid_by_credit');
  eq((await one(`select status from make_up_token_spends where booking_id = $1`, [b])).status, 'applied', 'spend');
});
await ok('scenario: cancelling a $20 card-paid booking adds $20 -> $35', async () => {
  const c = await newBooking(eve, vA, sA, 'confirmed', 'paid', 20);
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [c]);
  eq(await bal(eve, vA), 3500, 'balance');
});
await ok('scenario: a $50 booking uses the $35 and leaves $15 for the card', async () => {
  const b = await newBooking(eve, vA, sA);
  const r = (await one(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb) r`, [eve, vA, JSON.stringify([{ booking_id: b, cents: 5000 }])])).r;
  eq(r.total, 3500, 'reserved is capped at the balance');
  eq(5000 - r.total, 1500, 'card pays the difference');
  eq(await bal(eve, vA), 0, 'balance');
  globalThis.mixedBooking = b;
});

// ---- cancelling it gives the credit back to its own lots, cash part becomes a new lot ----
await ok('cancel a mixed booking: credit to its lots, card part to a new lot', async () => {
  const b = globalThis.mixedBooking;
  await db.query(`update bookings set amount = 50, payment_status = 'paid', status = 'confirmed' where id = $1`, [b]);
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [b]);
  eq(await bal(eve, vA), 5000, 'whole $50 back as credit');
  const lots = await all(`select auto_issued, amount_cents from make_up_tokens where origin_booking_id = $1`, [b]);
  eq(lots.length, 1, 'one new lot'); eq(lots[0].amount_cents, 1500, 'new lot is the card part');
  const n = await all(`select * from notifications where user_id = $1 and (data->>'booking_id') = $2`, [eve, b]);
  assert(n.length === 1, 'one notification');
});
await ok('cancelling twice never returns credit twice', async () => {
  const b = globalThis.mixedBooking;
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [b]);
  eq(await bal(eve, vA), 5000, 'balance unchanged');
});

// ---- abandoned checkout ----
await ok('an abandoned (pending, unpaid) booking gives its credit back, no new lot, any cancel mode', async () => {
  const before = await bal(eve, vA);
  const b = await newBooking(eve, vA, sA);
  await db.query(`update bookings set cancel_refund_mode = 'none' where id = $1`, [b]);
  await db.query(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb)`, [eve, vA, JSON.stringify([{ booking_id: b, cents: 1000 }])]);
  eq(await bal(eve, vA), before - 1000, 'held');
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [b]);
  eq(await bal(eve, vA), before, 'returned');
  eq((await all(`select 1 from make_up_tokens where origin_booking_id = $1`, [b])).length, 0, 'no new lot');
});

// ---- vendor scope ----
await ok('credit never crosses vendors', async () => {
  const sB = await sess(actB);
  const b = await (async () => {
    const x = await one(`insert into bookings (user_id, session_id) values ($1,$2) returning id`, [eve, sB]);
    return x.id;
  })();
  const r = (await one(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb) r`, [eve, vB, JSON.stringify([{ booking_id: b, cents: 3000 }])])).r;
  eq(r.total, 0, 'nothing from vendor A reaches vendor B');
  eq(await bal(eve, vA), 5000, 'vendor A balance intact');
});
await rejects('a booking that is not the parent\'s cannot be funded', async () => {
  const b = await newBooking(dad, vA, sA);
  await db.query(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb)`, [eve, vA, JSON.stringify([{ booking_id: b, cents: 100 }])]);
}, 'not yours');
await ok('my_make_up_credit lists each vendor separately with its name', async () => {
  const frank = (await one(`insert into parent_profiles (full_name) values ('Frank') returning id`)).id;
  await addLot(frank, vA, 700); await addLot(frank, vB, 900);
  await as(frank, 'authenticated');
  const rows = await all(`select * from my_make_up_credit()`);
  eq(rows.length, 2, 'two vendors');
  eq(rows.find((r) => r.business_name === 'Vendor A').balance_cents, 700, 'A');
  eq(rows.find((r) => r.business_name === 'Vendor B').balance_cents, 900, 'B');
  await server();
});

// ---- expiry ----
await ok('an expired lot is not spendable', async () => {
  const gina = (await one(`insert into parent_profiles (full_name) values ('Gina') returning id`)).id;
  await addLot(gina, vA, 1000, new Date(Date.now() - 864e5).toISOString());
  eq(await bal(gina, vA), 0, 'balance');
});
await ok('returned credit on a lapsed lot gets 30 fresh days', async () => {
  const hal = (await one(`insert into parent_profiles (full_name) values ('Hal') returning id`)).id;
  const l = await addLot(hal, vA, 1000, new Date(Date.now() + 3600e3).toISOString());
  const b = await newBooking(hal, vA, sA);
  await db.query(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb)`, [hal, vA, JSON.stringify([{ booking_id: b, cents: 1000 }])]);
  await db.query(`update make_up_tokens set expires_at = now() - interval '1 day' where id = $1`, [l]);
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [b]);
  const t = await lot(l);
  eq(t.balance_cents, 1000, 'balance back');
  assert(new Date(t.expires_at) > new Date(Date.now() + 25 * 864e5), 'fresh window');
});

// ---- refund modes ----
await ok('a vendor "no refund" cancel of a credit-paid booking gives nothing back', async () => {
  const ian = (await one(`insert into parent_profiles (full_name) values ('Ian') returning id`)).id;
  await addLot(ian, vA, 2000);
  const b = await newBooking(ian, vA, sA);
  await db.query(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb)`, [ian, vA, JSON.stringify([{ booking_id: b, cents: 2000 }])]);
  await db.query(`select * from confirm_credit_booking_seats($1::uuid[])`, [[b]]);
  await db.query(`update bookings set cancel_refund_mode = 'none', status = 'cancelled' where id = $1`, [b]);
  eq(await bal(ian, vA), 0, 'balance');
});
await ok('cash refunded: only the credit part returns, no new lot', async () => {
  const jo = (await one(`insert into parent_profiles (full_name) values ('Jo') returning id`)).id;
  await addLot(jo, vA, 1000);
  const b = await newBooking(jo, vA, sA);
  await db.query(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb)`, [jo, vA, JSON.stringify([{ booking_id: b, cents: 1000 }])]);
  await db.query(`update bookings set amount = 25, payment_status = 'paid', status = 'confirmed' where id = $1`, [b]);
  await db.query(`update bookings set payment_status = 'refunded', status = 'cancelled' where id = $1`, [b]);
  eq(await bal(jo, vA), 1000, 'credit part back');
  eq((await all(`select 1 from make_up_tokens where origin_booking_id = $1`, [b])).length, 0, 'no new lot');
});
await ok('card-only paid booking becomes a lot worth what was paid', async () => {
  const kim = (await one(`insert into parent_profiles (full_name) values ('Kim') returning id`)).id;
  const b = await newBooking(kim, vA, sA, 'confirmed', 'paid', 25);
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [b]);
  eq(await bal(kim, vA), 2500, 'balance');
});
await ok('an unpaid, unfunded booking cancelled compensates nothing', async () => {
  const lee = (await one(`insert into parent_profiles (full_name) values ('Lee') returning id`)).id;
  const b = await newBooking(lee, vA, sA);
  await db.query(`update bookings set status = 'cancelled' where id = $1`, [b]);
  eq(await bal(lee, vA), 0, 'balance');
});

// ---- holds on checkouts with no booking row (packs, add-ons, tickets) ----
await ok('a pack hold: reserved, then released when the checkout never finishes', async () => {
  const mo = (await one(`insert into parent_profiles (full_name) values ('Mo') returning id`)).id;
  await addLot(mo, vA, 3000);
  const hold = (await one(`select gen_random_uuid() h`)).h;
  const r = (await one(`select reserve_make_up_credit($1,$2,$3,'package',$4::jsonb,'pack-1') r`, [mo, vA, hold, JSON.stringify([{ cents: 2000 }])])).r;
  eq(r.total, 2000, 'reserved'); eq(await bal(mo, vA), 1000, 'balance');
  eq((await one(`select release_make_up_credit_hold($1) n`, [hold])).n, 2000, 'released');
  eq(await bal(mo, vA), 3000, 'balance restored');
  eq((await one(`select release_make_up_credit_hold($1) n`, [hold])).n, 0, 'releasing twice is a no-op');
});
await ok('a settled hold cannot be released', async () => {
  const ned = (await one(`insert into parent_profiles (full_name) values ('Ned') returning id`)).id;
  await addLot(ned, vA, 1000);
  const hold = (await one(`select gen_random_uuid() h`)).h;
  await db.query(`select reserve_make_up_credit($1,$2,$3,'package',$4::jsonb)`, [ned, vA, hold, JSON.stringify([{ cents: 1000 }])]);
  await db.query(`select settle_make_up_credit_hold($1)`, [hold]);
  eq((await one(`select release_make_up_credit_hold($1) n`, [hold])).n, 0, 'nothing released');
  eq(await bal(ned, vA), 0, 'still spent');
});
await ok('stale holds without a booking go back after 90 minutes', async () => {
  const ola = (await one(`insert into parent_profiles (full_name) values ('Ola') returning id`)).id;
  await addLot(ola, vA, 1000);
  const hold = (await one(`select gen_random_uuid() h`)).h;
  await db.query(`select reserve_make_up_credit($1,$2,$3,'addon',$4::jsonb)`, [ola, vA, hold, JSON.stringify([{ cents: 600 }])]);
  eq((await one(`select release_stale_make_up_credit_holds() n`)).n, 0, 'fresh hold is kept');
  await db.query(`update make_up_token_spends set created_at = now() - interval '2 hours' where hold_id = $1`, [hold]);
  eq((await one(`select release_stale_make_up_credit_holds() n`)).n, 600, 'stale hold returned');
  eq(await bal(ola, vA), 1000, 'balance');
});

// ---- who may write the money ----
await ok('vendor-issued token: amount is fixed to what the booking cost, whatever the client sends', async () => {
  const pat = (await one(`insert into parent_profiles (full_name) values ('Pat') returning id`)).id;
  const b = await newBooking(pat, vA, sA, 'cancelled', 'paid', 22);
  await as(null, 'authenticated', vA);
  await db.query(`select set_config('test.uid', '${vA}', false)`);
  const t = await one(`insert into make_up_tokens (provider_id, user_id, origin_booking_id, amount_cents, balance_cents)
                       values ($1,$2,$3,999999,999999) returning amount_cents, balance_cents, status`, [vA, pat, b]);
  eq(t.amount_cents, 2200, 'amount'); eq(t.balance_cents, 2200, 'balance'); eq(t.status, 'issued', 'status');
  await server();
  eq((await one(`select (data->>'amount_cents')::int a from notifications where user_id = $1 and type = 'make_up_token_issued'`, [pat])).a, 2200, 'notification carries the amount');
});
await rejects('a vendor cannot issue a token against a booking that is not theirs', async () => {
  const sB = await sess(actB);
  const b = await newBooking(dad, vB, sB, 'cancelled', 'paid', 30);
  await db.query(`select set_config('test.uid', '${vA}', false), set_config('test.role', 'authenticated', false)`);
  await db.query(`insert into make_up_tokens (provider_id, user_id, origin_booking_id) values ($1,$2,$3)`, [vA, dad, b]);
}, 'not one of yours');
await rejects('a vendor cannot issue a token for a free booking', async () => {
  const sFree = await sess(actFree);
  const b = await newBooking(dad, vA, sFree, 'cancelled', 'none', null);
  await db.query(`select set_config('test.uid', '${vA}', false), set_config('test.role', 'authenticated', false)`);
  await db.query(`insert into make_up_tokens (provider_id, user_id, origin_booking_id) values ($1,$2,$3)`, [vA, dad, b]);
}, 'free');
await rejects('a vendor cannot edit a balance', async () => {
  await db.query(`select set_config('test.uid', '${vA}', false), set_config('test.role', 'authenticated', false)`);
  await db.query(`update make_up_tokens set balance_cents = balance_cents + 100 where id = $1`, [tPaid]);
}, 'cannot be edited');
await ok('a vendor can still set an expiry', async () => {
  await db.query(`select set_config('test.uid', '${vA}', false), set_config('test.role', 'authenticated', false)`);
  await db.query(`update make_up_tokens set expires_at = now() + interval '10 days' where id = $1`, [tPaid]);
  await server();
});

// ---- the one-click redeem kept for old links ----
await ok('redeem_make_up_token: refuses when the balance does not cover the class', async () => {
  const quin = (await one(`insert into parent_profiles (full_name) values ('Quin') returning id`)).id;
  const t = await addLot(quin, vA, 1000);
  await as(quin, 'authenticated');
  try { await db.query(`select redeem_make_up_token($1, $2)`, [t, sA]); throw new Error('no raise'); }
  catch (e) { assert(String(e.message).includes('does not cover'), e.message); }
  await server();
  eq(await bal(quin, vA), 1000, 'untouched');
});
await ok('redeem_make_up_token: spends from the whole vendor balance when it covers the class', async () => {
  const rae = (await one(`insert into parent_profiles (full_name) values ('Rae') returning id`)).id;
  const t = await addLot(rae, vA, 1000);
  await addLot(rae, vA, 1500);
  await as(rae, 'authenticated');
  const r = (await one(`select redeem_make_up_token($1, $2) r`, [t, sA])).r;
  eq(r, 'confirmed', 'status');
  await server();
  eq(await bal(rae, vA), 0, 'spent $25 across two lots');
  const bk = await one(`select paid_by_credit, credit_cents from bookings where user_id = $1`, [rae]);
  eq(bk.paid_by_credit, true, 'flag'); eq(bk.credit_cents, 2500, 'credit');
});
await ok('redeem_make_up_token: a full class waitlists the parent and spends nothing', async () => {
  const sFull = await sess(actA, 1);
  await newBooking(dad, vA, sFull, 'confirmed');
  const sam = (await one(`insert into parent_profiles (full_name) values ('Sam') returning id`)).id;
  const t = await addLot(sam, vA, 2500);
  await as(sam, 'authenticated');
  eq((await one(`select redeem_make_up_token($1, $2) r`, [t, sFull])).r, 'waitlisted', 'status');
  await server();
  eq(await bal(sam, vA), 2500, 'untouched');
});

// ---- credit-only seat that cannot be seated ----
await ok('confirm_credit_booking_seats leaves a waitlisted seat waitlisted when the class is full', async () => {
  const sTiny = await sess(actA, 1);
  await newBooking(dad, vA, sTiny, 'confirmed');
  const tia = (await one(`insert into parent_profiles (full_name) values ('Tia') returning id`)).id;
  await addLot(tia, vA, 2500);
  const w = await newBooking(tia, vA, sTiny, 'waitlisted');
  await db.query(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb)`, [tia, vA, JSON.stringify([{ booking_id: w, cents: 2500 }])]);
  const r = await all(`select * from confirm_credit_booking_seats($1::uuid[])`, [[w]]);
  eq(r[0].confirmed, false, 'not seated');
  // The route hands the credit back for a seat that could not be seated.
  eq((await one(`select return_make_up_credit($1, null, array['held']) n`, [w])).n, 2500, 'returned');
  eq(await bal(tia, vA), 2500, 'balance');
});

// ---- add-on rows carry their own credit ----
await ok('add-on credit: held with the row, settled when the row is paid', async () => {
  const uma = (await one(`insert into parent_profiles (full_name) values ('Uma') returning id`)).id;
  await addLot(uma, vA, 2000);
  const b = await newBooking(uma, vA, sA, 'confirmed');
  const row = (await one(`insert into booking_addons (booking_id, user_id, provider_id, unit_price_cents, quantity) values ($1,$2,$3,1200,1) returning id`, [b, uma, vA])).id;
  const r = (await one(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'addon',$3::jsonb) r`, [uma, vA, JSON.stringify([{ addon_row_id: row, cents: 1200 }])])).r;
  eq(r.total, 1200, 'reserved');
  eq((await one(`select credit_cents from booking_addons where id = $1`, [row])).credit_cents, 1200, 'row credit');
  await db.query(`update booking_addons set payment_status = 'paid' where id = $1`, [row]);
  eq((await one(`select status from make_up_token_spends where ref_id = $1`, [row])).status, 'applied', 'settled');
  eq(await bal(uma, vA), 800, 'balance');
});
await ok('add-on credit: a row dropped before payment gives its credit back', async () => {
  const vic = (await one(`insert into parent_profiles (full_name) values ('Vic') returning id`)).id;
  await addLot(vic, vA, 2000);
  const b = await newBooking(vic, vA, sA, 'confirmed');
  const row = (await one(`insert into booking_addons (booking_id, user_id, provider_id, unit_price_cents, quantity) values ($1,$2,$3,1500,1) returning id`, [b, vic, vA])).id;
  await db.query(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'addon',$3::jsonb)`, [vic, vA, JSON.stringify([{ addon_row_id: row, cents: 1500 }])]);
  eq(await bal(vic, vA), 500, 'held');
  await db.query(`delete from booking_addons where id = $1`, [row]);
  eq(await bal(vic, vA), 2000, 'returned');
});
await ok('seats and an add-on can be reserved together in one go, seats first', async () => {
  const wes = (await one(`insert into parent_profiles (full_name) values ('Wes') returning id`)).id;
  await addLot(wes, vA, 3000);
  const b1 = await newBooking(wes, vA, sA); const b2 = await newBooking(wes, vA, sA);
  const row = (await one(`insert into booking_addons (booking_id, user_id, provider_id, unit_price_cents, quantity) values ($1,$2,$3,1000,1) returning id`, [b1, wes, vA])).id;
  const items = [{ booking_id: b1, cents: 2500 }, { booking_id: b2, cents: 2500 }, { addon_row_id: row, cents: 1000 }];
  const r = (await one(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb) r`, [wes, vA, JSON.stringify(items)])).r;
  eq(r.total, 3000, 'all the balance'); eq(r.items[0].cents, 2500, 'seat 1 full'); eq(r.items[1].cents, 500, 'seat 2 partly'); eq(r.items[2].cents, 0, 'add-on gets none');
});
await ok('a seat that falls back to the waitlist gives its held credit back', async () => {
  const xia = (await one(`insert into parent_profiles (full_name) values ('Xia') returning id`)).id;
  await addLot(xia, vA, 2500);
  const b = await newBooking(xia, vA, sA);
  await db.query(`select reserve_make_up_credit($1,$2,gen_random_uuid(),'booking',$3::jsonb)`, [xia, vA, JSON.stringify([{ booking_id: b, cents: 2500 }])]);
  await db.query(`update bookings set status = 'waitlisted' where id = $1`, [b]);
  eq(await bal(xia, vA), 2500, 'returned');
  eq((await one(`select credit_cents from bookings where id = $1`, [b])).credit_cents, 0, 'seat credit cleared');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
