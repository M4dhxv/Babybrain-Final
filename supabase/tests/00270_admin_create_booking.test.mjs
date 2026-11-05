/**
 * Behaviour tests for 00270_admin_create_booking.sql, run against an in-process Postgres (PGlite):
 * no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00270_admin_create_booking.test.mjs
 *
 * Focus: the safeguard. A credit or token from vendor A must never book a vendor B class, and
 * the credit / token must really be spent (exactly once) when a booking is made.
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

create table public.providers (id uuid primary key default gen_random_uuid(), business_name text, status text default 'active');
create table public.parent_profiles (id uuid primary key default gen_random_uuid(), full_name text, email text);
create table public.children (id uuid primary key default gen_random_uuid(), parent_id uuid, name text, created_at timestamptz default now());
create table public.activities (id uuid primary key default gen_random_uuid(), provider_id uuid, title text,
  wix_service_id text, wix_service_type text, wix_event_id text);
create table public.activity_sessions (id uuid primary key default gen_random_uuid(), activity_id uuid references public.activities(id),
  starts_at timestamptz not null, capacity int, wix_slot_key text, term_slot_id uuid);
create table public.packages (id uuid primary key default gen_random_uuid(), provider_id uuid, name text, activity_ids uuid[],
  allowed_weekday int, allowed_start_time time);
create table public.package_purchases (id uuid primary key default gen_random_uuid(), user_id uuid, package_id uuid, provider_id uuid,
  credits_total int, credits_remaining int, status text default 'active', expires_at timestamptz);
create table public.bookings (id uuid primary key default gen_random_uuid(), user_id uuid, session_id uuid references public.activity_sessions(id),
  child_id uuid, provider_id uuid, status text default 'confirmed', payment_status text default 'none', package_purchase_id uuid,
  guest_name text, guest_contact text, policies_accepted uuid[], waitlist_position int);
create table public.make_up_tokens (id uuid primary key default gen_random_uuid(), provider_id uuid, user_id uuid, child_id uuid,
  origin_booking_id uuid, redeemed_booking_id uuid, status text default 'issued', expires_at timestamptz);

create function public.handle_booking_insert() returns trigger language plpgsql as $$
declare cap int; taken int;
begin
  select s.capacity into cap from public.activity_sessions s where s.id = new.session_id for update;
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
async function rejects(name, fn, match) {
  try { await fn(); results.push(`FAIL  ${name}  -> did not raise`); fail++; }
  catch (e) {
    if (match && !String(e.message).includes(match)) { results.push(`FAIL  ${name}  -> wrong error: ${e.message}`); fail++; }
    else { results.push(`PASS  ${name}  -> ${e.message}`); pass++; }
  }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const assert = (c, m) => { if (!c) throw new Error(m); };
const uid = async () => (await one(`select gen_random_uuid() id`)).id;

await db.exec(stub);
await db.exec(file('00270_admin_create_booking.sql'));

// ---- fixtures ----
const vA = (await one(`insert into providers (business_name) values ('Vendor A') returning id`)).id;
const vB = (await one(`insert into providers (business_name) values ('Vendor B') returning id`)).id;
const mum = (await one(`insert into parent_profiles (full_name, email) values ('Mum', 'mum@x.sg') returning id`)).id;
const other = (await one(`insert into parent_profiles (full_name, email) values ('Other', 'other@x.sg') returning id`)).id;
const kid = (await one(`insert into children (parent_id, name) values ($1, 'Kid') returning id`, [mum])).id;
const otherKid = (await one(`insert into children (parent_id, name) values ($1, 'Their kid') returning id`, [other])).id;
const actA = (await one(`insert into activities (provider_id, title) values ($1, 'A class') returning id`, [vA])).id;
const actB = (await one(`insert into activities (provider_id, title) values ($1, 'B class') returning id`, [vB])).id;
const sess = async (act, cap = 10, hours = 48, extra = '') =>
  (await one(`insert into activity_sessions (activity_id, starts_at, capacity ${extra ? ',' + extra.split('=')[0] : ''}) values ($1, now() + make_interval(hours => $2), $3 ${extra ? ',' + extra.split('=')[1] : ''}) returning id`, [act, hours, cap])).id;
const pkg = async (prov, extra = {}) => (await one(`insert into packages (provider_id, name, activity_ids, allowed_weekday) values ($1, 'Pack', $2, $3) returning id`, [prov, extra.activity_ids ?? null, extra.weekday ?? null])).id;
const purchase = async (user, prov, pkgId, left = 5, status = 'active', expires = null) =>
  (await one(`insert into package_purchases (user_id, package_id, provider_id, credits_total, credits_remaining, status, expires_at) values ($1,$2,$3,5,$4,$5,$6) returning id`, [user, pkgId, prov, left, status, expires])).id;
const token = async (user, prov, child = null, status = 'issued', expires = null, origin = null) =>
  (await one(`insert into make_up_tokens (user_id, provider_id, child_id, status, expires_at, origin_booking_id) values ($1,$2,$3,$4,$5,$6) returning id`, [user, prov, child, status, expires, origin])).id;
const checks = async (...a) => (await one(`select admin_booking_checks($1,$2,$3,$4,$5,$6,$7) r`, a)).r;
const create = async (a) => (await one(`select admin_create_booking($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r`, a)).r;
const failing = (r) => r.checks.filter((c) => !c.ok).map((c) => c.key);
const left = async (id) => (await one(`select credits_remaining n, status from package_purchases where id = $1`, [id]));

const sA = await sess(actA), sB = await sess(actB);
const pkA = await pkg(vA);

// ---- credit ----
await ok('credit: matching vendor passes every check', async () => {
  const p = await purchase(mum, vA, pkA);
  const r = await checks(mum, sA, 'credit', p, null, kid, false);
  assert(r.ok, 'expected ok, failing: ' + failing(r));
  return `${r.checks.length} checks`;
});
await ok('credit: vendor A credit on a vendor B class is refused', async () => {
  const p = await purchase(mum, vA, pkA);
  const r = await checks(mum, sB, 'credit', p, null, kid, false);
  assert(!r.ok && failing(r).includes('vendor_match'), 'vendor_match should fail, got ' + failing(r));
});
await rejects('credit: create refuses the vendor mismatch and spends nothing', async () => {
  const p = await purchase(mum, vA, pkA);
  try { await create([mum, sB, 'credit', p, null, kid, null, null, false, false]); }
  finally { const l = await left(p); assert(l.n === 5, 'credit was spent: ' + l.n); }
}, 'Credit is from Vendor A');
await ok('credit: a pack whose own vendor disagrees with its purchase is refused', async () => {
  const bad = await pkg(vB); // pack says vendor B ...
  const p = await purchase(mum, vA, bad); // ... but the purchase says vendor A
  const r = await checks(mum, sA, 'credit', p, null, kid, false);
  assert(failing(r).includes('vendor_match'), 'vendor_match should fail');
});
await ok('credit: another customer\'s pack is refused', async () => {
  const p = await purchase(other, vA, pkA);
  const r = await checks(mum, sA, 'credit', p, null, kid, false);
  assert(failing(r).includes('owner'), 'owner should fail');
});
await ok('credit: empty, used and expired packs are refused', async () => {
  const empty = await purchase(mum, vA, pkA, 0);
  assert(failing(await checks(mum, sA, 'credit', empty, null, kid, false)).includes('balance'), 'empty');
  const used = await purchase(mum, vA, pkA, 3, 'used');
  assert(failing(await checks(mum, sA, 'credit', used, null, kid, false)).includes('active'), 'used');
  const old = await purchase(mum, vA, pkA, 3, 'active', '2020-01-01');
  assert(failing(await checks(mum, sA, 'credit', old, null, kid, false)).includes('active'), 'expired');
});
await ok('credit: a pack limited to other classes is refused', async () => {
  const lim = await pkg(vA, { activity_ids: [await uid()] });
  const p = await purchase(mum, vA, lim);
  assert(failing(await checks(mum, sA, 'credit', p, null, kid, false)).includes('pack_rules'), 'pack_rules');
});
await ok('credit: a child from another family is refused', async () => {
  const p = await purchase(mum, vA, pkA);
  assert(failing(await checks(mum, sA, 'credit', p, null, otherKid, false)).includes('child'), 'child');
});
await ok('credit: create books, spends exactly one credit, and a second try is a duplicate', async () => {
  const s = await sess(actA);
  const p = await purchase(mum, vA, pkA, 2);
  const r = await create([mum, s, 'credit', p, null, kid, null, null, false, false]);
  assert(r.status === 'confirmed' && r.credits_before === 2 && r.credits_after === 1, JSON.stringify(r));
  const l = await left(p); assert(l.n === 1 && l.status === 'active', 'balance ' + JSON.stringify(l));
  const b = await one(`select package_purchase_id, user_id, provider_id from bookings where id = $1`, [r.booking_id]);
  assert(b.package_purchase_id === p && b.user_id === mum, 'booking not linked');
  try { await create([mum, s, 'credit', p, null, kid, null, null, false, false]); assert(false, 'second booking allowed'); }
  catch (e) { assert(String(e.message).includes('already has a booking'), e.message); }
  assert((await left(p)).n === 1, 'credit spent twice');
});
await ok('credit: the last credit marks the pack used', async () => {
  const p = await purchase(mum, vA, pkA, 1);
  await create([mum, await sess(actA), 'credit', p, null, kid, null, null, false, false]);
  const l = await left(p); assert(l.n === 0 && l.status === 'used', JSON.stringify(l));
});
await ok('credit: a full class is refused and spends nothing', async () => {
  const full = await sess(actA, 1);
  await create([mum, full, 'manual', null, null, null, 'Walk in', null, false, false]);
  const p = await purchase(mum, vA, pkA);
  const r = await checks(mum, full, 'credit', p, null, kid, false);
  assert(failing(r).includes('capacity'), 'capacity');
  assert((await left(p)).n === 5, 'spent');
});
await ok('credit: a class that already started, a Wix class and a term class are refused', async () => {
  const p = await purchase(mum, vA, pkA);
  assert(failing(await checks(mum, await sess(actA, 10, -2), 'credit', p, null, kid, false)).includes('upcoming'), 'started');
  assert(failing(await checks(mum, await sess(actA, 10, 48, `wix_slot_key='k'`), 'credit', p, null, kid, false)).includes('path'), 'wix');
  assert(failing(await checks(mum, await sess(actA, 10, 48, `term_slot_id=gen_random_uuid()`), 'credit', p, null, kid, false)).includes('path'), 'term');
});
await ok('credit: a suspended vendor is refused', async () => {
  const vS = (await one(`insert into providers (business_name, status) values ('Suspended', 'suspended') returning id`)).id;
  const aS = (await one(`insert into activities (provider_id, title) values ($1, 'S') returning id`, [vS])).id;
  const p = await purchase(mum, vS, await pkg(vS));
  assert(failing(await checks(mum, await sess(aS), 'credit', p, null, kid, false)).includes('vendor_active'), 'vendor_active');
});

// ---- token ----
await ok('token: matching vendor passes and create redeems it against the booking', async () => {
  const t = await token(mum, vA, kid);
  const s = await sess(actA);
  const r = await create([mum, s, 'token', null, t, kid, null, null, false, false]);
  const row = await one(`select status, redeemed_booking_id from make_up_tokens where id = $1`, [t]);
  assert(row.status === 'redeemed' && row.redeemed_booking_id === r.booking_id, JSON.stringify(row));
  const b = await one(`select child_id from bookings where id = $1`, [r.booking_id]);
  assert(b.child_id === kid, 'child');
});
await rejects('token: vendor A token on a vendor B class is refused and stays unused', async () => {
  const t = await token(mum, vA, kid);
  try { await create([mum, sB, 'token', null, t, kid, null, null, false, false]); }
  finally { assert((await one(`select status from make_up_tokens where id = $1`, [t])).status === 'issued', 'token was spent'); }
}, 'Token is from Vendor A');
await ok('token: used, expired and other-customer tokens are refused', async () => {
  assert(failing(await checks(mum, sA, 'token', null, await token(mum, vA, kid, 'redeemed'), kid, false)).includes('active'), 'used');
  assert(failing(await checks(mum, sA, 'token', null, await token(mum, vA, kid, 'issued', '2020-01-01'), kid, false)).includes('active'), 'expired');
  assert(failing(await checks(mum, sA, 'token', null, await token(other, vA, otherKid), kid, false)).includes('owner'), 'owner');
});
await ok('token: a token whose cancelled booking was another vendor\'s is refused', async () => {
  const wrongOrigin = (await one(`insert into bookings (user_id, session_id, status, provider_id) values ($1, $2, 'cancelled', $3) returning id`, [mum, sB, vB])).id;
  const t = await token(mum, vA, kid, 'issued', null, wrongOrigin);
  assert(failing(await checks(mum, sA, 'token', null, t, kid, false)).includes('token_origin'), 'token_origin');
});
await ok('token: issued for a different child is refused', async () => {
  const kid2 = (await one(`insert into children (parent_id, name) values ($1, 'Kid 2') returning id`, [mum])).id;
  const t = await token(mum, vA, kid2);
  assert(failing(await checks(mum, sA, 'token', null, t, kid, false)).includes('token_child'), 'token_child');
});

// ---- manual ----
await ok('manual: books a guest with no account and no credit', async () => {
  const r = await create([mum, await sess(actA), 'manual', null, null, null, 'Guest Person', '9123 4567', true, false]);
  const b = await one(`select user_id, guest_name, guest_contact, payment_status, status from bookings where id = $1`, [r.booking_id]);
  assert(b.user_id === null && b.guest_name === 'Guest Person' && b.payment_status === 'paid' && b.status === 'confirmed', JSON.stringify(b));
});
await rejects('manual: a name is required', () => create([mum, sA, 'manual', null, null, null, '  ', null, false, false]), 'name is required');
await ok('manual: a full class is refused unless over-capacity is chosen, then capacity rises by one', async () => {
  const full = await sess(actA, 1);
  await create([mum, full, 'manual', null, null, null, 'First', null, false, false]);
  assert(failing(await checks(mum, full, 'manual', null, null, null, false)).includes('capacity'), 'should be refused');
  try { await create([mum, full, 'manual', null, null, null, 'Second', null, false, false]); assert(false, 'allowed'); }
  catch (e) { assert(String(e.message).includes('full'), e.message); }
  const r = await create([mum, full, 'manual', null, null, null, 'Second', null, false, true]);
  assert(r.capacity_increased === true && r.status === 'confirmed', JSON.stringify(r));
  assert((await one(`select capacity from activity_sessions where id = $1`, [full])).capacity === 2, 'capacity');
});
await ok('manual: over-capacity on a Wix-linked class is refused', async () => {
  const w = await sess(actA, 1, 48, `wix_slot_key='k'`);
  await create([mum, w, 'manual', null, null, null, 'First', null, false, false]);
  assert(failing(await checks(mum, w, 'manual', null, null, null, true)).includes('capacity'), 'capacity');
});

await ok('the functions are not callable by the public roles', async () => {
  for (const f of ['admin_booking_checks(uuid, uuid, text, uuid, uuid, uuid, boolean)', 'admin_create_booking(uuid, uuid, text, uuid, uuid, uuid, text, text, boolean, boolean)']) {
    for (const role of ['anon', 'authenticated', 'public']) {
      const r = await one(`select has_function_privilege($1, 'public.${f}', 'execute') p`, [role === 'public' ? 'anon' : role]);
      assert(!r.p, `${role} can execute ${f}`);
    }
    assert((await one(`select has_function_privilege('service_role', 'public.${f}', 'execute') p`)).p, 'service_role cannot execute');
  }
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
