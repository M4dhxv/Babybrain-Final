import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import FavoriteButton from '@/components/FavoriteButton';
import {
  IconCalendar,
  IconPin,
  IconSearch,
  IconStar,
  IconUsers,
} from '@/components/icons';
import { catMeta } from '@/lib/categories';
import { areaFromAddress, sgDateTime } from '@/lib/format';
import { formatAgeRange, type SortOption } from '@/types/database';

const AGE_OPTIONS: [string, string][] = [
  ['', 'All Ages'],
  ['6', 'Under 1 year'],
  ['18', '1–2 years'],
  ['30', '2–3 years'],
  ['42', '3–4 years'],
  ['60', '4–6 years'],
];
const DISTANCE_OPTIONS: [string, string][] = [
  ['', 'Any distance'],
  ['3', 'Within 3 km'],
  ['10', 'Within 10 km'],
  ['20', 'Within 20 km'],
];
const PER_PAGE = 8;

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  let lat: number | null = null;
  let lng: number | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from('parent_profiles')
      .select('latitude, longitude')
      .eq('id', user.id)
      .single();
    lat = profile?.latitude ?? null;
    lng = profile?.longitude ?? null;
  }

  const [{ data: categories }, { data: allResults, error }, favRes] = await Promise.all([
    supabase.from('activity_categories').select('*').order('sort_order'),
    supabase.rpc('search_activities', {
      p_query: sp.q || null,
      p_category_slug: sp.category || null,
      p_age_months: sp.age ? Number(sp.age) : null,
      p_date: sp.date || null,
      p_lat: lat,
      p_lng: lng,
      p_radius_km: sp.distance && lat !== null ? Number(sp.distance) : null,
      p_sort: (sp.sort as SortOption) || 'popular',
      p_limit: 100,
      p_offset: 0,
    }),
    user
      ? supabase.from('favorites').select('activity_id')
      : Promise.resolve({ data: [] as { activity_id: string }[] }),
  ]);
  const favIds = new Set((favRes.data ?? []).map((f) => f.activity_id));

  const results = allResults ?? [];
  const totalPages = Math.max(1, Math.ceil(results.length / PER_PAGE));
  const page = Math.min(Math.max(1, Number(sp.page) || 1), totalPages);
  const pageResults = results.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const located = results.filter((r) => r.latitude !== null);

  const ids = pageResults.map((a) => a.id);
  const { data: addresses } = ids.length
    ? await supabase.from('activities').select('id, address').in('id', ids)
    : { data: [] };
  const addressById = new Map((addresses ?? []).map((a) => [a.id, a.address]));

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== 'page') params.set(k, v);
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return `/explore${qs ? `?${qs}` : ''}`;
  };

  return (
    <main className="container">
      <h1 className="page-h1">Explore Activities ✨</h1>
      <p className="page-sub">Browse activities across Singapore.</p>

      {/* ---------- Filter bar ---------- */}
      <form method="get" className="filter-bar">
        <label className="f-pill">
          <IconSearch size={15} />
          <input type="search" name="q" placeholder="Search activities…" defaultValue={sp.q ?? ''} aria-label="Search" />
        </label>
        <label className="f-pill">
          Category
          <select name="category" defaultValue={sp.category ?? ''}>
            <option value="">All</option>
            {(categories ?? []).map((c) => (
              <option key={c.slug} value={c.slug}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="f-pill">
          <IconUsers size={15} /> Age
          <select name="age" defaultValue={sp.age ?? ''}>
            {AGE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="f-pill">
          <IconCalendar size={15} /> Date
          <input type="date" name="date" defaultValue={sp.date ?? ''} aria-label="Date" />
        </label>
        <label className="f-pill" title={lat === null ? 'Log in and complete onboarding to filter by distance' : undefined}>
          <IconPin size={15} /> Distance
          <select name="distance" defaultValue={sp.distance ?? ''} disabled={lat === null}>
            {DISTANCE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="f-pill sort-wrap">
          Sort by:
          <select name="sort" defaultValue={sp.sort ?? 'popular'}>
            <option value="popular">Most Popular</option>
            <option value="rating">Highest Rated</option>
            {lat !== null && <option value="distance">Nearest</option>}
          </select>
        </label>
        <button className="btn sm" type="submit">Apply</button>
      </form>

      {error ? (
        <p className="notice error">Search failed: {error.message}</p>
      ) : (
        <p className="found">
          {results.length} {results.length === 1 ? 'activity' : 'activities'} found
        </p>
      )}

      <section className="explore-grid">
        {/* ---------- Result list ---------- */}
        <div>
          {pageResults.map((a) => {
            const meta = catMeta(a.category_slug);
            return (
              <Link key={a.id} href={`/activities/${a.slug}`} className="row-card">
                <div className="row-media">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.image_urls[0] ?? ''} alt="" loading="lazy" />
                  <span className={`cat-pill ${meta.solid}`}>{a.category_name}</span>
                </div>
                <div className="row-body">
                  <h3>{a.title}</h3>
                  <div className="meta">
                    <IconUsers size={14} /> {formatAgeRange(a.age_min_months, a.age_max_months)}
                    {addressById.get(a.id) && (
                      <>
                        <IconPin size={14} /> {areaFromAddress(addressById.get(a.id))}
                      </>
                    )}
                  </div>
                  <div className="meta">
                    {a.next_session_at && (
                      <>
                        <IconCalendar size={14} /> {sgDateTime(a.next_session_at)}
                      </>
                    )}
                    {a.dist_km !== null && (
                      <span className="muted">· {a.dist_km.toFixed(1)} km away</span>
                    )}
                  </div>
                  {a.rating_count > 0 && (
                    <div className="rating">
                      <IconStar size={13} /> {Number(a.rating_avg).toFixed(1)}{' '}
                      <span className="muted">({a.rating_count})</span>
                      {a.popularity > 2 && (
                        <span className="tag soft-movement" style={{ color: 'var(--blue)' }}>
                          Popular this week
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <FavoriteButton
                  activityId={a.id}
                  initialFavorited={favIds.has(a.id)}
                  authed={Boolean(user)}
                  variant="heart"
                />
              </Link>
            );
          })}
          {pageResults.length === 0 && !error && (
            <p className="notice">
              No activities match those filters yet — try widening your search.
            </p>
          )}

          {totalPages > 1 && (
            <nav className="pagination" aria-label="Pages">
              {page > 1 && (
                <Link className="page-btn" href={pageHref(page - 1)} aria-label="Previous page">‹</Link>
              )}
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <Link key={p} className={`page-btn${p === page ? ' on' : ''}`} href={pageHref(p)}>
                  {p}
                </Link>
              ))}
              {page < totalPages && (
                <Link className="page-btn" href={pageHref(page + 1)} aria-label="Next page">›</Link>
              )}
            </nav>
          )}
        </div>

        {/* ---------- Map panel ---------- */}
        <aside className="map-card">
          <div className="map-head">
            <h2>Explore on map</h2>
            <span className="f-pill">
              <IconSearch size={14} /> Search this area
            </span>
          </div>
          <div className="map-canvas">
            <span style={{ fontSize: 34 }}>🗺️</span>
            <strong>{located.length} located activities</strong>
            <p className="muted" style={{ margin: 0, fontSize: 13.5, fontWeight: 600, maxWidth: '34ch' }}>
              The interactive map arrives with a maps API key. Meanwhile, every
              activity below is pinned by neighbourhood:
            </p>
            <div className="chip-row" style={{ justifyContent: 'center', marginTop: 6 }}>
              {located.slice(0, 8).map((r) => (
                <Link key={r.id} href={`/activities/${r.slug}`} className="chip clickable" style={{ background: '#fff' }}>
                  📍 {r.title.length > 22 ? `${r.title.slice(0, 22)}…` : r.title}
                </Link>
              ))}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
