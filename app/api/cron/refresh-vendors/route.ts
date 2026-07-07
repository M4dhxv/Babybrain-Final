import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Weekly refresh of AUTO-LISTED (unclaimed directory) vendors. Triggered by
 * Supabase pg_cron via pg_net (see migration 00021), guarded by a shared
 * secret. Tier-1 strategy: for vendors on WordPress, pull the WP REST API and
 * refresh any clearly-detected price, then stamp synced_at. NEVER touches a
 * claimed vendor's data (only is_auto_listed AND NOT is_claimed rows). Bounded
 * per run (oldest-synced first) so it stays within serverless limits; the weekly
 * cadence rotates through the whole set.
 */
export const maxDuration = 60;

const BATCH = 25;
const FETCH_TIMEOUT_MS = 6000;

async function fetchJson(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BabyBrainBot/1.0' } });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Lowest sensible SGD price found in WP page text, or null. */
function extractPrice(pages: unknown): number | null {
  if (!Array.isArray(pages)) return null;
  const nums: number[] = [];
  for (const p of pages as Array<{ content?: { rendered?: string } }>) {
    const html = p?.content?.rendered ?? '';
    for (const m of html.matchAll(/(?:\$|SGD|S\$)\s?(\d{1,4}(?:\.\d{2})?)/gi)) {
      const n = Number(m[1]);
      if (n >= 5 && n <= 2000) nums.push(n);
    }
  }
  return nums.length ? Math.min(...nums) : null;
}

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.WEBHOOK_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: vendors } = await admin
    .from('providers')
    .select('id, website')
    .eq('is_auto_listed', true)
    .eq('is_claimed', false)
    .not('website', 'is', null)
    .order('synced_at', { ascending: true, nullsFirst: true })
    .limit(BATCH);

  const now = new Date().toISOString();
  let checked = 0;
  let wpHits = 0;
  let pricesUpdated = 0;

  await Promise.all(
    (vendors ?? []).map(async (v) => {
      checked += 1;
      const base = (v.website ?? '').replace(/\/+$/, '');
      const pages = await fetchJson(`${base}/wp-json/wp/v2/pages?per_page=50`);
      if (pages) {
        wpHits += 1;
        const price = extractPrice(pages);
        if (price != null) {
          // Only fill the price on activities that don't already have one.
          const { count } = await admin
            .from('activities')
            .update({ price }, { count: 'exact' })
            .eq('provider_id', v.id)
            .is('price', null);
          if (count) pricesUpdated += count;
        }
      }
      // Always stamp synced_at so the batch rotates on the next run.
      await admin.from('providers').update({ synced_at: now }).eq('id', v.id);
    })
  );

  return NextResponse.json({ ok: true, checked, wp_sites: wpHits, prices_updated: pricesUpdated, at: now });
}
