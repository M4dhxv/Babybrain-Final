import { NextResponse } from 'next/server';

/**
 * Public, read-only, edge-cached front door for Explore's three catalogue
 * queries (search_activities, matching_activities, search_activity_facets).
 *
 * Why it exists: every filter tap used to send three queries straight from
 * the parent's browser to Postgres, and the answer is the same for every
 * visitor. A Vercel edge cache in front means the database sees roughly one
 * query per distinct filter combination per minute, however many parents are
 * browsing, instead of three per tap per parent. On the smallest Supabase tier
 * that is the difference between 500 activities working and falling over.
 *
 * It is a transparent pass-through: the same SQL functions run with the same
 * anonymous role the browser used, so rows, counts and ordering are exactly
 * what a direct call returns. The SPA falls back to the direct call if this
 * route is missing (see frontends/parent/src/lib/catalog.ts).
 *
 * Request:  GET /api/explore/<fn>?a=<JSON of the function's arguments>
 * Response: the function's JSON rows, with a short shared-cache lifetime.
 *
 * Everything here is validated: this is a public endpoint, and only
 * well-formed argument sets reach Postgres. Errors are never cached.
 */

const FNS = new Set(['search_activities', 'matching_activities', 'search_activity_facets']);

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SORTS = new Set(['popular', 'rating', 'distance', 'soonest', 'price_asc', 'price_desc']);

type Check = (v: unknown) => boolean;
const int = (min: number, max: number): Check => (v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const num = (min: number, max: number): Check => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const str = (max: number): Check => (v) => typeof v === 'string' && v.length > 0 && v.length <= max;
const slugs = (maxItems: number): Check => (v) =>
  Array.isArray(v) && v.length > 0 && v.length <= maxItems && v.every((x) => typeof x === 'string' && SLUG.test(x));

/** Arguments every one of the three functions takes (the shared filter set). */
const FILTER_ARGS: Record<string, Check> = {
  p_query: str(100),
  p_category_slug: (v) => typeof v === 'string' && SLUG.test(v),
  p_categories: slugs(20),
  p_age_months: int(0, 240),
  p_age_min_months: int(0, 240),
  p_age_max_months: int(0, 240),
  p_date: (v) => typeof v === 'string' && DATE.test(v),
  p_date_from: (v) => typeof v === 'string' && DATE.test(v),
  p_date_to: (v) => typeof v === 'string' && DATE.test(v),
  p_time_min: int(0, 23),
  p_time_max: int(0, 23),
  p_regions: slugs(12),
  p_max_price: num(0, 100000),
  p_lat: num(-90, 90),
  p_lng: num(-180, 180),
  p_radius_km: num(0, 20000),
};

/** Extra arguments only search_activities takes (ordering and paging). */
const SEARCH_ARGS: Record<string, Check> = {
  p_sort: (v) => typeof v === 'string' && SORTS.has(v),
  p_limit: int(1, 100),
  p_offset: int(0, 5000),
  p_region_order: slugs(12),
};

function validate(fn: string, raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = fn === 'search_activities' ? { ...FILTER_ARGS, ...SEARCH_ARGS } : FILTER_ARGS;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const check = allowed[k];
    if (!check || !check(v)) return null; // unknown or malformed argument: reject, don't guess
    out[k] = v;
  }
  return out;
}

type Upstream = { ok: true; text: string } | { ok: false; detail: string };

/** Identical queries already running on this instance. */
const inflight = new Map<string, Promise<Upstream>>();

/** The last good answer per query on this instance, for when the database
 *  fails. Bounded so a stream of unusual searches can't grow it forever. */
const lastGood = new Map<string, { text: string; at: number }>();
const MAX_REMEMBERED = 300;
const STALE_ON_ERROR_MS = 30 * 60_000;

function rememberGood(key: string, text: string) {
  lastGood.delete(key);
  lastGood.set(key, { text, at: Date.now() });
  if (lastGood.size > MAX_REMEMBERED) lastGood.delete(lastGood.keys().next().value as string);
}

async function fetchUpstream(base: string, key: string, fn: string, args: Record<string, unknown>): Promise<Upstream> {
  try {
    const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      // PostgREST's own error code (e.g. 57014 = statement timeout) is safe to
      // pass on and is what tells us overload from a bad request.
      let code = '';
      try { code = (JSON.parse(text) as { code?: string }).code ?? ''; } catch { /* not JSON */ }
      return { ok: false, detail: `database ${res.status}${code ? ` ${code}` : ''}` };
    }
    // A well-formed answer is always an array; anything else is not cached.
    if (!Array.isArray(JSON.parse(text))) return { ok: false, detail: 'unexpected answer' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, detail: e instanceof Error && e.name === 'TimeoutError' ? 'database did not answer in 8s' : 'could not reach database' };
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ fn: string }> }) {
  const { fn } = await params;
  if (!FNS.has(fn)) return NextResponse.json({ error: 'Unknown query' }, { status: 404 });

  let args: Record<string, unknown> | null = null;
  try {
    const a = new URL(request.url).searchParams.get('a');
    args = validate(fn, a ? JSON.parse(a) : {});
  } catch {
    args = null;
  }
  if (!args) return NextResponse.json({ error: 'Bad arguments' }, { status: 400 });

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) return NextResponse.json({ error: 'Not configured' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });

  const cacheKey = `${fn}:${JSON.stringify(args, Object.keys(args).sort())}`;

  // One database call per distinct query per instance at a time: a burst of
  // identical requests (many parents opening the same filter, or one parent's
  // retries) waits on the call already in flight instead of adding to it.
  let call = inflight.get(cacheKey);
  if (!call) {
    call = fetchUpstream(base, key, fn, args).finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, call);
  }
  const result = await call;

  if (result.ok) {
    rememberGood(cacheKey, result.text);
  } else {
    // The database failed. If this instance has served this exact query
    // before, hand that back rather than an error wall: a slightly old list is
    // far better for a parent than "couldn't load". Marked stale and cached
    // only briefly so the real answer replaces it as soon as the database is
    // back. Nothing else (errors included) is ever cached.
    const old = lastGood.get(cacheKey);
    if (old && Date.now() - old.at < STALE_ON_ERROR_MS) {
      return new Response(old.text, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=5', 'X-Catalogue-Stale': '1' },
      });
    }
    // `upstream: true` tells the SPA the database itself failed, so it must
    // not retry the same query directly and pile onto a struggling database.
    return NextResponse.json(
      { error: 'Catalogue unavailable', upstream: true, detail: result.detail },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const text = result.text;

  // Fresh for 45s, then served stale for up to 2 more minutes while one
  // request refreshes it. A listing edit can therefore take a minute or two
  // to reach Explore cards; the activity page and checkout always read live.
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=45, stale-while-revalidate=120',
    },
  });
}
