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

  let text: string;
  try {
    const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    text = await res.text();
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    // A well-formed answer is always an array; anything else is not cached.
    if (!Array.isArray(JSON.parse(text))) throw new Error('unexpected shape');
  } catch {
    // `upstream: true` tells the SPA the database itself failed, so it must
    // not retry the same query directly and pile onto a struggling database.
    return NextResponse.json({ error: 'Catalogue unavailable', upstream: true }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

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
