import { verifyPushPicture } from '@/lib/push-images';

/**
 * A push notification's picture, at the shape Android wants: `square` (the
 * thumbnail, 256²) or `wide` (the expanded picture, 1024×512, the 2:1 Android
 * would otherwise crop to itself).
 *
 * `fit=cover` fills the frame, keeping the most interesting part (faces) in;
 * `fit=contain` fits the whole picture on the brand's pink tint — used for a
 * vendor's logo, which must never be cropped (CLAUDE.md, Parent app images).
 *
 * Only links signed by lib/push-images are served (else this is an open proxy).
 * Any failure is a 404: the notification still shows, just without a picture.
 */
export const runtime = 'nodejs';
export const maxDuration = 20;

const SIZES = { square: [256, 256], wide: [1024, 512] } as const;
const TINT = { r: 0xfc, g: 0xef, b: 0xf4, alpha: 1 };
const MAX_BYTES = 12 * 1024 * 1024;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const shape = q.get('shape') ?? '';
  const fit = q.get('fit') ?? '';
  const src = q.get('src') ?? '';
  if (!(shape in SIZES) || (fit !== 'cover' && fit !== 'contain') || !/^https:\/\//i.test(src)
      || !verifyPushPicture(shape, fit, src, q.get('sig') ?? '')) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error(`source ${res.status}`);
    const input = Buffer.from(await res.arrayBuffer());
    if (input.length > MAX_BYTES) throw new Error('source too large');

    const sharp = (await import('sharp')).default;
    const [width, height] = SIZES[shape as keyof typeof SIZES];
    const out = await sharp(input, { animated: false })
      .rotate() // honour the photo's EXIF orientation
      .resize(width, height, fit === 'contain'
        ? { fit: 'contain', background: TINT }
        : { fit: 'cover', position: sharp.strategy.attention })
      .flatten({ background: TINT }) // a transparent logo sits on the tint, not black
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

    return new Response(new Uint8Array(out), {
      headers: {
        'Content-Type': 'image/jpeg',
        // The link names its source, shape and fit, so the same link is always the same picture.
        'Cache-Control': 'public, max-age=604800, s-maxage=604800, immutable',
      },
    });
  } catch (e) {
    console.warn('[push-image] could not prepare a picture:', e instanceof Error ? e.message : e);
    return new Response('Not found', { status: 404 });
  }
}
