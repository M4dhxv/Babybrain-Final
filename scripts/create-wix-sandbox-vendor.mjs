/**
 * Provisions a login-capable sandbox vendor for testing the Wix Bookings
 * integration end-to-end: a real Supabase auth user + a `providers` row
 * linked to the sandbox Wix site (WIX_SITE_ID) + one `activities` row
 * mapped to a real Wix service/resource. Idempotent — reuses the auth user
 * and upserts the provider/activity on repeat runs.
 *
 * Availability itself is never stored here — it's fetched live from Wix at
 * request time (see app/api/wix/slots, lib/wix/client.ts). This script only
 * creates the linkage rows needed for that to resolve to something.
 *
 * Run: node scripts/create-wix-sandbox-vendor.mjs
 */
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const WIX_ACCESS_TOKEN = process.env.WIX_ACCESS_TOKEN;
const WIX_SITE_ID = process.env.WIX_SITE_ID;
if (!WIX_ACCESS_TOKEN || !WIX_SITE_ID) {
  console.error('❌ Missing WIX_ACCESS_TOKEN / WIX_SITE_ID in .env.local');
  process.exit(1);
}

const wixHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${WIX_ACCESS_TOKEN}`,
  'wix-site-id': WIX_SITE_ID,
};

async function wixFetch(path, body) {
  const res = await fetch(`https://www.wixapis.com${path}`, {
    method: 'POST',
    headers: wixHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Wix API ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Fixed by default (like scripts/validate-vendor.mjs's VendorTest123!) so the
// credentials are predictable across runs — this is a sandbox/test account,
// never a real vendor's. Override via env if you want a different password.
const EMAIL = process.env.SANDBOX_VENDOR_EMAIL || 'wix-sandbox-vendor@babybrain.sg';
const PASSWORD = process.env.SANDBOX_VENDOR_PASSWORD || 'WixSandbox123!';

console.log('--- Provisioning Wix sandbox vendor ---\n');

// 1. Auth user (reuse it if a previous run already created it).
let userId;
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email: EMAIL,
  password: PASSWORD,
  email_confirm: true,
  user_metadata: { full_name: 'Wix Sandbox Vendor' },
});
if (created?.user) {
  userId = created.user.id;
  console.log(`✅ Created auth user ${EMAIL}`);
} else if (createErr?.message?.toLowerCase().includes('already been registered')) {
  const { data: list, error: listErr } = await admin.auth.admin.listUsers();
  if (listErr) throw listErr;
  const existing = list.users.find((u) => u.email === EMAIL);
  if (!existing) throw createErr;
  userId = existing.id;
  await admin.auth.admin.updateUserById(userId, { password: PASSWORD });
  console.log(`✅ Reused existing auth user ${EMAIL} (password reset)`);
} else {
  throw createErr;
}

// 2. Real Wix services + a bookable resource. One APPOINTMENT service (1:1
//    slots, needs a resource) and one CLASS service (group sessions, real
//    capacity, no resource) — see lib/wix/client.ts for why they need
//    different code paths.
const { services } = await wixFetch('/bookings/v2/services/query', { query: { paging: { limit: 50 } } });
const appointmentService = (services ?? []).find((s) => s.type === 'APPOINTMENT');
if (!appointmentService) throw new Error('No APPOINTMENT service found on the Wix sandbox site.');
const classService = (services ?? []).find((s) => s.type === 'CLASS');
if (!classService) throw new Error('No CLASS service found on the Wix sandbox site.');

const { resources } = await wixFetch('/bookings/v2/resources/query', { query: {} });
const resource = (resources ?? []).find((r) => r.bookable);
if (!resource) throw new Error('No bookable resource found on the Wix sandbox site.');
console.log(
  `✅ Found Wix services "${appointmentService.name}" (APPOINTMENT) + "${classService.name}" (CLASS), resource "${resource.name}" (${resource.id})`
);

// 3. Provider row — reuse one already owned by this user, else create it.
const { data: existingProvider } = await admin
  .from('providers')
  .select('id')
  .eq('owner_id', userId)
  .maybeSingle();

const providerFields = {
  owner_id: userId,
  business_name: 'Wix Sandbox Studio',
  vendor_category: 'baby-toddler-classes',
  status: 'active',
  is_claimed: true,
  verification_status: 'verified',
  wix_site_id: WIX_SITE_ID,
};
const { data: provider, error: providerErr } = existingProvider
  ? await admin.from('providers').update(providerFields).eq('id', existingProvider.id).select().single()
  : await admin.from('providers').insert(providerFields).select().single();
if (providerErr) throw providerErr;
console.log(`✅ Provider "${provider.business_name}" ready (${provider.id})`);

// 4. One activity per Wix service — this is what parents book.
const { data: category, error: catErr } = await admin
  .from('activity_categories')
  .select('id')
  .order('sort_order')
  .limit(1)
  .single();
if (catErr) throw catErr;

const { data: appointmentActivity, error: apptActErr } = await admin
  .from('activities')
  .upsert(
    {
      slug: 'wix-sandbox-studio-class',
      title: `${appointmentService.name} (Wix Sandbox)`,
      description: 'A 1:1 appointment — availability is pulled live from Wix. BabyBrain integration test listing.',
      category_id: category.id,
      provider_id: provider.id,
      vendor_category: 'baby-toddler-classes',
      is_published: true,
      wix_service_id: appointmentService.id,
      wix_resource_id: resource.id,
      wix_service_type: 'APPOINTMENT',
    },
    { onConflict: 'slug' }
  )
  .select()
  .single();
if (apptActErr) throw apptActErr;
console.log(`✅ Activity "${appointmentActivity.title}" ready (slug: ${appointmentActivity.slug})`);

const { data: classActivity, error: classActErr } = await admin
  .from('activities')
  .upsert(
    {
      slug: 'wix-sandbox-studio-group-class',
      title: `${classService.name} (Wix Sandbox)`,
      description: 'A group class with real capacity — availability is pulled live from Wix. BabyBrain integration test listing.',
      category_id: category.id,
      provider_id: provider.id,
      vendor_category: 'baby-toddler-classes',
      is_published: true,
      wix_service_id: classService.id,
      wix_resource_id: null,
      wix_service_type: 'CLASS',
    },
    { onConflict: 'slug' }
  )
  .select()
  .single();
if (classActErr) throw classActErr;
console.log(`✅ Activity "${classActivity.title}" ready (slug: ${classActivity.slug})\n`);

console.log('--- Done ---');
console.log(`Vendor portal login:      ${EMAIL} / ${PASSWORD}`);
console.log(`Appointment activity:     /book?slug=${appointmentActivity.slug}`);
console.log(`Class activity:           /book?slug=${classActivity.slug}`);
console.log('Vendor "Wix Availability" tab will show both activities once you log in.');
