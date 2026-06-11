/**
 * Seeds sample published activities + upcoming sessions (service role).
 * Idempotent: activities upsert on slug; sessions are only created for
 * activities that have no future sessions yet.
 *
 * Run: npm run seed
 */
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const img = (id) => `https://images.unsplash.com/${id}?q=80&w=900&auto=format&fit=crop`;

// [slug, title, category, tags, ageMin, ageMax, price, address, postal, lat, lng, image, days, hour]
const ACTIVITIES = [
  ['baby-beats-melodies', 'Baby Beats & Melodies', 'music', ['music'], 6, 24, 45,
    'Forum The Shopping Mall, Orchard Rd', '238884', 1.3052, 103.8302, 'photo-1542810634-71277d95dcbb',
    [6, 0], 11, 'Clap, sing and bounce along in our signature music and movement class for babies. Live guitar, shakers and parachute play build early rhythm and listening skills.', 'Tiny Tunes Studio'],
  ['sensory-explorers-playtime', 'Sensory Explorers Playtime', 'sensory-play', ['sensory-play'], 18, 48, 38,
    'United Square, Novena', '307591', 1.3175, 103.8434, 'photo-1596464716127-f2a82984de30',
    [6, 0], 10, 'Messy play heaven: water beads, kinetic sand, edible paint and texture trays designed by early-childhood educators to spark curiosity safely.', 'Little Senses SG'],
  ['little-artists-workshop', 'Little Artists Workshop', 'art-creativity', ['art-creativity'], 24, 72, 50,
    'Tiong Bahru Community Centre', '160058', 1.2859, 103.8270, 'photo-1617791160505-6f00504e3519',
    [3, 6], 14, 'Process-over-product art sessions: finger painting, clay, collage and big-canvas work. Aprons provided — mess guaranteed, masterpieces optional.', 'Studio Mini'],
  ['mini-movers-adventure', 'Mini Movers Adventure', 'movement', ['movement'], 18, 60, 42,
    'Our Tampines Hub', '528523', 1.3530, 103.9404, 'photo-1529333166437-7750a6dd5a70',
    [6, 0], 9, 'Obstacle courses, balance beams and soft gym play that build gross motor confidence. Coaches keep it playful while sneaking in real skills.', 'JumpStart Kids'],
  ['tiny-tunes-music-movement', 'Tiny Tunes: Music & Movement', 'music', ['music', 'movement'], 6, 36, 40,
    'Parkway Parade, Marine Parade', '449269', 1.3016, 103.9052, 'photo-1542810634-71277d95dcbb',
    [0], 11, 'A gentle intro to melody and beat for the littlest ones — lap songs, egg shakers and lots of giggles, ending with bubble time.', 'Tiny Tunes Studio'],
  ['curious-cubs-early-learning', 'Curious Cubs Early Learning', 'early-learning', ['early-learning'], 18, 48, 55,
    'Bukit Timah Plaza', '588996', 1.3396, 103.7770, 'photo-1503454537195-1dcabb73ffb9',
    [1, 3, 5], 10, 'Play-based phonics, numbers and fine-motor stations in small groups of six. A calm, Montessori-inspired space for first “school” experiences.', 'Curious Cubs'],
  ['splash-and-sing-parent-baby', 'Splash & Sing: Parent + Baby', 'parent-baby', ['parent-baby', 'sensory-play'], 3, 18, 48,
    'SAFRA Mount Faber', '099448', 1.2735, 103.8200, 'photo-1544126592-807ade215a0b',
    [6], 9, 'Warm-water bonding for parent and baby: gentle songs, floating play and water confidence basics with certified infant aquatics coaches.', 'AquaSprouts'],
  ['storytime-stretch-yoga', 'Storytime Stretch: Kids Yoga', 'movement', ['movement', 'early-learning'], 36, 84, 35,
    'Serangoon Gardens Country Club', '555947', 1.3640, 103.8680, 'photo-1544367567-0f2fcb009e0b',
    [0], 16, 'Animal poses woven into a picture-book adventure. Builds flexibility, focus and calm — pyjamas welcome at the evening session.', 'Om Littles'],
];

const { data: categories, error: catError } = await admin
  .from('activity_categories')
  .select('id, slug');
if (catError) throw catError;
const catId = Object.fromEntries(categories.map((c) => [c.slug, c.id]));

let sessionsCreated = 0;
for (const [slug, title, cat, tags, ageMin, ageMax, price, address, postal, lat, lng, image, days, hour, description, provider] of ACTIVITIES) {
  const { data: activity, error } = await admin
    .from('activities')
    .upsert(
      {
        slug,
        title,
        description,
        category_id: catId[cat],
        tags,
        provider_name: provider,
        age_min_months: ageMin,
        age_max_months: ageMax,
        price,
        address,
        postal_code: postal,
        latitude: lat,
        longitude: lng,
        image_urls: [img(image)],
        is_published: true,
      },
      { onConflict: 'slug' }
    )
    .select('id')
    .single();
  if (error) throw error;

  const { count } = await admin
    .from('activity_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('activity_id', activity.id)
    .gte('starts_at', new Date().toISOString());

  if ((count ?? 0) === 0) {
    // Sessions on the given weekdays (0=Sun..6=Sat) over the next 3 weeks, SGT.
    const sessions = [];
    for (let d = 1; d <= 21; d++) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + d);
      if (!days.includes(date.getUTCDay())) continue;
      const startSgt = new Date(
        `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+08:00`
      );
      sessions.push({
        activity_id: activity.id,
        starts_at: startSgt.toISOString(),
        ends_at: new Date(startSgt.getTime() + 60 * 60 * 1000).toISOString(),
        capacity: 12,
      });
    }
    if (sessions.length > 0) {
      const { error: sessError } = await admin.from('activity_sessions').insert(sessions);
      if (sessError) throw sessError;
      sessionsCreated += sessions.length;
    }
  }
  console.log(`✓ ${title}`);
}

console.log(`\nSeeded ${ACTIVITIES.length} activities, ${sessionsCreated} new sessions.`);
