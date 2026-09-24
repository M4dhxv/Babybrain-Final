/**
 * Provision login-capable vendor accounts without sending a single email.
 *
 *   node scripts/provision-vendor-accounts.mjs          # dry run — reports, writes nothing
 *   node scripts/provision-vendor-accounts.mjs --live   # creates accounts, prints passwords
 *
 * Dry run by default, like every other data-writing script in scripts/.
 *
 * ---------------------------------------------------------------------------
 * How the no-email guarantee works
 * ---------------------------------------------------------------------------
 * Every row inserted into public.notifications fires on_notification_created
 * -> notify_email_webhook(), which net.http_post()s to /api/webhooks/notifications
 * and becomes a real Resend email. There is no type filter: ANY notification
 * row is an email. So the whole job is making sure account creation inserts
 * no notification at all.
 *
 * Two functions would insert a 'welcome' notification for a new confirmed
 * account: handle_new_user() on INSERT into auth.users, and
 * handle_user_email_confirmed() on UPDATE when email_confirmed_at changes.
 *
 * Its predecessor (provision-priority-vendors.mjs) handled this by rewriting
 * handle_new_user()'s body in the live database for the duration of the run
 * and restoring it afterwards. That works, but it is schema surgery on the
 * only database there is: for the length of the batch, every REAL parent
 * signup silently loses its welcome email, and a crash between patch and
 * restore leaves production that way. It also broke the moment migration
 * 00151 added a condition to the block it matched verbatim — which is the
 * state it is in right now, so it would abort rather than run.
 *
 * This script needs no patching, because 00151 already put the escape hatch
 * in both functions:
 *
 *     and coalesce(new.raw_user_meta_data ->> 'intended_plan', '') <> 'plus'
 *
 * An account created with user_metadata.intended_plan = 'plus' skips the
 * welcome insert in BOTH functions, by their own logic, with nothing
 * temporarily rewritten. Step 2 then clears that metadata key, so the
 * account isn't left looking like a parent mid-upgrade — the triggers have
 * already fired by then, and neither re-fires on a metadata-only update
 * (handle_user_email_confirmed is guarded on email_confirmed_at actually
 * changing).
 *
 * Because that guarantee rests entirely on those two guards, the script
 * verifies both are still present in the live function bodies and refuses to
 * run if either has been edited away. It also asserts afterwards that no
 * 'welcome' notification row exists for any account it touched — so a silent
 * regression shows up as a loud failure rather than as mail in someone's
 * inbox.
 *
 * Nothing here writes passwords to disk; they are printed once, to stdout.
 */
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';
import crypto from 'node:crypto';

process.loadEnvFile('.env.local');
const LIVE = process.argv.includes('--live');
const FORCE = process.argv.includes('--force');
// --except=Name[,Name] leaves those vendors completely untouched, for when
// part of a batch needs a decision the rest doesn't.
const EXCEPT = (process.argv.find((a) => a.startsWith('--except=')) ?? '')
  .replace('--except=', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const VENDORS = [
  { name: 'Muckypups', email: 'rachel@muckypups.info' },
  { name: 'Spirit Stretch', email: 'sales@spiritstretch.com' },
  { name: 'Physio Down Under', email: 'info@physiodownunder.sg' },
  { name: 'Penguin Swim School', email: 'swim@penguinswimschool.sg' },
  { name: 'Avoyoga Kids', email: 'studio@avo.sg' },
];

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require', max: 1 });

const genPassword = () => crypto.randomBytes(12).toString('base64url') + '!1';
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const GUARD = "intended_plan', '') <> 'plus'";

async function preflight() {
  console.log(`${LIVE ? 'LIVE' : 'DRY RUN'} against ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`);
  for (const fn of ['handle_new_user', 'handle_user_email_confirmed']) {
    const [r] = await sql`select prosrc from pg_proc where proname = ${fn}`;
    if (!r) throw new Error(`ABORT: ${fn}() not found.`);
    const welcomes = r.prosrc.includes("'welcome'");
    if (welcomes && !r.prosrc.includes(GUARD)) {
      throw new Error(
        `ABORT: ${fn}() still inserts a 'welcome' notification but no longer carries the ` +
        `intended_plan guard this script relies on. Creating an account now would email the vendor.`
      );
    }
    console.log(`  guard ok: ${fn}()${welcomes ? '' : ' (no welcome insert at all)'}`);
  }
  console.log();
}

async function findProvider(name) {
  const { data, error } = await admin
    .from('providers')
    .select('id, business_name, slug, owner_id, is_claimed, contact_email')
    .ilike('business_name', name)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function uniqueSlug(base) {
  let slug = base;
  for (let n = 2; ; n += 1) {
    const { data } = await admin.from('providers').select('id').eq('slug', slug).maybeSingle();
    if (!data) return slug;
    slug = `${base}-${n}`;
  }
}

async function findUser(email) {
  // listUsers is paged; walk until found or exhausted.
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
  return null;
}

await preflight();

const results = [];
const skipped = [];
for (const v of VENDORS) {
  if (EXCEPT.includes(v.name.toLowerCase())) {
    console.log(`=== ${v.name} — EXCLUDED by --except, untouched ===\n`);
    continue;
  }
  console.log(`=== ${v.name} <${v.email}> ===`);
  const existingUser = await findUser(v.email);
  const existingProvider = await findProvider(v.name);

  // A listing that already has an owner belongs to somebody. Relinking it
  // would silently transfer a live business — with its activities and its
  // real bookings — to a brand-new account, and the displaced owner would
  // simply stop seeing their own dashboard. Only skip this guard when the
  // existing owner IS the account we're provisioning (i.e. a password reset).
  const hijack = existingProvider?.owner_id && existingProvider.owner_id !== existingUser?.id;
  if (hijack && !FORCE) {
    console.log(`  SKIPPED: "${v.name}" is already claimed by a different account.`);
    console.log(`           Its owner would be replaced and would lose access. Pass --force to`);
    console.log(`           override, or reset that owner's password instead.\n`);
    skipped.push(v.name);
    continue;
  }

  if (!LIVE) {
    console.log(`  auth user     : ${existingUser ? 'EXISTS — password would be reset' : 'would be created'}`);
    console.log(`  provider row  : ${existingProvider
      ? `EXISTS (${existingProvider.id}, claimed=${existingProvider.is_claimed}) — would link ownership`
      : `would create bare row (slug: ${slugify(v.name)})`}`);
    console.log(`  emails sent   : none\n`);
    continue;
  }

  const password = genPassword();
  let userId;
  if (existingUser) {
    userId = existingUser.id;
    await admin.auth.admin.updateUserById(userId, { password });
    console.log('  auth user existed — password reset');
  } else {
    // intended_plan:'plus' is what suppresses the welcome notification in
    // both trigger functions. Cleared immediately below.
    const { data: created, error } = await admin.auth.admin.createUser({
      email: v.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: v.name, intended_plan: 'plus' },
    });
    if (error) throw error;
    userId = created.user.id;
    await admin.auth.admin.updateUserById(userId, { user_metadata: { full_name: v.name } });
    console.log('  auth user created (welcome suppressed, metadata cleared)');
  }

  let provider = existingProvider;
  if (provider) {
    const { data, error } = await admin
      .from('providers')
      .update({ owner_id: userId, is_claimed: true, contact_email: provider.contact_email ?? v.email })
      .eq('id', provider.id)
      .select()
      .single();
    if (error) throw error;
    provider = data;
    console.log(`  linked existing provider row (${provider.id})`);
  } else {
    const slug = await uniqueSlug(slugify(v.name));
    const { data, error } = await admin
      .from('providers')
      .insert({
        business_name: v.name,
        slug,
        vendor_category: 'other',
        contact_email: v.email,
        status: 'active',
        is_claimed: true,
        owner_id: userId,
      })
      .select()
      .single();
    if (error) throw error;
    provider = data;
    console.log(`  created bare provider row (${provider.id}, slug: ${slug})`);
  }

  // provider_members_guard_single_owner raises unique_violation if a second
  // active owner is inserted, so a displaced owner has to be stood down first
  // — otherwise the providers.owner_id update above lands and this insert
  // fails, leaving the listing half-transferred (owner_id pointing at the new
  // account while provider_members still names the old one).
  //
  // Demoted to 'manager', not deleted and not 'disabled': the guard only
  // objects to role='owner' AND status='active', so manager clears it while
  // keeping the person's access and an audit trail of who held it. Set them
  // to 'disabled' by hand if the intent is to cut them off entirely.
  const { data: displaced, error: demErr } = await admin
    .from('provider_members')
    .update({ role: 'manager' })
    .eq('provider_id', provider.id)
    .eq('role', 'owner')
    .eq('status', 'active')
    .neq('user_id', userId)
    .select('user_id');
  if (demErr) throw demErr;
  for (const d of displaced ?? []) {
    console.log(`  DISPLACED former owner ${d.user_id} -> role 'manager' (reversible)`);
  }

  const { error: memErr } = await admin
    .from('provider_members')
    .upsert({ provider_id: provider.id, user_id: userId, role: 'owner', status: 'active' },
            { onConflict: 'provider_id,user_id' });
  if (memErr) throw memErr;
  console.log('  provider_members owner row ready');

  // The proof, not the promise: if anything did queue mail, it left a row.
  const [{ count }] = await sql`
    select count(*)::int as count from public.notifications where user_id = ${userId}`;
  if (count > 0) {
    console.error(`  *** WARNING: ${count} notification row(s) exist for this account — mail may have been sent.`);
  } else {
    console.log('  verified: 0 notification rows — no email queued');
  }

  results.push({ name: v.name, email: v.email, password, slug: provider.slug });
  console.log();
}

if (LIVE && results.length) {
  console.log('\n================ CREDENTIALS (shown once, not saved) ================');
  for (const r of results) {
    console.log(`${r.name}\n  email    : ${r.email}\n  password : ${r.password}\n  listing  : /provider/${r.slug}`);
  }
  console.log('=====================================================================');
  console.log('Vendors should change these on first sign-in.');
} else if (!LIVE) {
  console.log('Dry run complete — nothing written, no email sent. Re-run with --live.');
}

if (skipped.length) {
  console.log(`\nSkipped as already-owned: ${skipped.join(', ')}. Nothing was changed for them.`);
}

await sql.end();
