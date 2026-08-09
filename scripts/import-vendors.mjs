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
/* Without this, a vendor whose provider row already exists is skipped whole —
 * which meant 145 of 156 freshly extracted classes were dropped, including
 * every class for the providers that currently have no listings at all. Only
 * unclaimed, auto-listed providers are touched, so a vendor who has claimed
 * their page and curated it by hand is never overwritten. */
const UPDATE_EXISTING = args.includes('--update-existing');
/* Scraped "medium confidence" records are where the adult-only classes crept
 * in last time (the pre/post-natal cleanup). They import unpublished so they
 * can be reviewed before parents see them. */
const PUBLISH_ALL = args.includes('--publish-all');
const SRC = args.find((a) => !a.startsWith('--'));
if (!SRC) {
  throw new Error(
    'Usage: import-vendors.mjs <enriched.json> [--update-existing] [--publish-all] [--live]'
  );
}

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

/* Must track the live taxonomy. Migration 00031 merged `art-creativity` into
 * sensory-play and `gymnastics` into movement, and this list still named
 * `art-creativity` while omitting swimming/playspaces/community-events/
 * holiday-camps — so those categories could never be matched and every such
 * listing silently fell through to `fallbackCat`. */
const CATS = [
  'music', 'sensory-play', 'movement', 'swimming',
  'early-learning', 'parent-baby', 'playspaces',
  'community-events', 'holiday-camps',
];
const VENDOR_CATS = ['baby-toddler-classes', 'playspaces', 'camps-holiday', 'community-events', 'mum-bub-exercise', 'other'];

/* BabyBrain lists activities a child attends. Pre/post-natal and pelvic-floor
 * work is for the adult only, and publishing it is what forced the earlier
 * cleanup of 41 listings.
 *
 * The extractor's `confidence` doesn't catch these — it scores "is this
 * clearly described", not "is a child present" — so they're filtered on the
 * title instead. Parent-and-child classes ("Mum & Baby Pilates", "Mums &
 * Bubs") are a real category here, so a child word rescues the title. */
const ADULT_ONLY = /pre-?natal|post-?natal|post-?partum|pelvic|physio|physical therapy|antenatal|c-section|diastasis/i;
const CHILD_PRESENT = /baby|bub|child|kid|toddler|infant|newborn|little one|parent\s*(&|and)\s*\w+|mum\s*(&|and)\s*(baby|bub)/i;
const isAdultOnly = (title) => ADULT_ONLY.test(title) && !CHILD_PRESENT.test(title);

function isClosed(rec) {
  // enrich-openai.mjs reports this explicitly; fall back to reading the summary
  // for records produced by the older enrichment scripts.
  if (rec.permanently_closed === true) return true;
  return /permanently closed|is closed|now closed/i.test(rec.summary || '');
}

async function main() {
  const records = JSON.parse(readFileSync(SRC, 'utf8'));
  console.log(`Loaded ${records.length} records from ${SRC}`);

  // slug -> category_id, and existing provider slugs (for dedupe)
  const cats = await rest('activity_categories?select=id,slug');
  const catId = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const fallbackCat = catId['early-learning'] ?? cats[0].id;
  const existingRows = await rest('providers?select=id,slug,is_claimed,contact_email,contact_phone,whatsapp,website');
  const existing = new Map(existingRows.map((p) => [p.slug, p]));
  // Activity slugs are globally unique, so this is what stops a re-run from
  // duplicating classes onto a provider we already topped up.
  const existingActivitySlugs = new Set(
    (await rest('activities?select=slug')).map((a) => a.slug)
  );

  const plan = { providers: [], updates: [], skipped: [] };
  const usedSlugs = new Set(existing.keys());

  for (const rec of records) {
    const reason =
      isClosed(rec) ? 'permanently closed' :
      rec.confidence === 'low' ? 'low confidence' :
      !rec.name ? 'no name' : null;
    if (reason) { plan.skipped.push({ name: rec.name, reason }); continue; }

    const slug = slugify(rec.name);
    const already = existing.get(slug);
    if (already && !UPDATE_EXISTING) {
      plan.skipped.push({ name: rec.name, reason: `already exists (${slug}) — pass --update-existing to add its classes` });
      continue;
    }
    if (already?.is_claimed) {
      plan.skipped.push({ name: rec.name, reason: 'provider has claimed their page — not overwriting' });
      continue;
    }
    if (!already && usedSlugs.has(slug)) {
      plan.skipped.push({ name: rec.name, reason: 'duplicate slug ' + slug });
      continue;
    }
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
    // A placeholder activity named after the business is only worth creating
    // for a brand-new provider; adding one to a provider that already has
    // listings is just noise.
    const source = classes.length ? classes : already ? [] : [{ name: rec.name }];
    const acts = source.map((c, i) => {
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
        // Only high-confidence extractions go live unattended. Medium ones
        // land unpublished for review — that is where adult-only classes hid
        // last time.
        is_published: (PUBLISH_ALL || rec.confidence === 'high') && !isAdultOnly(c.name),
        requires_medical_disclosure: false,
        external_booking_url: bookingUrl,
      };
    })
      // Never re-add a class we imported on an earlier run.
      .filter((a) => !existingActivitySlugs.has(a.slug));
    acts.forEach((a) => existingActivitySlugs.add(a.slug));

    if (already) {
      if (!acts.length) { plan.skipped.push({ name: rec.name, reason: 'exists, no new classes to add' }); continue; }
      // Fill blanks on the existing row without clobbering anything already set.
      const backfill = {};
      for (const f of ['contact_email', 'contact_phone', 'whatsapp', 'website']) {
        const v = { contact_email: rec.email, contact_phone: rec.phone, whatsapp: rec.whatsapp, website: rec.website }[f];
        if (!already[f] && v) backfill[f] = v;
      }
      plan.updates.push({ id: already.id, name: rec.name, acts, backfill });
      continue;
    }

    plan.providers.push({ provider, locations, acts });
  }

  // --- summary ---
  const totalActs = plan.providers.reduce((n, p) => n + p.acts.length, 0);
  const totalLocs = plan.providers.reduce((n, p) => n + p.locations.length, 0);
  const updActs = plan.updates.reduce((n, u) => n + u.acts.length, 0);
  const allActs = [...plan.providers.flatMap((p) => p.acts), ...plan.updates.flatMap((u) => u.acts)];
  const pub = allActs.filter((a) => a.is_published).length;

  console.log(`\nNew providers   : ${plan.providers.length}  (${totalLocs} locations, ${totalActs} activities)`);
  console.log(`Existing topped : ${plan.updates.length}  (${updActs} activities)`);
  console.log(`Total activities: ${allActs.length}  — ${pub} published, ${allActs.length - pub} unpublished for review`);
  console.log(`Skipped         : ${plan.skipped.length}`);
  for (const s of plan.skipped) console.log(`  - ${s.name}: ${s.reason}`);

  if (plan.updates.length) {
    console.log('\nClasses added to existing providers:');
    for (const u of plan.updates) {
      const extra = Object.keys(u.backfill).length ? ` [+${Object.keys(u.backfill).join(', ')}]` : '';
      console.log(`  ${u.name} (+${u.acts.length})${extra}`);
      for (const a of u.acts) console.log(`      · ${a.title}${a.is_published ? '' : '  (unpublished)'}`);
    }
  }
  if (plan.providers.length) {
    console.log('\nSample new provider:', JSON.stringify(plan.providers[0].provider, null, 2).slice(0, 500));
  }

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

  let okU = 0, okUA = 0;
  for (const u of plan.updates) {
    try {
      if (Object.keys(u.backfill).length) {
        await rest(`providers?id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ ...u.backfill, synced_at: new Date().toISOString() }) });
      }
      await rest('activities', { method: 'POST', body: JSON.stringify(u.acts.map((a) => ({ ...a, provider_id: u.id }))) });
      okU += 1; okUA += u.acts.length;
      console.log(`  ✓ ${u.name} (+${u.acts.length} activities)`);
    } catch (e) {
      console.log(`  ✗ ${u.name}: ${e.message}`);
    }
  }

  console.log(
    `\nDone: ${okP} providers created · ${okL} locations · ${okA} activities` +
      `\n      ${okU} existing providers topped up · ${okUA} activities added`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
