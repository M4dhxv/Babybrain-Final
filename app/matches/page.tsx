import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ActivityCard from '@/components/ActivityCard';
import { IconArrowRight, IconChevronRight } from '@/components/icons';
import { catMeta } from '@/lib/categories';
import { areaFromAddress, initials, scheduleSummary } from '@/lib/format';
import {
  formatAgeRange,
  formatChildAge,
  type RecommendationWithActivity,
} from '@/types/database';

const REASON_ICONS: [string, string][] = [
  ['interest', '❤️'],
  ['age', '👥'],
  ['schedule', '🕐'],
  ['location', '📍'],
  ['budget', '💲'],
];
const reasonIcon = (reason: string) => {
  const r = reason.toLowerCase();
  return REASON_ICONS.find(([k]) => r.includes(k))?.[1] ?? '✨';
};

export default async function MatchesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/matches');

  const [{ data: profile }, { data: children }, { data: favorites }, { data: categories }] =
    await Promise.all([
      supabase.from('parent_profiles').select('full_name').eq('id', user.id).single(),
      supabase.from('children').select('*').order('created_at'),
      supabase.from('favorites').select('activity_id'),
      supabase.from('activity_categories').select('*').order('sort_order'),
    ]);
  if (!children || children.length === 0) redirect('/onboarding');
  const favIds = new Set((favorites ?? []).map((f) => f.activity_id));
  const firstName = profile?.full_name?.split(' ')[0] ?? 'there';

  const recsByChild = await Promise.all(
    children.map(async (child) => {
      const { data: recs } = await supabase
        .from('user_recommendations')
        .select('*, activities(*)')
        .eq('child_id', child.id)
        .order('score', { ascending: false })
        .limit(8);
      const rows = (recs ?? []) as RecommendationWithActivity[];
      const ids = rows.map((r) => r.activity_id);
      const { data: sessions } = ids.length
        ? await supabase
            .from('activity_sessions')
            .select('activity_id, starts_at')
            .in('activity_id', ids)
            .gte('starts_at', new Date().toISOString())
            .order('starts_at')
        : { data: [] };
      const sessionsByActivity = new Map<string, string[]>();
      (sessions ?? []).forEach((s) => {
        sessionsByActivity.set(s.activity_id, [
          ...(sessionsByActivity.get(s.activity_id) ?? []),
          s.starts_at,
        ]);
      });
      return { child, recs: rows, sessionsByActivity };
    })
  );

  return (
    <main className="container">
      {recsByChild.map(({ child, recs, sessionsByActivity }, idx) => {
        const topReasons = [...new Set(recs.slice(0, 4).flatMap((r) => r.reasons))].slice(0, 4);
        return (
          <section key={child.id} style={{ marginBottom: 34 }}>
            {/* ---------- Hero: greeting · child · why ---------- */}
            <div className="match-hero">
              <div className="card pad-lg" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start' }}>
                {idx === 0 && <p className="wave">Hi {firstName}! 👋</p>}
                <h1>
                  Here are classes
                  <br />
                  matched for <span className="hl">{child.name}</span>
                </h1>
                <p className="muted" style={{ margin: '0 0 16px', fontWeight: 600 }}>
                  Activities matching your profile.
                </p>
                <Link href="/explore" className="btn">
                  Explore activities <IconArrowRight size={16} />
                </Link>
              </div>

              <div className="card child-card">
                <span className="avatar" style={{ background: 'var(--pink-soft)', color: 'var(--pink)' }}>
                  {initials(child.name)}
                </span>
                <div>
                  <strong style={{ fontSize: 18 }}>{child.name}</strong>
                  <p className="muted" style={{ margin: '2px 0 0', fontWeight: 700, fontSize: 14 }}>
                    {formatChildAge(child.date_of_birth)}
                  </p>
                </div>
                <div className="trait-chips">
                  {child.interests.map((slug) => {
                    const meta = catMeta(slug);
                    return (
                      <span key={slug} className={`tag ${meta.soft}`}>
                        {meta.emoji} enjoys {(categories ?? []).find((c) => c.slug === slug)?.name.toLowerCase() ?? slug}
                      </span>
                    );
                  })}
                </div>
              </div>

              <div className="why-panel">
                <h2>Why these activities?</h2>
                <p className="sub">These activities match what you’ve shared with us.</p>
                {topReasons.length > 0 ? (
                  topReasons.map((reason) => (
                    <div key={reason} className="reason-row">
                      <span className="ico">{reasonIcon(reason)}</span>
                      <strong>{reason}</strong>
                    </div>
                  ))
                ) : (
                  <p className="muted" style={{ fontWeight: 600, fontSize: 14 }}>
                    Complete your preferences in onboarding to sharpen these matches.
                  </p>
                )}
              </div>
            </div>

            {/* ---------- Matching activities ---------- */}
            <div className="sec-head">
              <h2>Matching Activities ✨</h2>
              <Link href="/explore" className="sec-link">
                See activity options <IconArrowRight size={14} />
              </Link>
            </div>
            {recs.length > 0 ? (
              <div className="h-scroll">
                {recs.slice(0, 4).map(
                  (r) =>
                    r.activities && (
                      <ActivityCard
                        key={r.id}
                        slug={r.activities.slug}
                        title={r.activities.title}
                        imageUrl={r.activities.image_urls[0]}
                        categorySlug={
                          (categories ?? []).find((c) => c.id === r.activities!.category_id)?.slug
                        }
                        categoryName={
                          (categories ?? []).find((c) => c.id === r.activities!.category_id)?.name
                        }
                        ageText={formatAgeRange(
                          r.activities.age_min_months,
                          r.activities.age_max_months
                        )}
                        locationText={areaFromAddress(r.activities.address) ?? undefined}
                        scheduleText={
                          scheduleSummary(sessionsByActivity.get(r.activity_id) ?? []) ?? undefined
                        }
                        rating={r.activities.rating_avg}
                        ratingCount={r.activities.rating_count}
                        cta="details"
                        fav={{
                          activityId: r.activity_id,
                          initialFavorited: favIds.has(r.activity_id),
                          authed: true,
                        }}
                      />
                    )
                )}
              </div>
            ) : (
              <p className="notice">
                No matches yet for {child.name} — new activities are added regularly.
              </p>
            )}
          </section>
        );
      })}

      {/* ---------- Options based on preferences ---------- */}
      <div className="sec-head">
        <h2>Options Based on Preferences ✨</h2>
      </div>
      <div className="opt-grid" style={{ marginBottom: 16 }}>
        {(categories ?? []).map((c) => {
          const meta = catMeta(c.slug);
          return (
            <Link key={c.slug} href={`/explore?category=${c.slug}`} className="opt-card">
              <span className={`ico ${meta.soft}`}>{meta.emoji}</span>
              <div>
                <strong>{c.name}</strong>
                <span>{meta.tagline}</span>
              </div>
              <IconChevronRight size={15} />
            </Link>
          );
        })}
      </div>
    </main>
  );
}
