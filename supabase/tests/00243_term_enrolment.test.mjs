/**
 * Behaviour tests for 00243_term_enrolment.sql, run against an in-process
 * Postgres (PGlite) — no database, no Docker, nothing touches production.
 *
 *   npm i --no-save @electric-sql/pglite
 *   node supabase/tests/00243_term_enrolment.test.mjs
 *
 * The tables and triggers this migration leans on (bookings, activity_sessions,
 * book_party, the capacity and defaults triggers, vendor_cancel_session) are
 * replaced by small stand-ins below, so this checks the term rules themselves:
 * publishing, the booking gate, enrol / trial / single, mid-term pricing,
 * skip dates and per-day times. It is not a substitute for running the real
 * migration chain on a staging database before it ships.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATION = fileURLToPath(new URL('../migrations/00243_term_enrolment.sql', import.meta.url));
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
  id uuid primary key default gen_random_uuid(), provider_id uuid, title text, price numeric,
  bookings_paused boolean default false, booking_cutoff_minutes int default 15,
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
  checkout_started_at timestamptz, created_at timestamptz default now());

create function public.user_provider_ids() returns setof uuid language sql stable as $$
  select provider_id from public.provider_members where user_id = auth.uid() $$;
create function public.user_manage_provider_ids() returns setof uuid language sql stable as $$
  select provider_id from public.provider_members where user_id = auth.uid() and role in ('owner','manager') $$;

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
  return query select g, st, 0;
end $$;

create function public.vendor_cancel_session(p_session_id uuid) returns integer language plpgsql security definer as $$
declare v_provider uuid; n int;
begin
  select a.provider_id into v_provider from public.activity_sessions s join public.activities a on a.id = s.activity_id where s.id = p_session_id;
  if v_provider not in (select public.user_provider_ids()) then raise exception 'not authorized'; end if;
  update public.activity_sessions set status = 'cancelled' where id = p_session_id;
  update public.bookings set status = 'cancelled' where session_id = p_session_id and status in ('pending','confirmed','waitlisted');
  get diagnostics n = row_count;
  return n;
end $$;
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
const all = async (sql, params) => (await db.query(sql, params)).rows;

await db.exec(stub);
await ok('migration applies', async () => { await db.exec(readFileSync(MIGRATION, 'utf8')); });
await ok('migration is idempotent (second run)', async () => { await db.exec(readFileSync(MIGRATION, 'utf8')); });

// --- fixtures
const P = (await one(`insert into providers default values returning id`)).id;
const VENDOR = '11111111-1111-1111-1111-111111111111';
const PARENT = '22222222-2222-2222-2222-222222222222';
const PARENT2 = '33333333-3333-3333-3333-333333333333';
await db.query(`insert into provider_members (user_id, provider_id) values ($1, $2)`, [VENDOR, P]);
await db.query(`insert into parent_profiles (id) values ($1), ($2)`, [PARENT, PARENT2]);
const CHILD = (await one(`insert into children (parent_id, name) values ($1, 'Emma') returning id`, [PARENT])).id;
const CHILD2 = (await one(`insert into children (parent_id, name) values ($1, 'Noah') returning id`, [PARENT2])).id;
const A = (await one(`insert into activities (provider_id, title, price) values ($1, 'Swim', 40) returning id`, [P])).id;
// A second activity that has NOT switched terms on.
const A_OFF = (await one(`insert into activities (provider_id, title, price) values ($1, 'Music', 30) returning id`, [P])).id;
await db.query(`update activities set terms_enabled = true where id = $1`, [A]);

// first class: a Saturday ~10 days out, in Singapore time
const startDate = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 7, 'YYYY-MM-DD') as d`)).d;
const pattern = { days: [6], time: '09:00', duration: 45, start: startDate, weeks: 10, skip: [], perDay: false, dayTimes: {} };
await asUser(VENDOR);
const T = (await one(
  `insert into terms (provider_id, activity_id, name, price_cents, min_left, reduce_enabled, reduce_by_cents, allow_singles)
   values ($1, $2, 'Term 4', 40000, 3, true, 4000, true) returning id`, [P, A])).id;
const S = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 10, $2) returning id`, [T, JSON.stringify(pattern)])).id;

await ok('a draft term has no classes yet', async () => {
  const n = (await one(`select count(*)::int n from activity_sessions where term_slot_id = $1`, [S])).n;
  if (n !== 0) throw new Error(`expected 0, got ${n}`);
});
await rejects('a parent cannot publish', async () => { await asUser(PARENT); await db.query(`select publish_term($1)`, [T]); }, 'not authorized');
await asUser(VENDOR);
await ok('publish writes 10 classes', async () => {
  const r = await one(`select publish_term($1) as n`, [T]);
  if (r.n !== 10) throw new Error(`expected 10, got ${r.n}`);
  const s = await all(`select starts_at at time zone 'Asia/Singapore' as local, term_session_no, price from activity_sessions where term_slot_id = $1 order by term_session_no`, [S]);
  return `${s.length} sessions, first ${s[0].local.toISOString?.() ?? s[0].local}, rate ${s[0].price}`;
});
await rejects('cannot publish twice', async () => { await db.query(`select publish_term($1)`, [T]); }, 'already published');
await rejects('a published slot pattern is frozen', async () => {
  await db.query(`update term_slots set pattern = jsonb_set(pattern, '{time}', '"10:00"') where id = $1`, [S]);
}, 'fixed');

await asUser(PARENT);
await ok('quote before the first class', async () => {
  const q = await one(`select * from term_quote($1)`, [S]);
  if (!(q.sessions_total === 10 && q.sessions_passed === 0 && q.joinable && q.price_cents === 40000)) throw new Error(JSON.stringify(q));
  return JSON.stringify(q);
});

const firstSession = (await one(`select id from activity_sessions where term_slot_id = $1 order by term_session_no limit 1`, [S])).id;
await rejects('plain booking of a term class is refused (book_party)', async () => {
  await db.query(`select * from book_party($1, $2)`, [firstSession, CHILD]);
}, 'part of a term');
await rejects('direct insert cannot self-declare a kind', async () => {
  await db.query(`insert into bookings (user_id, session_id, term_booking_kind) values ($1, $2, 'term')`, [PARENT, firstSession]);
}, 'part of a term');

let ENROL;
await ok('enrol creates a seat in every class', async () => {
  const r = await one(`select * from enrol_in_term($1, $2)`, [S, CHILD]);
  ENROL = r;
  const n = await one(`select count(*)::int n, count(distinct session_id)::int d, bool_and(term_booking_kind = 'term') k, bool_and(status = 'pending') p
                         from bookings where booking_group_id = $1`, [r.group_id]);
  if (!(n.n === 10 && n.d === 10 && n.k && n.p)) throw new Error(JSON.stringify(n));
  if (r.price_cents !== 40000 || r.sessions !== 10) throw new Error(JSON.stringify(r));
  return `${r.sessions} classes, ${r.price_cents} cents, ${r.status}`;
});
await ok('enrolling again returns the same unpaid attempt', async () => {
  const r = await one(`select * from enrol_in_term($1, $2)`, [S, CHILD]);
  if (r.group_id !== ENROL.group_id) throw new Error('different group');
  const n = (await one(`select count(*)::int n from bookings where user_id = $1`, [PARENT])).n;
  if (n !== 10) throw new Error(`bookings ${n}`);
});
await ok('the enrolment is linked and the gate stamped the rows', async () => {
  const n = (await one(`select count(*)::int n from bookings where term_enrolment_id = $1`, [ENROL.enrolment_id])).n;
  if (n !== 10) throw new Error(`linked ${n}`);
});

// capacity: someone else tries a slot whose 4th class is already full
await asUser(VENDOR);
await db.query(`update activity_sessions set capacity = 1 where term_slot_id = $1 and term_session_no = 4`, [S]);
await asUser(PARENT2);
await rejects('enrolling is refused if any class is full', async () => {
  await db.query(`select * from enrol_in_term($1, $2)`, [S, CHILD2]);
}, 'full');
await ok('...and nothing was written for the refused enrolment', async () => {
  const n = (await one(`select count(*)::int n from bookings where user_id = $1`, [PARENT2])).n;
  if (n !== 0) throw new Error(`bookings ${n}`);
});
await asUser(VENDOR);
await db.query(`update activity_sessions set capacity = 10 where term_slot_id = $1`, [S]);

// singles
await asUser(PARENT2);
await ok('a single class can be booked while singles are on', async () => {
  const r = await one(`select * from book_term_class($1, 'single', $2)`, [firstSession, CHILD2]);
  const k = await one(`select term_booking_kind k from bookings where booking_group_id = $1`, [r.group_id]);
  if (k.k !== 'single') throw new Error(JSON.stringify(k));
  return r.status;
});
await rejects('a trial is refused when trial is off', async () => {
  await db.query(`select * from book_term_class($1, 'trial', $2)`, [firstSession, CHILD2]);
}, 'no trial');

await asUser(VENDOR);
await ok('trial and single can both be on', async () => {
  await db.query(`update terms set allow_trial = true, trial_price_cents = 2000, trial_limit = 1 where id = $1`, [T]);
  const r = await one(`select allow_trial, allow_singles from terms where id = $1`, [T]);
  if (!(r.allow_trial && r.allow_singles)) throw new Error(JSON.stringify(r));
});
await asUser(PARENT2);
const fourth = (await one(`select id from activity_sessions where term_slot_id = $1 and term_session_no = 4`, [S])).id;
const fifth = (await one(`select id from activity_sessions where term_slot_id = $1 and term_session_no = 5`, [S])).id;
await rejects('both on: a single session is refused while the child has a trial left', async () => {
  await db.query(`select * from book_term_class($1, 'single', $2)`, [fourth, CHILD2]);
}, 'trial session first');
await ok('both on: a trial first, and the child has one left before it', async () => {
  const before = await one(`select * from term_trial_remaining($1, $2)`, [A, CHILD2]);
  if (!(before.remaining === 1 && before.trial_limit === 1)) throw new Error('before ' + JSON.stringify(before));
  await db.query(`select * from book_term_class($1, 'trial', $2)`, [fourth, CHILD2]);
  const after = await one(`select * from term_trial_remaining($1, $2)`, [A, CHILD2]);
  if (!(after.used === 1 && after.remaining === 0)) throw new Error('after ' + JSON.stringify(after));
  return 'remaining 1 -> 0';
});
await rejects('both on: a second trial is refused once the limit is used', async () => {
  await db.query(`select * from book_term_class($1, 'trial', $2)`, [fifth, CHILD2]);
}, 'limit');
await ok('both on: single sessions are still offered after the trial is used', async () => {
  const r = await one(`select * from book_term_class($1, 'single', $2)`, [fifth, CHILD2]);
  return r.status;
});
await rejects("term_trial_remaining will not answer for someone else's child", async () => {
  await db.query(`select * from term_trial_remaining($1, $2)`, [A, CHILD]);
}, 'no longer on your profile');
await asUser(VENDOR);
await db.query(`update terms set allow_singles = false where id = $1`, [T]);
await asUser(PARENT2);
await rejects('singles refused once switched to trial', async () => {
  const second = (await one(`select id from activity_sessions where term_slot_id = $1 and term_session_no = 2`, [S])).id;
  await db.query(`select * from book_term_class($1, 'single', $2)`, [second, CHILD2]);
}, 'not offered');
const second = (await one(`select id from activity_sessions where term_slot_id = $1 and term_session_no = 2`, [S])).id;
const third = (await one(`select id from activity_sessions where term_slot_id = $1 and term_session_no = 3`, [S])).id;
await rejects('trial still refused for a child who has used theirs (trial-only now)', async () => {
  await db.query(`select * from book_term_class($1, 'trial', $2)`, [second, CHILD2]);
}, 'limit');
await ok('a child with no trial used can take one (trial-only now)', async () => {
  const kid = (await one(`insert into children (parent_id, name) values ($1, 'Mia') returning id`, [PARENT2])).id;
  const r = await one(`select * from book_term_class($1, 'trial', $2)`, [third, kid]);
  return r.status;
});

// mid-term pricing
await asUser(VENDOR);
await db.query(`update activity_sessions set starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '45 minutes'
                where term_slot_id = $1 and term_session_no <= 3`, [S]);
await asUser(PARENT);
await ok('after 3 sessions: 7 left, price reduced by 3 x 40', async () => {
  const q = await one(`select * from term_quote($1)`, [S]);
  if (!(q.sessions_passed === 3 && q.sessions_left === 7 && q.joinable && q.price_cents === 28000)) throw new Error(JSON.stringify(q));
  return JSON.stringify(q);
});
await asUser(VENDOR);
await db.query(`update activity_sessions set starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '45 minutes'
                where term_slot_id = $1 and term_session_no <= 8`, [S]);
await asUser(PARENT);
await ok('with 2 left the term is closed to joiners', async () => {
  const q = await one(`select * from term_quote($1)`, [S]);
  if (q.joinable !== false) throw new Error(JSON.stringify(q));
  return q.reason;
});

// vendor skips a class
await asUser(VENDOR);
const tenth = (await one(`select id from activity_sessions where term_slot_id = $1 and term_session_no = 10`, [S])).id;
await ok('skipping a class cancels it and records the date', async () => {
  const n = await one(`select skip_term_class($1) as n`, [tenth]);
  const row = await one(`select pattern->'skip' as skip, session_count from term_slots where id = $1`, [S]);
  const s = await one(`select status from activity_sessions where id = $1`, [tenth]);
  if (s.status !== 'cancelled' || row.skip.length !== 1 || row.session_count !== 9) throw new Error(JSON.stringify({ n, row, s }));
  return `cancelled ${n.n} booking(s), skip ${JSON.stringify(row.skip)}`;
});
await rejects('a parent cannot skip a class', async () => { await asUser(PARENT); await db.query(`select skip_term_class($1)`, [tenth]); }, 'not authorized');

await asUser(VENDOR);
await ok('per-day times: Monday 16:00 and Wednesday 17:30 (60 min)', async () => {
  const T2 = (await one(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'Term 5', 10000) returning id`, [P, A])).id;
  const mon = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((1 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 14, 'YYYY-MM-DD') as d`)).d;
  const pat = { days: [1, 3], time: '09:00', duration: 45, start: mon, weeks: 2, skip: [], perDay: true,
    dayTimes: { '1': { time: '16:00', duration: 45 }, '3': { time: '17:30', duration: 60 } } };
  const S2 = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 8, $2) returning id`, [T2, JSON.stringify(pat)])).id;
  const n = (await one(`select publish_term($1) as n`, [T2])).n;
  const rows = await all(
    `select to_char(starts_at at time zone 'Asia/Singapore', 'Dy HH24:MI') as t, extract(epoch from ends_at - starts_at)/60 as mins
       from activity_sessions where term_slot_id = $1 order by starts_at`, [S2]);
  const got = rows.map((r) => `${r.t}/${Math.round(Number(r.mins))}`).join(', ');
  if (n !== 4 || got !== 'Mon 16:00/45, Wed 17:30/60, Mon 16:00/45, Wed 17:30/60') throw new Error(`${n} ${got}`);
  return got;
});

// The per-activity switch.
await asUser(VENDOR);
await rejects('publishing is refused while the activity has terms switched off', async () => {
  const t = (await one(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, 'Off', 5000) returning id`, [P, A_OFF])).id;
  const sat = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + 14, 'YYYY-MM-DD') as d`)).d;
  await db.query(`insert into term_slots (term_id, capacity, pattern) values ($1, 8, $2)`,
    [t, JSON.stringify({ days: [new Date(sat + 'T00:00:00Z').getUTCDay()], time: '09:00', duration: 45, start: sat, weeks: 2, skip: [] })]);
  await db.query(`select publish_term($1)`, [t]);
}, 'Turn on');
await rejects('terms cannot be switched off under a running term', async () => {
  await db.query(`update activities set terms_enabled = false where id = $1`, [A]);
}, 'still has sessions to run');
await ok('terms can be switched off where no term is running', async () => {
  await db.query(`update activities set terms_enabled = true where id = $1`, [A_OFF]);
  await db.query(`update activities set terms_enabled = false where id = $1`, [A_OFF]);
});

// Headline price: trial, else single, else lowest term.
await asUser(PARENT);
await ok('headline price: trial class wins when a term has one', async () => {
  // Term 4 was switched to a trial class (2000 cents) earlier in this file.
  const r = await one(`select * from term_headline_prices(array[$1::uuid])`, [A]);
  if (!(r && r.kind === 'trial' && r.price_cents === 2000)) throw new Error(JSON.stringify(r));
  return JSON.stringify(r);
});
await asUser(VENDOR);
await ok('headline price: single class when no trial is on', async () => {
  await db.query(`update terms set allow_trial = false where activity_id = $1`, [A]);
  await db.query(`update terms set allow_singles = true, single_price_cents = 3300 where id = $1`, [T]);
  const r = await one(`select * from term_headline_prices(array[$1::uuid])`, [A]);
  if (!(r.kind === 'single' && r.price_cents === 3300)) throw new Error(JSON.stringify(r));
  return JSON.stringify(r);
});
await ok('headline price: lowest term price when neither is on', async () => {
  await db.query(`update terms set allow_singles = false where activity_id = $1`, [A]);
  const r = await one(`select * from term_headline_prices(array[$1::uuid])`, [A]);
  // Term 4 is 40000, the 30-week "Long term" and "Twelve" are 10000 each, the per-day term is 10000.
  if (!(r.kind === 'term' && r.price_cents === 10000)) throw new Error(JSON.stringify(r));
  return JSON.stringify(r);
});
await ok('headline price: nothing when terms are switched off', async () => {
  const r = await all(`select * from term_headline_prices(array[$1::uuid])`, [A_OFF]);
  if (r.length !== 0) throw new Error(JSON.stringify(r));
});

// Packages: an activity whose running terms all refuse packages is closed to them.
await asUser(PARENT);
await ok('packages: open while a running term accepts them', async () => {
  const r = await all(`select * from activity_packages_closed(array[$1::uuid])`, [A]);
  if (r.length !== 0) throw new Error(JSON.stringify(r));
});
await asUser(VENDOR);
await ok('packages: closed once no running term accepts them', async () => {
  await db.query(`update terms set allow_packages = false where activity_id = $1`, [A]);
  const r = await all(`select * from activity_packages_closed(array[$1::uuid])`, [A]);
  if (!(r.length === 1 && r[0].activity_id === A)) throw new Error(JSON.stringify(r));
  await db.query(`update terms set allow_packages = true where activity_id = $1`, [A]);
});
await ok('packages: an activity with terms switched off is never closed', async () => {
  const r = await all(`select * from activity_packages_closed(array[$1::uuid])`, [A_OFF]);
  if (r.length !== 0) throw new Error(JSON.stringify(r));
});

// A term is as long as the vendor says: well past 10 classes, and an exact count.
async function publishSat(name, patch) {
  const t = (await one(`insert into terms (provider_id, activity_id, name, price_cents) values ($1, $2, $3, 10000) returning id`, [P, A, name])).id;
  const sat = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 21, 'YYYY-MM-DD') as d`)).d;
  const pat = { days: [6], time: '09:00', duration: 45, start: sat, weeks: 1, skip: [], perDay: false, dayTimes: {}, ...patch };
  const sl = (await one(`insert into term_slots (term_id, capacity, pattern) values ($1, 8, $2) returning id`, [t, JSON.stringify(pat)])).id;
  const n = (await one(`select publish_term($1) as n`, [t])).n;
  const last = (await one(`select to_char(max(starts_at at time zone 'Asia/Singapore'), 'YYYY-MM-DD') as d from activity_sessions where term_slot_id = $1`, [sl])).d;
  return { n, last, start: sat };
}
await asUser(VENDOR);
await ok('30 weekly classes is allowed (no cap at 10 or 26)', async () => {
  const r = await publishSat('Long term', { weeks: 30 });
  if (r.n !== 30) throw new Error(`expected 30, got ${r.n}`);
  return `${r.n} classes`;
});
await ok('by sessions: exactly 12, skipped dates do not count', async () => {
  const sat = (await one(`select to_char((now() at time zone 'Asia/Singapore')::date + ((6 - extract(dow from (now() at time zone 'Asia/Singapore')::date)::int + 7) % 7) + 21, 'YYYY-MM-DD') as d`)).d;
  const skipTwo = await one(`select to_char($1::date + 7, 'YYYY-MM-DD') as a, to_char($1::date + 21, 'YYYY-MM-DD') as b`, [sat]);
  const r = await publishSat('Twelve', { count: 12, skip: [skipTwo.a, skipTwo.b] });
  if (r.n !== 12) throw new Error(`expected 12, got ${r.n}`);
  // 12 classes + 2 skipped Saturdays = the 14th Saturday is the last.
  const expectLast = (await one(`select to_char($1::date + 7 * 13, 'YYYY-MM-DD') as d`, [sat])).d;
  if (r.last !== expectLast) throw new Error(`last ${r.last}, expected ${expectLast}`);
  return `${r.n} classes, last ${r.last}`;
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
