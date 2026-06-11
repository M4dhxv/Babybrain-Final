import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import FavoriteButton from '@/components/FavoriteButton';
import ReviewForm from '@/components/ReviewForm';
import {
  IconArrowLeft,
  IconCalendar,
  IconChat,
  IconClock,
  IconPin,
  IconShield,
  IconStar,
  IconUser,
  IconUsers,
} from '@/components/icons';
import { catMeta } from '@/lib/categories';
import { sgDateTime, sgTime } from '@/lib/format';
import { formatAgeRange } from '@/types/database';

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

  const [{ data: sessions }, { data: reviews }, favoriteRes, ownReviewRes, suggestedRes] =
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
      user
        ? supabase
            .from('user_recommendations')
            .select('activity_id')
            .eq('activity_id', activity.id)
            .limit(1)
        : Promise.resolve({ data: [] }),
    ]);

  const category = activity.activity_categories as unknown as {
    name: string;
    slug: string;
  } | null;
  const meta = catMeta(category?.slug);
  const isSuggested = (suggestedRes.data ?? []).length > 0;
  const nextSession = (sessions ?? [])[0];
  const durationMins = nextSession
    ? Math.round(
        (new Date(nextSession.ends_at).getTime() - new Date(nextSession.starts_at).getTime()) / 60000
      )
    : null;
  const images = activity.image_urls;

  return (
    <main className="container">
      <Link href="/explore" className="back-link">
        <IconArrowLeft size={15} /> Back to results
      </Link>

      <div className="detail-grid">
        {/* ---------------- Main column ---------------- */}
        <div>
          {isSuggested && <span className="badge">⭐ Suggested Activity</span>}
          <h1 className="detail-h1">{activity.title}</h1>
          {category && (
            <span className={`tag ${meta.soft}`} style={{ fontSize: 13, padding: '6px 12px' }}>
              {meta.emoji} {category.name}
            </span>
          )}
          <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, fontWeight: 600, margin: '14px 0 10px', maxWidth: '56ch' }}>
            {activity.description.split('.').slice(0, 2).join('.')}
            {activity.description.includes('.') ? '.' : ''}
          </p>
          {activity.rating_count > 0 && (
            <div className="rating" style={{ fontSize: 15 }}>
              <IconStar size={16} /> {Number(activity.rating_avg).toFixed(1)}{' '}
              <span className="muted">({activity.rating_count})</span>
              {activity.popularity > 2 && (
                <span className="tag soft-movement" style={{ color: 'var(--blue)' }}>
                  👍 Popular this week
                </span>
              )}
            </div>
          )}

          <div className="facts">
            <div className="fact">
              <IconUsers size={17} />
              <div>
                <strong>{formatAgeRange(activity.age_min_months, activity.age_max_months)}</strong>
                Age range
              </div>
            </div>
            {category && (
              <div className="fact">
                <IconUser size={17} />
                <div>
                  <strong>{category.name}</strong>
                  Class type
                </div>
              </div>
            )}
            {durationMins && (
              <div className="fact">
                <IconClock size={17} />
                <div>
                  <strong>{durationMins} mins</strong>
                  Per session
                </div>
              </div>
            )}
            {nextSession?.capacity && (
              <div className="fact">
                <IconUsers size={17} />
                <div>
                  <strong>Max {nextSession.capacity} children</strong>
                  Group size
                </div>
              </div>
            )}
          </div>

          <div className="gallery">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={images[0] ?? ''} alt={activity.title} />
            {images.length > 1 && (
              <div className="thumbs">
                {images.slice(1, 7).map((url) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={url} src={url} alt="" loading="lazy" />
                ))}
              </div>
            )}
          </div>

          <section className="detail-sec">
            <h2>About this class</h2>
            <p className="body">{activity.description}</p>
            {activity.tags.length > 0 && (
              <div className="card" style={{ marginTop: 14, background: 'var(--blue-soft)', border: 0 }}>
                <strong style={{ fontSize: 14 }}>
                  Families often explore this activity if interested in:
                </strong>
                <div className="chip-row" style={{ marginTop: 10 }}>
                  {activity.tags.map((t) => (
                    <span key={t} className="chip" style={{ background: '#fff' }}>
                      {catMeta(t).emoji} {(t as string).replace(/-/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="detail-sec card">
            <h2>Details</h2>
            {activity.provider_name && (
              <div className="kv">
                <span className="k"><IconUser size={15} /> Provider</span>
                <strong>{activity.provider_name}</strong>
              </div>
            )}
            {activity.address && (
              <div className="kv">
                <span className="k"><IconPin size={15} /> Venue</span>
                <strong style={{ textAlign: 'right' }}>{activity.address}</strong>
              </div>
            )}
            <div className="kv">
              <span className="k"><IconUsers size={15} /> Age range</span>
              <strong>{formatAgeRange(activity.age_min_months, activity.age_max_months)}</strong>
            </div>
            {durationMins && (
              <div className="kv">
                <span className="k"><IconClock size={15} /> Duration</span>
                <strong>{durationMins} mins</strong>
              </div>
            )}
            {nextSession?.capacity && (
              <div className="kv">
                <span className="k"><IconUsers size={15} /> Group size</span>
                <strong>Max {nextSession.capacity} children</strong>
              </div>
            )}
          </section>

          <section className="detail-sec" id="sessions">
            <h2>Upcoming sessions</h2>
            <div className="chip-row">
              {(sessions ?? []).map((s) => (
                <span key={s.id} className="session-chip">
                  {sgDateTime(s.starts_at)}
                  <span>
                    {sgTime(s.starts_at)} – {sgTime(s.ends_at)}
                    {s.capacity !== null && <> · {s.capacity} spots</>}
                  </span>
                </span>
              ))}
              {(sessions ?? []).length === 0 && (
                <p className="muted" style={{ fontWeight: 600 }}>No upcoming sessions scheduled yet.</p>
              )}
            </div>
          </section>

          <section className="detail-sec" id="reviews">
            <h2>Reviews ({activity.rating_count})</h2>
            {(reviews ?? []).map((r) => (
              <div key={r.id} className="card review-card">
                <span className="rating">
                  {[...Array(r.rating)].map((_, i) => (
                    <IconStar key={i} size={14} />
                  ))}
                </span>
                {r.comment && <p style={{ margin: '8px 0 0', fontWeight: 600 }}>{r.comment}</p>}
                <div className="who">
                  <span className="avatar" style={{ width: 28, height: 28, fontSize: 12 }}>👤</span>
                  A BabyBrain parent ·{' '}
                  {new Date(r.created_at).toLocaleDateString('en-SG', { month: 'short', year: 'numeric' })}
                </div>
              </div>
            ))}
            {(reviews ?? []).length === 0 && (
              <p className="muted" style={{ fontWeight: 600 }}>No reviews yet — be the first!</p>
            )}
            {user ? (
              <ReviewForm activityId={activity.id} existing={ownReviewRes.data} />
            ) : (
              <p className="notice">
                <Link href="/login">Log in</Link> to save this activity or leave a review.
              </p>
            )}
          </section>
        </div>

        {/* ---------------- Booking card ---------------- */}
        <aside className="book-card">
          {activity.price !== null ? (
            <>
              <p className="price">
                ${Number(activity.price)} <small>/ class</small>
              </p>
              <p className="price-sub">Book directly with the provider.</p>
            </>
          ) : (
            <p className="price" style={{ fontSize: 22 }}>Price on enquiry</p>
          )}
          <div className="book-actions">
            <button className="btn lg" disabled title="Booking opens in a later release">
              <IconCalendar size={17} /> Book a Class
            </button>
            <button className="btn outline" disabled title="Enquiries open in a later release">
              <IconChat size={16} /> Enquire Now
            </button>
            <FavoriteButton
              activityId={activity.id}
              initialFavorited={Boolean(favoriteRes.data)}
              authed={Boolean(user)}
              variant="block"
            />
          </div>
          {activity.address && (
            <div className="book-row">
              <span className="k">Location</span>
              <strong style={{ textAlign: 'right' }}>{activity.address}</strong>
            </div>
          )}
          {nextSession && (
            <div className="book-row">
              <span className="k">Next available session</span>
              <span style={{ textAlign: 'right' }}>
                <strong>{sgDateTime(nextSession.starts_at)}</strong>
                <br />
                <a href="#sessions" style={{ fontSize: 12.5 }}>View all times</a>
              </span>
            </div>
          )}
          {nextSession?.capacity && (
            <div className="book-row">
              <span className="k">Spaces left</span>
              <strong style={{ color: 'var(--green)' }}>{nextSession.capacity} spots</strong>
            </div>
          )}
          <div className="trust">
            <IconShield size={18} />
            <span>
              <strong>Hosted by a trusted provider.</strong>
              <br />
              All venues and instructors are verified.
            </span>
          </div>
        </aside>
      </div>
    </main>
  );
}
