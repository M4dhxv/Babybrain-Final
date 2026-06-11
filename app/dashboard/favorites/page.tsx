import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import FavoriteButton from '@/components/FavoriteButton';
import { formatAgeRange, type Activity } from '@/types/database';

export default async function FavoritesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/dashboard/favorites');

  const { data: favorites } = await supabase
    .from('favorites')
    .select('created_at, activities(*)')
    .order('created_at', { ascending: false });

  const rows = (favorites ?? []) as unknown as {
    created_at: string;
    activities: Activity | null;
  }[];

  return (
    <main className="container">
      <h1 style={{ fontSize: 40, marginTop: 20 }}>Saved Activities</h1>
      <p className="muted">
        <Link href="/dashboard">← Back to dashboard</Link>
      </p>
      {rows.map(
        (f) =>
          f.activities && (
            <div key={f.activities.id} className="list-item">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.activities.image_urls[0] ?? ''} alt={f.activities.title} />
              <div style={{ padding: '12px 12px 12px 0' }}>
                <h3 style={{ margin: '8px 0 4px' }}>
                  <Link href={`/activities/${f.activities.slug}`} style={{ color: 'inherit' }}>
                    {f.activities.title}
                  </Link>
                </h3>
                <p className="muted" style={{ margin: '0 0 8px' }}>
                  {formatAgeRange(f.activities.age_min_months, f.activities.age_max_months)}
                  {f.activities.price !== null && <> · ${f.activities.price}</>}
                </p>
                <FavoriteButton
                  activityId={f.activities.id}
                  initialFavorited
                  authed
                  variant="remove"
                />
              </div>
            </div>
          )
      )}
      {rows.length === 0 && (
        <p className="notice">
          Nothing saved yet — tap “Save Activity” on any{' '}
          <Link href="/explore">activity</Link> to keep it here.
        </p>
      )}
    </main>
  );
}
