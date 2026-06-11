'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { IconBookmark, IconHeart } from '@/components/icons';

export default function FavoriteButton({
  activityId,
  initialFavorited,
  authed,
  variant = 'block',
}: {
  activityId: string;
  initialFavorited: boolean;
  authed: boolean;
  /** heart = circle overlay on images, bookmark = square icon button,
      block = full-width "Save to Favorites", remove = danger text button */
  variant?: 'heart' | 'bookmark' | 'block' | 'remove';
}) {
  const router = useRouter();
  const [favorited, setFavorited] = useState(initialFavorited);
  const [busy, setBusy] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
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

  if (variant === 'heart') {
    return (
      <button
        className={`icon-btn round${favorited ? ' on' : ''}`}
        onClick={toggle}
        disabled={busy}
        aria-label={favorited ? 'Remove from favorites' : 'Save to favorites'}
        style={!favorited ? { color: 'var(--muted)' } : undefined}
      >
        <IconHeart size={18} filled={favorited} />
      </button>
    );
  }
  if (variant === 'bookmark') {
    return (
      <button
        className={`icon-btn${favorited ? ' on' : ''}`}
        onClick={toggle}
        disabled={busy}
        aria-label={favorited ? 'Remove from favorites' : 'Save to favorites'}
      >
        <IconBookmark size={17} filled={favorited} />
      </button>
    );
  }
  if (variant === 'remove') {
    return (
      <button className="btn danger sm" onClick={toggle} disabled={busy}>
        Remove
      </button>
    );
  }
  return (
    <button
      className={favorited ? 'btn soft block' : 'btn outline block'}
      onClick={toggle}
      disabled={busy}
    >
      <IconHeart size={17} filled={favorited} />
      {favorited ? 'Saved to Favorites' : 'Save to Favorites'}
    </button>
  );
}
