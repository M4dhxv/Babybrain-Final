import { createClient } from '@/lib/supabase/server';
import ActivityCard from '@/components/ActivityCard';
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

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  // Use the parent's geocoded home location for distance filtering/sorting.
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

  const [{ data: categories }, { data: results, error }] = await Promise.all([
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
      p_limit: 24,
      p_offset: 0,
    }),
  ]);

  return (
    <main className="container">
      <h1 style={{ fontSize: 44, color: '#7e5acd', marginTop: 18 }}>Explore Activities</h1>
      <p className="lead" style={{ fontSize: 20 }}>Browse activities across Singapore.</p>

      <form method="get" className="card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input name="q" placeholder="Search activities…" defaultValue={sp.q ?? ''} style={{ flex: '2 1 200px' }} />
        <select name="category" defaultValue={sp.category ?? ''} style={{ flex: '1 1 150px' }}>
          <option value="">Category: All</option>
          {(categories ?? []).map((c) => (
            <option key={c.slug} value={c.slug}>{c.name}</option>
          ))}
        </select>
        <select name="age" defaultValue={sp.age ?? ''} style={{ flex: '1 1 130px' }}>
          {AGE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input type="date" name="date" defaultValue={sp.date ?? ''} style={{ flex: '1 1 140px' }} />
        <select name="distance" defaultValue={sp.distance ?? ''} style={{ flex: '1 1 140px' }} disabled={lat === null}
          title={lat === null ? 'Log in and complete onboarding to filter by distance' : undefined}>
          {DISTANCE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select name="sort" defaultValue={sp.sort ?? 'popular'} style={{ flex: '1 1 140px' }}>
          <option value="popular">Most Popular</option>
          <option value="rating">Highest Rated</option>
          {lat !== null && <option value="distance">Nearest</option>}
        </select>
        <button className="btn small" type="submit">Apply</button>
      </form>

      {error && <p className="notice error">Search failed: {error.message}</p>}

      <section className="twocol" style={{ marginTop: 18 }}>
        <div>
          {(results ?? []).map((a) => (
            <a key={a.id} href={`/activities/${a.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="list-item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.image_urls[0] ?? ''} alt={a.title} />
                <div style={{ padding: '12px 12px 12px 0' }}>
                  <h3 style={{ margin: '8px 0 4px' }}>{a.title}</h3>
                  <p className="muted" style={{ margin: 0 }}>
                    {a.category_name} · {formatAgeRange(a.age_min_months, a.age_max_months)}
                    {a.price !== null && <> · ${a.price}</>}
                    {a.dist_km !== null && <> · {a.dist_km.toFixed(1)} km away</>}
                  </p>
                  {a.rating_count > 0 && (
                    <p style={{ margin: '4px 0 0' }}>
                      <span className="stars">{'★'.repeat(Math.round(a.rating_avg))}</span>{' '}
                      <span className="muted">({a.rating_count})</span>
                    </p>
                  )}
                </div>
              </div>
            </a>
          ))}
          {(results ?? []).length === 0 && !error && (
            <p className="notice">No activities match those filters yet — try widening your search.</p>
          )}
        </div>
        <div className="map">
          <h2 style={{ margin: '4px 0 12px' }}>Explore on map</h2>
          <p className="lead" style={{ fontSize: 18 }}>
            Map view with {(results ?? []).filter((r) => r.latitude !== null).length} located
            activities. (Interactive map ships with a maps key in a later iteration.)
          </p>
          <ul className="muted" style={{ fontSize: 15 }}>
            {(results ?? [])
              .filter((r) => r.latitude !== null)
              .slice(0, 10)
              .map((r) => (
                <li key={r.id}>
                  {r.title} — {r.latitude!.toFixed(4)}, {r.longitude!.toFixed(4)}
                </li>
              ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
