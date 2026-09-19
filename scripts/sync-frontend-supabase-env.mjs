/**
 * frontends/parent and frontends/vendor are separate Vite apps whose
 * .env.production is committed to git with the production Supabase
 * project baked in — Vite always prefers .env.production over any
 * process env var, so every branch (including `test`/preview builds)
 * silently built against the *production* database regardless of what
 * Vercel env vars were set to. That's why unpublishing on the live admin
 * portal appeared to affect the preview site too: the preview site was
 * never actually reading its own data.
 *
 * .env.production.local outranks .env.production in Vite's env loading
 * order and is gitignored, so writing one here — from whatever
 * NEXT_PUBLIC_SUPABASE_* the current Vercel environment (Production or
 * Preview) actually provides — makes each frontend build match the
 * Supabase project the rest of the app is using.
 *
 * Run: node scripts/sync-frontend-supabase-env.mjs <frontendDir>
 */
const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node sync-frontend-supabase-env.mjs <frontendDir>');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.log(`[sync-frontend-supabase-env] NEXT_PUBLIC_SUPABASE_URL/ANON_KEY not set — leaving ${dir}/.env.production as committed.`);
  process.exit(0);
}

const fs = await import('node:fs');
const path = await import('node:path');
const target = path.join(dir, '.env.production.local');
fs.writeFileSync(target, `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anonKey}\n`);
console.log(`[sync-frontend-supabase-env] wrote ${target} (${url})`);
