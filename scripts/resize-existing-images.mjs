#!/usr/bin/env node
/**
 * Downscale already-uploaded activity/provider photos (the vendor portal now
 * resizes on upload; this catches what was uploaded before).
 *
 *   node scripts/resize-existing-images.mjs            # dry-run (default)
 *   node scripts/resize-existing-images.mjs --live     # upload + repoint DB
 *
 * Non-destructive: each oversized original is left in storage untouched. A
 * 1600px WebP copy is uploaded beside it (<name>.opt.webp) and the DB rows
 * (activities.image_urls / cover_image_url, providers.logo_url /
 * cover_image_url / gallery_urls) are repointed. To roll back, repoint to the
 * originals — they are still there. Idempotent: .opt.webp URLs are skipped.
 * Reads creds from .env.local.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

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
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const BUCKET = 'activity-images';
const PUBLIC_PREFIX = `${SB}/storage/v1/object/public/${BUCKET}/`;
const MAX_EDGE = 1600;
const SKIP_BELOW = 300 * 1024;

async function rest(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: { ...H, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${r.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** original URL -> optimised URL (or null when left alone), so a photo shared
 *  by several rows is only processed once. */
const cache = new Map();
const stats = { checked: 0, resized: 0, skipped: 0, failed: 0, savedBytes: 0 };

async function optimise(url) {
  if (!url || !url.startsWith(PUBLIC_PREFIX) || url.endsWith('.opt.webp')) return null;
  if (cache.has(url)) return cache.get(url);
  stats.checked++;
  let result = null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp)/.test(type)) { stats.skipped++; cache.set(url, null); return null; }
    const meta = await sharp(buf).metadata();
    const big = Math.max(meta.width || 0, meta.height || 0) > MAX_EDGE;
    if (!big && buf.length <= SKIP_BELOW) { stats.skipped++; cache.set(url, null); return null; }
    const out = await sharp(buf)
      .rotate() // bake in EXIF orientation before metadata is stripped
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    if (out.length >= buf.length) { stats.skipped++; cache.set(url, null); return null; }
    const path = decodeURIComponent(url.slice(PUBLIC_PREFIX.length));
    const newPath = path.replace(/\.[^./]+$/, '') + '.opt.webp';
    console.log(`  ${path}  ${(buf.length / 1024) | 0}KB ${meta.width}x${meta.height} -> ${(out.length / 1024) | 0}KB`);
    if (LIVE) {
      const up = await fetch(`${SB}/storage/v1/object/${BUCKET}/${newPath.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'image/webp', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' },
        body: out,
      });
      if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);
    }
    stats.resized++;
    stats.savedBytes += buf.length - out.length;
    result = PUBLIC_PREFIX + newPath.split('/').map(encodeURIComponent).join('/');
  } catch (e) {
    stats.failed++;
    console.warn(`  FAILED ${url}: ${e.message}`);
  }
  cache.set(url, result);
  return result;
}

async function processTable(table, scalarCols, arrayCols) {
  const cols = ['id', ...scalarCols, ...arrayCols].join(',');
  const rows = await rest(`${table}?select=${cols}&limit=100000`);
  console.log(`${table}: ${rows.length} rows`);
  for (const row of rows) {
    const patch = {};
    for (const c of scalarCols) {
      const next = await optimise(row[c]);
      if (next) patch[c] = next;
    }
    for (const c of arrayCols) {
      if (!Array.isArray(row[c]) || !row[c].length) continue;
      const next = [];
      let changed = false;
      for (const u of row[c]) {
        const n = await optimise(u);
        next.push(n || u);
        if (n) changed = true;
      }
      if (changed) patch[c] = next;
    }
    if (LIVE && Object.keys(patch).length) {
      await rest(`${table}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=minimal' } });
    }
  }
}

console.log(LIVE ? 'LIVE run' : 'DRY RUN (no uploads, no DB writes) — pass --live to apply');
console.log(`target: ${SB}`);
await processTable('activities', ['cover_image_url'], ['image_urls']);
await processTable('providers', ['logo_url', 'cover_image_url'], ['gallery_urls']);
console.log(
  `\nchecked ${stats.checked}, ${LIVE ? 'resized' : 'would resize'} ${stats.resized}, skipped ${stats.skipped}, failed ${stats.failed}, ` +
    `saving ~${(stats.savedBytes / 1048576).toFixed(1)}MB`
);
