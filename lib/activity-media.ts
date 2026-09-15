/**
 * Where an activity's parent-facing photos come from — its own uploads, or
 * (default, and whenever it has none of its own) the provider's own profile
 * picture (as the default cover) followed by their catalogue. Mirrors
 * frontends/parent/src/lib/activityMedia.ts — kept as a small duplicate
 * rather than a shared import since this Next.js app and the Vite parent
 * SPA are separate builds with no shared lib layer.
 */

export interface ActivityMediaInput {
  image_urls: string[] | null | undefined;
  image_source?: string | null;
  cover_image_url?: string | null;
}

export interface ProviderMediaInput {
  logo_url?: string | null;
  cover_image_url?: string | null;
  gallery_urls?: string[] | null;
}

export function resolveActivityImages(
  activity: ActivityMediaInput,
  provider: ProviderMediaInput | null | undefined
): string[] {
  const ownImages = (activity.image_urls ?? []).filter(Boolean);
  const wantsCustom = activity.image_source === 'custom';

  if (wantsCustom && ownImages.length > 0) {
    return orderWithCover(ownImages, activity.cover_image_url);
  }

  const providerImages = providerPhotoPool(provider);
  if (providerImages.length > 0) {
    return orderWithCover(providerImages, activity.cover_image_url);
  }

  return ownImages;
}

/** Logo first (the default cover), then the catalogue. The dedicated
 *  cover_image_url field is deliberately not part of this. */
function providerPhotoPool(provider: ProviderMediaInput | null | undefined): string[] {
  return [provider?.logo_url, ...(provider?.gallery_urls ?? [])].filter((u): u is string => !!u);
}

function orderWithCover(images: string[], cover: string | null | undefined): string[] {
  if (!cover || !images.includes(cover)) return images;
  return [cover, ...images.filter((u) => u !== cover)];
}

export function resolveActivityImage(
  activity: ActivityMediaInput,
  provider: ProviderMediaInput | null | undefined
): string | null {
  return resolveActivityImages(activity, provider)[0] ?? null;
}
