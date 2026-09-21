import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Crops an activity photo to the frame the parent app shows it in.
 *
 * The parent's activity page hero is about 2:1 on a desktop and roughly square on a
 * phone (it centre-crops the sides). This frame is 2:1, with a dashed "phone view"
 * guide showing what stays visible on a phone, so the vendor can keep the important
 * part of the picture in the middle. "Fit whole image" keeps a logo uncropped on a
 * white background; "Fill frame" crops to the edges.
 */
const FRAME_W = 560;
const FRAME_H = 280;
const OUT_W = 1600;
const OUT_H = 800;
const PHONE_RATIO = 1.07; // the hero's width:height on a phone

export function ImageCropDialog({
  url,
  open,
  onClose,
  onCropped,
}: {
  url: string | null;
  open: boolean;
  onClose: () => void;
  /** Receives the cropped image, ready to upload. */
  onCropped: (file: File) => Promise<void> | void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Scale = displayed pixels per natural pixel; (cx, cy) = image centre inside the frame.
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: FRAME_W / 2, y: FRAME_H / 2 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const fitScale = img ? Math.min(FRAME_W / img.naturalWidth, FRAME_H / img.naturalHeight) : 1;
  const fillScale = img ? Math.max(FRAME_W / img.naturalWidth, FRAME_H / img.naturalHeight) : 1;
  const maxScale = fillScale * 4;

  /** Keep the image covering the frame on any axis where it is larger than it; centre it otherwise. */
  const clamp = useCallback(
    (x: number, y: number, s: number) => {
      if (!img) return { x, y };
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      return {
        x: w >= FRAME_W ? Math.min(w / 2, Math.max(FRAME_W - w / 2, x)) : FRAME_W / 2,
        y: h >= FRAME_H ? Math.min(h / 2, Math.max(FRAME_H - h / 2, y)) : FRAME_H / 2,
      };
    },
    [img]
  );

  const place = useCallback(
    (s: number) => {
      setScale(s);
      setPos((p) => clamp(p.x, p.y, s));
    },
    [clamp]
  );

  useEffect(() => {
    if (!open || !url) return;
    setImg(null);
    setError(null);
    const el = new Image();
    // The photo lives on Supabase storage, which allows cross-origin reads, so the canvas stays exportable.
    el.crossOrigin = 'anonymous';
    el.onload = () => {
      setImg(el);
      const ratio = el.naturalWidth / el.naturalHeight;
      // Landscape photos start filled; logos and portraits start fitted so nothing is cut off.
      const s = ratio >= 1.3
        ? Math.max(FRAME_W / el.naturalWidth, FRAME_H / el.naturalHeight)
        : Math.min(FRAME_W / el.naturalWidth, FRAME_H / el.naturalHeight);
      setScale(s);
      setPos({ x: FRAME_W / 2, y: FRAME_H / 2 });
    };
    el.onerror = () => setError('Could not load this photo to crop it.');
    el.src = url;
  }, [open, url]);

  async function save() {
    if (!img) return;
    setSaving(true);
    setError(null);
    try {
      const k = OUT_W / FRAME_W;
      const canvas = document.createElement('canvas');
      canvas.width = OUT_W;
      canvas.height = OUT_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      const w = img.naturalWidth * scale * k;
      const h = img.naturalHeight * scale * k;
      ctx.drawImage(img, pos.x * k - w / 2, pos.y * k - h / 2, w, h);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
      if (!blob) throw new Error('export failed');
      await onCropped(new File([blob], `crop-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      onClose();
    } catch {
      setError('Could not save the crop. Try again, or re-upload the photo.');
    } finally {
      setSaving(false);
    }
  }

  const w = img ? img.naturalWidth * scale : 0;
  const h = img ? img.naturalHeight * scale : 0;
  const phoneW = FRAME_H * PHONE_RATIO;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Crop photo</DialogTitle>
          <DialogDescription>
            Drag to position, and zoom to resize. This is the frame parents see on the activity page.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-x-auto">
          <div
            className="relative mx-auto touch-none select-none overflow-hidden rounded-xl bg-white ring-1 ring-gray-200"
            style={{ width: FRAME_W, height: FRAME_H, cursor: drag.current ? 'grabbing' : 'grab' }}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              setPos(clamp(d.x + (e.clientX - d.px), d.y + (e.clientY - d.py), scale));
            }}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
          >
            {img && (
              <img
                src={img.src}
                alt=""
                draggable={false}
                className="pointer-events-none absolute max-w-none"
                style={{ width: w, height: h, left: pos.x - w / 2, top: pos.y - h / 2 }}
              />
            )}
            {!img && !error && <div className="absolute inset-0 grid place-items-center text-sm text-gray-400">Loading photo…</div>}
            {/* What stays visible on a phone, where the hero is closer to square. */}
            <div
              className="pointer-events-none absolute inset-y-0 border-x-2 border-dashed border-[#FA4D8D]/70"
              style={{ left: (FRAME_W - phoneW) / 2, width: phoneW }}
            >
              <span className="absolute left-1/2 top-1 -translate-x-1/2 whitespace-nowrap rounded bg-[#FA4D8D] px-1.5 py-0.5 text-[10px] font-medium text-white">
                Phone view
              </span>
            </div>
          </div>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={!img} onClick={() => place(fitScale)}>
            Fit whole image
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!img} onClick={() => { place(fillScale); }}>
            Fill frame
          </Button>
          <label className="flex min-w-[180px] flex-1 items-center gap-2 text-xs text-gray-500">
            Zoom
            <input
              type="range"
              min={fitScale}
              max={maxScale}
              step={(maxScale - fitScale) / 200 || 0.001}
              value={Math.min(maxScale, Math.max(fitScale, scale))}
              disabled={!img}
              onChange={(e) => place(Number(e.target.value))}
              className="h-2 w-full accent-[#FA4D8D]"
              aria-label="Zoom"
            />
          </label>
        </div>
        <p className="text-xs text-gray-500">
          Keep the important part between the dashed lines so it also shows on phones. Blank areas are filled with white.
        </p>
        {error && <p className="text-xs font-medium text-red-600">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={() => void save()} disabled={!img || saving} className="bg-[#FA4D8D] text-white hover:opacity-90">
            {saving ? 'Saving…' : 'Save crop'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
