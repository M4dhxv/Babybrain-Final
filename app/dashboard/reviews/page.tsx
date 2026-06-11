import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import DeleteReviewButton from '@/components/DeleteReviewButton';

export default async function MyReviewsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/dashboard/reviews');

  const { data: reviews } = await supabase
    .from('reviews')
    .select('*, activities(slug, title)')
    .order('created_at', { ascending: false });

  const rows = (reviews ?? []) as unknown as {
    id: string;
    rating: number;
    comment: string | null;
    created_at: string;
    activities: { slug: string; title: string } | null;
  }[];

  return (
    <main className="container">
      <h1 style={{ fontSize: 40, marginTop: 20 }}>Your Reviews</h1>
      <p className="muted">
        <Link href="/dashboard">← Back to dashboard</Link>
      </p>
      {rows.map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: '0 0 4px' }}>
            {r.activities ? (
              <Link href={`/activities/${r.activities.slug}`} style={{ color: 'inherit' }}>
                {r.activities.title}
              </Link>
            ) : (
              'Activity'
            )}
          </h3>
          <span className="stars">{'★'.repeat(r.rating)}</span>
          {r.comment && <p style={{ margin: '6px 0' }}>{r.comment}</p>}
          <p className="muted" style={{ fontSize: 14 }}>
            {new Date(r.created_at).toLocaleDateString('en-SG')}
          </p>
          <DeleteReviewButton reviewId={r.id} />
        </div>
      ))}
      {rows.length === 0 && (
        <p className="notice">
          You haven’t reviewed anything yet. Visit an{' '}
          <Link href="/explore">activity page</Link> to leave your first review.
        </p>
      )}
    </main>
  );
}
