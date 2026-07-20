import { createAdminClient } from '@/lib/supabase/admin';
import { apifyToken, startCrawl, getRunStatus, getDatasetText, abortRun } from '@/lib/apify';

/**
 * Core vendor directory-refresh routine, shared by the weekly pg_cron route
 * ({@link file://app/api/cron/refresh-vendors/route.ts}) and the manual admin
 * trigger ({@link file://app/api/admin/vendors/refresh/route.ts}).
 *
 * Strategy — for AUTO-LISTED, UNCLAIMED vendors, pull the vendor's public site
 * and fill a clearly-detected price on price-less activities, then stamp
 * `synced_at`:
 *
 *   1. Apify crawl (PRIMARY, when APIFY_API_TOKEN is set). A managed headless
 *      crawler that works on any site — JS-rendered pages, non-WordPress CMSes,
 *      proxied to dodge blocks. This is the reliable path the founder asked for.
 *   2. WordPress REST API (FALLBACK, when no Apify token is configured). A plain
 *      `wp-json` fetch — free and instant, but only works on WP sites that leave
 *      the REST API open. Kept so the routine still does *something* pre-key.
 *
 * NEVER touches a claimed vendor. Bounded per run (oldest-synced first) and
 * time-boxed under the serverless limit; the weekly cadence rotates through the
 * whole set. Every run is logged to `vendor_sync_runs` so the founder can see,
 * from /admin, exactly what happened.
 */

// WP fallback can hit many sites cheaply; Apify crawls are slower + metered, so
// a smaller batch keeps each run inside the serverless deadline.
const WP_BATCH = 25;
const APIFY_BATCH = 12;
const FETCH_TIMEOUT_MS = 6000;

// Wall-clock budget for the whole run. Route `maxDuration` is 60s; leave head-
// room to fetch datasets, write results, and abort stragglers before the kill.
const RUN_BUDGET_MS = 50_000;
const POLL_INTERVAL_MS = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `no_wp` predates the Apify path; it now means "no content could be pulled"
// (site unreachable / crawl failed). Kept as-is for admin-UI + API compatibility.
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
  method: 'apify' | 'wordpress';
  checked: number;
  wp_sites: number; // sites we pulled content from (reachable)
  prices_updated: number;
  no_wp: number; // sites with no pullable content
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

/** Lowest sensible SGD price found in a chunk of text/HTML, or null. */
function extractPriceFromText(text: string): number | null {
  const nums: number[] = [];
  for (const m of text.matchAll(/(?:\$|SGD|S\$)\s?(\d{1,4}(?:\.\d{2})?)/gi)) {
    const n = Number(m[1]);
    if (n >= 5 && n <= 2000) nums.push(n);
  }
  return nums.length ? Math.min(...nums) : null;
}

/** Lowest sensible SGD price across WP `pages` REST payload, or null. */
function extractPriceFromWpPages(pages: unknown): number | null {
  if (!Array.isArray(pages)) return null;
  const html = (pages as Array<{ content?: { rendered?: string } }>)
    .map((p) => p?.content?.rendered ?? '')
    .join('\n');
  return extractPriceFromText(html);
}

type Vendor = { id: string; business_name: string | null; website: string | null };

/** Fill a detected price on this vendor's price-less activities. Returns rows updated. */
async function applyPrice(
  admin: ReturnType<typeof createAdminClient>,
  vendorId: string,
  price: number
): Promise<number> {
  const { count } = await admin
    .from('activities')
    .update({ price }, { count: 'exact' })
    .eq('provider_id', vendorId)
    .is('price', null);
  return count ?? 0;
}

/**
 * Crawl one vendor site with Apify and detect a price. Time-boxed against the
 * shared run deadline; aborts its own crawl if it's still going at the buzzer so
 * we don't leak billable runs.
 */
async function priceViaApify(
  vendor: Vendor,
  token: string,
  deadline: number
): Promise<{ reachable: boolean; price: number | null }> {
  const url = (vendor.website ?? '').trim();
  if (!/^https?:\/\//.test(url)) return { reachable: false, price: null };

  const run = await startCrawl(url, token, { maxPages: 3, runTimeoutSecs: 55 });
  if (!run) return { reachable: false, price: null };

  try {
    let status: string | null = 'RUNNING';
    while (status && ['READY', 'RUNNING'].includes(status) && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      status = await getRunStatus(run.runId, token);
    }
    // Grab whatever pages have streamed into the dataset (even on a partial run).
    const texts = await getDatasetText(run.datasetId, token);
    if (status && ['READY', 'RUNNING'].includes(status)) {
      // Still going at the deadline — stop it so it doesn't keep billing.
      void abortRun(run.runId, token);
    }
    if (!texts.length) return { reachable: false, price: null };
    return { reachable: true, price: extractPriceFromText(texts.join('\n')) };
  } catch {
    void abortRun(run.runId, token);
    return { reachable: false, price: null };
  }
}

/** WP REST fallback: pull `wp-json` pages and detect a price. */
async function priceViaWordpress(vendor: Vendor): Promise<{ reachable: boolean; price: number | null }> {
  const base = (vendor.website ?? '').replace(/\/+$/, '');
  const pages = await fetchJson(`${base}/wp-json/wp/v2/pages?per_page=50`);
  if (!pages) return { reachable: false, price: null };
  return { reachable: true, price: extractPriceFromWpPages(pages) };
}

export async function runVendorRefresh(
  trigger: 'cron' | 'manual',
  triggeredBy?: string | null
): Promise<RefreshSummary> {
  const admin = createAdminClient();
  const token = apifyToken();
  const method: 'apify' | 'wordpress' = token ? 'apify' : 'wordpress';
  const batch = token ? APIFY_BATCH : WP_BATCH;
  const deadline = Date.now() + RUN_BUDGET_MS;

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
      .limit(batch);

    const now = new Date().toISOString();
    const results: VendorResult[] = [];
    let checked = 0;
    let reachable = 0;
    let pricesUpdated = 0;

    await Promise.all(
      (vendors ?? []).map(async (v) => {
        checked += 1;
        const name = v.business_name ?? '(unnamed)';
        const website = v.website ?? '';

        const { reachable: ok, price } = token
          ? await priceViaApify(v, token, deadline)
          : await priceViaWordpress(v);

        let outcome: VendorOutcome = 'no_wp';
        let priceUpdated = 0;
        if (ok) {
          reachable += 1;
          outcome = 'no_price';
          if (price != null) {
            priceUpdated = await applyPrice(admin, v.id, price);
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
          wp_sites: reachable,
          prices_updated: pricesUpdated,
          results,
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId);
    }

    return {
      run_id: runId,
      trigger,
      method,
      checked,
      wp_sites: reachable,
      prices_updated: pricesUpdated,
      no_wp: checked - reachable,
      at: now,
    };
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
