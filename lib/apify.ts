/**
 * Minimal Apify API client used by the vendor directory refresh
 * ({@link file://lib/vendor-refresh.ts}). Uses the same actor as the offline
 * bulk-import script (scripts/crawl-vendors.mjs) so behaviour stays
 * consistent: `apify~website-content-crawler` with the fast cheerio engine.
 *
 * The token comes from `APIFY_API_TOKEN`. Every helper is failure-tolerant —
 * a network error or bad response returns null/[] instead of throwing, so one
 * flaky vendor site can never take down a whole refresh run.
 */

const APIFY_BASE = 'https://api.apify.com/v2';
export const APIFY_ACTOR = 'apify~website-content-crawler';

export function apifyToken(): string | null {
  const t = process.env.APIFY_API_TOKEN?.trim();
  return t ? t : null;
}

async function apifyJson(
  path: string,
  token: string,
  init?: RequestInit
): Promise<unknown | null> {
  const sep = path.includes('?') ? '&' : '?';
  try {
    const r = await fetch(`${APIFY_BASE}${path}${sep}token=${token}`, init);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export type ApifyRun = { runId: string; datasetId: string };

/** Start a shallow content crawl of one site. Returns null if the run could not start. */
export async function startCrawl(
  url: string,
  token: string,
  opts: { maxPages?: number; runTimeoutSecs?: number } = {}
): Promise<ApifyRun | null> {
  const input = {
    startUrls: [{ url }],
    crawlerType: 'cheerio', // static fetch — fast + cheap; fine for price detection
    maxCrawlDepth: 1,
    maxCrawlPages: opts.maxPages ?? 3,
    maxConcurrency: 3,
    saveMarkdown: true,
    saveHtml: false,
    proxyConfiguration: { useApifyProxy: true },
  };
  const res = (await apifyJson(
    `/acts/${APIFY_ACTOR}/runs?timeout=${opts.runTimeoutSecs ?? 55}&memory=1024`,
    token,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
  )) as { data?: { id?: string; defaultDatasetId?: string } } | null;
  const runId = res?.data?.id;
  const datasetId = res?.data?.defaultDatasetId;
  return runId && datasetId ? { runId, datasetId } : null;
}

/** Current run status (READY | RUNNING | SUCCEEDED | FAILED | ABORTED | TIMED-OUT), or null. */
export async function getRunStatus(runId: string, token: string): Promise<string | null> {
  const res = (await apifyJson(`/actor-runs/${runId}`, token)) as
    | { data?: { status?: string } }
    | null;
  return res?.data?.status ?? null;
}

/** Best-effort abort so a stuck crawl stops burning credits. */
export async function abortRun(runId: string, token: string): Promise<void> {
  await apifyJson(`/actor-runs/${runId}/abort`, token, { method: 'POST' });
}

/**
 * Text content of every page the crawl has stored so far. Items stream into
 * the dataset while the run is live, so this also yields partial results for
 * runs we abort at the deadline.
 */
export async function getDatasetText(datasetId: string, token: string): Promise<string[]> {
  const items = await apifyJson(`/datasets/${datasetId}/items?clean=true&format=json`, token);
  if (!Array.isArray(items)) return [];
  return (items as Array<{ markdown?: string; text?: string }>)
    .map((p) => p.markdown || p.text || '')
    .filter(Boolean);
}
