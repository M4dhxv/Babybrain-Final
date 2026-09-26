/**
 * Creates or resets a founder/admin auth user on the *test* Supabase project
 * only — mirrors provision-test-accounts.mjs's safety pattern exactly.
 *
 * This only creates the Supabase Auth user. Signing in still needs the same
 * email in the `ADMIN_EMAILS` allowlist (a Vercel env var on the babybrain-test
 * project, checked by lib/admin.ts) — that part isn't touched by this script.
 *
 * Safety:
 *   - Reads .env.test.local (gitignored), never .env.local (production).
 *   - Refuses to run unless the Supabase URL is the babybrain-test project,
 *     and hard-refuses the production project.
 *   - Email/password come from env vars, not from this source.
 *
 * Run:
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/provision-admin-account.mjs
 */
import { createClient } from '@supabase/supabase-js';

const TEST_REF = 'imlfhepnucytyajxpoum';
const PROD_REF = 'laftgypwwfevzggxknii';

process.loadEnvFile('.env.test.local');

const {
  TEST_SUPABASE_URL: url,
  TEST_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
} = process.env;

for (const [k, v] of Object.entries({ TEST_SUPABASE_URL: url, TEST_SUPABASE_SERVICE_ROLE_KEY: serviceKey, ADMIN_EMAIL, ADMIN_PASSWORD })) {
  if (!v) throw new Error(`Missing ${k}`);
}

if (url.includes(PROD_REF)) {
  throw new Error('Refusing to run: TEST_SUPABASE_URL is the PRODUCTION project.');
}
if (!url.includes(TEST_REF)) {
  throw new Error(`Refusing to run: TEST_SUPABASE_URL must be the ${TEST_REF} (babybrain-test) project.`);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const email = ADMIN_EMAIL.toLowerCase();

const { data: created, error } = await admin.auth.admin.createUser({
  email,
  password: ADMIN_PASSWORD,
  email_confirm: true,
  user_metadata: { full_name: 'BabyBrain Admin' },
});

if (created?.user) {
  console.log(`Created auth user ${email} on ${url}`);
} else {
  if (!error?.message?.toLowerCase().includes('already been registered')) throw error;
  let existing;
  for (let page = 1; !existing; page++) {
    const { data, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (listErr) throw listErr;
    existing = data.users.find((u) => u.email?.toLowerCase() === email);
    if (!existing && data.users.length < 200) throw error;
  }
  const { error: pwErr } = await admin.auth.admin.updateUserById(existing.id, {
    password: ADMIN_PASSWORD,
    email_confirm: true,
  });
  if (pwErr) throw pwErr;
  console.log(`Reused auth user ${email} on ${url} (password reset)`);
}

console.log('\nThis only creates the Supabase Auth user on the TEST project.');
console.log(`Sign-in will still be denied ("This account isn't an admin.") until`);
console.log(`${email} is added to the ADMIN_EMAILS env var on the babybrain-test`);
console.log('Vercel project (Settings > Environment Variables), followed by a redeploy.');
