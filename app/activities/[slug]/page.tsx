import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import FavoriteButton from '@/components/FavoriteButton';
import ReviewForm from '@/components/ReviewForm';
import { formatAgeRange } from '@/types/database';

const sgTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

export default async function ActivityDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: activity } = await supabase
    .from('activities')
    .select('*, activity_categories(name, slug)')
    .eq('slug', slug)
    .single();
  if (!activity) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: sessions }, { data: reviews }, favoriteRes, ownReviewRes] =
    await Promise.all([
      supabase
        .from('activity_sessions')
        .select('*')
        .eq('activity_id', activity.id)
        .gte('starts_at', new Date().toISOString())
        .order('starts_at')
        .limit(12),
      supabase
        .from('reviews')
        .select('*')
        .eq('activity_id', activity.id)
        .order('created_at', { ascending: false })
        .limit(10),
      user
        ? supabase
            .from('favorites')
            .select('activity_id')
            .eq('user_id', user.id)
            .eq('activity_id', activity.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      user
        ? supabase
            .from('reviews')
            .select('*')
            .eq('user_id', user.id)
            .eq('activity_id', activity.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const category = activity.activity_categories as unknown as {
    name: string;
    slug: string;
  } | null;

  return (
    <main className="container">
      <section className="twocol" style={{ marginTop: 20 }}>
        <div className="hero-art" style={{ minHeight: 340 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={activity.image_urls[0] ?? ''} alt={activity.title} />
        </div>
        <div className="card">
          <p className="badge">{category?.name}</p>
          <h1 style={{ fontSize: 42, margin: '10px 0' }}>{activity.title}</h1>
          <p className="lead" style={{ fontSize: 19 }}>
            {formatAgeRange(activity.age_min_months, activity.age_max_months)}
            {activity.price !== null && <> · ${activity.price} per session</>}
            {activity.provider_name && <> · by {activity.provider_name}</>}
          </p>
          {activity.rating_count > 0 && (
            <p>
              <span className="stars">{'★'.repeat(Math.round(activity.rating_avg))}</span>{' '}
              {activity.rating_avg} ({activity.rating_count} review
              {activity.rating_count === 1 ? '' : 's'})
            </p>
          )}
          {activity.address && <p className="muted">{activity.address}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <FavoriteButton
              activityId={activity.id}
              initialFavorited={Boolean(favoriteRes.data)}
              authed={Boolean(user)}
            />
            <button className="btn small" disabled title="Booking opens in a later release">
              Book Activity (coming soon)
            </button>
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>About this activity</h2>
        <p className="lead" style={{ fontSize: 18 }}>{activity.description}</p>
      </section>

      <h2 className="section-title" style={{ fontSize: 32 }}>Upcoming sessions</h2>
      <div className="pill-row">
        {(sessions ?? []).map((s) => (
          <span key={s.id} className="pill">
            {sgTime(s.starts_at)}
            {s.capacity !== null && <span className="muted"> · {s.capacity} spots</span>}
          </span>
        ))}
        {(sessions ?? []).length === 0 && (
          <p className="muted">No upcoming sessions scheduled yet.</p>
        )}
      </div>

      <h2 className="section-title" style={{ fontSize: 32 }}>Reviews</h2>
      {(reviews ?? []).map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 10 }}>
          <span className="stars">{'★'.repeat(r.rating)}</span>
          {r.comment && <p style={{ margin: '6px 0 0' }}>{r.comment}</p>}
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 14 }}>
            A BabyBrain parent ·{' '}
            {new Date(r.created_at).toLocaleDateString('en-SG', { month: 'short', year: 'numeric' })}
          </p>
        </div>
      ))}
      {(reviews ?? []).length === 0 && <p className="muted">No reviews yet — be the first!</p>}

      {user ? (
        <ReviewForm activityId={activity.id} existing={ownReviewRes.data} />
      ) : (
        <p className="notice">
          <a href="/login">Log in</a> to save this activity or leave a review.
        </p>
      )}
    </main>
  );
}
