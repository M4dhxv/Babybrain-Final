import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ActivityCard from '@/components/ActivityCard';
import {
  formatAgeRange,
  formatChildAge,
  type RecommendationWithActivity,
} from '@/types/database';

export default async function MatchesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/matches');

  const { data: children } = await supabase
    .from('children')
    .select('*')
    .order('created_at');
  if (!children || children.length === 0) redirect('/onboarding');

  const recsByChild = await Promise.all(
    children.map(async (child) => {
      const { data } = await supabase
        .from('user_recommendations')
        .select('*, activities(*)')
        .eq('child_id', child.id)
        .order('score', { ascending: false })
        .limit(8);
      return { child, recs: (data ?? []) as RecommendationWithActivity[] };
    })
  );

  return (
    <main className="container">
      {recsByChild.map(({ child, recs }) => {
        const topReasons = [...new Set(recs.slice(0, 4).flatMap((r) => r.reasons))];
        return (
          <section key={child.id} style={{ marginBottom: 28 }}>
            <section className="twocol" style={{ marginTop: 20 }}>
              <div className="card">
                <h1 style={{ fontSize: 40, margin: '6px 0' }}>
                  Here are classes matched for{' '}
                  <span style={{ color: '#9d8bee' }}>{child.name}</span>
                </h1>
                <p className="muted">{formatChildAge(child.date_of_birth)}</p>
                <Link href="/explore"><button className="btn">Explore activities</button></Link>
              </div>
              <div className="card">
                <h2 style={{ marginTop: 0 }}>Why these activities?</h2>
                {topReasons.length > 0 ? (
                  <div className="reason-chips">
                    {topReasons.map((r) => <span key={r}>{r}</span>)}
                  </div>
                ) : (
                  <p className="muted">
                    Complete your preferences in onboarding to sharpen these matches.
                  </p>
                )}
              </div>
            </section>

            <h2 className="section-title" style={{ fontSize: 32 }}>Matching Activities</h2>
            <div className="grid4">
              {recs.map(
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
                      footer={
                        <div className="reason-chips">
                          {r.reasons.slice(0, 2).map((reason) => (
                            <span key={reason}>{reason}</span>
                          ))}
                        </div>
                      }
                    />
                  )
              )}
            </div>
            {recs.length === 0 && (
              <p className="notice">
                No matches yet for {child.name} — new activities are added regularly.
              </p>
            )}
          </section>
        );
      })}
    </main>
  );
}
