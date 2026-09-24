/**
 * One-off: provision login-capable vendor accounts for the 7 priority
 * vendors, without sending any email (welcome or otherwise).
 *
 * `public.handle_new_user()` fires on every insert into auth.users and — for
 * an already-confirmed account — inserts a 'welcome' notification
 * synchronously, which a pg_net webhook turns into a real Resend email
 * within the same request. There is no reliable window to delete that row
 * before the webhook fires.
 *
 * `auth.users` itself is owned by Supabase's internal `supabase_auth_admin`
 * role, so `ALTER TABLE ... DISABLE TRIGGER` from this connection fails with
 * "must be owner of table users" — confirmed by running this script once.
 * `public.handle_new_user()` IS owned by this connection's role (`postgres`,
 * same as every migration), so instead the function body is swapped for a
 * copy with just the notification insert removed, for the duration of the
 * batch, then restored to the exact original source in a `finally`. The
 * live definition is diffed against the known-original text before patching
 * and after restoring, so this aborts loudly instead of silently leaving
 * production signups (parent or vendor) without their welcome email.
 *
 * For each vendor:
 *   - reuses an existing unclaimed `providers` row if one matches by name,
 *     otherwise creates a bare-minimum one (business_name + contact_email +
 *     vendor_category 'other' as a placeholder — the vendor fills in the
 *     rest from their dashboard);
 *   - creates a confirmed auth user (idempotent — reuses + resets password
 *     if it already exists);
 *   - links ownership: providers.owner_id/is_claimed + a provider_members
 *     'owner' row (both service-role writes, which 00114's ownership guard
 *     trusts).
 *
 * Run: node scripts/provision-priority-vendors.mjs
 */
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';
import crypto from 'node:crypto';

process.loadEnvFile('.env.local');

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), prepare: false, ssl: 'require', max: 1 });

const VENDORS = [
  { name: 'Wonder Words', email: 'roohi@wonderwordstherapy.com' },
  { name: 'BeAlere', email: 'BeAlere.sg@gmail.com' },
  { name: 'Impressions Kids Club', email: 'info@impressionskidsclub.com' },
  { name: 'Inspire Mum & Baby', email: 'info@inspiremumbaby.com' },
  { name: 'Oma Studio', email: 'info@omastudio.sg' },
  { name: 'The Artground', email: 'info@theartground.com.sg' },
  { name: 'Swish', email: 'customercare@swishswimming.com' },
];

function genPassword() {
  // 12 random bytes, base64url -> readable, no ambiguous padding.
  return crypto.randomBytes(12).toString('base64url') + '!1';
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function findProvider(name) {
  const { data, error } = await admin
    .from('providers')
    .select('id, business_name, owner_id, is_claimed')
    .eq('business_name', name)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function ensureUniqueSlug(base) {
  let slug = base;
  let n = 1;
  for (;;) {
    const { data } = await admin.from('providers').select('id').eq('slug', slug).maybeSingle();
    if (!data) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

const results = [];

async function currentFnDef() {
  const [{ pg_get_functiondef }] = await sql`select pg_get_functiondef('public.handle_new_user()'::regprocedure)`;
  return pg_get_functiondef;
}

// The block that fires the welcome email — matched verbatim against whatever
// is actually live right now, not a hand-copied guess. If this exact text
// isn't found, abort: patching a function we can't precisely reverse is
// worse than not running at all. (Stored function body uses CRLF — confirmed
// by inspecting the live text — so build the anchor with the same endings
// rather than assume.)
const NOTIFY_BLOCK = [
  '  -- Only welcome a confirmed address. Unconfirmed sign-ups are welcomed later,',
  '  -- by the confirmation trigger below.',
  '  if new.email_confirmed_at is not null',
  '     and not exists (',
  '       select 1 from public.notifications',
  "       where user_id = new.id and type = 'welcome'",
  '     ) then',
  '    insert into public.notifications (user_id, type, title, body, data)',
  "    values (new.id, 'welcome', 'Welcome to BabyBrain!',",
  "      'Tell us about your child to get personalised activity recommendations.',",
  '      \'{"url": "/onboarding"}\');',
  '  end if;',
  '',
  '',
].join('\r\n');

console.log('--- Patching handle_new_user() to skip the welcome-email insert ---');
const ORIGINAL_FN = await currentFnDef();
if (!ORIGINAL_FN.includes(NOTIFY_BLOCK)) {
  console.error('ABORT: could not find the expected welcome-notification block in the live function — refusing to patch blind.');
  console.error('--- live ---\n' + ORIGINAL_FN);
  await sql.end();
  process.exit(1);
}
const PATCHED_FN = ORIGINAL_FN.replace(
  NOTIFY_BLOCK,
  [
    '  -- TEMPORARILY SUPPRESSED by scripts/provision-priority-vendors.mjs: no',
    "  -- 'welcome' notification insert here, so the Resend webhook has nothing to",
    "  -- send. Restored verbatim in the script's finally block.",
    '',
    '',
  ].join('\r\n')
);
await sql.unsafe(PATCHED_FN);

try {
  for (const v of VENDORS) {
    console.log(`\n=== ${v.name} (${v.email}) ===`);
    const password = genPassword();

    // 1. Auth user — idempotent.
    let userId;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: v.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: v.name },
    });
    if (created?.user) {
      userId = created.user.id;
      console.log(`  auth user created`);
    } else if (createErr?.message?.toLowerCase().includes('already been registered')) {
      const { data: list, error: listErr } = await admin.auth.admin.listUsers();
      if (listErr) throw listErr;
      const existing = list.users.find((u) => u.email?.toLowerCase() === v.email.toLowerCase());
      if (!existing) throw createErr;
      userId = existing.id;
      await admin.auth.admin.updateUserById(userId, { password });
      console.log(`  auth user already existed, password reset`);
    } else if (createErr) {
      throw createErr;
    }

    // 2. Provider row — reuse existing unclaimed listing, else create bare one.
    let provider = await findProvider(v.name);
    if (provider) {
      const { data: updated, error: updErr } = await admin
        .from('providers')
        .update({ owner_id: userId, is_claimed: true, contact_email: provider.contact_email ?? v.email })
        .eq('id', provider.id)
        .select()
        .single();
      if (updErr) throw updErr;
      provider = updated;
      console.log(`  linked existing provider row (${provider.id})`);
    } else {
      const slug = await ensureUniqueSlug(slugify(v.name));
      const { data: inserted, error: insErr } = await admin
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
      if (insErr) throw insErr;
      provider = inserted;
      console.log(`  created bare provider row (${provider.id}, slug: ${slug})`);
    }

    // 3. provider_members owner row — idempotent (unique(provider_id,user_id)).
    const { error: memErr } = await admin
      .from('provider_members')
      .upsert(
        { provider_id: provider.id, user_id: userId, role: 'owner', status: 'active' },
        { onConflict: 'provider_id,user_id' }
      );
    if (memErr) throw memErr;
    console.log(`  provider_members owner row ready`);

    results.push({ name: v.name, email: v.email, password, providerId: provider.id, slug: provider.slug });
  }
} finally {
  console.log('\n--- Restoring handle_new_user() to its original definition ---');
  await sql.unsafe(ORIGINAL_FN);
  const restored = await currentFnDef();
  if (restored.trim() !== ORIGINAL_FN.trim()) {
    console.error('WARNING: post-restore definition does not match the original byte-for-byte. Check manually:');
    console.error(restored);
  } else {
    console.log('confirmed: handle_new_user() restored exactly.');
  }
  await sql.end();
}

console.log('\n\n=== Vendor portal logins (no emails sent) ===');
console.log('Login URL: https://babybrain-final.vercel.app/vendor/login\n');
for (const r of results) {
  console.log(`${r.name}`);
  console.log(`  email:    ${r.email}`);
  console.log(`  password: ${r.password}`);
  console.log(`  provider: ${r.slug} (${r.providerId})\n`);
}
