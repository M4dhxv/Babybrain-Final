'use client';

import { useEffect, useState } from 'react';
import { C, primaryBtn, tabBtn } from '../_lib/core';
import { formatBytes } from '../_lib/imageEdit';
import {
  BACKDROPS, SHAPES, backgroundHint, fromHex, heroShowsWhole, toHex, usePhotoEditor, type PhotoKind,
} from '../_lib/usePhotoEditor';

export type { PhotoKind };

/**
 * Pop-up photo editor shown before an image is uploaded (admin styling; the logic is
 * in usePhotoEditor, shared with the vendor-portal dialog).
 *
 * Everything happens in the browser on a canvas: rotate/flip, crop to a shape, brightness
 * / contrast / saturation, optionally make a flat background transparent, trim the margin,
 * and resize + compress. The preview is the real result, and "Upload original" always
 * sends the untouched file, so a bad cut-out is never forced on anyone.
 *
 * `kind` only changes the starting point: a logo on a plain white background starts with
 * the background removed and the margin trimmed; a photo starts untouched.
 */
/**
 * What a parent actually sees, drawn with the parent app's own rules (see heroShowsWhole):
 * the Explore card thumbnail, the activity-page hero on a computer, and the same hero on a phone.
 * Frames are the real sizes scaled down (hero 860 x 305; phone about 360 wide).
 */
function ParentView({ url, ratio, kind, bg, real }: {
  url: string | null; ratio: number; kind: PhotoKind;
  /** Background chosen under "Preview on"; the frames follow it so what you test is what you see. */
  bg: React.CSSProperties;
  /** True when that background is the parent app's real card tint. */
  real: boolean;
}) {
  const whole = heroShowsWhole(kind, ratio);
  const cap: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: C.muted, margin: '0 0 6px' };
  // aspect = the real frame: hero 860 x 305 on a computer, about 360 x 305 on a phone.
  const hero = (maxW: number, aspect: string) => (
    <div style={{ position: 'relative', width: '100%', maxWidth: maxW, aspectRatio: aspect, overflow: 'hidden', ...bg, borderRadius: 14,
      border: `1px solid ${C.border}` }}>
      {whole && url && (
        <img src={url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
          transform: 'scale(1.25)', opacity: 0.5, filter: 'blur(16px)' }} />
      )}
      {url && (
        <img src={url} alt="" style={{ position: 'relative', width: '100%', height: '100%',
          objectFit: whole ? 'contain' : 'cover', objectPosition: whole ? 'center' : 'center 15%' }} />
      )}
    </div>
  );
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
      {!url ? <div style={{ color: C.muted, padding: 30, textAlign: 'center' }}>Preparing the preview…</div> : (
        <>
          <p style={cap}>Explore card</p>
          <div style={{ width: '100%', maxWidth: 300, aspectRatio: '300 / 108', ...bg, borderRadius: 14, overflow: 'hidden', marginBottom: 14,
            border: `1px solid ${C.border}` }}>
            <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain',
              padding: kind === 'logo' ? 16 : 0, boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: '2.35 1 0', minWidth: 0 }}>
              <p style={cap}>Activity page · computer</p>
              {hero(520, '860 / 305')}
            </div>
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
              <p style={cap}>· phone</p>
              {hero(220, '360 / 305')}
            </div>
          </div>
          <p style={{ color: C.muted, fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            {whole
              ? 'Shown whole, never cropped, on a soft tint. On the activity page the empty sides pick up a blurred copy of the picture.'
              : 'Fills the activity-page frame and keeps the top of the picture in view, so the bottom edge may be trimmed. On Explore cards it is always shown whole.'}
          </p>
          {!real && (
            <p style={{ color: C.pink, fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              These frames follow the &ldquo;Preview on&rdquo; background you picked. Parents see the pale card tint, so choose Card tint to match exactly.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function PhotoEditor({
  source, kind, heading, queueLabel, onCancel, onSave, onUseOriginal,
}: {
  /** A file the admin just picked, or the URL of an image that is already stored. */
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

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

  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: C.muted, display: 'block', marginBottom: 5 };
  const sect: React.CSSProperties = { borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 14 };
  const slider = (
    label: string, value: number, min: number, max: number, step: number, on: (v: number) => void, suffix = ''
  ) => (
    <label style={{ display: 'block', marginBottom: 8 }}>
      <span style={{ ...lbl, display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span><span style={{ fontWeight: 600 }}>{value}{suffix}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => on(Number(e.target.value))}
        style={{ width: '100%', accentColor: C.blue }} />
    </label>
  );

  const { aspect } = ed;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10100, background: 'rgba(0,0,0,.72)', overflow: 'auto', padding: 20 }}>
      <div role="dialog" aria-modal="true" aria-label="Edit photo"
        style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, maxWidth: 980, margin: '0 auto', padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 17 }}>
              {heading ?? (kind === 'logo' ? 'Edit logo' : 'Edit photo')}
              {queueLabel && <span style={{ color: C.muted, fontWeight: 600, fontSize: 13 }}> · {queueLabel}</span>}
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>
              {kind === 'logo'
                ? 'Logos are never cropped on the parent app, so keep the whole mark. Remove the background only if the preview looks right.'
                : 'Crop, adjust and resize before it goes live. Use the original if you would rather not change it.'}
            </div>
          </div>
          <button type="button" onClick={onCancel} disabled={!!busy} style={tabBtn(false)}>Cancel</button>
        </div>

        {ed.loadErr ? (
          <div style={{ color: C.pink, padding: '20px 0' }}>
            {ed.loadErr}
            {onUseOriginal && <div style={{ marginTop: 12 }}>
              <button type="button" style={primaryBtn()} onClick={uploadOriginal} disabled={!!busy}>
                {busy === 'original' ? 'Uploading…' : 'Upload the original instead'}
              </button>
            </div>}
          </div>
        ) : !ed.ready ? (
          <div style={{ color: C.muted, padding: '40px 0', textAlign: 'center' }}>Opening image…</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 18, alignItems: 'start' }}>
            {/* ---- preview ---- */}
            <div>
              <div>
              <div style={{
                ...BACKDROPS.find((b) => b.key === backdrop)!.css,
                borderRadius: 12, border: `1px solid ${C.border}`, minHeight: 320,
                display: 'grid', placeItems: 'center', padding: 14,
              }}>
                <div {...ed.pan}
                  style={{ position: 'relative', display: 'inline-block', lineHeight: 0, touchAction: 'none',
                    cursor: aspect ? (ed.dragging ? 'grabbing' : 'grab') : 'default' }}>
                  <canvas ref={previewRef}
                    style={{ maxWidth: '100%', maxHeight: 460, width: 'auto', height: 'auto', display: 'block' }} />
                  {ed.phoneShare !== null && ed.phoneShare < 1 && (
                    <div style={{
                      pointerEvents: 'none', position: 'absolute', top: 0, bottom: 0,
                      left: `${((1 - ed.phoneShare) / 2) * 100}%`, width: `${ed.phoneShare * 100}%`,
                      borderLeft: '2px dashed #FA4D8D', borderRight: '2px dashed #FA4D8D',
                    }}>
                      <span style={{ position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)',
                        background: '#FA4D8D', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: 1.4,
                        padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>Phone view</span>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                <span style={{ ...lbl, margin: 0 }}>Preview on</span>
                {BACKDROPS.map((b) => (
                  <button key={b.key} type="button" onClick={() => setBackdrop(b.key)}
                    style={{ ...tabBtn(backdrop === b.key), padding: '4px 10px', fontSize: 12 }}>{b.label}</button>
                ))}
              </div>
              </div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>
                {ed.outInfo
                  ? <>Result: {ed.outInfo.w} × {ed.outInfo.h} px · {formatBytes(ed.outInfo.bytes)} · {ed.outInfo.type.replace('image/', '').toUpperCase()}</>
                  : 'Working out the result size…'}
                {aspect ? ' · Drag the picture to reposition it.' : ''}
              </div>
              {/* Live: updates as you edit, so there's no need to switch tabs to check. */}
              <div style={{ marginTop: 14 }}>
                <div style={{ ...lbl, marginBottom: 8 }}>How parents will see it <span style={{ fontWeight: 600 }}>· updates as you edit</span></div>
                {ed.previewDims && <ParentView url={ed.previewUrl} ratio={ed.previewDims.w / ed.previewDims.h} kind={kind}
                  bg={BACKDROPS.find((b) => b.key === backdrop)!.css} real={backdrop === 'tint'} />}
              </div>
            </div>

            {/* ---- controls ---- */}
            <div>
              <div>
                <span style={lbl}>Rotate &amp; flip</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" style={tabBtn(false)} onClick={() => ed.rotate(-90)} aria-label="Rotate left">↺ Left</button>
                  <button type="button" style={tabBtn(false)} onClick={() => ed.rotate(90)} aria-label="Rotate right">↻ Right</button>
                  <button type="button" style={tabBtn(ed.flipH)} onClick={ed.flip}>⇋ Flip</button>
                </div>
              </div>

              <div style={sect}>
                <span style={lbl}>Crop shape</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {SHAPES.map((s) => (
                    <button key={s.key} type="button" onClick={() => ed.setShape(s.key)}
                      style={{ ...tabBtn(ed.shape === s.key), padding: '5px 10px', fontSize: 12 }}>{s.label}</button>
                  ))}
                </div>
                {aspect && slider('Zoom', Math.round(ed.zoom * 100) / 100, 1, 4, 0.05, ed.setZoom, '×')}
                {kind === 'logo' && aspect && (
                  <div style={{ color: C.pink, fontSize: 12, marginTop: 6 }}>
                    Heads up: a cropped logo loses part of the mark. Use Original unless you mean it.
                  </div>
                )}
              </div>

              <div style={sect}>
                <span style={lbl}>Background</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700 }}>
                  <input type="checkbox" checked={ed.removeBg} disabled={ed.analysis?.borderTransparent}
                    onChange={(e) => ed.setRemoveBg(e.target.checked)} />
                  Make the background transparent
                </label>
                <div style={{ color: C.muted, fontSize: 12, margin: '6px 0 8px' }}>
                  {backgroundHint(ed.analysis)}{' '}
                  {kind === 'photo' && 'Only suits graphics on a plain background, not real photos.'}
                </div>
                {ed.removeBg && (
                  <>
                    {slider('How much counts as background', ed.tolerance, 0, 100, 1, ed.setTolerance, '%')}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <input type="color" value={toHex(ed.sampleColour)} aria-label="Background colour"
                        onChange={(e) => ed.setBgOverride(fromHex(e.target.value))}
                        style={{ width: 38, height: 30, padding: 0, border: `1px solid ${C.border}`, background: 'none', borderRadius: 6 }} />
                      <span style={{ color: C.muted, fontSize: 12 }}>
                        Colour removed {ed.bgOverride ? '(chosen)' : '(detected)'}
                      </span>
                      {ed.bgOverride && (
                        <button type="button" style={{ ...tabBtn(false), padding: '3px 9px', fontSize: 12 }}
                          onClick={() => ed.setBgOverride(null)}>Auto</button>
                      )}
                    </div>
                  </>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, opacity: aspect ? 0.5 : 1 }}>
                  <input type="checkbox" checked={ed.trim && !aspect} disabled={!!aspect} onChange={(e) => ed.setTrim(e.target.checked)} />
                  Trim empty margin
                </label>
                {aspect && <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Not used while a crop shape is chosen.</div>}
                {ed.trim && !aspect && slider('Space kept around it', Math.round(ed.padding * 100), 0, 20, 1, (v) => ed.setPadding(v / 100), '%')}
              </div>

            </div>
          </div>
        )}

        {err && <div style={{ color: C.pink, fontSize: 13, marginTop: 12 }}>{err}</div>}

        {!ed.loadErr && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 16,
            paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            <button type="button" onClick={save} disabled={!ed.ready || !!busy}
              style={{ ...primaryBtn(), opacity: !ed.ready || busy ? 0.55 : 1 }}>
              {busy === 'save' ? 'Uploading…' : 'Save & upload'}
            </button>
            {onUseOriginal && (
              <button type="button" onClick={uploadOriginal} disabled={!!busy} style={tabBtn(false)}>
                {busy === 'original' ? 'Uploading…' : 'Upload original unchanged'}
              </button>
            )}
            <button type="button" onClick={onCancel} disabled={!!busy} style={tabBtn(false)}>Cancel</button>
            {ed.nothingTransparent && (
              <span style={{ color: C.pink, fontSize: 12 }}>
                Nothing was made transparent. Try raising &ldquo;How much counts as background&rdquo;.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
