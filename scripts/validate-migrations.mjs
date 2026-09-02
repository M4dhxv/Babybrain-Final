/**
 * Check that the database actually matches supabase/migrations.
 *
 *   node scripts/validate-migrations.mjs
 *
 * Three questions, in order of how badly getting them wrong hurt us:
 *
 *   1. Is every migration file recorded in supabase_migrations.schema_migrations?
 *      apply-migration.mjs used to apply without recording, so that table saw
 *      only CLI-applied migrations and drifted 15 behind.
 *   2. Does every object the migrations leave behind (table, column, function,
 *      index, policy, type) exist?
 *   3. Does every live function BODY match the last migration that defines it?
 *
 * (3) is the one that matters. 00068_package_multi_activity.sql half-applied
 * in production: the DDL landed, the function was never re-created, and it
 * kept referencing a dropped column until it blew up on a parent's checkout
 * screen. Existence checks say nothing about that — only the body does.
 *
 * Objects are tracked as a ledger applied in migration order: a create adds,
 * a drop removes. Checking creates alone would demand that everything ever
 * created still exists — 00013 drops the "anyone logs a view" policy 00007
 * created, and that is correct, not drift.
 *
 * Read-only. Safe to run against production.
 */
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { parseDbUrl } from './lib/db-url.mjs';

process.loadEnvFile('.env.local');
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require' });

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };

const bare = (s) => s.replace(/"/g, '');
/** `storage.objects` -> ['storage','objects']; `foo` -> ['public','foo']. */
const split = (s) => { const p = bare(s).split('.'); return p.length > 1 ? [p[0], p[1]] : ['public', p[0]]; };
// Comments and whitespace differ freely between a migration file and what
// Postgres stores; nothing else should.
const norm = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const key = (o) => [o.kind, o.schema, o.table, o.name].join('|');

const DIR = 'supabase/migrations';
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

/** Ordered create/drop events for one file. */
function parse(text) {
  const src = text.replace(/--[^\n]*/g, '');
  const ev = [];
  const add = (at, op, o) => ev.push({ at, op, obj: o });

  // Function bodies are dollar-quoted with either $$ or $function$, and are
  // created both as `create or replace function` and as `drop function` +
  // `create function`. Miss either form and you get false positives.
  for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\([\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\2/gi)) {
    const [schema, name] = split(m[1]);
    add(m.index, 'add', { kind: 'function', schema, name, body: m[3] });
  }
  for (const m of src.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?([\w."]+)/gi)) {
    const [schema, name] = split(m[1]);
    add(m.index, 'del', { kind: 'function', schema, name });
  }

  // Strip dollar-quoted bodies before looking for DDL, so SQL *inside* a
  // function is not mistaken for a top-level statement.
  const t = src.replace(/\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/gi, (s) => ' '.repeat(s.length));
  const simple = [
    ['table', /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi, /drop\s+table\s+(?:if\s+exists\s+)?([\w."]+)/gi],
    ['type', /create\s+type\s+([\w."]+)/gi, /drop\s+type\s+(?:if\s+exists\s+)?([\w."]+)/gi],
    ['index', /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w."]+)/gi, /drop\s+index\s+(?:if\s+exists\s+)?([\w."]+)/gi],
  ];
  for (const [kind, reC, reD] of simple) {
    for (const m of t.matchAll(reC)) { const [schema, name] = split(m[1]); add(m.index, 'add', { kind, schema, name }); }
    for (const m of t.matchAll(reD)) { const [schema, name] = split(m[1]); add(m.index, 'del', { kind, schema, name }); }
  }
  for (const m of t.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+([\w."]+)/gi)) {
    const [schema, table] = split(m[2]);
    add(m.index, 'add', { kind: 'policy', schema, table, name: m[1] });
  }
  for (const m of t.matchAll(/drop\s+policy\s+(?:if\s+exists\s+)?"([^"]+)"\s+on\s+([\w."]+)/gi)) {
    const [schema, table] = split(m[2]);
    add(m.index, 'del', { kind: 'policy', schema, table, name: m[1] });
  }
  for (const m of t.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([\w."]+)([\s\S]*?);/gi)) {
    const [schema, table] = split(m[1]);
    for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([\w"]+)/gi))
      add(m.index + c.index, 'add', { kind: 'column', schema, table, name: bare(c[1]) });
    for (const c of m[2].matchAll(/drop\s+column\s+(?:if\s+exists\s+)?([\w"]+)/gi))
      add(m.index + c.index, 'del', { kind: 'column', schema, table, name: bare(c[1]) });
  }
  return ev.sort((a, b) => a.at - b.at);
}

try {
  // --- 1. recorded? ---
  const recorded = (await sql`select version from supabase_migrations.schema_migrations`).map((r) => r.version);
  const versions = files.map((f) => f.slice(0, 5));
  const unrecorded = versions.filter((v) => !recorded.includes(v));
  const orphaned = recorded.filter((v) => !versions.includes(v));
  check('Every migration file is recorded', unrecorded.length === 0,
    unrecorded.length ? `missing: ${unrecorded.join(', ')}` : `${versions.length} files`);
  check('No recorded version without a file', orphaned.length === 0,
    orphaned.length ? `orphaned: ${orphaned.join(', ')}` : `${recorded.length} rows`);

  // --- build the ledger across every migration, in order ---
  const ledger = new Map();
  const from = new Map();
  for (const f of files) {
    for (const { op, obj } of parse(readFileSync(`${DIR}/${f}`, 'utf8'))) {
      if (obj.schema === 'pg_temp') continue;
      if (op === 'del') ledger.delete(key(obj));
      else { ledger.set(key(obj), obj); from.set(key(obj), f); }
    }
  }
  const objs = [...ledger.values()].filter((o) => o.kind !== 'function');
  const funcs = [...ledger.values()].filter((o) => o.kind === 'function');

  // --- 2. objects ---
  // One query per catalog rather than one per object: this used to make 300+
  // sequential round-trips to a remote database, which was slow and hung
  // outright often enough to make the validator untrustworthy.
  const schemas = [...new Set([...ledger.values()].map((o) => o.schema))];
  const setOf = (rows, f) => new Set(rows.map(f));
  const tables = setOf(await sql`select table_schema s, table_name n from information_schema.tables
    where table_schema in ${sql(schemas)}`, (r) => `${r.s}.${r.n}`);
  const columns = setOf(await sql`select table_schema s, table_name t, column_name n from information_schema.columns
    where table_schema in ${sql(schemas)}`, (r) => `${r.s}.${r.t}.${r.n}`);
  const indexes = setOf(await sql`select schemaname s, indexname n from pg_indexes
    where schemaname in ${sql(schemas)}`, (r) => `${r.s}.${r.n}`);
  const policies = setOf(await sql`select schemaname s, tablename t, policyname n from pg_policies
    where schemaname in ${sql(schemas)}`, (r) => `${r.s}.${r.t}.${r.n}`);
  const typeNames = setOf(await sql`select typname n from pg_type`, (r) => r.n);

  const present = (o) => {
    switch (o.kind) {
      case 'table': return tables.has(`${o.schema}.${o.name}`);
      case 'column': return columns.has(`${o.schema}.${o.table}.${o.name}`);
      case 'index': return indexes.has(`${o.schema}.${o.name}`);
      case 'policy': return policies.has(`${o.schema}.${o.table}.${o.name}`);
      case 'type': return typeNames.has(o.name);
      default: return true;
    }
  };

  const missing = objs.filter((o) => !present(o))
    .map((o) => `${from.get(key(o))}: ${o.kind} ${o.schema}.${o.table ? o.table + '.' : ''}${o.name}`);
  check('Every declared object exists in the database', missing.length === 0,
    missing.length ? missing.join('; ') : `${objs.length} objects`);

  // --- 3. function bodies ---
  const procs = new Map();
  for (const r of await sql`select n.nspname s, p.proname n, p.prosrc src from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${sql(schemas)}`) {
    const k = `${r.s}.${r.n}`;
    if (!procs.has(k)) procs.set(k, []);
    procs.get(k).push(r.src);
  }
  const absent = [], stale = [];
  for (const o of funcs) {
    const live = procs.get(`${o.schema}.${o.name}`);
    if (!live) absent.push(`${o.name} (last defined in ${from.get(key(o))})`);
    else if (!live.some((src) => norm(src) === norm(o.body)))
      stale.push(`${o.name} (expected ${from.get(key(o))})`);
  }
  check('Every migration-defined function exists', absent.length === 0,
    absent.length ? absent.join('; ') : `${funcs.length} functions`);
  check('Every live function body matches its last migration', stale.length === 0,
    stale.length ? stale.join('; ') : `${funcs.length} functions`);
} finally {
  await sql.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
