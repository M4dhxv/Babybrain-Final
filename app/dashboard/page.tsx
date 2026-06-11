import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ActivityCard from '@/components/ActivityCard';
import {
  IconArrowRight,
  IconBell,
  IconBookmark,
  IconChat,
  IconEdit,
  IconHome,
  IconStar,
} from '@/components/icons';
import { catMeta } from '@/lib/categories';
import { areaFromAddress, initials, sgDateTime } from '@/lib/format';
import {
  formatAgeRange,
  formatChildAge,
  type RecommendationWithActivity,
} from '@/types/database';

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/dashboard');

  const { data: profile } = await supabase
    .from('parent_profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  if (!profile?.onboarding_completed_at) redirect('/onboarding');

  const [
    { data: children },
    { data: recs },
    { data: bookings },
    unreadRes,
    { data: favorites },
    { data: categories },
  ] = await Promise.all([
    supabase.from('children').select('*').order('created_at'),
    supabase
      .from('user_recommendations')
      .select('*, activities(*)')
      .order('score', { ascending: false })
      .limit(8),
    supabase
      .from('bookings')
      .select('*, activity_sessions(starts_at, ends_at, activities(slug, title, image_urls))')
      .order('created_at', { ascending: false }),
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null),
    supabase.from('favorites').select('activity_id'),
    supabase.from('activity_categories').select('*').order('sort_order'),
  ]);
  const favIds = new Set((favorites ?? []).map((f) => f.activity_id));

  const childStats = await Promise.all(
    (children ?? []).map(async (child) => {
      const { data } = await supabase.rpc('child_journey_stats', {
        p_child_id: child.id,
      });
      return { child, stats: data?.[0] ?? null };
    })
  );

  type BookingRow = NonNullable<typeof bookings>[number] & {
    activity_sessions: {
      starts_at: string;
      ends_at: string;
      activities: { slug: string; title: string; image_urls: string[] } | null;
    } | null;
  };
  const now = Date.now();
  const upcoming = ((bookings ?? []) as BookingRow[]).filter(
    (b) =>
      b.status === 'confirmed' &&
      b.activity_sessions &&
      new Date(b.activity_sessions.starts_at).getTime() > now
  );
  const unread = unreadRes.count ?? 0;

  // Dedupe recommendations by activity for the "recommended" grid
  const seen = new Set<string>();
  const recCards = ((recs ?? []) as RecommendationWithActivity[]).filter((r) => {
    if (!r.activities || seen.has(r.activity_id)) return false;
    seen.add(r.activity_id);
    return true;
  });

  return (
    <main className="container dash">
      {/* ---------------- Sidebar ---------------- */}
      <aside className="side">
        <div className="who">
          <span className="avatar" style={{ width: 44, height: 44, fontSize: 17 }}>
            {initials(profile.full_name)}
          </span>
          <div>
            <strong style={{ fontSize: 16 }}>{profile.full_name || 'Your family'}</strong>
            {profile.postal_code && (
              <p className="hint" style={{ margin: 0 }}>Singapore ({profile.postal_code})</p>
            )}
          </div>
        </div>
        {(children ?? []).map((c) => (
          <p key={c.id} className="hint" style={{ margin: '4px 0', fontWeight: 700 }}>
            👶 {c.name} · {formatChildAge(c.date_of_birth)}
          </p>
        ))}
        <nav className="side-nav">
          <Link href="/dashboard" className="on"><IconHome size={16} /> Overview</Link>
          <Link href="/dashboard/favorites"><IconBookmark size={16} /> Favorites</Link>
          <Link href="/dashboard/reviews"><IconStar size={16} /> Reviews</Link>
          <Link href="/dashboard/notifications">
            <IconBell size={16} /> Notifications
            {unread > 0 && (
              <span className="tag" style={{ background: 'var(--pink)', color: '#fff', marginLeft: 'auto' }}>
                {unread}
              </span>
            )}
          </Link>
          <Link href="/support"><IconChat size={16} /> Support</Link>
          <Link href="/onboarding"><IconEdit size={16} /> Edit Profile</Link>
        </nav>
      </aside>

      {/* ---------------- Main ---------------- */}
      <section>
        <div className="twocol">
          {childStats.map(({ child, stats }) => (
            <div key={child.id} className="card pad-lg">
              <div className="who" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span className="avatar" style={{ width: 52, height: 52, fontSize: 20, background: 'var(--pink-soft)', color: 'var(--pink)' }}>
                  {initials(child.name)}
                </span>
                <div>
                  <h2 style={{ margin: 0, fontSize: 21 }}>{child.name}</h2>
                  <p className="hint" style={{ margin: '2px 0 0' }}>
                    {formatChildAge(child.date_of_birth)}
                  </p>
                </div>
              </div>
              {child.interests.length > 0 && (
                <div className="chip-row" style={{ margin: '12px 0 0' }}>
                  {child.interests.map((slug) => {
                    const m = catMeta(slug);
                    return (
                      <span key={slug} className={`tag ${m.soft}`}>
                        {m.emoji} {(categories ?? []).find((c) => c.slug === slug)?.name ?? slug}
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="stat-tiles">
                <div className="stat-tile">
                  <strong>{stats?.classes_attended ?? 0}</strong>
                  <span>classes attended</span>
                </div>
                <div className="stat-tile" style={{ background: 'var(--pink-soft)' }}>
                  <strong>{stats?.venues_explored ?? 0}</strong>
                  <span>venues explored</span>
                </div>
                <div className="stat-tile" style={{ background: 'var(--green-soft)' }}>
                  <strong>{stats?.hours_of_learning ?? 0}</strong>
                  <span>hours of learning</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="sec-head">
          <h2>Recommended for your family ✨</h2>
          <Link href="/matches" className="sec-link">
            See all matches <IconArrowRight size={14} />
          </Link>
        </div>
        {recCards.length > 0 ? (
          <div className="grid-cards" style={{ gridTemplateColumns: undefined }}>
            {recCards.slice(0, 4).map((r) => {
              const cat = (categories ?? []).find((c) => c.id === r.activities!.category_id);
              return (
                <ActivityCard
                  key={r.id}
                  slug={r.activities!.slug}
                  title={r.activities!.title}
                  imageUrl={r.activities!.image_urls[0]}
                  categorySlug={cat?.slug}
                  categoryName={cat?.name}
                  ageText={formatAgeRange(r.activities!.age_min_months, r.activities!.age_max_months)}
                  locationText={areaFromAddress(r.activities!.address) ?? undefined}
                  rating={r.activities!.rating_avg}
                  ratingCount={r.activities!.rating_count}
                  cta="details"
                  fav={{
                    activityId: r.activity_id,
                    initialFavorited: favIds.has(r.activity_id),
                    authed: true,
                  }}
                  extra={
                    r.reasons.length > 0 ? (
                      <div className="reason-chips">
                        {r.reasons.slice(0, 2).map((reason) => (
                          <span key={reason}>{reason}</span>
                        ))}
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        ) : (
          <p className="notice">
            Recommendations appear once activities match your child.{' '}
            <Link href="/explore">Explore activities</Link> in the meantime.
          </p>
        )}

        <div className="sec-head">
          <h2>Upcoming Classes</h2>
        </div>
        {upcoming.length > 0 ? (
          <div className="grid-cards">
            {upcoming.map(
              (b) =>
                b.activity_sessions?.activities && (
                  <ActivityCard
                    key={b.id}
                    slug={b.activity_sessions.activities.slug}
                    title={b.activity_sessions.activities.title}
                    imageUrl={b.activity_sessions.activities.image_urls[0]}
                    scheduleText={sgDateTime(b.activity_sessions.starts_at)}
                    cta="none"
                  />
                )
            )}
          </div>
        ) : (
          <p className="muted" style={{ fontWeight: 600 }}>
            No upcoming classes — booking opens in a later release.
          </p>
        )}
      </section>
    </main>
  );
}
