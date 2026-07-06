#!/usr/bin/env node
/**
 * Import enriched crawl data as CLAIMABLE (unclaimed) vendor listings.
 *
 *   node scripts/import-vendors.mjs <enriched.json>            # dry-run (default)
 *   node scripts/import-vendors.mjs <enriched.json> --live     # actually write
 *
 * Creates, per vendor: one provider (is_claimed=false, is_auto_listed=true,
 * status=active), its locations, and one published activity per class with the
 * vendor's own booking_url as external_booking_url (so "Book" links out for now).
 * Skips permanently-closed and low-confidence records. Dedupes providers by slug.
 * Reads SUPABASE creds from .env.local.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// --- env ---
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) throw new Error('Missing SUPABASE creds in .env.local');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const SRC = args.find((a) => !a.startsWith('--'));
if (!SRC) throw new Error('Usage: import-vendors.mjs <enriched.json> [--live]');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function rest(path, opts = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${r.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const slugify = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);

const CATS = ['music', 'sensory-play', 'art-creativity', 'movement', 'early-learning', 'parent-baby'];
const VENDOR_CATS = ['baby-toddler-classes', 'playspaces', 'camps-holiday', 'community-events', 'mum-bub-exercise', 'other'];

function isClosed(rec) {
  return /permanently closed|is closed|now closed/i.test(rec.summary || '');
}

async function main() {
  const records = JSON.parse(readFileSync(SRC, 'utf8'));
  console.log(`Loaded ${records.length} records from ${SRC}`);

  // slug -> category_id, and existing provider slugs (for dedupe)
  const cats = await rest('activity_categories?select=id,slug');
  const catId = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const fallbackCat = catId['early-learning'] ?? cats[0].id;
  const existing = new Set((await rest('providers?select=slug')).map((p) => p.slug));

  const plan = { providers: [], skipped: [] };
  const usedSlugs = new Set(existing);

  for (const rec of records) {
    const reason =
      isClosed(rec) ? 'permanently closed' :
      rec.confidence === 'low' ? 'low confidence' :
      !rec.name ? 'no name' : null;
    if (reason) { plan.skipped.push({ name: rec.name, reason }); continue; }

    let slug = slugify(rec.name);
    if (usedSlugs.has(slug)) { plan.skipped.push({ name: rec.name, reason: 'duplicate slug ' + slug }); continue; }
    usedSlugs.add(slug);

    const vcat = VENDOR_CATS.includes(rec.bb_vendor_category) ? rec.bb_vendor_category : 'other';
    const loc0 = (rec.locations || [])[0] || {};
    const age = rec.target_age || {};
    const provider = {
      business_name: rec.name,
      slug,
      description: (rec.summary || '').slice(0, 2000),
      vendor_category: vcat,
      contact_email: rec.email || null,
      contact_phone: rec.phone || null,
      whatsapp: rec.whatsapp || null,
      website: rec.website || null,
      social: rec.socials || {},
      address: rec.address || loc0.address || null,
      postal_code: loc0.postal_code || null,
      latitude: rec.latitude ?? null,
      longitude: rec.longitude ?? null,
      is_claimed: false,
      is_auto_listed: true,
      verification_status: 'unverified',
      status: 'active',
      source_url: rec.website || null,
      synced_at: new Date().toISOString(),
    };

    const locations = (rec.locations || [])
      .filter((l) => l && (l.name || l.address))
      .slice(0, 12)
      .map((l, i) => ({ name: l.name || rec.name, address: l.address || null, postal_code: l.postal_code || null, is_primary: i === 0 }));

    const bookingUrl = rec.booking_url || rec.website || null;
    const classes = (rec.classes || []).filter((c) => c && c.name).slice(0, 20);
    const acts = (classes.length ? classes : [{ name: rec.name }]).map((c, i) => {
      const cslug = (CATS.find((s) => (rec.activities_categories || []).includes(s)) || null);
      const desc = [c.days ? `Days: ${(c.days || []).join(', ')}` : '', c.times ? `Times: ${(c.times || []).join(', ')}` : '', c.duration ? `Duration: ${c.duration}` : '', c.location ? `Location: ${c.location}` : '']
        .filter(Boolean).join(' · ');
      return {
        slug: `${slug}-${slugify(c.name) || 'class'}-${i}`.slice(0, 70),
        title: c.name.slice(0, 120),
        description: desc || (rec.summary || '').slice(0, 500),
        category_id: catId[cslug] ?? fallbackCat,
        provider_name: rec.name,
        vendor_category: vcat,
        age_min_months: Number.isFinite(age.min_months) ? age.min_months : 0,
        age_max_months: Number.isFinite(age.max_months) ? age.max_months : 216,
        price: null,
        address: rec.address || loc0.address || null,
        postal_code: loc0.postal_code || null,
        image_urls: [],
        is_published: true,
        requires_medical_disclosure: false,
        external_booking_url: bookingUrl,
      };
    });

    plan.providers.push({ provider, locations, acts });
  }

  // --- summary ---
  const totalActs = plan.providers.reduce((n, p) => n + p.acts.length, 0);
  const totalLocs = plan.providers.reduce((n, p) => n + p.locations.length, 0);
  console.log(`\nWould create: ${plan.providers.length} providers · ${totalLocs} locations · ${totalActs} activities`);
  console.log(`Skipped: ${plan.skipped.length}`);
  for (const s of plan.skipped) console.log(`  - ${s.name}: ${s.reason}`);
  console.log('\nSample provider:', JSON.stringify(plan.providers[0]?.provider, null, 2));
  console.log('Sample activity:', JSON.stringify(plan.providers[0]?.acts[0], null, 2));

  if (!LIVE) {
    console.log('\nDRY RUN — nothing written. Re-run with --live to import.');
    return;
  }

  console.log('\n--- LIVE IMPORT ---');
  let okP = 0, okL = 0, okA = 0;
  for (const p of plan.providers) {
    try {
      const [created] = await rest('providers', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(p.provider) });
      okP += 1;
      const pid = created.id;
      if (p.locations.length) {
        await rest('provider_locations', { method: 'POST', body: JSON.stringify(p.locations.map((l) => ({ ...l, provider_id: pid }))) });
        okL += p.locations.length;
      }
      await rest('activities', { method: 'POST', body: JSON.stringify(p.acts.map((a) => ({ ...a, provider_id: pid }))) });
      okA += p.acts.length;
      console.log(`  ✓ ${p.provider.business_name} (${p.acts.length} activities)`);
    } catch (e) {
      console.log(`  ✗ ${p.provider.business_name}: ${e.message}`);
    }
  }
  console.log(`\nDone: ${okP} providers · ${okL} locations · ${okA} activities created.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
