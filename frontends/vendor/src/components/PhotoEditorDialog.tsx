import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/imageEdit';
import {
  BACKDROPS, SHAPES, backgroundHint, fromHex, heroShowsWhole, toHex, usePhotoEditor, type PhotoKind,
} from '@/lib/usePhotoEditor';

export type { PhotoKind };

/**
 * Photo editor shown before a picture is uploaded: rotate/flip, crop to a shape,
 * brightness / contrast / saturation, optional transparent background, trim, and
 * resize + compress. The preview is the real result, and "Use original" always sends the
 * untouched file, so a bad cut-out is never forced on anyone.
 *
 * Mount it only while there is something to edit; unmounting resets it. The logic lives in
 * usePhotoEditor, which is shared with the admin portal's pop-up.
 */
/**
 * What a parent actually sees, drawn with the parent app's own rules (see heroShowsWhole):
 * the Explore card thumbnail, the activity-page hero on a computer, and the same hero on a phone.
 * Frames are the real sizes scaled down (hero 860 x 305; phone about 360 wide).
 */
function ParentView({ url, ratio, kind, bg, real }: {
  url: string | null; ratio: number; kind: PhotoKind;
  /** Background chosen under "Preview on"; the frames follow it so what you test is what you see. */
  bg: Record<string, string>;
  /** True when that background is the parent app's real card tint. */
  real: boolean;
}) {
  const whole = heroShowsWhole(kind, ratio);
  const cap = 'mb-1.5 text-xs font-semibold text-gray-500';
  // aspect = the real frame: hero 860 x 305 on a computer, about 360 x 305 on a phone.
  const hero = (maxW: number, aspect: string) => (
    <div className="relative w-full overflow-hidden rounded-[14px] ring-1 ring-gray-200"
      style={{ maxWidth: maxW, aspectRatio: aspect, ...bg }}>
      {whole && url && (
        <img src={url} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl" />
      )}
      {url && (
        <img src={url} alt="" className={cn('relative h-full w-full', whole ? 'object-contain' : 'object-cover object-[center_15%]')} />
      )}
    </div>
  );
  return (
    <div className="rounded-xl bg-gray-50 p-3 ring-1 ring-gray-200">
      {!url ? <div className="py-8 text-center text-sm text-gray-400">Preparing the preview…</div> : (
        <>
          <p className={cap}>Explore card</p>
          <div className="mb-3.5 w-full max-w-[300px] overflow-hidden rounded-[14px] ring-1 ring-gray-200" style={{ aspectRatio: '300 / 108', ...bg }}>
            <img src={url} alt="" className={cn('h-full w-full object-contain', kind === 'logo' && 'p-4')} />
          </div>
          <div className="flex items-start gap-3">
            <div className="min-w-0" style={{ flex: '2.35 1 0' }}>
              <p className={cap}>Activity page · computer</p>
              {hero(520, '860 / 305')}
            </div>
            <div className="min-w-0 flex-1">
              <p className={cap}>· phone</p>
              {hero(220, '360 / 305')}
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            {whole
              ? 'Shown whole, never cropped, on a soft tint. On the activity page the empty sides pick up a blurred copy of the picture.'
              : 'Fills the activity-page frame and keeps the top of the picture in view, so the bottom edge may be trimmed. On Explore cards it is always shown whole.'}
          </p>
          {!real && (
            <p className="mt-2 text-xs font-medium text-[#FA4D8D]">
              These frames follow the &ldquo;Preview on&rdquo; background you picked. Parents see the pale card tint, so choose Card tint to match exactly.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function PhotoEditorDialog({
  source, kind, heading, queueLabel, onCancel, onSave, onUseOriginal,
}: {
  /** A file the vendor just picked, or the URL of an image that is already stored. */
  source: File | string;
  kind: PhotoKind;
  heading?: string;
  /** e.g. "Photo 2 of 4" when several are queued. */
  queueLabel?: string;
  onCancel: () => void;
  onSave: (file: File) => Promise<void> | void;
  /** Upload the untouched file instead (only offered when `source` is a File). */
  onUseOriginal?: () => Promise<void> | void;
}) {
  const [ed, previewRef] = usePhotoEditor(source, kind);
  const [backdrop, setBackdrop] = useState('tint');
  const [busy, setBusy] = useState<null | 'save' | 'original'>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy('save'); setErr(null);
    try { await onSave(await ed.renderFile()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(null); }
  }
  async function uploadOriginal() {
    if (!onUseOriginal) return;
    setBusy('original'); setErr(null);
    try { await onUseOriginal(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(null); }
  }

  const { aspect } = ed;
  const label = 'mb-1 block text-xs font-semibold text-gray-500';
  const section = 'mt-4 border-t border-gray-100 pt-3';
  const chip = (on: boolean) =>
    cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
      on ? 'border-[#FA4D8D] bg-[#FA4D8D] text-white' : 'border-gray-200 text-gray-700 hover:bg-gray-50');
  const slider = (
    name: string, value: number, min: number, max: number, step: number, on: (v: number) => void, suffix = ''
  ) => (
    <label className="mb-2 block">
      <span className="mb-1 flex justify-between text-xs font-semibold text-gray-500">
        <span>{name}</span><span className="font-normal">{value}{suffix}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => on(Number(e.target.value))}
        className="h-2 w-full accent-[#FA4D8D]" aria-label={name} />
    </label>
  );

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onCancel(); }}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-[980px]">
        <DialogHeader>
          <DialogTitle>
            {heading ?? (kind === 'logo' ? 'Edit logo' : 'Edit photo')}
            {queueLabel && <span className="ml-2 text-sm font-normal text-gray-500">{queueLabel}</span>}
          </DialogTitle>
          <DialogDescription>
            {kind === 'logo'
              ? 'Your whole logo is always shown, never cropped. Remove the background only if the preview looks right.'
              : 'Crop, adjust and resize before it goes live. You can also use the original as it is.'}
          </DialogDescription>
        </DialogHeader>

        {ed.loadErr ? (
          <div className="py-4 text-sm text-red-600">
            {ed.loadErr}
            {onUseOriginal && (
              <div className="mt-3">
                <Button type="button" onClick={() => void uploadOriginal()} disabled={!!busy}
                  className="bg-[#FA4D8D] text-white hover:opacity-90">
                  {busy === 'original' ? 'Uploading…' : 'Upload the original instead'}
                </Button>
              </div>
            )}
          </div>
        ) : !ed.ready ? (
          <div className="py-10 text-center text-sm text-gray-400">Opening image…</div>
        ) : (
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_300px]">
            {/* ---- preview ---- */}
            <div>
              <div>
              <div
                className="grid min-h-[260px] place-items-center rounded-xl p-3 ring-1 ring-gray-200"
                style={BACKDROPS.find((b) => b.key === backdrop)!.css}
              >
                <div
                  {...ed.pan}
                  className="relative inline-block touch-none leading-[0]"
                  style={{ cursor: aspect ? (ed.dragging ? 'grabbing' : 'grab') : 'default' }}
                >
                  <canvas ref={previewRef} className="block h-auto max-h-[420px] w-auto max-w-full" />
                  {ed.phoneShare !== null && ed.phoneShare < 1 && (
                    <div
                      className="pointer-events-none absolute inset-y-0 border-x-2 border-dashed border-[#FA4D8D]"
                      style={{ left: `${((1 - ed.phoneShare) / 2) * 100}%`, width: `${ed.phoneShare * 100}%` }}
                    >
                      <span className="absolute left-1/2 top-1 -translate-x-1/2 whitespace-nowrap rounded bg-[#FA4D8D] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                        Phone view
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-gray-500">Preview on</span>
                {BACKDROPS.map((b) => (
                  <button key={b.key} type="button" className={chip(backdrop === b.key)} onClick={() => setBackdrop(b.key)}>
                    {b.label}
                  </button>
                ))}
              </div>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                {ed.outInfo
                  ? `Result: ${ed.outInfo.w} × ${ed.outInfo.h} px · ${formatBytes(ed.outInfo.bytes)} · ${ed.outInfo.type.replace('image/', '').toUpperCase()}`
                  : 'Working out the result size…'}
                {aspect ? ' · Drag the picture to reposition it.' : ''}
              </p>
              {/* Live: updates as you edit, so there's no need to switch tabs to check. */}
              <div className="mt-4">
                <div className="mb-2 text-xs font-semibold text-gray-500">
                  How parents will see it <span className="font-normal">· updates as you edit</span>
                </div>
                {ed.previewDims && <ParentView url={ed.previewUrl} ratio={ed.previewDims.w / ed.previewDims.h} kind={kind}
                  bg={BACKDROPS.find((b) => b.key === backdrop)!.css} real={backdrop === 'tint'} />}
              </div>
            </div>

            {/* ---- controls ---- */}
            <div>
              <div>
                <span className={label}>Rotate &amp; flip</span>
                <div className="flex gap-2">
                  <button type="button" className={chip(false)} onClick={() => ed.rotate(-90)}>↺ Left</button>
                  <button type="button" className={chip(false)} onClick={() => ed.rotate(90)}>↻ Right</button>
                  <button type="button" className={chip(ed.flipH)} onClick={ed.flip}>⇋ Flip</button>
                </div>
              </div>

              <div className={section}>
                <span className={label}>Crop shape</span>
                <div className="flex flex-wrap gap-1.5">
                  {SHAPES.map((s) => (
                    <button key={s.key} type="button" className={chip(ed.shape === s.key)} onClick={() => ed.setShape(s.key)}>
                      {s.label}
                    </button>
                  ))}
                </div>
                {aspect && <div className="mt-2">{slider('Zoom', Math.round(ed.zoom * 100) / 100, 1, 4, 0.05, ed.setZoom, '×')}</div>}
                {kind === 'logo' && aspect && (
                  <p className="mt-1 text-xs text-[#FA4D8D]">
                    A cropped logo loses part of the mark. Choose Original unless you mean it.
                  </p>
                )}
              </div>

              <div className={section}>
                <span className={label}>Background</span>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-900">
                  <input type="checkbox" className="accent-[#FA4D8D]" checked={ed.removeBg}
                    disabled={ed.analysis?.borderTransparent}
                    onChange={(e) => ed.setRemoveBg(e.target.checked)} />
                  Make the background transparent
                </label>
                <p className="my-1.5 text-xs text-gray-500">
                  {backgroundHint(ed.analysis)}{' '}
                  {kind === 'photo' && 'Only suits graphics on a plain background, not real photos.'}
                </p>
                {ed.removeBg && (
                  <>
                    {slider('How much counts as background', ed.tolerance, 0, 100, 1, ed.setTolerance, '%')}
                    <div className="mb-2 flex items-center gap-2">
                      <input type="color" value={toHex(ed.sampleColour)} aria-label="Background colour"
                        onChange={(e) => ed.setBgOverride(fromHex(e.target.value))}
                        className="h-8 w-10 cursor-pointer rounded border border-gray-200 bg-transparent p-0" />
                      <span className="text-xs text-gray-500">Colour removed {ed.bgOverride ? '(chosen)' : '(detected)'}</span>
                      {ed.bgOverride && (
                        <button type="button" className={chip(false)} onClick={() => ed.setBgOverride(null)}>Auto</button>
                      )}
                    </div>
                  </>
                )}
                <label className={cn('flex items-center gap-2 text-sm font-medium text-gray-900', aspect && 'opacity-50')}>
                  <input type="checkbox" className="accent-[#FA4D8D]" checked={ed.trim && !aspect}
                    disabled={!!aspect} onChange={(e) => ed.setTrim(e.target.checked)} />
                  Trim empty margin
                </label>
                {aspect && <p className="mt-1 text-xs text-gray-500">Not used while a crop shape is chosen.</p>}
                {ed.trim && !aspect && (
                  <div className="mt-2">
                    {slider('Space kept around it', Math.round(ed.padding * 100), 0, 20, 1, (v) => ed.setPadding(v / 100), '%')}
                  </div>
                )}
              </div>

            </div>
          </div>
        )}

        {err && <p className="text-xs font-medium text-red-600">{err}</p>}
        {ed.nothingTransparent && (
          <p className="text-xs font-medium text-[#FA4D8D]">
            Nothing was made transparent. Try raising &ldquo;How much counts as background&rdquo;, or untick it.
          </p>
        )}

        {!ed.loadErr && (
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={!!busy}>Cancel</Button>
            {onUseOriginal && (
              <Button type="button" variant="outline" onClick={() => void uploadOriginal()} disabled={!!busy}>
                {busy === 'original' ? 'Uploading…' : 'Use original'}
              </Button>
            )}
            <Button type="button" onClick={() => void save()} disabled={!ed.ready || !!busy}
              className="bg-[#FA4D8D] text-white hover:opacity-90">
              {busy === 'save' ? 'Uploading…' : 'Save & upload'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
