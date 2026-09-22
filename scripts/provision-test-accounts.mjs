/**
 * Provisions the demo vendor logins on the *test* Supabase project only:
 *
 *   demo.vendor@babybrain.sg
 *   indsg.kidscenter@babybrain.sg
 *
 * Each gets an auth user, a `providers` row, a primary location, a Premium
 * (`pro`) subscription with no Stripe objects, a couple of published
 * activities and upcoming sessions. Idempotent: re-running reuses the users
 * (password is reset), updates the provider, and upserts activities by slug.
 *
 * This is NOT a migration and must never live under supabase/migrations/, so
 * `supabase db push` can never carry these accounts to production.
 *
 * Safety:
 *   - Reads .env.test.local (gitignored via `.env*.local`), never .env.local,
 *     because .env.local points at production.
 *   - Refuses to run unless the Supabase URL is the babybrain-test project,
 *     and hard-refuses the production project.
 *   - Passwords come from the env file, not from this source.
 *
 * .env.test.local needs:
 *   TEST_SUPABASE_URL=https://imlfhepnucytyajxpoum.supabase.co
 *   TEST_SUPABASE_SERVICE_ROLE_KEY=...   (test project's service_role key)
 *   DEMO_VENDOR_PASSWORD=...
 *   INDSG_VENDOR_PASSWORD=...
 *
 * Run: node scripts/provision-test-accounts.mjs
 */
import { createClient } from '@supabase/supabase-js';

const TEST_REF = 'imlfhepnucytyajxpoum';
const PROD_REF = 'laftgypwwfevzggxknii';

process.loadEnvFile('.env.test.local');

const {
  TEST_SUPABASE_URL: url,
  TEST_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  DEMO_VENDOR_PASSWORD,
  INDSG_VENDOR_PASSWORD,
} = process.env;

for (const [k, v] of Object.entries({
  TEST_SUPABASE_URL: url,
  TEST_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  DEMO_VENDOR_PASSWORD,
  INDSG_VENDOR_PASSWORD,
})) {
  if (!v) throw new Error(`Missing ${k} in .env.test.local`);
}

if (url.includes(PROD_REF)) {
  throw new Error('Refusing to run: TEST_SUPABASE_URL is the PRODUCTION project.');
}
if (!url.includes(TEST_REF)) {
  throw new Error(`Refusing to run: TEST_SUPABASE_URL must be the ${TEST_REF} (babybrain-test) project.`);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const DAY_MS = 24 * 60 * 60 * 1000;

const VENDORS = [
  {
    email: 'demo.vendor@babybrain.sg',
    password: DEMO_VENDOR_PASSWORD,
    fullName: 'Demo Vendor',
    business_name: 'Demo Vendor',
    description: 'Demo vendor account for testing the BabyBrain vendor portal.',
    vendor_category: 'baby-toddler-classes',
    phone: '+6591234567',
    address: '1 Orchard Boulevard, Singapore',
    postal_code: '248649',
    latitude: 1.3048,
    longitude: 103.8318,
    region: 'central',
    locationName: 'Demo Vendor — Orchard',
    activities: [
      {
        slug: 'demo-vendor-baby-sensory',
        title: 'Baby Sensory Playtime',
        description: 'Gentle sensory play with lights, textures and sounds for little explorers.',
        category_id: 2,
        age_min_months: 3,
        age_max_months: 18,
        price: 20,
        default_capacity: 10,
      },
      {
        slug: 'demo-vendor-toddler-music',
        title: 'Toddler Music & Movement',
        description: 'Songs, instruments and movement games for toddlers and their grown-ups.',
        category_id: 1,
        age_min_months: 12,
        age_max_months: 36,
        price: 24,
        default_capacity: 12,
      },
    ],
  },
  {
    email: 'indsg.kidscenter@babybrain.sg',
    password: INDSG_VENDOR_PASSWORD,
    fullName: 'Ind-SG Kids Center',
    business_name: 'Ind-SG Kids Center',
    description:
      "Celebrating Singapore's Indian heritage through music, dance and art — playful, culturally-rooted classes for little ones.",
    vendor_category: 'baby-toddler-classes',
    phone: '+6598765432',
    address: '48 Serangoon Road, Singapore',
    postal_code: '218148',
    latitude: 1.3066,
    longitude: 103.8518,
    region: 'central',
    locationName: 'Ind-SG Kids Center — Little India',
    activities: [
      {
        slug: 'indsg-bollywood-beats-babies',
        title: 'Bollywood Beats for Babies',
        description:
          'A lively sing-and-move class set to Bollywood classics — rhythm, rhymes and plenty of giggles for babies and their grown-ups.',
        category_id: 1,
        age_min_months: 6,
        age_max_months: 24,
        price: 25,
        default_capacity: 10,
      },
      {
        slug: 'indsg-rangoli-art-sensory-play',
        title: 'Rangoli Art & Sensory Play',
        description:
          'Hands-on sensory play inspired by rangoli patterns — coloured rice, textured paints and pattern-making for curious little hands.',
        category_id: 2,
        age_min_months: 18,
        age_max_months: 60,
        price: 22,
        default_capacity: 12,
      },
      {
        slug: 'indsg-bharatanatyam-tots',
        title: 'Bharatanatyam Tots',
        description:
          'A playful introduction to Bharatanatyam — basic postures, footwork and storytelling gestures, adapted for preschoolers.',
        category_id: 4,
        age_min_months: 36,
        age_max_months: 72,
        price: 28,
        default_capacity: 8,
      },
    ],
  },
];

// Staggered so classes don't collide: ~10am, ~12pm, ~4pm SGT.
const SESSION_PLAN = [
  { hourUTC: 2, durationMin: 45 },
  { hourUTC: 4, durationMin: 60 },
  { hourUTC: 8, durationMin: 45 },
];

async function upsertAuthUser({ email, password, fullName }) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (created?.user) {
    console.log(`  Created auth user ${email}`);
    return created.user.id;
  }
  if (!error?.message?.toLowerCase().includes('already been registered')) throw error;

  // Page through users to find the existing one (listUsers is paginated).
  for (let page = 1; ; page++) {
    const { data, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (listErr) throw listErr;
    const existing = data.users.find((u) => u.email?.toLowerCase() === email);
    if (existing) {
      const { error: pwErr } = await admin.auth.admin.updateUserById(existing.id, {
        password,
        email_confirm: true,
      });
      if (pwErr) throw pwErr;
      console.log(`  Reused auth user ${email} (password reset)`);
      return existing.id;
    }
    if (data.users.length < 200) throw error;
  }
}

async function saveRow(table, match, fields) {
  let q = admin.from(table).select('id');
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const { data: existing } = await q.maybeSingle();
  const { data, error } = existing
    ? await admin.from(table).update(fields).eq('id', existing.id).select().single()
    : await admin.from(table).insert(fields).select().single();
  if (error) throw error;
  return data;
}

async function provision(v) {
  console.log(`\n--- ${v.business_name} (${v.email}) ---`);
  const userId = await upsertAuthUser(v);

  const provider = await saveRow('providers', { owner_id: userId }, {
    owner_id: userId,
    business_name: v.business_name,
    description: v.description,
    vendor_category: v.vendor_category,
    contact_email: v.email,
    contact_phone: v.phone,
    whatsapp: v.phone,
    address: v.address,
    postal_code: v.postal_code,
    latitude: v.latitude,
    longitude: v.longitude,
    is_claimed: true,
    verification_status: 'verified',
    status: 'active',
    region: v.region,
  });
  console.log(`  Provider ready (${provider.id})`);

  const location = await saveRow('provider_locations', { provider_id: provider.id, is_primary: true }, {
    provider_id: provider.id,
    name: v.locationName,
    address: v.address,
    postal_code: v.postal_code,
    latitude: v.latitude,
    longitude: v.longitude,
    is_primary: true,
    region: v.region,
  });
  console.log(`  Location ready (${location.id})`);

  // Premium = `pro` in the DB. No Stripe ids, so nothing can reach live Stripe.
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
  console.log('  Subscription: Premium (pro), active');

  for (let i = 0; i < v.activities.length; i++) {
    const a = v.activities[i];
    const { data: activity, error } = await admin
      .from('activities')
      .upsert(
        {
          ...a,
          provider_id: provider.id,
          location_id: location.id,
          provider_name: provider.business_name,
          vendor_category: v.vendor_category,
          tags: ['demo'],
          address: v.address,
          postal_code: v.postal_code,
          latitude: v.latitude,
          longitude: v.longitude,
          region: v.region,
          is_published: true,
        },
        { onConflict: 'slug' }
      )
      .select()
      .single();
    if (error) throw error;

    const plan = SESSION_PLAN[i % SESSION_PLAN.length];
    const first = new Date();
    first.setUTCHours(plan.hourUTC, 0, 0, 0);
    const { data: existing } = await admin
      .from('activity_sessions')
      .select('starts_at')
      .eq('activity_id', activity.id);
    const have = new Set((existing ?? []).map((s) => new Date(s.starts_at).toISOString()));

    let added = 0;
    for (let w = 0; w < 3; w++) {
      const startsAt = new Date(first.getTime() + (i + 1) * DAY_MS + w * 7 * DAY_MS);
      if (have.has(startsAt.toISOString())) continue;
      const { error: sErr } = await admin.from('activity_sessions').insert({
        activity_id: activity.id,
        location_id: location.id,
        starts_at: startsAt.toISOString(),
        ends_at: new Date(startsAt.getTime() + plan.durationMin * 60 * 1000).toISOString(),
        capacity: a.default_capacity,
        status: 'scheduled',
      });
      if (sErr) throw sErr;
      added++;
    }
    console.log(`  Activity "${activity.title}" ready (+${added} session(s))`);
  }
}

console.log(`Provisioning demo vendors on ${url}`);
for (const v of VENDORS) await provision(v);
console.log('\n--- Done ---');
for (const v of VENDORS) console.log(`Vendor portal login: ${v.email}`);
