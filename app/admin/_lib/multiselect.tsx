'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { C, input } from './core';

export type MultiOption = { id: string; label: string; sub?: string };

/**
 * A dropdown that lets you tick several options, with a search box. The button shows how many are
 * chosen. Closes on a click outside or Esc.
 */
export function MultiSelect({ label, placeholder, options, selected, onChange, width = 200 }: {
  label: string; placeholder: string; options: MultiOption[]; selected: string[]; onChange: (ids: string[]) => void; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const chosen = useMemo(() => new Set(selected), [selected]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(needle)) : options;
  }, [options, q]);
  const names = options.filter((o) => chosen.has(o.id)).map((o) => o.label);
  const summary = selected.length === 0 ? placeholder : selected.length === 1 ? (names[0] ?? '1 selected') : `${selected.length} selected`;

  return (
    <div ref={box} style={{ position: 'relative', width, display: 'grid', gap: 4, fontSize: 12, color: C.muted, fontWeight: 700 }}>
      {label}
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ ...input(), textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
          color: selected.length ? C.text : C.muted, borderColor: selected.length ? C.blue : undefined }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <span aria-hidden style={{ color: C.muted, fontSize: 11 }}>▾</span>
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true"
          style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: Math.max(width, 280), zIndex: 40, background: C.panel, border: `1px solid ${C.border}`,
            borderRadius: 12, boxShadow: '0 12px 30px rgba(0,0,0,.45)', overflow: 'hidden' }}>
          <div style={{ padding: 8, borderBottom: `1px solid ${C.border}` }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label={`Search ${label}`} style={{ ...input(), padding: '7px 10px' }} />
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {shown.map((o) => (
              <label key={o.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 12px', cursor: 'pointer', color: C.text, fontWeight: 600, fontSize: 13,
                background: chosen.has(o.id) ? 'rgba(74,144,255,.10)' : 'transparent' }}>
                <input type="checkbox" checked={chosen.has(o.id)} style={{ width: 15, height: 15, margin: '2px 0 0' }}
                  onChange={() => onChange(chosen.has(o.id) ? selected.filter((x) => x !== o.id) : [...selected, o.id])} />
                <span style={{ minWidth: 0 }}>
                  {o.label}
                  {o.sub && <span style={{ display: 'block', color: C.muted, fontSize: 11, fontWeight: 600 }}>{o.sub}</span>}
                </span>
              </label>
            ))}
            {shown.length === 0 && <div style={{ padding: '12px', color: C.muted, fontSize: 13 }}>No matches.</div>}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderTop: `1px solid ${C.border}` }}>
            <button type="button" onClick={() => onChange([])} disabled={selected.length === 0}
              style={{ background: 'none', border: 'none', color: selected.length ? C.blue : C.muted, fontWeight: 800, cursor: selected.length ? 'pointer' : 'default', fontSize: 12 }}>Clear</button>
            <button type="button" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: C.blue, fontWeight: 800, cursor: 'pointer', fontSize: 12 }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
