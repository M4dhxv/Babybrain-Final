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
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
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

const body = readFileSync(file, 'utf8');
// version and label are [0-9a-z_] by the check above, so they cannot break out
// of these quotes.
const record =
  `\ninsert into supabase_migrations.schema_migrations (version, name)\n` +
  `values ('${version}', '${label}')\non conflict (version) do nothing;\n`;

// A file that opens its own transaction ends with `commit;` (10 of them do).
// Appending after that would record in a second transaction of its own, so
// splice the insert in just before it instead.
const selfCommitting = body.match(/([\s\S]*?)(\bcommit\s*;\s*)$/i);
const text = selfCommitting ? selfCommitting[1] + record + selfCommitting[2] : body + record;

const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require' });
try {
  await sql.unsafe(text);
  console.log(`applied ${file} (recorded as ${version})`);
} catch (e) {
  console.error(`FAILED ${file}:`, e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
