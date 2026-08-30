/**
 * Apply one migration file to the database in SUPABASE_DB_URL.
 *   node scripts/apply-migration.mjs supabase/migrations/000NN_name.sql
 *
 * Migrations here are written to be idempotent, so re-running is safe.
 *
 * The whole file goes through in ONE call so Postgres wraps it in a single
 * implicit transaction: a migration that alters a table and re-creates the
 * functions reading that table must not be able to land half of itself.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';

process.loadEnvFile('.env.local');
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to.sql>');
  process.exit(1);
}

const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require' });
try {
  await sql.unsafe(readFileSync(file, 'utf8'));
  console.log(`applied ${file}`);
} catch (e) {
  console.error(`FAILED ${file}:`, e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
