import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import ActivityCard from '@/components/ActivityCard';
import { formatAgeRange } from '@/types/database';

export default async function HomePage() {
  const supabase = await createClient();

  const [{ data: categories }, { data: featured }] = await Promise.all([
    supabase.from('activity_categories').select('*').order('sort_order'),
    supabase
      .from('activities')
      .select('slug, title, image_urls, age_min_months, age_max_months')
      .eq('is_published', true)
      .order('popularity', { ascending: false })
      .limit(4),
  ]);

  return (
    <main className="container">
      <section className="hero">
        <div>
          <p className="badge">Made for you. Designed to save time.</p>
          <h1>
            Curated activities that fit <span style={{ color: '#3d8eee' }}>your child</span>
          </h1>
          <p className="lead" style={{ fontSize: 22 }}>
            Discover activities and play spaces that match your child’s age,
            interests and stage of growth.
          </p>
          <div style={{ display: 'flex', gap: 14, marginTop: 18 }}>
            <Link href="/explore"><button className="btn">Explore Activities</button></Link>
            <Link href="/signup"><button className="btn ghost">Create Profile</button></Link>
          </div>
        </div>
        <div className="hero-art">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://images.unsplash.com/photo-1607453998774-d533f65dac99?q=80&w=1600&auto=format&fit=crop"
            alt="Parent and child"
          />
        </div>
      </section>

      <section className="row">
        <article className="card"><h3>Curated activities</h3><p className="muted">Picked to match your child’s needs</p></article>
        <article className="card"><h3>Trusted providers</h3><p className="muted">We partner with verified providers</p></article>
        <article className="card"><h3>Planned with ease</h3><p className="muted">Find activities that fit your day</p></article>
      </section>

      <h2 className="section-title" style={{ fontSize: 36 }}>Explore activities by category</h2>
      <div className="pill-row">
        {(categories ?? []).map((c) => (
          <Link key={c.slug} href={`/explore?category=${c.slug}`} style={{ textDecoration: 'none' }}>
            <span className="pill clickable">{c.name}</span>
          </Link>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 className="section-title" style={{ fontSize: 36 }}>Activities near you</h2>
        <Link href="/explore">View all activities</Link>
      </div>
      <div className="grid4">
        {(featured ?? []).map((a) => (
          <ActivityCard
            key={a.slug}
            slug={a.slug}
            title={a.title}
            imageUrl={a.image_urls[0]}
            subtitle={formatAgeRange(a.age_min_months, a.age_max_months)}
          />
        ))}
        {(featured ?? []).length === 0 && (
          <p className="muted">Activities are coming soon.</p>
        )}
      </div>

      <section className="card" style={{ marginTop: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Curated activities. Reduced mental load.</h3>
        <Link href="/signup"><button className="btn">Create your profile</button></Link>
      </section>
    </main>
  );
}
