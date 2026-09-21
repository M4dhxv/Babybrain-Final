/**
 * frontends/parent and frontends/vendor are separate Vite apps whose
 * .env.production is committed to git with the production Supabase
 * project baked in — Vite always prefers .env.production over any
 * process env var, so every deployment silently built against the
 * *production* database regardless of what Vercel env vars were set to.
 *
 * .env.production.local outranks .env.production in Vite's env loading
 * order and is gitignored, so writing one here — from whatever
 * NEXT_PUBLIC_SUPABASE_* the current Vercel project provides — makes each
 * frontend build match the Supabase project the rest of the app uses.
 *
 * This lets one branch (main) build two deployments, each with its own
 * database: the live Vercel project (production Supabase) and the test
 * Vercel project (test Supabase), differing only in their env vars.
 *
 * Guard: set EXPECTED_SUPABASE_REF on each Vercel project to that project's
 * Supabase ref. The build fails if the URL it would bake in doesn't contain
 * it, so a missing or wrong env var can never quietly point the test site at
 * production (or the reverse) — including the fallback to the committed file.
 *
 * Run: node scripts/sync-frontend-supabase-env.mjs <frontendDir>
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node sync-frontend-supabase-env.mjs <frontendDir>');
  process.exit(1);
}

const expectedRef = process.env.EXPECTED_SUPABASE_REF;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function fail(msg) {
  console.error(`[sync-frontend-supabase-env] ${msg}`);
  process.exit(1);
}

if (!url || !anonKey) {
  const committed = path.join(dir, '.env.production');
  const fallbackUrl = fs.existsSync(committed)
    ? (fs.readFileSync(committed, 'utf8').match(/^VITE_SUPABASE_URL=(.*)$/m)?.[1] ?? '')
    : '';
  if (expectedRef && !fallbackUrl.includes(expectedRef)) {
    fail(
      `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY not set and ${committed} points at ` +
        `"${fallbackUrl}", not the expected project ${expectedRef}. Refusing to build.`
    );
  }
  console.log(`[sync-frontend-supabase-env] NEXT_PUBLIC_SUPABASE_URL/ANON_KEY not set — leaving ${dir}/.env.production as committed.`);
  process.exit(0);
}

if (expectedRef && !url.includes(expectedRef)) {
  fail(`NEXT_PUBLIC_SUPABASE_URL (${url}) is not the expected project ${expectedRef}. Refusing to build.`);
}

const target = path.join(dir, '.env.production.local');
fs.writeFileSync(target, `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anonKey}\n`);
console.log(`[sync-frontend-supabase-env] wrote ${target} (${url})`);
