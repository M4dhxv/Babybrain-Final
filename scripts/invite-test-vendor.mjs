#!/usr/bin/env node
/**
 * Stand up a throwaway vendor and email a real Supabase invite to it, so the
 * owner onboarding can be walked end to end before a real vendor is sent down it.
 *
 *   node scripts/invite-test-vendor.mjs --email=you@example.com            # dry run
 *   node scripts/invite-test-vendor.mjs --email=you@example.com --apply    # creates + SENDS
 *   node scripts/invite-test-vendor.mjs --email=you@example.com --cleanup --apply
 *
 * Dry run by default. --apply is the only thing that writes or sends.
 *
 * ---------------------------------------------------------------------------
 * Why a throwaway provider, rather than inviting you to a real one
 * ---------------------------------------------------------------------------
 * The onboarding being tested — Terms, then Stripe Connect — is owner-only:
 * RequireAuth.tsx:62 gates on `role === 'owner'`. A staff/manager invite via
 * /api/vendor/staff/invite sails straight past it and tests nothing. And a
 * second owner cannot be added to an existing business —
 * provider_members_guard_single_owner raises unique_violation. So testing the
 * real gate means owning a business of your own, hence a disposable one.
 *
 * It is created with no activities, so it cannot surface on Explore (Explore
 * lists activities, not providers) and is flagged `is_test` besides. --cleanup
 * removes both the provider and the auth user when you're done.
 *
 * ---------------------------------------------------------------------------
 * The two emails, and the one we don't want
 * ---------------------------------------------------------------------------
 * inviteUserByEmail sends the branded `auth_invite` ("You're invited") mail
 * through the Resend SMTP sender. That one is the point.
 *
 * The one to avoid is the parent welcome. handle_new_user() only welcomes an
 * address that is already confirmed, and an invited user's email_confirmed_at
 * is null until they accept — so nothing fires at creation. But
 * handle_user_email_confirmed() fires on the UPDATE when they DO accept, and
 * would then send "Tell us about your child" to a vendor. Exactly what already
 * happened to Oma Studio on 15 Sep. The `intended_plan: 'plus'` metadata is the
 * guard both trigger functions honour (migration 00151); it is set here and
 * cleared once the invite is out.
 *
 * redirectTo has NO trailing slash on purpose. The hosted allow-list is exact
 * match: `https://test.babybrain.sg/vendor` is listed, `.../vendor/` is not and
 * gets silently rewritten to site_url (babybrain-final.vercel.app) — the same
 * bug that breaks "Forgot password?" on test.babybrain.sg today, because
 * AuthProvider.tsx:282 builds its redirect from BASE_URL, which has the slash.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const APPLY = process.argv.includes('--apply');
const CLEANUP = process.argv.includes('--cleanup');
const ACTIVATE = process.argv.includes('--activate');
const EMAIL = arg('email');
const NAME = arg('name', 'Handover Test Studio');
const SLUG = arg('slug', 'handover-test-studio');
const PORTAL = arg('portal', 'https://test.babybrain.sg/vendor'); // no trailing slash — see above

if (!EMAIL) {
  console.error('Usage: node scripts/invite-test-vendor.mjs --email=you@example.com [--apply]');
  console.error('       [--name="..."] [--slug=...] [--portal=URL] [--cleanup]');
  process.exit(1);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require', max: 1 });

async function findUser(email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
  return null;
}

const existingUser = await findUser(EMAIL);
const [existingProvider] = await sql`select id, business_name, slug, owner_id, is_test from providers where slug = ${SLUG}`;

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${CLEANUP ? 'cleanup' : 'invite'} ${EMAIL}\n`);
console.log(`  auth user      : ${existingUser ? `EXISTS (${existingUser.id})` : 'none'}`);
console.log(`  test provider  : ${existingProvider ? `EXISTS (${existingProvider.id}, is_test=${existingProvider.is_test})` : 'none'}`);
console.log(`  portal         : ${PORTAL}\n`);

/**
 * Turn an invited-but-stuck account into one that can simply sign in.
 *
 * The invite email does not survive this portal. Supabase sends the browser to
 * `<portal>#access_token=…&type=invite`, and the vendor SPA routes with a
 * HashRouter — so it reads `access_token=…` as the path, matches no route, and
 * renders the catch-all 404 (App.tsx:137). Only PASSWORD_RECOVERY is rescued
 * (AuthProvider.tsx:216, RecoveryRedirect); an invite fires SIGNED_IN and is
 * left to the router. Hence the real handover never uses invites at all — it
 * hands over a password, which is what this does.
 *
 * email_confirm is set at the same time because enable_confirmations is on:
 * an invited user's email_confirmed_at is null, and a password alone would not
 * get them past sign-in. Confirming it here is the UPDATE that fires
 * handle_user_email_confirmed(), so the intended_plan=plus guard left on the
 * account is doing real work at this moment — without it this line would email
 * a vendor "Tell us about your child".
 */
if (ACTIVATE) {
  if (!existingUser) {
    console.error(`ABORT: no account for ${EMAIL} to activate.`);
    await sql.end();
    process.exit(1);
  }
  if (!APPLY) {
    console.log('Would set a password on this account and confirm its email,');
    console.log(`so it can sign in normally at ${PORTAL}/#/login`);
    console.log('\nNothing written. Re-run with --apply.');
    await sql.end();
    process.exit(0);
  }
  const password = `${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}!1`;
  const { error } = await admin.auth.admin.updateUserById(existingUser.id, {
    password,
    email_confirm: true,
  });
  if (error) {
    console.error(`Could not activate: ${error.message}`);
    await sql.end();
    process.exit(1);
  }
  const [{ count }] = await sql`select count(*)::int as count from notifications where user_id = ${existingUser.id}`;
  console.log('Account activated.\n');
  console.log(`  Portal   : ${PORTAL}/#/login`);
  console.log(`  Email    : ${EMAIL}`);
  console.log(`  Password : ${password}        (shown once, not stored)`);
  console.log(`\nNotification rows: ${count} (expect 0 — the welcome guard held).`);
  await sql.end();
  process.exit(0);
}

if (CLEANUP) {
  if (!APPLY) {
    console.log('Would delete the test provider row and the auth user above.');
    console.log('\nNothing written. Re-run with --apply.');
    await sql.end();
    process.exit(0);
  }
  if (existingProvider) {
    if (!existingProvider.is_test) {
      console.error(`ABORT: provider "${SLUG}" is not flagged is_test. Refusing to delete a real business.`);
      await sql.end();
      process.exit(1);
    }
    await sql`delete from provider_members where provider_id = ${existingProvider.id}`;
    await sql`delete from providers where id = ${existingProvider.id}`;
    console.log('Test provider deleted.');
  }
  if (existingUser) {
    const { error } = await admin.auth.admin.deleteUser(existingUser.id);
    if (error) console.error(`Could not delete the auth user: ${error.message}`);
    else console.log('Auth user deleted.');
  }
  await sql.end();
  process.exit(0);
}

if (existingUser) {
  console.error(
    `ABORT: ${EMAIL} already has an account. Inviting again would not re-send a usable invite,\n` +
    '       and this script will not touch an account it did not create. Run with --cleanup --apply\n' +
    '       first if this is a leftover test account.'
  );
  await sql.end();
  process.exit(1);
}

if (!APPLY) {
  console.log(`Would create provider "${NAME}" (slug ${SLUG}, is_test=true, no activities).`);
  console.log(`Would send a Supabase "You're invited" email to ${EMAIL}, redirecting to ${PORTAL}.`);
  console.log('Would suppress the parent welcome via intended_plan=plus, then clear that metadata.');
  console.log('\nYou would then: open the invite -> set a password at #/reset-password ->');
  console.log('go to #/dashboard -> Terms gate -> Stripe Connect (LIVE mode — use a real');
  console.log('account or abandon at the Stripe screen).');
  console.log('\nNothing written, nothing sent. Re-run with --apply.');
  await sql.end();
  process.exit(0);
}

const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(EMAIL, {
  data: { full_name: NAME, intended_plan: 'plus' },
  redirectTo: PORTAL,
});
if (inviteErr) {
  console.error(`Invite failed: ${inviteErr.message}`);
  await sql.end();
  process.exit(1);
}
const userId = invited.user.id;
console.log(`Invite sent to ${EMAIL} (user ${userId}).`);

// intended_plan is deliberately NOT cleared here, unlike in
// provision-vendor-accounts.mjs. That script creates an already-confirmed
// account, so handle_new_user() fires once, at creation, and the key has done
// its job by the time the next line runs. An invited account is different:
// email_confirmed_at stays null until the invite is accepted, and it is that
// UPDATE which fires handle_user_email_confirmed(). Clear the key now and
// accepting the invite emails a vendor "Tell us about your child".
//
// (Worth knowing either way: admin.updateUserById MERGES user_metadata rather
// than replacing it, so assigning an object without the key does not remove
// it — you have to set the key to null. provision-vendor-accounts.mjs logs
// "metadata cleared" but never actually clears it; Muckypups, Spirit Stretch
// and Avoyoga all still carry intended_plan=plus.)

const [provider] = await sql`
  insert into providers (business_name, slug, vendor_category, contact_email, status, is_claimed, owner_id, is_test)
  values (${NAME}, ${SLUG}, 'other', ${EMAIL}, 'active', true, ${userId}, true)
  returning id, slug
`;
await sql`
  insert into provider_members (provider_id, user_id, role, status)
  values (${provider.id}, ${userId}, 'owner', 'active')
  on conflict do nothing
`;
console.log(`Test provider created (${provider.id}, slug ${provider.slug}).`);

const [{ count }] = await sql`select count(*)::int as count from notifications where user_id = ${userId}`;
console.log(`Notification rows for this user: ${count} (expect 0 — only the invite mail should have gone out).`);

console.log('\nNext: open the invite, set a password at #/reset-password, then #/dashboard.');
console.log(`Clean up with: node scripts/invite-test-vendor.mjs --email=${EMAIL} --cleanup --apply`);

await sql.end();
