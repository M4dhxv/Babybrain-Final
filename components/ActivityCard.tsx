import Link from 'next/link';
import FavoriteButton from '@/components/FavoriteButton';
import { catMeta } from '@/lib/categories';
import {
  IconBookmark,
  IconCalendar,
  IconPin,
  IconStar,
  IconUsers,
} from '@/components/icons';

export type FavProps = {
  activityId: string;
  initialFavorited: boolean;
  authed: boolean;
} | null;

/**
 * Vertical activity card per the design: image with category pill +
 * heart overlay, meta rows with icons, then a Book Now button (cta
 * "book") or a View Details link + bookmark (cta "details").
 */
export default function ActivityCard({
  slug,
  title,
  imageUrl,
  categorySlug,
  categoryName,
  ageText,
  locationText,
  scheduleText,
  rating,
  ratingCount,
  cta = 'book',
  fav = null,
  extra,
}: {
  slug: string;
  title: string;
  imageUrl?: string | null;
  categorySlug?: string | null;
  categoryName?: string | null;
  ageText?: string | null;
  locationText?: string | null;
  scheduleText?: string | null;
  rating?: number | null;
  ratingCount?: number | null;
  cta?: 'book' | 'details' | 'none';
  fav?: FavProps;
  extra?: React.ReactNode;
}) {
  const meta = catMeta(categorySlug);
  return (
    <div className="a-card">
      <Link href={`/activities/${slug}`} aria-label={title}>
        <div className="a-media">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={
              imageUrl ||
              'https://images.unsplash.com/photo-1529333166437-7750a6dd5a70?q=80&w=900&auto=format&fit=crop'
            }
            alt={title}
            loading="lazy"
          />
          {categoryName && <span className={`cat-pill ${meta.solid}`}>{categoryName}</span>}
          {fav && (
            <div className="fav-overlay">
              <FavoriteButton {...fav} variant="heart" />
            </div>
          )}
        </div>
      </Link>
      <div className="a-body">
        <h3 className="a-title">
          <Link href={`/activities/${slug}`} style={{ color: 'inherit' }}>
            {title}
          </Link>
        </h3>
        {ageText && (
          <div className="meta">
            <IconUsers size={15} /> {ageText}
          </div>
        )}
        {locationText && (
          <div className="meta">
            <IconPin size={15} /> {locationText}
          </div>
        )}
        {scheduleText && (
          <div className="meta">
            <IconCalendar size={15} /> {scheduleText}
          </div>
        )}
        {rating != null && (ratingCount ?? 0) > 0 && (
          <div className="rating">
            <IconStar size={14} /> {Number(rating).toFixed(1)}{' '}
            <span className="muted">({ratingCount})</span>
          </div>
        )}
        {extra}
        {cta === 'book' && (
          <div className="a-actions">
            <Link href={`/activities/${slug}`} className="btn sm block">
              Book Now
            </Link>
          </div>
        )}
        {cta === 'details' && (
          <div className="a-actions">
            <Link href={`/activities/${slug}`} className="sec-link">
              View Details
            </Link>
            {fav ? (
              <FavoriteButton {...fav} variant="bookmark" />
            ) : (
              <span className="icon-btn" style={{ opacity: 0.5 }}>
                <IconBookmark size={16} />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
