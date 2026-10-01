'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { C, adminFetch } from './core';

type Hit =
  | { kind: 'tab'; id: string; label: string }
  | { kind: 'parent'; id: string; label: string; sub: string; email: string }
  | { kind: 'vendor'; id: string; label: string; sub: string };

/**
 * Ctrl/Cmd+K quick search: jump to a tab, a parent or a vendor. Tabs match instantly; parents and
 * vendors come from /api/admin/search once two characters are typed.
 */
export function CommandPalette({ open, onClose, tabs, onTab, onParent, onVendor }: {
  open: boolean; onClose: () => void;
  tabs: { id: string; label: string }[];
  onTab: (id: string) => void; onParent: (id: string, email: string) => void; onVendor: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(''); setRemote([]); setCursor(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < 2) { setRemote([]); return; }
    let stale = false;
    setBusy(true);
    const t = setTimeout(() => {
      adminFetch<{ parents: { id: string; name: string; email: string; phone: string | null }[]; vendors: { id: string; name: string; status: string }[] }>(
        `/api/admin/search?q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (stale) return;
          setRemote([
            ...r.parents.map((p): Hit => ({ kind: 'parent', id: p.id, label: p.name, email: p.email, sub: [p.email, p.phone].filter(Boolean).join(' · ') })),
            ...r.vendors.map((v): Hit => ({ kind: 'vendor', id: v.id, label: v.name, sub: `Vendor · ${v.status}` })),
          ]);
        })
        .catch(() => { if (!stale) setRemote([]); })
        .finally(() => { if (!stale) setBusy(false); });
    }, 200);
    return () => { stale = true; clearTimeout(t); };
  }, [q, open]);

  const hits: Hit[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const tabHits: Hit[] = tabs.filter((t) => !term || t.label.toLowerCase().includes(term)).map((t) => ({ kind: 'tab', id: t.id, label: t.label }));
    return [...tabHits, ...remote];
  }, [q, tabs, remote]);

  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, hits.length - 1))); }, [hits.length]);

  if (!open) return null;
  const choose = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    if (h.kind === 'tab') onTab(h.id);
    else if (h.kind === 'parent') onParent(h.id, h.email);
    else onVendor(h.id);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Quick search" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(5,9,18,.65)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '12vh 16px 16px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 100%)', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 18px 50px rgba(0,0,0,.5)' }}>
        <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setCursor(0); }}
          placeholder="Search a parent, vendor or jump to a tab…" aria-label="Search"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(hits.length - 1, c + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(hits[cursor]); }
            else if (e.key === 'Escape') onClose();
          }}
          style={{ width: '100%', padding: '14px 16px', background: 'transparent', border: 'none', borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 15, outline: 'none', boxSizing: 'border-box' }} />
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {hits.map((h, i) => (
            <button key={`${h.kind}-${h.id}`} type="button" onClick={() => choose(h)} onMouseEnter={() => setCursor(i)}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, textAlign: 'left', padding: '10px 16px', border: 'none', cursor: 'pointer',
                background: i === cursor ? C.panel2 : 'transparent', color: C.text, font: 'inherit' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, width: 52, textTransform: 'uppercase', flex: 'none' }}>{h.kind === 'tab' ? 'Go to' : h.kind}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 700 }}>{h.label}</span>
                {h.kind !== 'tab' && <span style={{ display: 'block', color: C.muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.sub}</span>}
              </span>
            </button>
          ))}
          {hits.length === 0 && <div style={{ padding: '18px 16px', color: C.muted, fontSize: 13 }}>{busy ? 'Searching…' : 'No matches.'}</div>}
        </div>
        <div style={{ padding: '8px 16px', color: C.muted, fontSize: 11, borderTop: `1px solid ${C.border}` }}>Up/Down to move · Enter to open · Esc to close{busy && hits.length > 0 ? ' · searching…' : ''}</div>
      </div>
    </div>
  );
}
