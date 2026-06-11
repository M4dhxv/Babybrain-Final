'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function FavoriteButton({
  activityId,
  initialFavorited,
  authed,
  variant = 'save',
}: {
  activityId: string;
  initialFavorited: boolean;
  authed: boolean;
  variant?: 'save' | 'remove';
}) {
  const router = useRouter();
  const [favorited, setFavorited] = useState(initialFavorited);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!authed) {
      router.push('/login');
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    if (favorited) {
      await supabase
        .from('favorites')
        .delete()
        .eq('user_id', user.id)
        .eq('activity_id', activityId);
      setFavorited(false);
    } else {
      await supabase
        .from('favorites')
        .insert({ user_id: user.id, activity_id: activityId });
      setFavorited(true);
    }
    setBusy(false);
    router.refresh();
  }

  if (variant === 'remove') {
    return (
      <button className="btn danger small" onClick={toggle} disabled={busy}>
        Remove
      </button>
    );
  }
  return (
    <button className={favorited ? 'btn small' : 'btn ghost small'} onClick={toggle} disabled={busy}>
      {favorited ? '♥ Saved' : '♡ Save Activity'}
    </button>
  );
}
