import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ActivityCard from '@/components/ActivityCard';
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

  const [{ data: children }, { data: recs }, { data: bookings }, unreadRes] =
    await Promise.all([
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
    ]);

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

  return (
    <main className="container left-rail-layout">
      <aside className="side">
        <h3 style={{ marginTop: 0 }}>{profile.full_name || 'Your family'}</h3>
        {(children ?? []).map((c) => (
          <p key={c.id} className="muted" style={{ margin: '4px 0' }}>
            {c.name} · {formatChildAge(c.date_of_birth)}
          </p>
        ))}
        <div className="pill-row" style={{ marginTop: 12 }}>
          <Link href="/dashboard" style={{ textDecoration: 'none' }}><span className="pill selected">Overview</span></Link>
          <Link href="/dashboard/favorites" style={{ textDecoration: 'none' }}><span className="pill clickable">Favorites</span></Link>
          <Link href="/dashboard/reviews" style={{ textDecoration: 'none' }}><span className="pill clickable">Reviews</span></Link>
          <Link href="/dashboard/notifications" style={{ textDecoration: 'none' }}>
            <span className="pill clickable">
              {(unreadRes.count ?? 0) > 0 && <span className="unread-dot" />}
              Notifications
            </span>
          </Link>
          <Link href="/support" style={{ textDecoration: 'none' }}><span className="pill clickable">Support</span></Link>
          <Link href="/onboarding" style={{ textDecoration: 'none' }}><span className="pill clickable">Edit Profile</span></Link>
        </div>
      </aside>

      <section>
        <div className="twocol">
          {childStats.map(({ child, stats }) => (
            <div key={child.id} className="card">
              <h2 style={{ margin: '0 0 4px' }}>{child.name}</h2>
              <p className="muted" style={{ margin: '0 0 8px' }}>
                {formatChildAge(child.date_of_birth)}
                {child.interests.length > 0 && <> · Interests: {child.interests.join(', ')}</>}
              </p>
              <h3 style={{ margin: '10px 0 4px' }}>{child.name}&apos;s Journey</h3>
              <p className="lead" style={{ fontSize: 17, margin: 0 }}>
                {stats?.classes_attended ?? 0} classes attended
                <br />
                {stats?.venues_explored ?? 0} venues explored
                <br />
                {stats?.hours_of_learning ?? 0} hours of learning
              </p>
            </div>
          ))}
        </div>

        <h2 className="section-title" style={{ fontSize: 30 }}>Recommended for your family</h2>
        <div className="grid4">
          {((recs ?? []) as RecommendationWithActivity[]).map(
            (r) =>
              r.activities && (
                <ActivityCard
                  key={r.id}
                  slug={r.activities.slug}
                  title={r.activities.title}
                  imageUrl={r.activities.image_urls[0]}
                  subtitle={formatAgeRange(
                    r.activities.age_min_months,
                    r.activities.age_max_months
                  )}
                />
              )
          )}
        </div>
        {(recs ?? []).length === 0 && (
          <p className="notice">
            Recommendations appear once onboarding is complete and activities match
            your child. <Link href="/explore">Explore activities</Link> in the meantime.
          </p>
        )}

        <h2 className="section-title" style={{ fontSize: 30 }}>Upcoming Classes</h2>
        <div className="grid4">
          {upcoming.map(
            (b) =>
              b.activity_sessions?.activities && (
                <ActivityCard
                  key={b.id}
                  slug={b.activity_sessions.activities.slug}
                  title={b.activity_sessions.activities.title}
                  imageUrl={b.activity_sessions.activities.image_urls[0]}
                  subtitle={new Date(b.activity_sessions.starts_at).toLocaleString('en-SG', {
                    timeZone: 'Asia/Singapore',
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                />
              )
          )}
        </div>
        {upcoming.length === 0 && (
          <p className="muted">No upcoming classes — booking opens in a later release.</p>
        )}
      </section>
    </main>
  );
}
