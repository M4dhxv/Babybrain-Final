#!/usr/bin/env node
/**
 * Prepare a vendor account we built ourselves for handover to its real owner.
 *
 *   node scripts/prepare-vendor-handover.mjs --slug=oma-studio           # dry run
 *   node scripts/prepare-vendor-handover.mjs --slug=oma-studio --apply   # writes
 *
 * Dry run by default, like every other data-writing script in scripts/.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The sibling of provision-vendor-accounts.mjs, for the second half of the
 * same job. That script creates a login-capable vendor account and prints its
 * password; this one hands an account we have since been *using* over to the
 * business that owns it.
 *
 * The reference run is the 20 Sep batch (Muckypups, Spirit Stretch, Physio
 * Down Under, Penguin Swim School, Avoyoga Kids) and Wonder Words before it.
 * Handover is deliberately not an email flow — `auth.users.invited_at` is null
 * for every one of them and none has a single notifications row, because the
 * password goes out by hand. The owner then does the last three steps
 * themselves at https://test.babybrain.sg/vendor:
 *
 *     sign in -> set their own password -> OnboardingGate Terms -> Stripe Connect
 *
 * The catch this script exists to fix is the Terms step. Setting an account up
 * means signing in AS the owner, and the first thing OnboardingGate asks for is
 * consent. Clicking through it during setup records `vendor_terms_accepted_at`
 * against us, not the business, and the real owner then never sees the Terms
 * screen at all. So handover prep has to put that consent back to null.
 *
 * What it does:
 *
 *   1. Clears `vendor_terms_accepted_at` and `marketing_consent_at`, so
 *      OnboardingGate (frontends/vendor/src/components/OnboardingGate.tsx:89)
 *      shows the blocking Terms step at the owner's first sign-in. Both are
 *      cleared together because the gate writes them from the same click.
 *   2. Optionally sets the provider's `cover_image_url` (--cover=URL).
 *   3. Resets the owner's password to a fresh random one and prints it once,
 *      so the password we have been signing in with stops being the one they
 *      get. Same call and same generator as provision-vendor-accounts.mjs.
 *
 * Without --send-reset it SENDS NOTHING — a real vendor's inbox is only
 * touched when you ask for the handover email (see the SEND_RESET block).
 * admin.auth.admin.updateUserById({ password }) fires neither
 * handle_new_user() (no INSERT) nor handle_user_email_confirmed()
 * (email_confirmed_at doesn't change), so no notifications row is written and
 * therefore no Resend mail goes out. The script asserts that afterwards rather
 * than trusting it, the same way provision-vendor-accounts.mjs does.
 *
 * `payouts_enabled` is left alone: Stripe Connect needs the business's own UEN,
 * bank account and identity documents, so it is the owner's job after handover,
 * not something we can pre-bake. RequireAuth.tsx:62 keeps showing the gate
 * until it's done.
 *
 * Guard: refuses a provider that already has bookings, because clearing consent
 * underneath a vendor who is already trading locks them out of their own live
 * dashboard until they re-accept. --force overrides.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import crypto from 'node:crypto';
import { parseDbUrl } from './lib/db-url.mjs';
import { Resend } from 'resend';
import { renderEmail } from '../lib/emails/render.ts';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const KEEP_PASSWORD = process.argv.includes('--keep-password');
const SEND_RESET = process.argv.includes('--send-reset');
const SLUG = arg('slug');
const COVER = arg('cover');
// Hand the business to a named person rather than a generic inbox: this
// becomes the owner's LOGIN identity. providers.contact_email is left alone —
// that one is the business's public contact and what the Stripe Connect route
// seeds an Express account with.
const OWNER_EMAIL = arg('owner-email');
// The vendor portal is served at /vendor/ (frontends/vendor/vite.config.ts
// `base`). Note the brand domain www.babybrain.sg does NOT serve the app —
// it 404s on /vendor and /explore alike.
const PORTAL = arg('portal', 'https://test.babybrain.sg/vendor');

if (!SLUG) {
  console.error('Usage: node scripts/prepare-vendor-handover.mjs --slug=<provider-slug> [--apply]');
  console.error('       [--cover=URL] [--portal=URL] [--owner-email=…] [--keep-password] [--send-reset] [--force]');
  process.exit(1);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require', max: 1 });

// Same generator as provision-vendor-accounts.mjs, so a handed-over password
// looks exactly like a freshly provisioned one.
const genPassword = () => crypto.randomBytes(12).toString('base64url') + '!1';

const [provider] = await sql`
  select p.id, p.business_name, p.slug, p.owner_id, p.contact_email,
         p.vendor_terms_accepted_at, p.marketing_consent_at, p.cover_image_url,
         p.stripe_account_id, p.payouts_enabled,
         (select count(*) from bookings b where b.provider_id = p.id) as bookings
    from providers p
   where p.slug = ${SLUG}
`;

if (!provider) {
  console.error(`No provider with slug "${SLUG}".`);
  await sql.end();
  process.exit(1);
}

const [owner] = provider.owner_id
  ? await sql`select id, email, last_sign_in_at from auth.users where id = ${provider.owner_id}`
  : [];

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${provider.business_name} (${provider.slug})\n`);
console.log(`  owner          : ${owner ? owner.email : 'NONE — provider has no owner_id'}`);
console.log(`  last sign-in   : ${owner?.last_sign_in_at ?? '—'}`);
console.log(`  terms accepted : ${provider.vendor_terms_accepted_at ?? 'already null'}`);
console.log(`  marketing      : ${provider.marketing_consent_at ?? 'already null'}`);
console.log(`  cover image    : ${provider.cover_image_url ?? 'none'}`);
console.log(`  stripe connect : ${provider.stripe_account_id ?? 'not connected'} (payouts ${provider.payouts_enabled})`);
console.log(`  bookings       : ${provider.bookings}\n`);

if (!owner) {
  console.error('ABORT: no owner account to hand over to.');
  await sql.end();
  process.exit(1);
}

if (Number(provider.bookings) > 0 && !FORCE) {
  console.error(
    `ABORT: ${provider.business_name} already has ${provider.bookings} booking(s). Clearing consent on a\n` +
    '       trading vendor gates the owner out of their own live dashboard until they re-accept.\n' +
    '       Pass --force if that is genuinely what you want.'
  );
  await sql.end();
  process.exit(1);
}

if (provider.payouts_enabled) {
  console.log('NOTE: payouts are already enabled — this account may already have been handed over.\n');
}

// Notification rows written before this run, so the post-run assertion can
// tell an old one (Oma carries a stray parent 'welcome' from 15 Sep) from
// anything this script might have caused.
const [{ count: notifsBefore }] = await sql`
  select count(*)::int as count from notifications where user_id = ${owner.id}
`;

if (!APPLY) {
  console.log('Would clear vendor_terms_accepted_at and marketing_consent_at.');
  if (COVER) console.log(`Would set cover_image_url to ${COVER}`);
  console.log(KEEP_PASSWORD ? 'Would leave the password alone.' : 'Would reset the password and print it once.');
  console.log(`Portal to hand over: ${PORTAL}`);
  if (SEND_RESET) console.log('Would email the owner a "set your password" link (token_hash, scanner-proof) via Resend.');
  console.log(`Existing notification rows for this owner: ${notifsBefore}`);
  console.log('\nNothing written. Re-run with --apply.');
  await sql.end();
  process.exit(0);
}

const [updated] = await sql`
  update providers
     set vendor_terms_accepted_at = null,
         marketing_consent_at = null
         ${COVER ? sql`, cover_image_url = ${COVER}` : sql``}
   where id = ${provider.id}
  returning slug, vendor_terms_accepted_at, marketing_consent_at, cover_image_url
`;
console.log('Consent cleared:', JSON.stringify(updated, null, 2));

let password = null;
if (!KEEP_PASSWORD) {
  password = genPassword();
  const { error } = await admin.auth.admin.updateUserById(owner.id, { password });
  if (error) {
    console.error(`\nPassword reset FAILED: ${error.message}`);
    console.error('The consent clear above still applied — re-run with --keep-password to skip this step.');
    await sql.end();
    process.exit(1);
  }
  console.log('Password reset.');
}

// Trust nothing: any notifications row is a Resend email, so confirm this run
// produced none before declaring the handover silent.
const [{ count: notifsAfter }] = await sql`
  select count(*)::int as count from notifications where user_id = ${owner.id}
`;
if (notifsAfter !== notifsBefore) {
  console.error(
    `\nWARNING: notification rows went ${notifsBefore} -> ${notifsAfter}. This run may have emailed ` +
    `${owner.email}. Check the notifications table before sending anything else.`
  );
} else {
  console.log(`No notification written (${notifsAfter} row(s), unchanged) — nothing was emailed.`);
}

// Re-point the login at a named person. email_confirm skips the two-sided
// confirmation dance (double_confirm_changes is on, so without it BOTH the old
// and new address get mail). Re-confirming is an email_confirmed_at change, so
// handle_user_email_confirmed() fires — but its welcome insert is guarded on
// "no existing welcome row", and any account we have been setting up already
// has one, so this cannot re-send "Tell us about your child".
let loginEmail = owner.email;
if (OWNER_EMAIL && OWNER_EMAIL.toLowerCase() !== owner.email.toLowerCase()) {
  const { error } = await admin.auth.admin.updateUserById(owner.id, {
    email: OWNER_EMAIL,
    email_confirm: true,
  });
  if (error) {
    console.error(`\nCould not move the login to ${OWNER_EMAIL}: ${error.message}`);
    await sql.end();
    process.exit(1);
  }
  loginEmail = OWNER_EMAIL;
  console.log(`Login moved: ${owner.email} -> ${OWNER_EMAIL} (providers.contact_email unchanged).`);
}

// --send-reset mails the owner a "your account is ready — set your password"
// email. The link is built here from generateLink's hashed_token and points
// straight at the portal (`<PORTAL>?token_hash=…&type=recovery`); the token is
// spent only when the owner presses Continue on #/reset-password (verifyOtp).
// Supabase's own /verify link is NOT used: it spends the token on the first
// GET, and mail scanners such as Microsoft Defender Safe Links open every link
// before the recipient does, so vendors were clicking an already-used link.
// Sending through Resend ourselves also sidesteps Supabase's ~2/hour auth-email
// cap, and generateLink sends nothing on its own. A fresh link voids any
// earlier reset link for this account.
//
// PORTAL must have NO trailing slash (vite serves /vendor/, Next rewrites both,
// but keep the link identical to what the portal itself generates).
if (SEND_RESET) {
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: loginEmail,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    console.error(`\nHandover email NOT sent: could not create a link (${linkErr?.message ?? 'no token'}).`);
  } else {
    const setPasswordUrl = `${PORTAL}?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`;
    const rendered = renderEmail(
      'provider_account_handover',
      { business_name: provider.business_name, set_password_url: setPasswordUrl, sign_in_url: `${PORTAL}/#/login` },
      { appUrl: new URL(PORTAL).origin }
    );
    const { data: sent, error: sendErr } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.EMAIL_FROM ?? 'Katie from BabyBrain <hello@updates.babybrain.sg>',
      replyTo: 'hello@babybrain.sg',
      to: loginEmail,
      subject: rendered.subject,
      html: rendered.html,
    });
    if (sendErr) console.error(`\nHandover email NOT sent: ${sendErr.message}`);
    else console.log(`Handover email sent to ${loginEmail} (Resend id ${sent.id}).`);
  }
}

console.log('\n--- hand these over ---');
console.log(`  Portal   : ${PORTAL}`);
console.log(`  Email    : ${loginEmail}`);
if (password) console.log(`  Password : ${password}        (shown once, not stored)`);
console.log('\nThey then: sign in -> set their own password -> accept Terms -> connect Stripe.');

await sql.end();
