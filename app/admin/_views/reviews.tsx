'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, C, Skeleton, adminFetch, card, input, peekCache, sgTime } from '../_lib/core';

type ReviewRow = {
  id: string; rating: number; comment: string | null; createdAt: string; reviewer: string;
  response: string | null; respondedAt: string | null;
  activityId: string; activityTitle: string; activitySlug: string | null; vendorKey: string; vendorName: string;
};
type ReviewsData = { rows: ReviewRow[]; vendors: { key: string; name: string }[] };

const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, Math.round(n)))) + '☆'.repeat(5 - Math.max(0, Math.min(5, Math.round(n))));

type Option = { value: string; label: string; hint?: string };

/** A dropdown of checkboxes: empty selection = no filter. */
function MultiSelect({ label, allLabel, options, selected, onChange }: {
  label: string; allLabel: string; options: Option[]; selected: Set<string>; onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const toggle = (v: string) => { const n = new Set(selected); if (n.has(v)) n.delete(v); else n.add(v); onChange(n); };
  const names = options.filter((o) => selected.has(o.value)).map((o) => o.label);
  const summary = selected.size === 0 ? allLabel : names.length <= 1 ? (names[0] ?? `${selected.size} selected`) : `${names.length} selected`;

  return (
    <div ref={box} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" className="bb-select" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}
        style={{ ...input(), textAlign: 'left', font: 'inherit', fontSize: 14, border: `1px solid ${selected.size ? C.blue : C.border}` }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
      </button>
      {open && (
        <div role="listbox" aria-multiselectable style={{ position: 'absolute', zIndex: 30, top: 'calc(100% + 6px)', left: 0, minWidth: '100%', width: 'max-content', maxWidth: 380,
          maxHeight: 300, overflowY: 'auto', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 6, boxShadow: '0 12px 30px rgba(0,0,0,.45)' }}>
          <button type="button" onClick={() => onChange(new Set())} disabled={selected.size === 0}
            style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', color: selected.size ? C.blue : C.muted, font: 'inherit', fontSize: 12, fontWeight: 800, padding: '6px 8px', cursor: selected.size ? 'pointer' : 'default' }}>
            {selected.size ? `Clear (${selected.size})` : allLabel}
          </button>
          {options.length === 0 && <div style={{ color: C.muted, fontSize: 12, padding: '6px 8px' }}>Nothing to choose.</div>}
          {options.map((o) => (
            <label key={o.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 8 }}>
              <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} style={{ marginTop: 2 }} />
              <span>{o.label}{o.hint && <span style={{ color: C.muted, fontSize: 12 }}> · {o.hint}</span>}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Parent reviews, newest first, grouped by activity. Vendor, activity and star
 * filters are all multi-select and apply to the loaded list, so changing one is
 * instant. Empty selection = everything.
 */
export default function ReviewsView() {
  const [data, setData] = useState<ReviewsData | null>(() => peekCache<ReviewsData>('/api/admin/reviews') ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Set<string>>(new Set());
  const [activities, setActivities] = useState<Set<string>>(new Set());
  const [ratings, setRatings] = useState<Set<string>>(new Set());

  useEffect(() => {
    adminFetch<ReviewsData>('/api/admin/reviews').then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // Activities on offer: those of the chosen vendors (all of them when no vendor is chosen).
  const activityOptions = useMemo<Option[]>(() => {
    if (!data) return [];
    const seen = new Map<string, Option & { vendor: string }>();
    for (const r of data.rows) {
      if (vendors.size && !vendors.has(r.vendorKey)) continue;
      if (!seen.has(r.activityId)) seen.set(r.activityId, { value: r.activityId, label: r.activityTitle, hint: r.vendorName, vendor: r.vendorName });
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [data, vendors]);

  // Drop chosen activities that a vendor change has taken out of the list.
  useEffect(() => {
    setActivities((cur) => {
      const ok = new Set(activityOptions.map((o) => o.value));
      const next = new Set([...cur].filter((a) => ok.has(a)));
      return next.size === cur.size ? cur : next;
    });
  }, [activityOptions]);

  const groups = useMemo(() => {
    if (!data) return [];
    const byActivity = new Map<string, { id: string; title: string; slug: string | null; vendor: string; reviews: ReviewRow[] }>();
    for (const r of data.rows) {
      if (vendors.size && !vendors.has(r.vendorKey)) continue;
      if (activities.size && !activities.has(r.activityId)) continue;
      if (ratings.size && !ratings.has(String(Math.round(r.rating)))) continue;
      const g = byActivity.get(r.activityId) ?? { id: r.activityId, title: r.activityTitle, slug: r.activitySlug, vendor: r.vendorName, reviews: [] };
      g.reviews.push(r);
      byActivity.set(r.activityId, g);
    }
    return [...byActivity.values()]
      .map((g) => {
        const reviews = [...g.reviews].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
        return { ...g, reviews, avg: reviews.reduce((s, r) => s + r.rating, 0) / reviews.length, latest: reviews[0].createdAt };
      })
      .sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0)); // activity with the newest review first
  }, [data, vendors, activities, ratings]);

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!data) return <Skeleton />;

  const shown = groups.reduce((n, g) => n + g.reviews.length, 0);
  const overall = shown ? groups.reduce((s, g) => s + g.avg * g.reviews.length, 0) / shown : 0;
  const filtered = vendors.size + activities.size + ratings.size > 0;
  const lab: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 12, color: C.muted, fontWeight: 700 };
  const clearAll = () => { setVendors(new Set()); setActivities(new Set()); setRatings(new Set()); };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontWeight: 900, fontSize: 20, color: C.blue }}>Reviews</h2>
        <span style={{ color: C.muted, fontSize: 13 }}>
          {shown} review{shown === 1 ? '' : 's'} · {groups.length} activit{groups.length === 1 ? 'y' : 'ies'}
          {shown > 0 && <> · average {overall.toFixed(1)} / 5</>}
        </span>
      </div>

      <div style={{ ...card(), marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, alignItems: 'end' }}>
          <div style={lab}>Vendor
            <MultiSelect label="Filter by vendor" allLabel={`All vendors (${data.vendors.length})`} selected={vendors} onChange={setVendors}
              options={data.vendors.map((v) => ({ value: v.key, label: v.name }))} />
          </div>
          <div style={lab}>Activity
            <MultiSelect label="Filter by activity" allLabel={`All activities (${activityOptions.length})`} selected={activities} onChange={setActivities}
              options={activityOptions} />
          </div>
          <div style={lab}>Stars
            <MultiSelect label="Filter by stars" allLabel="All ratings" selected={ratings} onChange={setRatings}
              options={[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${'★'.repeat(n)}${'☆'.repeat(5 - n)}  ${n} star${n === 1 ? '' : 's'}` }))} />
          </div>
          {filtered && (
            <button type="button" onClick={clearAll}
              style={{ background: 'none', border: 'none', color: C.blue, font: 'inherit', fontSize: 13, fontWeight: 800, cursor: 'pointer', padding: '11px 0', textAlign: 'left' }}>Clear filters</button>
          )}
        </div>
      </div>

      {groups.length === 0 && <p style={{ color: C.muted }}>No reviews{filtered ? ' match these filters' : ' yet'}.</p>}

      <div style={{ display: 'grid', gap: 12 }}>
        {groups.map((g) => (
          <section key={g.id} style={card()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <div>
                <span style={{ fontWeight: 900, fontSize: 15 }}>{g.title}</span>
                <span style={{ color: C.muted, fontSize: 13 }}> · {g.vendor}</span>
              </div>
              <div style={{ fontSize: 13 }}>
                <span style={{ color: '#FFD77A', letterSpacing: 1 }}>{stars(g.avg)}</span>{' '}
                <strong>{g.avg.toFixed(1)}</strong> <span style={{ color: C.muted }}>({g.reviews.length})</span>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              {g.reviews.map((r) => (
                <div key={r.id} style={{ borderTop: `1px solid ${C.border}`, padding: '10px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                    <span><span style={{ color: '#FFD77A', letterSpacing: 1 }}>{stars(r.rating)}</span> <strong>{r.reviewer}</strong></span>
                    <span style={{ color: C.muted }}>{sgTime(r.createdAt)}</span>
                  </div>
                  {r.comment
                    ? <p style={{ marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 13 }}>{r.comment}</p>
                    : <p style={{ marginTop: 6, color: C.muted, fontSize: 12 }}>Rating only, no comment.</p>}
                  {r.response && (
                    <div style={{ marginTop: 8, paddingLeft: 10, borderLeft: `3px solid ${C.border}` }}>
                      <div style={{ marginBottom: 2 }}><Badge tone="blue">Vendor replied</Badge> {r.respondedAt && <span style={{ color: C.muted, fontSize: 12 }}>{sgTime(r.respondedAt)}</span>}</div>
                      <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 13 }}>{r.response}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
