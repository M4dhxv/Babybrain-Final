/**
 * Where an activity's parent-facing photos come from — its own uploads, or
 * (default, and whenever it has none of its own) the provider's profile
 * photo/cover/gallery. One resolver shared by the Explore/search cards and
 * the activity detail page so the two can never disagree about which image
 * a listing shows.
 */

export type ImageSource = "profile" | "custom";

export interface ActivityMediaInput {
  image_urls: string[] | null | undefined;
  image_source?: ImageSource | string | null;
  cover_image_url?: string | null;
}

export interface ProviderMediaInput {
  logo_url?: string | null;
  cover_image_url?: string | null;
  gallery_urls?: string[] | null;
}

/**
 * Returns the ordered list of images to show for this activity — chosen
 * cover first, then the rest — or an empty array when neither the activity
 * nor its provider has anything (the caller falls back to a static
 * placeholder, same as before this existed).
 *
 * 'custom' only actually uses the activity's own photos when it has any;
 * an activity flipped to 'custom' with nothing uploaded yet still borrows
 * the provider's, so a listing is never left with no image just because a
 * vendor started (but didn't finish) picking its own.
 */
export function resolveActivityImages(
  activity: ActivityMediaInput,
  provider: ProviderMediaInput | null | undefined
): string[] {
  const ownImages = (activity.image_urls ?? []).filter(Boolean);
  const wantsCustom = activity.image_source === "custom";

  if (wantsCustom && ownImages.length > 0) {
    return orderWithCover(ownImages, activity.cover_image_url);
  }

  const providerImages = providerPhotoPool(provider);
  if (providerImages.length > 0) {
    return orderWithCover(providerImages, activity.cover_image_url);
  }

  // Nothing from the intended source — fall back to whichever side has
  // anything at all rather than showing nothing.
  return ownImages;
}

/**
 * The provider's real photos — cover + gallery — with the logo/avatar
 * excluded whenever either of those exists. A logo is branding (a small
 * square mark meant to identify the business, e.g. next to its name), not a
 * photo of the activity itself; concatenating it onto a real cover photo put
 * it side-by-side in the gallery as if it were an equally-valid second shot
 * of the class, which looked exactly like what it is — a mismatched logo
 * stuck in a photo gallery. Only used as a single last-resort image when the
 * provider has genuinely nothing else at all — better than no image.
 */
function providerPhotoPool(provider: ProviderMediaInput | null | undefined): string[] {
  const photos = [provider?.cover_image_url, ...(provider?.gallery_urls ?? [])].filter(
    (u): u is string => !!u
  );
  if (photos.length > 0) return photos;
  return provider?.logo_url ? [provider.logo_url] : [];
}

function orderWithCover(images: string[], cover: string | null | undefined): string[] {
  if (!cover || !images.includes(cover)) return images;
  return [cover, ...images.filter((u) => u !== cover)];
}

/** The single image a card needs — same resolution as the gallery, first entry. */
export function resolveActivityImage(
  activity: ActivityMediaInput,
  provider: ProviderMediaInput | null | undefined
): string | null {
  return resolveActivityImages(activity, provider)[0] ?? null;
}
