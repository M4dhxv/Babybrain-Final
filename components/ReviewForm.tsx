'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Review } from '@/types/database';

export default function ReviewForm({
  activityId,
  existing,
}: {
  activityId: string;
  existing: Review | null;
}) {
  const router = useRouter();
  const [rating, setRating] = useState(existing?.rating ?? 5);
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase.from('reviews').upsert(
      { user_id: user.id, activity_id: activityId, rating, comment: comment || null },
      { onConflict: 'user_id,activity_id' }
    );
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>{existing ? 'Update your review' : 'Leave a review'}</h3>
      {error && <p className="notice error">{error}</p>}
      {saved && <p className="notice">Review saved — thank you!</p>}
      <div className="field">
        <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
          {[5, 4, 3, 2, 1].map((r) => (
            <option key={r} value={r}>
              {'★'.repeat(r)} ({r}/5)
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <textarea
          rows={3}
          placeholder="How was it?"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      <button className="btn small" disabled={busy}>
        {busy ? 'Saving…' : existing ? 'Update review' : 'Submit review'}
      </button>
    </form>
  );
}
