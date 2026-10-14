/**
 * Browser-side photo editing engine for the admin and vendor-portal upload pop-ups.
 *
 * NOTE: this file exists twice, byte for byte —
 *   app/admin/_lib/imageEdit.ts
 *   frontends/vendor/src/lib/imageEdit.ts
 * The two apps don't share a source tree, so keep them identical (diff them after editing).
 *
 * Split in two on purpose:
 *   - pure pixel functions that work on a Uint8ClampedArray of RGBA (testable in Node);
 *   - thin canvas glue that orients, crops, resizes and encodes.
 *
 * The background remover is a port of `colourToAlpha` in scripts/trim-logo-whitespace.mjs
 * (GIMP-style "colour to alpha"): per pixel the smallest alpha that lets the colour
 * composite back to the original over the background colour B, so anti-aliased edges
 * keep their look and there is no white halo. It only makes sense for artwork on a flat
 * background, so `analyse` reports whether that holds and the UI lets the user opt out.
 */

export type Rgb = [number, number, number];
export type Rotation = 0 | 90 | 180 | 270;
export type Box = { left: number; top: number; width: number; height: number };

export type Adjust = {
  /** -100..100 each; 0 = unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
};

export type EditOptions = {
  rotation: Rotation;
  flipH: boolean;
  /** Crop window inside the rotated/flipped image, as fractions of it (0..1). */
  crop: { x: number; y: number; w: number; h: number };
  adjust: Adjust;
  /** Turn the background colour transparent. */
  removeBg: boolean;
  /** Background to remove; null = detect from the image corners. */
  bgColour: Rgb | null;
  /** 0..100: how close to the background colour still counts as background. */
  tolerance: number;
  /** Crop the empty margin around the artwork. */
  trim: boolean;
  /** Breathing room kept around the artwork after trimming, as a fraction of its longest edge. */
  padding: number;
  /** Longest edge cap in px; never upscales. Infinity = no cap. */
  maxSide: number;
};

export const DEFAULT_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0 };

/** Largest working canvas; bigger photos are scaled down to this before editing. */
export const MAX_WORKING_SIDE = 4096;

// ---------------------------------------------------------------------------
// Pure pixel functions
// ---------------------------------------------------------------------------

export type Analysis = {
  /** Border colour (median of 8 samples around the edge). */
  colour: Rgb;
  /** The border is one flat colour, so removing it is safe. */
  flat: boolean;
  /** The image already has transparent pixels. */
  hasAlpha: boolean;
  /** The border itself is transparent: nothing to remove. */
  borderTransparent: boolean;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function analyse(data: Uint8ClampedArray, w: number, h: number): Analysis {
  const pts: [number, number][] = [
    [0, 0], [w >> 1, 0], [w - 1, 0],
    [0, h >> 1], [w - 1, h >> 1],
    [0, h - 1], [w >> 1, h - 1], [w - 1, h - 1],
  ];
  const px = pts.map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]] as const;
  });
  const colour: Rgb = [
    median(px.map((p) => p[0])), median(px.map((p) => p[1])), median(px.map((p) => p[2])),
  ];
  const borderTransparent = px.filter((p) => p[3] < 128).length >= 4;
  const flat = !borderTransparent && px.every(
    (p) => Math.abs(p[0] - colour[0]) + Math.abs(p[1] - colour[1]) + Math.abs(p[2] - colour[2]) <= 45
  );
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4 * 7) {
    if (data[i] < 250) { hasAlpha = true; break; }
  }
  return { colour, flat, hasAlpha, borderTransparent };
}

/** Alpha floor for a tolerance slider value: 0 → 2% (JPEG noise only), 100 → 30%. */
const floorFor = (tolerance: number) => 0.02 + (Math.min(100, Math.max(0, tolerance)) / 100) * 0.28;

/**
 * Background colour → transparency, in place. Returns the fraction of pixels cleared.
 * Colour B becomes fully transparent (including B inside the artwork); mid-tones keep
 * their look over B and blend correctly over any tint.
 */
export function colourToAlpha(data: Uint8ClampedArray, bg: Rgb, tolerance: number): number {
  const floor = floorFor(tolerance);
  let cleared = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const a0 = data[i + 3];
    if (a0 === 0) { cleared++; continue; }
    let a = 0;
    for (let c = 0; c < 3; c++) {
      const p = data[i + c];
      const room = p < bg[c] ? bg[c] : 255 - bg[c];
      const t = room > 0 ? Math.abs(p - bg[c]) / room : 0;
      if (t > a) a = t;
    }
    if (a < floor) { data[i + 3] = 0; cleared++; continue; }
    for (let c = 0; c < 3; c++) {
      const v = bg[c] + (data[i + c] - bg[c]) / a;
      data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    data[i + 3] = Math.round(a * a0);
  }
  return cleared / n;
}

/** Bounding box of pixels with alpha above a small floor, or null if there are none. */
export function alphaBounds(data: Uint8ClampedArray, w: number, h: number, floor = 8): Box | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > floor) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Bounding box of pixels that differ from `bg` by more than `threshold` (sum of channels). */
export function colourBounds(
  data: Uint8ClampedArray, w: number, h: number, bg: Rgb, threshold = 36
): Box | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4;
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > threshold || data[i + 3] < 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Brightness / contrast / saturation, in place. Alpha is untouched. */
export function applyAdjust(data: Uint8ClampedArray, a: Adjust): void {
  if (!a.brightness && !a.contrast && !a.saturation) return;
  const add = a.brightness * 2.55;
  const c = a.contrast * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const sat = 1 + a.saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    r = cf * (r + add - 128) + 128;
    g = cf * (g + add - 128) + 128;
    b = cf * (b + add - 128) + 128;
    if (a.saturation) {
      const grey = 0.299 * r + 0.587 * g + 0.114 * b;
      r = grey + (r - grey) * sat;
      g = grey + (g - grey) * sat;
      b = grey + (b - grey) * sat;
    }
    data[i] = r; data[i + 1] = g; data[i + 2] = b; // Uint8ClampedArray clamps
  }
}

// ---------------------------------------------------------------------------
// Canvas glue
// ---------------------------------------------------------------------------

export function loadImage(src: Blob | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    let revoke: string | null = null;
    // Photos live on Supabase storage, which allows cross-origin reads, so the canvas stays exportable.
    if (typeof src === 'string') el.crossOrigin = 'anonymous';
    el.onload = () => { if (revoke) URL.revokeObjectURL(revoke); resolve(el); };
    el.onerror = () => {
      if (revoke) URL.revokeObjectURL(revoke);
      reject(new Error("This image couldn't be opened for editing."));
    };
    if (typeof src === 'string') el.src = src;
    else { revoke = URL.createObjectURL(src); el.src = revoke; }
  });
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Draw the source rotated/flipped, scaled down so its longest edge is at most `cap`. */
export function orient(img: HTMLImageElement, rotation: Rotation, flipH: boolean, cap: number): HTMLCanvasElement {
  const sw = img.naturalWidth, sh = img.naturalHeight;
  const swap = rotation === 90 || rotation === 270;
  const ow = swap ? sh : sw, oh = swap ? sw : sh;
  const s = Math.min(1, cap / Math.max(ow, oh));
  const c = makeCanvas(ow * s, oh * s);
  const ctx = ctxOf(c);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  if (flipH) ctx.scale(-1, 1);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  return c;
}

/** Resize with repeated halving, which keeps thin strokes sharper than one big step. */
function resizeTo(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  let cur = src;
  while (cur.width / 2 > w && cur.height / 2 > h) {
    const half = makeCanvas(cur.width / 2, cur.height / 2);
    ctxOf(half).drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  if (cur.width === Math.round(w) && cur.height === Math.round(h)) return cur;
  const out = makeCanvas(w, h);
  ctxOf(out).drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

export const CROP_ALL = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Largest crop window of `aspect` (width / height) that fits inside an image of
 * w × h, shrunk by `zoom` (1 = as large as possible) and centred on (cx, cy), all as
 * fractions of the image. The window is kept inside the image.
 */
export function cropFor(
  w: number, h: number, aspect: number | null, zoom: number, cx: number, cy: number
): { x: number; y: number; w: number; h: number } {
  if (!aspect) return { ...CROP_ALL };
  const imgAspect = w / h;
  let cw = 1, ch = 1;
  if (aspect > imgAspect) ch = imgAspect / aspect; else cw = aspect / imgAspect;
  cw /= Math.max(1, zoom);
  ch /= Math.max(1, zoom);
  const x = Math.min(1 - cw, Math.max(0, cx - cw / 2));
  const y = Math.min(1 - ch, Math.max(0, cy - ch / 2));
  return { x, y, w: cw, h: ch };
}

/**
 * Run the whole edit on an already-oriented canvas. Order matters: crop, then remove
 * the background, then adjust colours (on the remaining pixels), then trim + pad, then resize.
 */
export function renderEdit(oriented: HTMLCanvasElement, o: EditOptions): HTMLCanvasElement {
  // 1. crop
  const cx = Math.round(o.crop.x * oriented.width);
  const cy = Math.round(o.crop.y * oriented.height);
  const cw = Math.max(1, Math.round(o.crop.w * oriented.width));
  const ch = Math.max(1, Math.round(o.crop.h * oriented.height));
  let work = makeCanvas(cw, ch);
  ctxOf(work).drawImage(oriented, cx, cy, cw, ch, 0, 0, cw, ch);

  let ctx = ctxOf(work);
  const img = ctx.getImageData(0, 0, work.width, work.height);
  const info = analyse(img.data, work.width, work.height);
  const bg: Rgb = o.bgColour ?? info.colour;

  // 2. background → transparent
  let madeTransparent = false;
  if (o.removeBg && !info.borderTransparent) {
    colourToAlpha(img.data, bg, o.tolerance);
    madeTransparent = true;
  }

  // 3. colour adjustments
  applyAdjust(img.data, o.adjust);

  // 4. trim + pad
  let box: Box | null = null;
  if (o.trim) {
    if (madeTransparent || info.borderTransparent || info.hasAlpha) {
      box = alphaBounds(img.data, work.width, work.height);
    } else if (info.flat) {
      box = colourBounds(img.data, work.width, work.height, info.colour);
    }
  }
  if (box && (box.width < 8 || box.height < 8)) box = null; // would leave nothing meaningful
  if (!box) box = { left: 0, top: 0, width: work.width, height: work.height };

  const pad = o.trim && box ? Math.round(Math.max(box.width, box.height) * Math.max(0, o.padding)) : 0;
  const out = makeCanvas(box.width + pad * 2, box.height + pad * 2);
  const octx = ctxOf(out);
  const transparentOut = madeTransparent || info.borderTransparent || info.hasAlpha;
  if (pad && !transparentOut) {
    octx.fillStyle = `rgb(${info.colour[0]},${info.colour[1]},${info.colour[2]})`;
    octx.fillRect(0, 0, out.width, out.height);
  }
  // putImageData → temp canvas, because drawImage honours alpha compositing and a sub-rect.
  work = makeCanvas(img.width, img.height);
  ctx = ctxOf(work);
  ctx.putImageData(img, 0, 0);
  octx.drawImage(work, box.left, box.top, box.width, box.height, pad, pad, box.width, box.height);

  // 5. resize
  const scale = Math.min(1, o.maxSide / Math.max(out.width, out.height));
  if (scale < 1) return resizeTo(out, out.width * scale, out.height * scale);
  return out;
}

export function canvasHasAlpha(c: HTMLCanvasElement): boolean {
  const d = ctxOf(c).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

export type Encoded = { blob: Blob; type: string; ext: string; hasAlpha: boolean };

/**
 * WebP where the browser can encode it (smallest, keeps transparency). Safari used to
 * ignore the type and hand back PNG, so check what actually came out and otherwise pick
 * PNG for transparent artwork and JPEG for everything else.
 */
export async function encode(c: HTMLCanvasElement, quality: number): Promise<Encoded> {
  const hasAlpha = canvasHasAlpha(c);
  const toBlob = (type: string, q?: number) =>
    new Promise<Blob | null>((res) => c.toBlob(res, type, q));
  const webp = await toBlob('image/webp', quality);
  if (webp && webp.type === 'image/webp') return { blob: webp, type: 'image/webp', ext: 'webp', hasAlpha };
  if (hasAlpha) {
    const png = await toBlob('image/png');
    if (png) return { blob: png, type: 'image/png', ext: 'png', hasAlpha };
  }
  const jpeg = await toBlob('image/jpeg', quality);
  if (!jpeg) throw new Error("Couldn't export the edited image.");
  return { blob: jpeg, type: 'image/jpeg', ext: 'jpg', hasAlpha };
}

export function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
