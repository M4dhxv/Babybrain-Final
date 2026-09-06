/**
 * Apply one migration file to the database in SUPABASE_DB_URL.
 *   node scripts/apply-migration.mjs supabase/migrations/000NN_name.sql
 *
 * Migrations here are written to be idempotent, so re-running is safe.
 *
 * The whole file goes through in ONE call so Postgres wraps it in a single
 * implicit transaction: a migration that alters a table and re-creates the
 * functions reading that table must not be able to land half of itself.
 *
 * That same call now also records the migration in
 * supabase_migrations.schema_migrations. This script used to apply without
 * recording anything, so that table only ever saw migrations run through the
 * Supabase CLI — 15 applied by this script were invisible to it, which is why
 * comparing the table against supabase/migrations could not have caught the
 * 00068 half-apply (see 00075_repair_redeem_package_credit.sql).
 *
 * The insert rides inside the migration's own transaction — spliced in before
 * the final `commit;` of a file that opens its own — so a migration that
 * fails is never recorded, and one that lands always is.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';

process.loadEnvFile('.env.local');
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to.sql>');
  process.exit(1);
}

// The filename is the only source for the version, so it has to conform.
// Refusing here beats applying something that can never be recorded.
const parts = basename(file, '.sql').match(/^(\d{5})_([a-z0-9_]+)$/);
if (!parts) {
  console.error(`FAILED ${file}: expected a NNNNN_name.sql filename so the migration can be recorded.`);
  process.exit(1);
}
const [, version, label] = parts;

// A version number is an identity, not a slot. Two different files claiming
// 00082 is always a mistake — it happened when a branch went stale and invented
// migrations on numbers `main` had already used, and nothing noticed until the
// database had run both. Cheap to catch before touching the database at all.
const sameVersion = readdirSync(dirname(file))
  .filter((f) => f.endsWith('.sql') && f.startsWith(`${version}_`) && f !== basename(file));
if (sameVersion.length) {
  console.error(
    `FAILED ${file}: version ${version} is also claimed by ${sameVersion.join(', ')}.\n` +
    `  Renumber one of them — a version identifies a single migration.`
  );
  process.exit(1);
}

const body = readFileSync(file, 'utf8');
// version and label are [0-9a-z_] by the check above, so they cannot break out
// of these quotes.
const record =
  `\ninsert into supabase_migrations.schema_migrations (version, name)\n` +
  `values ('${version}', '${label}')\non conflict (version) do nothing;\n`;
// `do nothing` is right for re-applying the SAME migration (they are written to
// be idempotent), but only once we know the recorded row IS this migration. The
// pre-flight below establishes that; without it, applying onto a version that
// belongs to a different migration recorded nothing and reported success.

// A file that opens its own transaction ends with `commit;` (10 of them do).
// Appending after that would record in a second transaction of its own, so
// splice the insert in just before it instead.
const selfCommitting = body.match(/([\s\S]*?)(\bcommit\s*;\s*)$/i);
const text = selfCommitting ? selfCommitting[1] + record + selfCommitting[2] : body + record;

// `max: 1` is required, not a tuning knob: postgres.js refuses an explicit
// BEGIN through a pooled connection ("UNSAFE_TRANSACTION"), which is exactly
// what the self-committing files spliced above send. Without it the splice
// logic could never actually run — the first migration to open its own
// transaction (00083) failed here. One connection is all this script uses.
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require', max: 1 });
try {
  const [existing] = await sql`
    select name from supabase_migrations.schema_migrations where version = ${version}`;
  if (existing && existing.name !== label) {
    console.error(
      `FAILED ${file}: version ${version} is already recorded as "${existing.name}".\n` +
      `  This file is "${label}". Applying it would run against a version number that\n` +
      `  belongs to a different migration, and the insert would silently record nothing.\n` +
      `  Renumber this file to a free version and re-run.`
    );
    process.exitCode = 1;
  } else {
    await sql.unsafe(text);
    console.log(`applied ${file} (recorded as ${version})`);
  }
} catch (e) {
  console.error(`FAILED ${file}:`, e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
