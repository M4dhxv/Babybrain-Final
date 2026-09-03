#!/usr/bin/env node
/**
 * Backfill coordinates for provider *locations* using OneMap (data.gov.sg).
 *
 *   node scripts/geocode-locations-onemap.mjs           # dry run
 *   node scripts/geocode-locations-onemap.mjs --live    # write
 *
 * geocode-onemap.mjs only fills in `providers.latitude/longitude`, i.e. one pin
 * per business. Multi-venue operators keep their venues in
 * `provider_locations`, and the Explore map draws a pin per venue — so an
 * ungeocoded row there is a venue missing from the map even when the business
 * itself is pinned. That is the "Kindermusik has permanent locations west, east
 * and north so this should show up" report.
 *
 * Postal code is tried first (exact in Singapore), then the free-text address.
 * No API key needed.
 */
import postgres from 'postgres';
import { parseDbUrl } from './lib/db-url.mjs';

process.loadEnvFile('.env.local');
const LIVE = process.argv.includes('--live');
const sql = postgres({ ...parseDbUrl(process.env.SUPABASE_DB_URL), ...{ prepare: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function onemap(query) {
  const url =
    'https://www.onemap.gov.sg/api/common/elastic/search' +
    `?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  // OneMap throttles aggressively; on the first pass a third of the failures
  // were 429s rather than genuine misses, so back off and retry.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(url);
    if (r.status === 429) {
      await sleep(1500 * attempt);
      continue;
    }
    if (!r.ok) throw new Error(`OneMap ${r.status}`);
    const j = await r.json();
    const hit = (j.results || [])[0];
    if (!hit?.LATITUDE || !hit?.LONGITUDE) return null;
    return { lat: Number(hit.LATITUDE), lng: Number(hit.LONGITUDE), matched: hit.ADDRESS || query };
  }
  throw new Error('OneMap 429 after retries');
}

/** "Various venues", "Location in Singapore" and friends can't be geocoded. */
const UNGEOCODABLE = /various|multiple|several|across singapore|location in singapore|islandwide|your home|customers/i;

const rows = await sql`
  select l.id, l.name, l.address, l.postal_code, p.business_name
    from provider_locations l
    join providers p on p.id = l.provider_id
   where l.latitude is null or l.longitude is null
   order by p.business_name, l.name`;

console.log(`${rows.length} location(s) without coordinates\n`);

let fixed = 0, skipped = 0, failed = 0;
const updates = [];

for (const row of rows) {
  const label = `${row.business_name} — ${row.name || '(unnamed)'}`;
  const candidates = [
    row.postal_code && /^\d{6}$/.test(row.postal_code) ? row.postal_code : null,
    row.address && !UNGEOCODABLE.test(row.address) ? row.address : null,
    // A venue name like "Trehaus @ Funan Mall" is often findable on its own.
    row.name && !UNGEOCODABLE.test(row.name) ? `${row.name} Singapore` : null,
  ].filter(Boolean);

  if (!candidates.length) {
    console.log(`  – ${label}: nothing geocodable`);
    skipped++;
    continue;
  }

  let hit = null;
  for (const c of candidates) {
    try {
      hit = await onemap(c);
    } catch (e) {
      console.log(`  ! ${label}: ${e.message}`);
    }
    if (hit) break;
    await sleep(200);
  }

  if (!hit) {
    console.log(`  ✗ ${label}: no match`);
    failed++;
  } else {
    console.log(`  ✓ ${label} -> ${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}  (${hit.matched.slice(0, 44)})`);
    updates.push({ id: row.id, ...hit });
    fixed++;
  }
  await sleep(220); // stay well under OneMap's rate limit
}

if (LIVE && updates.length) {
  for (const u of updates) {
    await sql`update provider_locations
                 set latitude = ${u.lat}, longitude = ${u.lng},
                     region = coalesce(region, public.sg_region(null, ${u.lat}, ${u.lng}))
               where id = ${u.id}`;
  }
  // A provider with no pin of its own can borrow its primary venue's.
  await sql`
    update providers p
       set latitude  = l.latitude,
           longitude = l.longitude,
           region    = coalesce(p.region, l.region)
      from provider_locations l
     where l.provider_id = p.id
       and p.latitude is null
       and l.latitude is not null`;
  console.log(`\nWrote ${updates.length} location(s), and backfilled provider pins from them.`);
} else {
  console.log(`\nDRY RUN — nothing written. Re-run with --live.`);
}

console.log(`geocoded ${fixed} · skipped ${skipped} · failed ${failed}`);
await sql.end();
