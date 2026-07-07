import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Core vendor directory-refresh routine, shared by the weekly pg_cron route
 * ({@link file://app/api/cron/refresh-vendors/route.ts}) and the manual admin
 * trigger ({@link file://app/api/admin/vendors/refresh/route.ts}).
 *
 * Tier-1 strategy: for AUTO-LISTED, UNCLAIMED vendors on WordPress, pull the WP
 * REST API and fill a clearly-detected price on price-less activities, then
 * stamp `synced_at`. NEVER touches a claimed vendor. Bounded per run
 * (oldest-synced first) so it stays within serverless limits; the weekly
 * cadence rotates through the whole set. Every run is logged to
 * `vendor_sync_runs` so the founder can see, from /admin, what happened.
 */

const BATCH = 25;
const FETCH_TIMEOUT_MS = 6000;

export type VendorOutcome = 'price_updated' | 'no_price' | 'no_wp';

export type VendorResult = {
  name: string;
  website: string;
  outcome: VendorOutcome;
  price_updated: number;
};

export type RefreshSummary = {
  run_id: string | null;
  trigger: 'cron' | 'manual';
  checked: number;
  wp_sites: number;
  prices_updated: number;
  no_wp: number;
  at: string;
};

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

export async function runVendorRefresh(
  trigger: 'cron' | 'manual',
  triggeredBy?: string | null
): Promise<RefreshSummary> {
  const admin = createAdminClient();

  // Open a run row so an in-progress/crashed run is still visible.
  const { data: run } = await admin
    .from('vendor_sync_runs')
    .insert({ trigger, triggered_by: triggeredBy ?? null })
    .select('id')
    .single();
  const runId = run?.id ?? null;

  try {
    const { data: vendors } = await admin
      .from('providers')
      .select('id, business_name, website')
      .eq('is_auto_listed', true)
      .eq('is_claimed', false)
      .not('website', 'is', null)
      .order('synced_at', { ascending: true, nullsFirst: true })
      .limit(BATCH);

    const now = new Date().toISOString();
    const results: VendorResult[] = [];
    let checked = 0;
    let wpHits = 0;
    let pricesUpdated = 0;

    await Promise.all(
      (vendors ?? []).map(async (v) => {
        checked += 1;
        const name = v.business_name ?? '(unnamed)';
        const website = v.website ?? '';
        const base = website.replace(/\/+$/, '');
        const pages = await fetchJson(`${base}/wp-json/wp/v2/pages?per_page=50`);

        let outcome: VendorOutcome = 'no_wp';
        let priceUpdated = 0;
        if (pages) {
          wpHits += 1;
          outcome = 'no_price';
          const price = extractPrice(pages);
          if (price != null) {
            const { count } = await admin
              .from('activities')
              .update({ price }, { count: 'exact' })
              .eq('provider_id', v.id)
              .is('price', null);
            priceUpdated = count ?? 0;
            pricesUpdated += priceUpdated;
            if (priceUpdated > 0) outcome = 'price_updated';
          }
        }
        results.push({ name, website, outcome, price_updated: priceUpdated });
        // Always stamp synced_at so the batch rotates on the next run.
        await admin.from('providers').update({ synced_at: now }).eq('id', v.id);
      })
    );

    // Newest-first so the log reads like a feed (updated vendors on top).
    results.sort((a, b) => Number(b.price_updated) - Number(a.price_updated) || a.outcome.localeCompare(b.outcome));

    if (runId) {
      await admin
        .from('vendor_sync_runs')
        .update({
          status: 'success',
          checked,
          wp_sites: wpHits,
          prices_updated: pricesUpdated,
          results,
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId);
    }

    return { run_id: runId, trigger, checked, wp_sites: wpHits, prices_updated: pricesUpdated, no_wp: checked - wpHits, at: now };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (runId) {
      await admin
        .from('vendor_sync_runs')
        .update({ status: 'error', error: msg, finished_at: new Date().toISOString() })
        .eq('id', runId);
    }
    throw e;
  }
}
