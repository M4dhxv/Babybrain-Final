/**
 * Behaviour tests for 00273_booking_addons.sql, run against an in-process Postgres (PGlite):
 * no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00273_booking_addons.test.mjs
 *
 * Focus: who can read and write what. A vendor manager manages only their own activity's add-ons,
 * staff cannot, a parent can read their own purchases and nobody can write a purchase from the
 * browser (money only moves through the service-role API routes).
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

create table public.providers (id uuid primary key default gen_random_uuid(), business_name text);
create table public.parent_profiles (id uuid primary key default gen_random_uuid(), full_name text);
create table public.provider_members (user_id uuid, provider_id uuid, role text);
create table public.activities (id uuid primary key default gen_random_uuid(), provider_id uuid, title text, archived_at timestamptz);
create table public.packages (id uuid primary key default gen_random_uuid(), provider_id uuid, name text, activity_ids uuid[], active boolean not null default true);
create table public.activity_sessions (id uuid primary key default gen_random_uuid(), activity_id uuid);
create table public.package_purchases (id uuid primary key default gen_random_uuid(), package_id uuid);
create table public.bookings (id uuid primary key default gen_random_uuid(), user_id uuid, session_id uuid, package_purchase_id uuid);

create function public.user_provider_ids() returns setof uuid language sql stable security definer as $$
  select provider_id from public.provider_members where user_id = auth.uid() $$;
create function public.user_manage_provider_ids() returns setof uuid language sql stable security definer as $$
  select provider_id from public.provider_members where user_id = auth.uid() and role in ('owner','manager') $$;
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
/** Run as a signed-in user under row-level security. */
async function as(user, fn) {
  await db.exec(`set role authenticated; select set_config('test.uid', '${user}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('test.uid', '', false);`); }
}

await db.exec(stub);
await db.exec(file('00273_booking_addons.sql'));
await db.exec(`grant all on all tables in schema public to authenticated; grant usage on schema auth to authenticated;`);
// Run the migration a second time: it must be idempotent.
await db.exec(file('00273_booking_addons.sql'));

// ---- fixtures ----
const uuid = async () => (await one(`select gen_random_uuid() id`)).id;
const vA = (await one(`insert into providers (business_name) values ('Vendor A') returning id`)).id;
const vB = (await one(`insert into providers (business_name) values ('Vendor B') returning id`)).id;
const manager = await uuid(), staff = await uuid(), rival = await uuid();
await db.query(`insert into provider_members values ($1,$2,'manager'), ($3,$2,'staff'), ($4,$5,'owner')`, [manager, vA, staff, rival, vB]);
const mum = (await one(`insert into parent_profiles (full_name) values ('Mum') returning id`)).id;
const dad = (await one(`insert into parent_profiles (full_name) values ('Dad') returning id`)).id;
const actA = (await one(`insert into activities (provider_id, title) values ($1, 'A class') returning id`, [vA])).id;
const actB = (await one(`insert into activities (provider_id, title) values ($1, 'B class') returning id`, [vB])).id;
const booking = (await one(`insert into bookings (user_id) values ($1) returning id`, [mum])).id;

const addAddon = (user, prov, act, name = 'Adult', price = 1200) =>
  as(user, () => one(`insert into activity_addons (activity_id, provider_id, name, price_cents) values ($1,$2,$3,$4) returning id`, [act, prov, name, price]));

// ---- catalogue ----
let adult;
await ok('manager adds an add-on to their own activity', async () => { adult = (await addAddon(manager, vA, actA)).id; assert(adult, 'no id'); });
await rejects('staff cannot add an add-on', () => addAddon(staff, vA, actA, 'Sibling', 800), 'row-level security');
await rejects('a manager cannot add one to another vendor\'s activity', () => addAddon(manager, vA, actB), 'row-level security');
await rejects('a manager cannot claim another provider id on their activity', () => addAddon(rival, vB, actA), 'row-level security');
await rejects('a negative price is refused', () => addAddon(manager, vA, actA, 'Free', -1), 'activity_addons_price_cents_check');
await rejects('a blank name is refused', () => addAddon(manager, vA, actA, '   '), 'activity_addons_name_check');
await rejects('a per-booking cap above 10 is refused', () =>
  as(manager, () => db.query(`insert into activity_addons (activity_id, provider_id, name, max_per_booking) values ($1,$2,'X',11)`, [actA, vA])), 'max_per_booking');
await ok('a free (zero-price) add-on is allowed', async () => { await addAddon(manager, vA, actA, 'Parent', 0); });
const ageInsert = (min, max) =>
  as(manager, () => db.query(`insert into activity_addons (activity_id, provider_id, name, min_age, max_age) values ($1,$2,'Aged',$3,$4)`, [actA, vA, min, max]));
await rejects('an age range with min above max is refused', () => ageInsert(15, 12), 'activity_addons_age_order');
await rejects('a negative age is refused', () => ageInsert(-1, null), 'min_age');
await rejects('an age above 120 is refused', () => ageInsert(null, 121), 'max_age');
await ok('child (up to 12), adult (15+) and open ranges are allowed', async () => {
  await ageInsert(null, 12); await ageInsert(15, null); await ageInsert(null, null);
  await db.query(`delete from activity_addons where name = 'Aged'`);
});
await ok('anyone signed in can read an active add-on', async () => {
  const rows = await as(dad, () => all(`select name from activity_addons where activity_id = $1`, [actA]));
  assert(rows.length === 2, `expected 2, got ${rows.length}`);
});
await ok('a hidden add-on is invisible to parents but visible to the vendor team', async () => {
  await as(manager, () => db.query(`update activity_addons set active = false where id = $1`, [adult]));
  const parent = await as(dad, () => all(`select name from activity_addons where id = $1`, [adult]));
  const team = await as(staff, () => all(`select name from activity_addons where id = $1`, [adult]));
  assert(parent.length === 0, 'a parent can see a hidden add-on');
  assert(team.length === 1, 'staff cannot see their own hidden add-on');
  await as(manager, () => db.query(`update activity_addons set active = true where id = $1`, [adult]));
});
await ok('staff cannot edit or delete an add-on', async () => {
  const u = await as(staff, () => db.query(`update activity_addons set price_cents = 1 where id = $1`, [adult]));
  const d = await as(staff, () => db.query(`delete from activity_addons where id = $1`, [adult]));
  assert(u.affectedRows === 0 && d.affectedRows === 0, 'staff changed a row');
});

// ---- companion mode, additional people, pack exclusivity ----
await ok('activities default to no companion and no additional people', async () => {
  const r = await one(`select companion_enabled, companion_count, companion_type, allow_additional_people from activities where id = $1`, [actA]);
  assert(r.companion_enabled === false && r.companion_count === 1 && r.companion_type === 'adult' && r.allow_additional_people === false, JSON.stringify(r));
});
await rejects('more than 4 companions is refused', () => db.query(`update activities set companion_count = 5 where id = $1`, [actA]), 'companion_count');
await rejects('a companion type other than adult or child is refused', () => db.query(`update activities set companion_type = 'senior' where id = $1`, [actA]), 'companion_type');
const actA2 = (await one(`insert into activities (provider_id, title) values ($1, 'A second class') returning id`, [vA])).id;
const pack = (ids, active = true) => db.query(`insert into packages (provider_id, name, activity_ids, active) values ($1,'Pack',$2,$3)`, [vA, ids, active]);
await ok('companion mode can be turned on when no pack reaches the class', async () => {
  await db.query(`update activities set companion_enabled = true, companion_type = 'adult' where id = $1`, [actA]);
});
await rejects('a pack for any class is refused while a companion class exists', () => pack(null), 'companion-mode class');
await rejects('a pack covering the companion class and another class is refused', () => pack([actA, actA2]), 'that class only');
await ok('a pack for the companion class alone is allowed', async () => { await pack([actA]); });
await ok('a pack for other classes only is allowed', async () => { await pack([actA2]); });
await ok('a paused any-class pack is allowed', async () => { await pack(null, false); });
await rejects('un-pausing that any-class pack is refused', () => db.query(`update packages set active = true where activity_ids is null`), 'companion-mode class');
await ok('turning companion mode off frees the packs again', async () => {
  await db.query(`update activities set companion_enabled = false where id = $1`, [actA]);
  await db.query(`update packages set active = true where activity_ids is null`);
});
await rejects('companion mode cannot be turned on while an any-class pack is active', () => db.query(`update activities set companion_enabled = true where id = $1`, [actA]), 'packs to be for this class only');
await ok('companion mode turns on once that pack is paused or restricted', async () => {
  await db.query(`update packages set active = false where activity_ids is null`);
  await db.query(`update activities set companion_enabled = true where id = $1`, [actA]);
});
await db.query(`update activities set companion_enabled = false where id = $1`, [actA]);
await db.query(`delete from packages`);

// ---- old credits on a companion class ----
const sessA = (await one(`insert into activity_sessions (activity_id) values ($1) returning id`, [actA])).id;
const sessA2 = (await one(`insert into activity_sessions (activity_id) values ($1) returning id`, [actA2])).id;
const mkPack = async (ids, active) => (await one(`insert into packages (provider_id, name, activity_ids, active) values ($1,'P',$2,$3) returning id`, [vA, ids, active])).id;
const mkPurchase = async (packId) => (await one(`insert into package_purchases (package_id) values ($1) returning id`, [packId])).id;
const credAny = await mkPurchase(await mkPack(null, true));
const credBoth = await mkPurchase(await mkPack([actA, actA2], true));
const credOwn = await mkPurchase(await mkPack([actA], true));
const seat = (sess, purchase) => db.query(`insert into bookings (user_id, session_id, package_purchase_id) values ($1,$2,$3)`, [mum, sess, purchase]);
await ok('any-class and multi-class credits still book a class without a companion', async () => {
  await seat(sessA, credAny); await seat(sessA, credBoth);
});
await db.query(`update packages set active = false where activity_ids is null or array_length(activity_ids,1) > 1`);
await db.query(`update activities set companion_enabled = true where id = $1`, [actA]);
await rejects('an old any-class credit is refused on a companion class', () => seat(sessA, credAny), 'pack made for this class alone');
await rejects('an old multi-class credit is refused on a companion class', () => seat(sessA, credBoth), 'pack made for this class alone');
await ok('a credit from a pack for that class alone is accepted', async () => { await seat(sessA, credOwn); });
await ok('an old credit still works on a different class', async () => { await seat(sessA2, credBoth); });
await ok('a booking with no credit is unaffected', async () => { await seat(sessA, null); });
await ok('moving an existing credit booking is not blocked', async () => {
  await db.query(`update bookings set session_id = $1 where package_purchase_id = $2`, [sessA, credOwn]);
});
await rejects('attaching an old credit to an existing seat is refused', async () => {
  const b = (await one(`insert into bookings (user_id, session_id) values ($1,$2) returning id`, [mum, sessA])).id;
  await db.query(`update bookings set package_purchase_id = $1 where id = $2`, [credAny, b]);
}, 'pack made for this class alone');
await db.query(`update activities set companion_enabled = false where id = $1`, [actA]);
await db.query(`delete from bookings where session_id is not null`);
await db.query(`delete from packages`);

// ---- purchases ----
const insertPurchase = (user, status = 'paid') =>
  as(user, () => db.query(
    `insert into booking_addons (booking_id, user_id, provider_id, addon_id, name, unit_price_cents, quantity, payment_status) values ($1,$2,$3,$4,'Adult',1200,1,$5)`,
    [booking, mum, vA, adult, status]));
await rejects('a parent cannot write a purchase from the browser', () => insertPurchase(mum), 'row-level security');
await rejects('a vendor cannot write a purchase from the browser', () => insertPurchase(manager), 'row-level security');
await db.query(`insert into booking_addons (booking_id, user_id, provider_id, addon_id, name, unit_price_cents, quantity, person_names, payment_status) values ($1,$2,$3,$4,'Adult',1200,2,'{Mum,Dad}','paid')`, [booking, mum, vA, adult]);
await ok('the booking parent reads their purchase', async () => {
  const r = await as(mum, () => all(`select quantity from booking_addons`));
  assert(r.length === 1 && r[0].quantity === 2, 'parent cannot read their own purchase');
});
await ok('another parent cannot read it', async () => {
  const r = await as(dad, () => all(`select quantity from booking_addons`));
  assert(r.length === 0, 'a stranger can read a purchase');
});
await ok('the vendor team reads it, a rival vendor does not', async () => {
  const mine = await as(staff, () => all(`select quantity from booking_addons`));
  const theirs = await as(rival, () => all(`select quantity from booking_addons`));
  assert(mine.length === 1, 'staff cannot read their purchases');
  assert(theirs.length === 0, 'a rival vendor can read them');
});
await ok('a purchase keeps each person\'s age and the age range it was bought under', async () => {
  await db.query(`insert into booking_addons (booking_id, user_id, provider_id, name, unit_price_cents, quantity, person_names, person_ages, age_min, age_max, payment_status) values ($1,$2,$3,'Child',800,2,'{Leo,""}','{9,null}',null,12,'paid')`, [booking, mum, vA]);
  const r = await as(mum, () => one(`select person_ages, age_max from booking_addons where name = 'Child'`));
  assert(r.person_ages.length === 2 && r.person_ages[0] === 9 && r.person_ages[1] === null && r.age_max === 12, JSON.stringify(r));
  await db.query(`delete from booking_addons where name = 'Child'`);
});
await ok('a free companion row is kept like any purchase, with its kind', async () => {
  await db.query(`insert into booking_addons (booking_id, user_id, provider_id, name, unit_price_cents, quantity, person_names, person_ages, kind, payment_status) values ($1,$2,$3,'Companion',0,1,'{Sam}','{34}','companion','paid')`, [booking, mum, vA]);
  const r = await as(mum, () => one(`select kind, unit_price_cents from booking_addons where kind = 'companion'`));
  assert(r.kind === 'companion' && r.unit_price_cents === 0, JSON.stringify(r));
  await db.query(`delete from booking_addons where kind = 'companion'`);
});
await rejects('an unknown purchase kind is refused', () =>
  db.query(`insert into booking_addons (booking_id, user_id, provider_id, name, unit_price_cents, quantity, kind) values ($1,$2,$3,'X',0,1,'gift')`, [booking, mum, vA]), 'kind');
await rejects('a quantity of zero is refused', () =>
  db.query(`insert into booking_addons (booking_id, user_id, provider_id, name, unit_price_cents, quantity) values ($1,$2,$3,'Adult',100,0)`, [booking, mum, vA]), 'quantity');
await rejects('an unknown payment status is refused', () =>
  db.query(`insert into booking_addons (booking_id, user_id, provider_id, name, unit_price_cents, quantity, payment_status) values ($1,$2,$3,'Adult',100,1,'refunded')`, [booking, mum, vA]), 'payment_status');
await ok('removing an add-on keeps what a parent already paid (name and price are copied)', async () => {
  await db.query(`delete from activity_addons where id = $1`, [adult]);
  const r = await as(mum, () => one(`select name, unit_price_cents, addon_id from booking_addons`));
  assert(r.name === 'Adult' && r.unit_price_cents === 1200 && r.addon_id === null, JSON.stringify(r));
});
await ok('deleting the booking removes its purchases', async () => {
  await db.query(`delete from bookings where id = $1`, [booking]);
  const n = (await one(`select count(*)::int n from booking_addons`)).n;
  assert(n === 0, `${n} purchases left behind`);
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
