#!/usr/bin/env node
/**
 * Hide bad Explore listings (reversible — sets is_published=false, keeps rows).
 *
 *   node scripts/cleanup-listings.mjs            # dry-run (default)
 *   node scripts/cleanup-listings.mjs --live     # actually unpublish
 *
 * Targets:
 *   1. Mock seed activities from Phase-1 (provider_id IS NULL, fabricated
 *      provider_name like "JumpStart Kids") — the "made up classes".
 *   2. Cross-contaminated crawl entries: activities whose title is actually a
 *      DIFFERENT business's name (Active Women listing "Avoyoga" /
 *      "TheMotherhoodSpace").
 * Reads creds from .env.local. Re-run with a real delete only if the user
 * confirms; unpublish is the safe default.
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

// Titles that are really other businesses, mis-attributed by the crawler.
const CONTAMINATED = new Set(['Avoyoga', 'TheMotherhoodSpace']);

async function main() {
  const all = await rest('activities?select=id,title,provider_id,provider_name,is_published&is_published=eq.true');

  const mock = all.filter((a) => !a.provider_id);
  const contaminated = all.filter((a) => a.provider_id && CONTAMINATED.has(a.title));
  const targets = [...mock, ...contaminated];

  console.log(`Published activities: ${all.length}`);
  console.log(`\nMock seed listings (null provider_id) — ${mock.length}:`);
  for (const a of mock) console.log(`  • ${a.title}  (fake provider: ${a.provider_name})`);
  console.log(`\nCross-contaminated listings — ${contaminated.length}:`);
  for (const a of contaminated) console.log(`  • ${a.title}`);

  if (!targets.length) { console.log('\nNothing to unpublish.'); return; }

  if (!LIVE) {
    console.log(`\nDRY RUN — would unpublish ${targets.length} activities. Re-run with --live.`);
    return;
  }

  const ids = targets.map((a) => a.id);
  await rest(`activities?id=in.(${ids.join(',')})`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ is_published: false }),
  });
  console.log(`\nUnpublished ${targets.length} activities.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
