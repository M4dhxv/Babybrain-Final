#!/usr/bin/env node
/**
 * Backfill coordinates for provider_locations using OneMap (data.gov.sg).
 *
 *   node scripts/geocode-locations.mjs            # dry-run (default)
 *   node scripts/geocode-locations.mjs --live     # actually write lat/lng
 *
 * Multi-venue businesses (Kindermusik, Lucy Sparkles, My Gym, Swish…) keep
 * their venues in provider_locations, but none of those rows were geocoded, so
 * only the provider's single primary coordinate ever reached the Explore map.
 * This fills them in: postal code first (authoritative), then the venue name,
 * then the address string. `region` is recalculated by the DB trigger.
 *
 * Reads creds from .env.local. No API key required.
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

async function oneMapSearch(term, attempt = 0) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(
    term
  )}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url).then((r) => r.json()).catch(() => null);
  // The free endpoint throttles under a long run; one backoff retry keeps
  // results stable rather than silently dropping a venue.
  if (!res && attempt < 2) {
    await sleep(1500 * (attempt + 1));
    return oneMapSearch(term, attempt + 1);
  }
  const hit = res?.results?.[0];
  if (!hit?.LATITUDE || !hit?.LONGITUDE) return null;
  const lat = Number(hit.LATITUDE);
  const lng = Number(hit.LONGITUDE);
  if (!(lat > 1.15 && lat < 1.48 && lng > 103.5 && lng < 104.15)) return null;
  return { lat, lng, matched: hit.ADDRESS };
}

const postalFrom = (s) => (s || '').match(/\b(\d{6})\b/)?.[1] || null;

// Venue names are written for humans ("Better Play (Katong)", "The Little Gym
// of Singapore East", "Other branches"). OneMap matches building names well but
// only when the query is the building alone, so try progressively looser terms.
// Names that describe no fixed place are skipped outright.
const VAGUE = /^(various|other|home-?based|school-?based|on-?site|condo pools|public pools)\b/i;

function nameTerms(name) {
  const raw = (name || '').trim();
  if (!raw || VAGUE.test(raw)) return [];
  const inParens = raw.match(/\(([^)]+)\)/)?.[1]?.trim();
  const bare = raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Drop the business prefix ("The Little Gym of Singapore East" → "East" is
  // useless, but "SWISH Laguna" → "Laguna" is the locality we want).
  const tail = bare.split(/\s+/).slice(-2).join(' ');

  const terms = [bare, inParens, `${bare} Singapore`, tail].filter(Boolean);
  return [...new Set(terms)].filter((t) => t.length > 3 && !VAGUE.test(t));
}

async function main() {
  const rows = await rest(
    'provider_locations?select=id,name,address,postal_code,latitude,longitude,providers(business_name)' +
      '&or=(latitude.is.null,longitude.is.null)'
  );
  console.log(`Found ${rows.length} venue rows with missing coordinates.\n`);

  let filled = 0;
  const skipped = [];
  for (const l of rows) {
    const vendor = l.providers?.business_name ?? '?';
    const postal = l.postal_code || postalFrom(l.address);
    const terms = [
      ...(postal ? [postal] : []),
      ...nameTerms(l.name || ''),
      ...(l.address ? [l.address] : []),
    ];

    let geo = null;
    for (const term of terms) {
      geo = await oneMapSearch(term);
      await sleep(300); // be polite to the free endpoint
      if (geo) break;
    }

    if (!geo) {
      skipped.push(`${vendor} — ${l.name}`);
      console.log(`  – ${vendor} / ${l.name}: no match`);
      continue;
    }
    console.log(`  ✓ ${vendor} / ${l.name} → ${geo.lat}, ${geo.lng}   [${geo.matched}]`);
    if (LIVE) {
      await rest(`provider_locations?id=eq.${l.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ latitude: geo.lat, longitude: geo.lng }),
      });
    }
    filled += 1;
  }

  console.log(`\n${LIVE ? 'Updated' : 'Would update'} ${filled} venues · ${skipped.length} skipped.`);
  if (skipped.length) console.log('Skipped:\n  ' + skipped.join('\n  '));
  if (!LIVE) console.log('\nDRY RUN — re-run with --live to write.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
