'use client';

/**
 * State and behaviour of the photo editor pop-up, with no markup, so the admin
 * pop-up (inline styles) and the vendor-portal dialog (Tailwind) stay thin and
 * can't drift apart.
 *
 * NOTE: this file exists twice, byte for byte —
 *   app/admin/_lib/usePhotoEditor.ts
 *   frontends/vendor/src/lib/usePhotoEditor.ts
 * (imports `./imageEdit`, which is the other duplicated file). Diff after editing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_ADJUST, MAX_WORKING_SIDE, analyse, canvasHasAlpha, cropFor, encode, loadImage, orient, renderEdit,
  type Adjust, type Analysis, type EditOptions, type Rgb, type Rotation,
} from './imageEdit';

export type PhotoKind = 'logo' | 'photo';

/** Preview is rendered from a copy no bigger than this, so sliders stay instant. */
const PREVIEW_SIDE = 1100;

/** The parent app's activity-page hero is 860 x 305 on a computer and about 360 x 305 on a phone. */
export const HERO_ASPECT = 860 / 305;
export const PHONE_HERO_ASPECT = 360 / 305;

export const SHAPES: { key: string; label: string; aspect: number | null }[] = [
  { key: 'orig', label: 'Original', aspect: null },
  { key: 'hero', label: 'Activity hero', aspect: HERO_ASPECT },
  { key: 'sq', label: 'Square', aspect: 1 },
  { key: '43', label: '4:3', aspect: 4 / 3 },
  { key: '169', label: '16:9', aspect: 16 / 9 },
  { key: '34', label: '3:4', aspect: 3 / 4 },
];

export const SIZES: { label: string; px: number }[] = [
  { label: 'Large · 2400 px', px: 2400 },
  { label: 'Standard · 1600 px', px: 1600 },
  { label: 'Medium · 1000 px', px: 1000 },
  { label: 'Small · 600 px', px: 600 },
  { label: 'Keep original size', px: Infinity },
];

export const BACKDROPS: { key: string; label: string; css: Record<string, string> }[] = [
  {
    key: 'check', label: 'Transparent',
    css: {
      backgroundColor: '#fff',
      backgroundImage:
        'linear-gradient(45deg,#d9d9d9 25%,transparent 25%,transparent 75%,#d9d9d9 75%),' +
        'linear-gradient(45deg,#d9d9d9 25%,transparent 25%,transparent 75%,#d9d9d9 75%)',
      backgroundSize: '16px 16px',
      backgroundPosition: '0 0, 8px 8px',
    },
  },
  { key: 'white', label: 'White', css: { background: '#ffffff' } },
  { key: 'tint', label: 'Card tint', css: { background: '#fdecf3' } },
  { key: 'dark', label: 'Dark', css: { background: '#1c2740' } },
];

/** Background the parent app paints behind every activity image. */
export const PARENT_BG = '#F3EDF0';

/**
 * Mirrors the parent app's activity-page hero (ActivityDetailPage HeroSlide): the vendor's
 * logo, and any picture that is very square or very wide, is shown whole on that tint;
 * everything else fills the frame, anchored near the top so faces stay in. Cards never crop.
 */
export function heroShowsWhole(kind: PhotoKind, ratio: number): boolean {
  return kind === 'logo' || ratio < 1.4 || ratio > 3.6;
}

export const toHex = (c: Rgb) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): Rgb => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
];
export const nearWhite = (c: Rgb) => Math.min(...c) >= 200;

/** File types the canvas can't usefully re-encode (animation, vector): upload untouched. */
export const SKIP_EDITOR_TYPES = ['image/gif', 'image/svg+xml'];

function baseName(source: File | string): string {
  const raw = typeof source === 'string' ? source.split('?')[0].split('/').pop() ?? 'image' : source.name;
  return raw.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9-]+/g, '_').slice(0, 50) || 'image';
}

export function backgroundHint(a: Analysis | null): string {
  if (!a) return '';
  if (a.borderTransparent) return 'This image already has a transparent background.';
  if (!a.flat) return "The background isn't one flat colour, so it may not come out clean. Check the preview.";
  if (nearWhite(a.colour)) return 'A plain white background was found.';
  return `A solid coloured background was found (${toHex(a.colour)}). Removing it is optional.`;
}

export function usePhotoEditor(source: File | string, kind: PhotoKind) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);

  const [rotation, setRotation] = useState<Rotation>(0);
  const [flipH, setFlipH] = useState(false);
  const [shape, setShapeKey] = useState('orig');
  const [zoom, setZoom] = useState(1);
  const [centre, setCentre] = useState({ x: 0.5, y: 0.5 });
  const [adjust, setAdjust] = useState<Adjust>(DEFAULT_ADJUST);
  const [removeBg, setRemoveBg] = useState(false);
  const [bgOverride, setBgOverride] = useState<Rgb | null>(null);
  const [tolerance, setTolerance] = useState(15);
  const [trim, setTrim] = useState(false);
  const [padding, setPadding] = useState(0.04);
  const [maxSide, setMaxSide] = useState(kind === 'logo' ? 1000 : 1600);
  const [quality, setQuality] = useState(0.9);

  const [previewDims, setPreviewDims] = useState<{ w: number; h: number; alpha: boolean } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [outInfo, setOutInfo] = useState<{ w: number; h: number; bytes: number; type: string } | null>(null);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // ---- load + starting point -------------------------------------------------
  useEffect(() => {
    let live = true;
    // (The editor is mounted fresh for each picture, so there is no stale state to clear.)
    loadImage(source)
      .then((el) => {
        if (!live) return;
        const probe = orient(el, 0, false, 600);
        const a = analyse(
          probe.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, probe.width, probe.height).data,
          probe.width, probe.height
        );
        setAnalysis(a);
        // A logo on a plain white background starts cleaned up; anything else starts untouched.
        if (kind === 'logo') {
          if (a.flat && nearWhite(a.colour)) { setRemoveBg(true); setTrim(true); }
          else if (a.borderTransparent || a.hasAlpha) setTrim(true);
        }
        setImg(el);
      })
      .catch((e) => live && setLoadErr(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [source, kind]);

  // ---- derived edit options --------------------------------------------------
  const base = useMemo(
    () => (img ? orient(img, rotation, flipH, PREVIEW_SIDE) : null),
    [img, rotation, flipH]
  );
  const aspect = SHAPES.find((s) => s.key === shape)?.aspect ?? null;

  const opts: EditOptions | null = useMemo(() => {
    if (!base) return null;
    return {
      rotation, flipH,
      crop: cropFor(base.width, base.height, aspect, zoom, centre.x, centre.y),
      adjust, removeBg, bgColour: bgOverride, tolerance,
      // A chosen crop shape already fixes the frame, so trimming would change its shape.
      trim: trim && !aspect, padding, maxSide,
    };
  }, [base, rotation, flipH, aspect, zoom, centre, adjust, removeBg, bgOverride, tolerance, trim, padding, maxSide]);

  // ---- live preview ----------------------------------------------------------
  useEffect(() => {
    if (!base || !opts || !previewRef.current) return;
    const out = renderEdit(base, { ...opts, maxSide: Infinity });
    const cv = previewRef.current;
    cv.width = out.width;
    cv.height = out.height;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(out, 0, 0);
    setPreviewDims({ w: out.width, h: out.height, alpha: canvasHasAlpha(out) });
  }, [base, opts]);

  // The "how parents will see it" frames use the current result as an image. Encoding it is
  // debounced so dragging a slider stays smooth; the frames catch up a moment later.
  useEffect(() => {
    if (!previewDims) return;
    const t = window.setTimeout(() => {
      const cv = previewRef.current;
      if (cv) setPreviewUrl(cv.toDataURL('image/png'));
    }, 120);
    return () => window.clearTimeout(t);
  }, [previewDims]);

  // ---- output size estimate (debounced: the real render is full resolution) ----
  useEffect(() => {
    if (!img || !opts) return;
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const out = renderEdit(orient(img, rotation, flipH, MAX_WORKING_SIDE), opts);
        const enc = await encode(out, quality);
        if (live) setOutInfo({ w: out.width, h: out.height, bytes: enc.blob.size, type: enc.type });
      } catch { /* the estimate is a nicety; saving reports real errors */ }
    }, 450);
    return () => { live = false; window.clearTimeout(t); };
  }, [img, opts, quality, rotation, flipH]);

  // ---- actions ---------------------------------------------------------------
  /** Render at full resolution and encode, ready to upload. */
  const renderFile = useCallback(async (): Promise<File> => {
    if (!img || !opts) throw new Error('The image is still opening.');
    const out = renderEdit(orient(img, rotation, flipH, MAX_WORKING_SIDE), opts);
    const enc = await encode(out, quality);
    return new File([enc.blob], `${baseName(source)}-edited.${enc.ext}`, { type: enc.type });
  }, [img, opts, rotation, flipH, quality, source]);

  const setShape = (key: string) => { setShapeKey(key); setZoom(1); setCentre({ x: 0.5, y: 0.5 }); };
  const rotate = (by: 90 | -90) => {
    setRotation((r) => ((r + by + 360) % 360) as Rotation);
    setCentre({ x: 0.5, y: 0.5 });
  };
  const flip = () => { setFlipH((v) => !v); setCentre((c) => ({ ...c, x: 1 - c.x })); };
  const resetColour = () => setAdjust(DEFAULT_ADJUST);

  // Pan: dragging the picture moves the crop window the other way.
  const onDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!aspect) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: centre.x, cy: centre.y };
    setDragging(true);
  };
  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !opts || !previewRef.current) return;
    const r = previewRef.current.getBoundingClientRect();
    setCentre({
      x: Math.min(1, Math.max(0, d.cx - ((e.clientX - d.x) / r.width) * opts.crop.w)),
      y: Math.min(1, Math.max(0, d.cy - ((e.clientY - d.y) / r.height) * opts.crop.h)),
    });
  };
  const onUp = () => { drag.current = null; setDragging(false); };

  // On a phone the hero is much squarer, so only the middle of a hero-shaped picture shows.
  const phoneShare = previewDims && aspect === HERO_ASPECT
    ? Math.min(1, (PHONE_HERO_ASPECT * previewDims.h) / previewDims.w) : null;
  const sampleColour: Rgb = bgOverride ?? analysis?.colour ?? [255, 255, 255];
  const nothingTransparent = removeBg && !!previewDims && !previewDims.alpha && !analysis?.borderTransparent;

  // The ref is returned beside the state, not inside it, so reading the state during render
  // isn't mistaken for reading a ref.
  const api = {
    // status
    img, loadErr, analysis, previewDims, previewUrl, outInfo, ready: !!img && !!opts,
    // edit state
    rotation, flipH, shape, aspect, zoom, setZoom, adjust, setAdjust,
    removeBg, setRemoveBg, bgOverride, setBgOverride, tolerance, setTolerance,
    trim, setTrim, padding, setPadding, maxSide, setMaxSide, quality, setQuality,
    // actions
    setShape, rotate, flip, resetColour, renderFile,
    pan: { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp },
    dragging,
    // derived
    phoneShare, sampleColour, nothingTransparent,
  };
  return [api, previewRef] as const;
}
