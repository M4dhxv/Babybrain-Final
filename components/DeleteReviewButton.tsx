'use client';

import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function DeleteReviewButton({ reviewId }: { reviewId: string }) {
  const router = useRouter();

  async function remove() {
    const supabase = createClient();
    await supabase.from('reviews').delete().eq('id', reviewId);
    router.refresh();
  }

  return (
    <button className="btn danger small" onClick={remove}>
      Delete
    </button>
  );
}
