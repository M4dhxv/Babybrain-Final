/**
 * Apply one migration file to the database in SUPABASE_DB_URL.
 *   node scripts/apply-migration.mjs supabase/migrations/000NN_name.sql
 *
 * Migrations here are written to be idempotent, so re-running is safe.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

process.loadEnvFile('.env.local');
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to.sql>');
  process.exit(1);
}

const sql = postgres(process.env.SUPABASE_DB_URL, { prepare: false });
try {
  await sql.unsafe(readFileSync(file, 'utf8'));
  console.log(`applied ${file}`);
} catch (e) {
  console.error(`FAILED ${file}:`, e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
