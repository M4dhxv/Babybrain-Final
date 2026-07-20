# Vendor directory refresh (Apify scraping)

How BabyBrain keeps **auto-listed, unclaimed** directory vendors fresh — currently
by detecting and filling in a class price from each vendor's public website.

- Core routine: [`lib/vendor-refresh.ts`](../lib/vendor-refresh.ts)
- Apify client: [`lib/apify.ts`](../lib/apify.ts)
- Weekly trigger (pg_cron): [`app/api/cron/refresh-vendors/route.ts`](../app/api/cron/refresh-vendors/route.ts)
- Manual trigger (from `/admin`): [`app/api/admin/vendors/refresh/route.ts`](../app/api/admin/vendors/refresh/route.ts)
- Run history table: `vendor_sync_runs` (migration `00022`)
- Offline bulk importer (separate, not this routine): [`scripts/crawl-vendors.mjs`](../scripts/crawl-vendors.mjs)

## Why Apify

The first version fetched each vendor's WordPress REST API (`/wp-json`). That only
works on WordPress sites that leave the REST API open — most vendor sites are on
Wix / Squarespace / custom stacks, JS-rendered, or block plain bots, so coverage
was poor and unreliable.

The refresh now uses **[Apify](https://apify.com)'s managed crawler**
(`apify~website-content-crawler`) as the primary strategy. It runs a real headless
browser behind rotating proxies, so it reads almost any public site regardless of
CMS or anti-bot measures. The WordPress fetch is kept as an automatic fallback for
when no Apify token is configured.

## Strategy selection

`runVendorRefresh()` picks its method at runtime from the environment:

| `APIFY_API_TOKEN` set? | Method | Batch size | Notes |
|---|---|---|---|
| **Yes** | Apify crawl (primary) | 12 / run | Reliable, works on any site, metered |
| **No** | WordPress REST (fallback) | 25 / run | Free + instant, WP-only, low coverage |

The method used is returned in the run summary (`method: 'apify' | 'wordpress'`)
and logged, so `/admin` always shows which path ran.

> **To enable Apify:** set `APIFY_API_TOKEN` (Vercel env + `.env.local`) to your
> Apify API token, then redeploy. Nothing else changes — the next refresh run
> (weekly cron or a manual `/admin` trigger) automatically switches to Apify.

## How a run works

1. **Open a run row** in `vendor_sync_runs` (`status='running'`) so an in-progress
   or crashed run is still visible in `/admin`.
2. **Select a batch** of auto-listed, unclaimed vendors with a website, ordered by
   `synced_at` ascending (least-recently-synced first, `NULL`s first). This rotates
   through the whole directory over successive weekly runs.
3. **For each vendor, in parallel:**
   - *Apify path* — start a shallow crawl (`maxPages: 3`, `maxCrawlDepth: 1`), poll
     the run until it finishes or the shared deadline hits, then read the page text
     from the run's dataset. Any crawl still running at the deadline is **aborted**
     so it stops burning credits.
   - *WordPress path* — fetch `/wp-json/wp/v2/pages?per_page=50`.
   - Detect the **lowest sensible SGD price** (`$` / `SGD` / `S$` followed by a
     number in the 5–2000 range) in the pulled text.
   - If a price is found, fill it on that vendor's activities where `price IS NULL`
     (never overwrites an existing price).
   - Always stamp `synced_at` so the vendor rotates to the back of the queue.
4. **Close the run row** (`status='success'`) with per-vendor outcomes, or
   `status='error'` + message if the whole run threw.

**Claimed vendors are never touched** — the query filters `is_claimed = false`.
Once a vendor claims their listing they own their own data.

### Per-vendor outcomes (shown in `/admin`)

| Outcome | Meaning |
|---|---|
| `price_updated` | A price was detected and filled on ≥1 activity |
| `no_price` | Site was reachable/crawled, but no price detected |
| `no_wp` | Site could not be pulled (unreachable / crawl failed). *Name is historical — it now means "no content", not "no WordPress".* |

## Time & cost budget

- **Serverless deadline:** the route sets `maxDuration = 60s`. The routine holds a
  `RUN_BUDGET_MS = 50s` internal budget, leaving headroom to fetch datasets, write
  results, and abort stragglers before the platform kill.
- **Batch of 12** Apify crawls run concurrently, each capped at `maxPages: 3` and a
  55s Apify-side `timeout`. Aborting unfinished runs at the deadline caps spend.
- **Apify cost** is usage-based (compute units per crawl). Keeping pages shallow and
  the batch small keeps each weekly run cheap. Monitor usage in the Apify console;
  if runs get expensive, lower `APIFY_BATCH` or `maxPages` in `lib/vendor-refresh.ts`.

## Extending what gets pulled

Today the routine only extracts a **price**. The plumbing (crawl → text → parse →
update) generalises. To pull more (e.g. schedule, age range, description):

1. Add a parser next to `extractPriceFromText()` in `lib/vendor-refresh.ts`.
2. Apply it in the per-vendor loop and widen the `activities` update.
3. Extend `VendorResult` / the `/admin` outcome labels if you want it surfaced.

## Failure behaviour (by design)

Every external call is failure-tolerant: a network error, non-200, or bad payload
returns `null`/`[]` rather than throwing. One flaky vendor site can therefore never
take down a whole refresh run — it just records `no_wp` for that vendor and moves on.
