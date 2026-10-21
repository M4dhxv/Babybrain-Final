import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Pictures for a push notification about one activity: its first photo, as the
 * parent app shows it, served through /api/push/image so it arrives at the shape
 * Android wants — a square thumbnail (`icon`) and a 2:1 picture (`image`).
 *
 * "First photo" follows the parent app exactly (frontends/parent/src/lib/
 * activityMedia.ts resolveActivityImages): the activity's own uploads when it is
 * set to 'custom' and has some, otherwise the provider's pool (logo first, then
 * gallery), with the chosen cover moved to the front.
 *
 * Every picture is fitted whole on the brand tint, never cropped — the same
 * crop-safe treatment as the Explore cards (CLAUDE.md, Parent app images). Not just
 * the provider's logo_url: vendors also upload their logo as a class's own photo
 * (seen 2026-10-21: "Wonder Tots", whose 2:1 crop cut the artwork off), and nothing
 * but the URL can tell a logo from a photo.
 */

type ActivityMedia = {
  image_urls: string[] | null; image_source: string | null; cover_image_url: string | null;
  providers: { logo_url: string | null; gallery_urls: string[] | null } | null;
};

const MEDIA_COLUMNS = 'image_urls, image_source, cover_image_url, providers(logo_url, gallery_urls)';

function orderWithCover(images: string[], cover: string | null): string[] {
  if (!cover || !images.includes(cover)) return images;
  return [cover, ...images.filter((u) => u !== cover)];
}

function firstImage(a: ActivityMedia): { url: string; isLogo: boolean } | null {
  const own = (a.image_urls ?? []).filter(Boolean);
  const logo = a.providers?.logo_url || null;
  const pool = [logo, ...(a.providers?.gallery_urls ?? [])].filter((u): u is string => !!u);
  const list = a.image_source === 'custom' && own.length
    ? orderWithCover(own, a.cover_image_url)
    : pool.length ? orderWithCover(pool, a.cover_image_url) : own;
  const url = list[0];
  return url ? { url, isLogo: !!logo && url === logo } : null;
}

/* The picture route fetches whatever `src` it is given, so it only serves links this file signed:
   otherwise it would be an open image proxy. Reuses the server-only webhook secret. */
const secret = () => process.env.PUSH_IMAGE_SECRET || process.env.WEBHOOK_SHARED_SECRET || '';
const sign = (shape: string, fit: string, src: string) =>
  createHmac('sha256', secret()).update(`${shape}|${fit}|${src}`).digest('base64url').slice(0, 32);

export function verifyPushPicture(shape: string, fit: string, src: string, sig: string): boolean {
  if (!secret() || !sig) return false;
  const want = Buffer.from(sign(shape, fit, src));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Site paths for the push payload (`icon`, `image`), or {} when there's no usable photo. */
export function pushPictures(photo: { url: string; isLogo: boolean } | null): { icon?: string; image?: string } {
  if (!photo || !/^https:\/\//i.test(photo.url) || !secret()) return {};
  // Always whole, never cropped (see the header). `cover` stays supported by the route for a
  // surface that can tell a real photo from a logo.
  const fit = 'contain';
  const q = (shape: 'square' | 'wide') =>
    `/api/push/image?shape=${shape}&fit=${fit}&src=${encodeURIComponent(photo.url)}&sig=${sign(shape, fit, photo.url)}`;
  return { icon: q('square'), image: q('wide') };
}

/** By activity id (a booking's class). */
export async function activityPushPictures(db: SupabaseClient, activityId: string) {
  const { data } = await db.from('activities').select(MEDIA_COLUMNS).eq('id', activityId).maybeSingle();
  return pushPictures(data ? firstImage(data as unknown as ActivityMedia) : null);
}

/** By slug (a suggestion carries only its /activity?slug=… link). */
export async function activityPushPicturesBySlug(db: SupabaseClient, slug: string) {
  const { data } = await db.from('activities').select(MEDIA_COLUMNS).eq('slug', slug).maybeSingle();
  return pushPictures(data ? firstImage(data as unknown as ActivityMedia) : null);
}

/** Extra push fields for the two notifications that carry a photo (Aman, 2026-10-21), used by
 *  app/api/webhooks/notifications:
 *  - booking_confirmed: the booked class's first photo;
 *  - suggested_activities: the top pick's photo, a title naming it, and a link to the parent's
 *    matches (the digest row's own title/body stay as they are for email and the in-app feed).
 *  Anything missing just leaves the plain push. */
export async function pushExtras(db: SupabaseClient, type: string, data: Record<string, unknown>): Promise<{
  title?: string; body?: string; url?: string; icon?: string; image?: string;
}> {
  if (type === 'booking_confirmed' && typeof data.booking_id === 'string') {
    const { data: b } = await db.from('bookings')
      .select('activity_sessions(activity_id)').eq('id', data.booking_id).maybeSingle();
    const activityId = (b?.activity_sessions as { activity_id?: string } | null)?.activity_id;
    return activityId ? activityPushPictures(db, activityId) : {};
  }
  if (type === 'suggested_activities' && Array.isArray(data.activities) && data.activities.length) {
    const list = data.activities as { activity_name?: string; date_time?: string; url?: string }[];
    const top = list[0];
    const slug = typeof top.url === 'string' ? new URLSearchParams(top.url.split('?')[1] ?? '').get('slug') : null;
    const name = top.activity_name?.trim();
    const more = list.length - 1;
    return {
      ...(name ? {
        title: more > 0 ? `${name} and ${more} more for you this week` : `${name}, picked for you this week`,
        body: [top.date_time, 'Tap to see all your suggestions'].filter(Boolean).join(' · '),
      } : {}),
      url: '/matches',
      ...(slug ? await activityPushPicturesBySlug(db, slug) : {}),
    };
  }
  return {};
}
