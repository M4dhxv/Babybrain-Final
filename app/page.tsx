import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import ActivityCard from '@/components/ActivityCard';
import { IconArrowRight, IconStar } from '@/components/icons';
import { catMeta } from '@/lib/categories';
import { areaFromAddress, initials, sgDateTime } from '@/lib/format';
import { formatAgeRange } from '@/types/database';

const TESTIMONIALS = [
  ['We found so many engaging activities that our daughter loves.', 'Jolene Tan', 'Mum of 2.5 year old'],
  ['Easy to use and saves us so much time planning our weekends.', 'Marcus Lim', 'Dad of 1.5 year old'],
  ['A great platform to discover new activities and local gems.', 'Sarah Wong', 'Mum of 4 year old'],
] as const;

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: categories }, { data: featured }, favRes] = await Promise.all([
    supabase.from('activity_categories').select('*').order('sort_order'),
    supabase.rpc('search_activities', { p_sort: 'popular', p_limit: 4 }),
    user
      ? supabase.from('favorites').select('activity_id')
      : Promise.resolve({ data: [] as { activity_id: string }[] }),
  ]);
  const favIds = new Set((favRes.data ?? []).map((f) => f.activity_id));

  // Address lookup for the "near you" cards (search RPC returns coords only)
  const ids = (featured ?? []).map((a) => a.id);
  const { data: addresses } = ids.length
    ? await supabase.from('activities').select('id, address').in('id', ids)
    : { data: [] };
  const addressById = new Map((addresses ?? []).map((a) => [a.id, a.address]));

  return (
    <main className="container">
      {/* ---------- Hero ---------- */}
      <section className="hero">
        <div>
          <span className="badge">💬 Made for you. Designed to save time.</span>
          <h1>
            Curated activities
            <br />
            that fit <span className="hl">your child</span>
          </h1>
          <p className="sub">
            Discover activities and play spaces that match your child’s age,
            interests and stage of growth.
          </p>
          <div className="hero-actions">
            <Link href="/explore" className="btn lg">
              Explore Activities <IconArrowRight size={17} />
            </Link>
            <Link href={user ? '/onboarding' : '/signup'} className="btn outline lg">
              Create Profile
            </Link>
          </div>
        </div>
        <div className="hero-media">
          <span className="blob b1" />
          <span className="blob b2" />
          <span className="blob b3" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://images.unsplash.com/photo-1607453998774-d533f65dac99?q=80&w=1600&auto=format&fit=crop"
            alt="Parent and child playing together"
          />
        </div>
      </section>

      {/* ---------- Feature row ---------- */}
      <section className="features">
        <div className="feature">
          <span className="ico soft-movement">🔍</span>
          <div>
            <h3>Curated activities</h3>
            <p>Picked to match your child’s needs</p>
          </div>
        </div>
        <div className="feature">
          <span className="ico soft-art-creativity">🛡️</span>
          <div>
            <h3>Trusted providers</h3>
            <p>We partner with verified providers</p>
          </div>
        </div>
        <div className="feature">
          <span className="ico soft-sensory-play">📅</span>
          <div>
            <h3>Planned with ease</h3>
            <p>Find activities that fit your day</p>
          </div>
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section className="how" id="how">
        <h2>How it works</h2>
        <p className="sub">
          Three simple steps to help you discover activities that suit your child.
        </p>
        <div className="steps">
          <div className="step">
            <div className="art soft-movement">
              <span className="num" style={{ background: 'var(--blue)' }}>1</span>
              📋
            </div>
            <h4>Tell us about your child</h4>
            <p>Share a few details about your child’s age, interests and what you’re looking for.</p>
          </div>
          <div className="step">
            <div className="art soft-music">
              <span className="num" style={{ background: 'var(--pink)' }}>2</span>
              🔎
            </div>
            <h4>Explore activities</h4>
            <p>Browse curated activities and play spaces that match your preferences.</p>
          </div>
          <div className="step">
            <div className="art soft-art-creativity">
              <span className="num" style={{ background: 'var(--green)' }}>3</span>
              🗓️
            </div>
            <h4>Plan and book</h4>
            <p>Choose what works for you and book directly with the provider.</p>
          </div>
        </div>
        <div className="stats">
          <div className="stat">
            <span className="ico soft-music">👨‍👩‍👧</span>
            <div>
              <strong style={{ color: 'var(--pink)' }}>500+</strong>
              <span>Curated activities</span>
            </div>
          </div>
          <div className="stat">
            <span className="ico soft-sensory-play">🏠</span>
            <div>
              <strong style={{ color: 'var(--orange)' }}>100+</strong>
              <span>Verified providers</span>
            </div>
          </div>
          <div className="stat">
            <span className="ico soft-art-creativity">📈</span>
            <div>
              <strong style={{ color: 'var(--green)' }}>Thousands</strong>
              <span>Satisfied customers</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Categories ---------- */}
      <h2 className="section-title center">Explore activities by category</h2>
      <div className="cat-grid">
        {(categories ?? []).map((c) => {
          const meta = catMeta(c.slug);
          return (
            <Link key={c.slug} href={`/explore?category=${c.slug}`} className={`cat-tile ${meta.soft}`}>
              <span className="ico">{meta.emoji}</span>
              {c.name}
            </Link>
          );
        })}
      </div>

      {/* ---------- Activities near you ---------- */}
      <div className="sec-head">
        <h2>Activities near you</h2>
        <Link href="/explore" className="sec-link">
          View all activities <IconArrowRight size={14} />
        </Link>
      </div>
      <div className="grid-cards">
        {(featured ?? []).map((a) => (
          <ActivityCard
            key={a.id}
            slug={a.slug}
            title={a.title}
            imageUrl={a.image_urls[0]}
            categorySlug={a.category_slug}
            categoryName={a.category_name}
            ageText={formatAgeRange(a.age_min_months, a.age_max_months)}
            locationText={areaFromAddress(addressById.get(a.id)) ?? undefined}
            scheduleText={a.next_session_at ? sgDateTime(a.next_session_at) : undefined}
            rating={a.rating_avg}
            ratingCount={a.rating_count}
            cta="book"
            fav={{ activityId: a.id, initialFavorited: favIds.has(a.id), authed: Boolean(user) }}
          />
        ))}
        {(featured ?? []).length === 0 && (
          <p className="muted">Activities are coming soon.</p>
        )}
      </div>

      {/* ---------- Testimonials ---------- */}
      <div className="testis">
        {TESTIMONIALS.map(([quote, name, sub]) => (
          <article key={name} className="card testi">
            <span className="rating" aria-label="5 stars">
              {[...Array(5)].map((_, i) => (
                <IconStar key={i} size={15} />
              ))}
            </span>
            <p>“{quote}”</p>
            <div className="who">
              <span className="avatar">{initials(name)}</span>
              <div>
                <strong>{name}</strong>
                <span>{sub}</span>
              </div>
            </div>
          </article>
        ))}
      </div>

      {/* ---------- CTA band ---------- */}
      <section className="cta">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/mascot-face.png" alt="" />
        <div className="txt">
          <h3>
            Curated activities.
            <br />
            Reduced mental load.
          </h3>
          <p>Let us help you find what’s right for your child.</p>
        </div>
        <Link href={user ? '/onboarding' : '/signup'} className="btn lg">
          Create your profile <IconArrowRight size={17} />
        </Link>
      </section>
    </main>
  );
}
