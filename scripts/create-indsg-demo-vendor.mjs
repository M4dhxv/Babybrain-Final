/**
 * Provisions a login-capable demo vendor, "Ind-SG Kids Center", entirely
 * on-site (no Wix integration) — a login-capable auth user + `providers` row
 * on the Premium plan (`pro` in the DB, per frontends/vendor/src/lib/plans.ts)
 * + one primary location + 2-3 published activities, each with a handful of
 * upcoming bookable sessions. Idempotent — reuses the auth user/provider and
 * upserts activities on repeat runs.
 *
 * Run: node scripts/create-indsg-demo-vendor.mjs
 */
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const EMAIL = process.env.INDSG_VENDOR_EMAIL || 'indsg.kidscenter@babybrain.sg';
const PASSWORD = process.env.INDSG_VENDOR_PASSWORD || 'IndSGDemo123!';

console.log('--- Provisioning Ind-SG Kids Center (demo vendor) ---\n');

// 1. Auth user (reuse it if a previous run already created it).
let userId;
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email: EMAIL,
  password: PASSWORD,
  email_confirm: true,
  user_metadata: { full_name: 'Ind-SG Kids Center' },
});
if (created?.user) {
  userId = created.user.id;
  console.log(`Created auth user ${EMAIL}`);
} else if (createErr?.message?.toLowerCase().includes('already been registered')) {
  const { data: list, error: listErr } = await admin.auth.admin.listUsers();
  if (listErr) throw listErr;
  const existing = list.users.find((u) => u.email === EMAIL);
  if (!existing) throw createErr;
  userId = existing.id;
  await admin.auth.admin.updateUserById(userId, { password: PASSWORD });
  console.log(`Reused existing auth user ${EMAIL} (password reset)`);
} else {
  throw createErr;
}

// 2. Provider row — Little India, a fitting home base for the theme.
const ADDRESS = '48 Serangoon Road, Singapore';
const POSTAL_CODE = '218148';
const LAT = 1.3066;
const LNG = 103.8518;

const { data: existingProvider } = await admin
  .from('providers')
  .select('id')
  .eq('owner_id', userId)
  .maybeSingle();

const providerFields = {
  owner_id: userId,
  business_name: 'Ind-SG Kids Center',
  description: "Celebrating Singapore's Indian heritage through music, dance and art — playful, culturally-rooted classes for little ones.",
  vendor_category: 'baby-toddler-classes',
  contact_email: EMAIL,
  contact_phone: '+6598765432',
  whatsapp: '+6598765432',
  address: ADDRESS,
  postal_code: POSTAL_CODE,
  latitude: LAT,
  longitude: LNG,
  is_claimed: true,
  verification_status: 'verified',
  status: 'active',
  region: 'central',
};
const { data: provider, error: providerErr } = existingProvider
  ? await admin.from('providers').update(providerFields).eq('id', existingProvider.id).select().single()
  : await admin.from('providers').insert(providerFields).select().single();
if (providerErr) throw providerErr;
console.log(`Provider "${provider.business_name}" ready (${provider.id})`);

// 3. Primary location.
const { data: existingLoc } = await admin
  .from('provider_locations')
  .select('id')
  .eq('provider_id', provider.id)
  .eq('is_primary', true)
  .maybeSingle();

const locationFields = {
  provider_id: provider.id,
  name: 'Ind-SG Kids Center — Little India',
  address: ADDRESS,
  postal_code: POSTAL_CODE,
  latitude: LAT,
  longitude: LNG,
  is_primary: true,
  region: 'central',
};
const { data: location, error: locErr } = existingLoc
  ? await admin.from('provider_locations').update(locationFields).eq('id', existingLoc.id).select().single()
  : await admin.from('provider_locations').insert(locationFields).select().single();
if (locErr) throw locErr;
console.log(`Location "${location.name}" ready (${location.id})`);

// 4. Premium plan — `pro` is the current DB value for what the vendor Plans
//    page displays as "Premium" (SGD 199/month, 8% commission); see
//    frontends/vendor/src/lib/plans.ts PLAN_META. No real Stripe objects
//    behind this — stripe_customer_id/stripe_subscription_id stay null so
//    nothing here can accidentally hit the live Stripe API.
const oneYearOut = new Date();
oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);

const { error: subErr } = await admin.from('subscriptions').upsert(
  {
    provider_id: provider.id,
    plan: 'pro',
    status: 'active',
    current_period_end: oneYearOut.toISOString(),
    cancel_at_period_end: false,
    commission_rate: 0.08,
    commission_flat_cents: 0,
    fee_payer: 'vendor',
    commission_on_packages: true,
    custom_terms: false,
    updated_at: new Date().toISOString(),
  },
  { onConflict: 'provider_id' }
);
if (subErr) throw subErr;
console.log('Subscription set to Premium (pro), active, 8% commission');

// 5. Activities — three on-site classes themed around the vendor's identity.
//    No wix_service_id anywhere: these are plain, vendor-entered listings.
const ACTIVITIES = [
  {
    slug: 'indsg-bollywood-beats-babies',
    title: 'Bollywood Beats for Babies',
    description: 'A lively sing-and-move class set to Bollywood classics — rhythm, rhymes and plenty of giggles for babies and their grown-ups.',
    category_id: 1, // Music & Drama
    age_min_months: 6,
    age_max_months: 24,
    price: 25,
    default_capacity: 10,
  },
  {
    slug: 'indsg-rangoli-art-sensory-play',
    title: 'Rangoli Art & Sensory Play',
    description: 'Hands-on sensory play inspired by rangoli patterns — coloured rice, textured paints and pattern-making for curious little hands.',
    category_id: 2, // Sensory & Art
    age_min_months: 18,
    age_max_months: 60,
    price: 22,
    default_capacity: 12,
  },
  {
    slug: 'indsg-bharatanatyam-tots',
    title: 'Bharatanatyam Tots',
    description: 'A playful introduction to Bharatanatyam — basic postures, footwork and storytelling gestures, adapted for preschoolers.',
    category_id: 4, // Gym & Dance
    age_min_months: 36,
    age_max_months: 72,
    price: 28,
    default_capacity: 8,
  },
];

const createdActivities = [];
for (const a of ACTIVITIES) {
  const { data: activity, error } = await admin
    .from('activities')
    .upsert(
      {
        ...a,
        provider_id: provider.id,
        location_id: location.id,
        provider_name: provider.business_name,
        vendor_category: 'baby-toddler-classes',
        tags: ['demo'],
        address: ADDRESS,
        postal_code: POSTAL_CODE,
        latitude: LAT,
        longitude: LNG,
        region: 'central',
        is_published: true,
      },
      { onConflict: 'slug' }
    )
    .select()
    .single();
  if (error) throw error;
  createdActivities.push(activity);
  console.log(`Activity "${activity.title}" ready (slug: ${activity.slug})`);
}

// 6. A few upcoming sessions per activity, so each is actually bookable —
//    weekday mornings/afternoons over the next two weeks, times staggered
//    per class so they don't all collide.
const DAY_MS = 24 * 60 * 60 * 1000;
function nextSessionDates(count, startOffsetDays, hourUTC) {
  const dates = [];
  let d = new Date();
  d.setUTCHours(hourUTC, 0, 0, 0);
  d = new Date(d.getTime() + startOffsetDays * DAY_MS);
  while (dates.length < count) {
    dates.push(new Date(d));
    d = new Date(d.getTime() + 7 * DAY_MS); // same weekday, next week
  }
  return dates;
}

const SESSION_PLAN = [
  { hourUTC: 2, durationMin: 45 },  // ~10am SGT
  { hourUTC: 4, durationMin: 60 },  // ~12pm SGT
  { hourUTC: 8, durationMin: 45 },  // ~4pm SGT
];

for (let i = 0; i < createdActivities.length; i++) {
  const activity = createdActivities[i];
  const plan = SESSION_PLAN[i % SESSION_PLAN.length];
  const starts = nextSessionDates(3, i + 1, plan.hourUTC);

  const { data: existingSessions } = await admin
    .from('activity_sessions')
    .select('id, starts_at')
    .eq('activity_id', activity.id);
  const existingTimes = new Set((existingSessions ?? []).map((s) => s.starts_at));

  let sessionsAdded = 0;
  for (const startsAt of starts) {
    if (existingTimes.has(startsAt.toISOString())) continue;
    const endsAt = new Date(startsAt.getTime() + plan.durationMin * 60 * 1000);
    const { error } = await admin.from('activity_sessions').insert({
      activity_id: activity.id,
      location_id: location.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      capacity: activity.default_capacity,
      status: 'scheduled',
    });
    if (error) throw error;
    sessionsAdded++;
  }
  console.log(`  + ${sessionsAdded} session(s) added for "${activity.title}"`);
}

console.log('\n--- Done ---');
console.log(`Vendor portal login:  ${EMAIL} / ${PASSWORD}`);
console.log(`Plan:                 Premium (pro), 8% commission`);
for (const a of createdActivities) {
  console.log(`Activity:             /activity?slug=${a.slug}`);
}
