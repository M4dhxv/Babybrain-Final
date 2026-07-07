#!/usr/bin/env node
/**
 * Backfill provider coordinates using the free OneMap (data.gov.sg) geocoder.
 *
 *   node scripts/geocode-onemap.mjs            # dry-run (default)
 *   node scripts/geocode-onemap.mjs --live     # actually write lat/lng
 *
 * Finds active providers with a null latitude/longitude, geocodes them via
 * OneMap's Search API (postal code first, then full address), and writes the
 * coordinates back. Providers with no geocodable address ("various venues",
 * demo rows) are reported and left untouched. Reads creds from .env.local.
 * No API key required.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) throw new Error('Missing SUPABASE creds in .env.local');

const LIVE = process.argv.includes('--live');
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function rest(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${r.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OneMap search — returns {lat, lng} for the top result, or null.
async function oneMapSearch(term) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(term)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url).then((r) => r.json()).catch(() => null);
  const hit = res?.results?.[0];
  if (!hit?.LATITUDE || !hit?.LONGITUDE) return null;
  const lat = Number(hit.LATITUDE);
  const lng = Number(hit.LONGITUDE);
  // Sanity-check the result falls within Singapore's bounding box.
  if (!(lat > 1.15 && lat < 1.48 && lng > 103.5 && lng < 104.15)) return null;
  return { lat, lng, matched: hit.ADDRESS };
}

// Pull a 6-digit SG postal code out of an address string if present.
const postalFrom = (s) => (s || '').match(/\b(\d{6})\b/)?.[1] || null;

async function main() {
  const providers = await rest(
    'providers?select=id,business_name,address,postal_code,latitude,longitude&status=eq.active&or=(latitude.is.null,longitude.is.null)'
  );
  console.log(`Found ${providers.length} active providers with missing coordinates.\n`);

  let filled = 0;
  const skipped = [];
  for (const p of providers) {
    const postal = p.postal_code || postalFrom(p.address);
    // Try postal code (most reliable), then the full address string.
    let geo = postal ? await oneMapSearch(postal) : null;
    if (!geo && p.address) geo = await oneMapSearch(p.address);
    await sleep(300); // be polite to the free endpoint

    if (!geo) {
      skipped.push({ name: p.business_name, address: p.address || '(none)' });
      console.log(`  – ${p.business_name}: no match (${p.address || 'no address'})`);
      continue;
    }
    console.log(`  ✓ ${p.business_name} → ${geo.lat}, ${geo.lng}   [${geo.matched}]`);
    if (LIVE) {
      await rest(`providers?id=eq.${p.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ latitude: geo.lat, longitude: geo.lng }),
      });
    }
    filled += 1;
  }

  console.log(`\n${LIVE ? 'Updated' : 'Would update'} ${filled} providers · ${skipped.length} skipped (no geocodable address).`);
  if (!LIVE) console.log('DRY RUN — re-run with --live to write.');
}

main().catch((e) => { console.error(e); process.exit(1); });
