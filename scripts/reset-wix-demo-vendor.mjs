/**
 * Simulates a vendor disconnecting their Wix account (via /api/vendor/wix-integration
 * DELETE) plus the reconciliation a sync would then perform: previously-linked
 * activities get flagged wix_missing_since + unpublished, matching what
 * lib/wix/sync.ts's reconciliation pass does when a service disappears from a
 * live Wix fetch. Does NOT touch wix_removed_at, wix_service_id, sessions, or
 * bookings — this is the "looks disconnected, not unlinked" state.
 *
 * One-off test-data helper for resetting the demo vendor's Wix integration
 * to a fresh/unconnected state. Not part of the app's runtime.
 *
 * Run: node scripts/reset-wix-demo-vendor.mjs
 */
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const EMAIL = 'demo.vendor@babybrain.sg';

console.log(`--- Resetting Wix integration for ${EMAIL} ---\n`);

// 1. Find the auth user.
const { data: list, error: listErr } = await admin.auth.admin.listUsers();
if (listErr) throw listErr;
const user = list.users.find((u) => u.email === EMAIL);
if (!user) throw new Error(`No auth user found for ${EMAIL}`);
console.log(`Found auth user ${user.id}`);

// 2. Find provider(s) they're linked to — owner first, else membership.
const { data: ownedProviders, error: ownedErr } = await admin
  .from('providers')
  .select('id, business_name, wix_site_id')
  .eq('owner_id', user.id);
if (ownedErr) throw ownedErr;

let providers = ownedProviders ?? [];
if (providers.length === 0) {
  const { data: members, error: membersErr } = await admin
    .from('provider_members')
    .select('provider_id, providers(id, business_name, wix_site_id)')
    .eq('user_id', user.id)
    .eq('status', 'active');
  if (membersErr) throw membersErr;
  providers = (members ?? []).map((r) => r.providers).filter(Boolean);
}

if (providers.length === 0) throw new Error(`No provider found linked to ${EMAIL}`);
console.log(`Linked provider(s): ${providers.map((p) => `${p.business_name} (${p.id})`).join(', ')}\n`);

for (const provider of providers) {
  console.log(`--- Provider ${provider.business_name} (${provider.id}) ---`);

  // 3. Delete Wix credentials + clear mirrored site id (same as the DELETE route).
  const { error: credErr, count: credCount } = await admin
    .from('provider_wix_credentials')
    .delete({ count: 'exact' })
    .eq('provider_id', provider.id);
  if (credErr) throw credErr;
  console.log(`Deleted provider_wix_credentials rows: ${credCount}`);

  const { error: siteErr } = await admin
    .from('providers')
    .update({ wix_site_id: null })
    .eq('id', provider.id);
  if (siteErr) throw siteErr;
  console.log('Cleared providers.wix_site_id');

  // 4. Reconcile linked activities as "missing" — same fields/condition the
  //    sync's reconciliation pass uses (lib/wix/sync.ts ~line 260-276), just
  //    applied for the case where no live Wix fetch is possible anymore.
  const { data: linked, error: linkedErr } = await admin
    .from('activities')
    .select('id, title, wix_service_id')
    .eq('provider_id', provider.id)
    .not('wix_service_id', 'is', null)
    .is('wix_missing_since', null);
  if (linkedErr) throw linkedErr;

  console.log(`Activities to flag as missing: ${linked?.length ?? 0}`);
  for (const act of linked ?? []) {
    const { error } = await admin
      .from('activities')
      .update({ wix_missing_since: new Date().toISOString(), is_published: false })
      .eq('id', act.id);
    if (error) {
      console.error(`  Failed on "${act.title}" (${act.id}): ${error.message}`);
    } else {
      console.log(`  Flagged "${act.title}" (${act.id})`);
    }
  }
  console.log('');
}

console.log('--- Done ---');
