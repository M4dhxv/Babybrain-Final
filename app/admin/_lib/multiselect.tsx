'use client';

import { Children, isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import { C, input } from './core';

export type MultiOption = { id: string; label: string; sub?: string };

/**
 * A dropdown that lets you tick several options, with a search box. The button shows how many are
 * chosen. Closes on a click outside or Esc.
 */
export function MultiSelect({ label, placeholder, options, selected, onChange, width = 200 }: {
  label: string; placeholder: string; options: MultiOption[]; selected: string[]; onChange: (ids: string[]) => void;
  /** A fixed width in px, or 'fill' to take the width of the grid cell it sits in (use inside filter grids). */
  width?: number | 'fill';
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
    <div ref={box} style={{ position: 'relative', width: width === 'fill' ? '100%' : width, minWidth: 0, display: 'grid', gap: 4, fontSize: 12, color: C.muted, fontWeight: 700 }}>
      {label}
      <button type="button" className="bb-select" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ ...input(), textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14,
          color: selected.length ? C.text : C.muted, borderColor: selected.length ? C.blue : undefined }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true"
          style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, ...(width === 'fill' ? { minWidth: 260, width: '100%' } : { width: Math.max(width, 280) }), zIndex: 40, background: C.panel, border: `1px solid ${C.border}`,
            borderRadius: 12, boxShadow: '0 12px 30px rgba(0,0,0,.45)', overflow: 'hidden' }}>
          <div style={{ padding: 8, borderBottom: `1px solid ${C.border}` }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label={`Search ${label}`} style={{ ...input(), padding: '7px 10px' }} />
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {shown.map((o) => {
              const on = chosen.has(o.id);
              return (
                <button key={o.id} type="button" role="option" aria-selected={on}
                  onClick={() => onChange(on ? selected.filter((x) => x !== o.id) : [...selected, o.id])}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', padding: '9px 12px',
                    border: 'none', cursor: 'pointer', font: 'inherit', color: C.text, fontWeight: 600, fontSize: 13,
                    background: on ? 'rgba(125,180,255,.10)' : 'transparent' }}>
                  <span style={{ minWidth: 0 }}>
                    {o.label}
                    {o.sub && <span style={{ display: 'block', color: C.muted, fontSize: 11, fontWeight: 600 }}>{o.sub}</span>}
                  </span>
                  {/* a light-blue tick on the right when chosen; nothing when not */}
                  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7db4ff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                    style={{ flex: 'none', visibility: on ? 'visible' : 'hidden' }}>
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </button>
              );
            })}
            {shown.length === 0 && <div style={{ padding: '12px', color: C.muted, fontSize: 13 }}>No matches.</div>}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderTop: `1px solid ${C.border}` }}>
            <span style={{ display: 'flex', gap: 14 }}>
              <button type="button" onClick={() => onChange([])} disabled={selected.length === 0}
                style={{ background: 'none', border: 'none', color: selected.length ? C.blue : C.muted, fontWeight: 800, cursor: selected.length ? 'pointer' : 'default', fontSize: 12 }}>Clear</button>
              {/* selects everything currently listed, so with a search typed it selects just the matches */}
              <button type="button" onClick={() => onChange([...new Set([...selected, ...shown.map((o) => o.id)])])} disabled={shown.length === 0 || shown.every((o) => chosen.has(o.id))}
                style={{ background: 'none', border: 'none', color: shown.length === 0 || shown.every((o) => chosen.has(o.id)) ? C.muted : C.blue, fontWeight: 800,
                  cursor: shown.length === 0 || shown.every((o) => chosen.has(o.id)) ? 'default' : 'pointer', fontSize: 12 }}>Select all</button>
            </span>
            <button type="button" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: C.blue, fontWeight: 800, cursor: 'pointer', fontSize: 12 }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The single-select twin of MultiSelect: a drop-in for a native select (same value, onChange(e.target.value),
 * disabled, style and option children) that opens the same panel: rounded, light-blue row for the chosen
 * option with a tick on the right. A search box appears once the list is long enough to need one.
 */
export function Select({ value, onChange, disabled, style, children, 'aria-label': ariaLabel }: {
  value: string | number | undefined | null;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const opts = Children.toArray(children).flatMap((c) => {
    if (!isValidElement(c)) return [];
    const p = c.props as { value?: string | number; children?: React.ReactNode; disabled?: boolean };
    const label = Children.toArray(p.children).map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('');
    return [{ value: String(p.value ?? label), label, disabled: !!p.disabled }];
  });
  const current = opts.find((o) => o.value === String(value ?? '')) ?? opts[0];
  const searchable = opts.length >= 7;
  const needle = q.trim().toLowerCase();
  const shown = needle ? opts.filter((o) => o.label.toLowerCase().includes(needle)) : opts;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const close = () => { setOpen(false); setQ(''); setActive(-1); };
  const choose = (v: string) => {
    close();
    if (v !== String(value ?? '')) onChange?.({ target: { value: v }, currentTarget: { value: v } } as unknown as React.ChangeEvent<HTMLSelectElement>);
  };
  const step = (dir: 1 | -1) => {
    const n = shown.length;
    if (!n) return;
    let i = active < 0 ? Math.max(0, shown.findIndex((o) => o === current)) : active;
    for (let k = 0; k < n; k++) { i = (i + dir + n) % n; if (!shown[i].disabled) break; }
    setActive(i);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (!open) setOpen(true); step(-1); }
    else if (e.key === 'Enter' && open && active >= 0 && shown[active]) { e.preventDefault(); choose(shown[active].value); }
  };
  const { width, marginTop, ...boxStyle } = style ?? {};

  return (
    <div ref={box} style={{ position: 'relative', width: width ?? '100%', marginTop, minWidth: 0 }}>
      <button type="button" className="bb-select" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => { if (open) close(); else setOpen(true); }} onKeyDown={onKey}
        style={{ ...input(), ...boxStyle, width: '100%', textAlign: 'left', fontFamily: 'inherit', fontSize: boxStyle.fontSize ?? 14,
          opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current?.label ?? ''}</span>
      </button>
      {open && (
        <div role="listbox"
          style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: '100%', width: 'max-content', maxWidth: 380, zIndex: 40,
            background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: '0 12px 30px rgba(0,0,0,.45)', overflow: 'hidden' }}>
          {searchable && (
            <div style={{ padding: 8, borderBottom: `1px solid ${C.border}` }}>
              <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(-1); }} onKeyDown={onKey} placeholder="Search…" aria-label="Search options"
                style={{ ...input(), padding: '7px 10px' }} />
            </div>
          )}
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {shown.map((o, i) => {
              const on = o.value === current?.value;
              return (
                <button key={o.value + i} type="button" role="option" aria-selected={on} disabled={o.disabled}
                  onMouseEnter={() => setActive(i)} onClick={() => choose(o.value)}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', padding: '9px 12px',
                    border: 'none', cursor: o.disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', color: o.disabled ? C.muted : C.text, fontWeight: 600, fontSize: 13,
                    background: on ? 'rgba(125,180,255,.10)' : active === i ? C.panel2 : 'transparent' }}>
                  <span style={{ minWidth: 0 }}>{o.label}</span>
                  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7db4ff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                    style={{ flex: 'none', visibility: on ? 'visible' : 'hidden' }}>
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </button>
              );
            })}
            {shown.length === 0 && <div style={{ padding: '12px', color: C.muted, fontSize: 13 }}>No matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
