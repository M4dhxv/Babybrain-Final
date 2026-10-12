'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, C, Skeleton, adminFetch, card, peekCache, sgTime } from '../_lib/core';
import { MultiSelect, type MultiOption } from '../_lib/multiselect';

type ReviewRow = {
  id: string; rating: number; comment: string | null; createdAt: string; reviewer: string;
  response: string | null; respondedAt: string | null;
  activityId: string; activityTitle: string; activitySlug: string | null; vendorKey: string; vendorName: string;
};
type ReviewsData = { rows: ReviewRow[]; vendors: { key: string; name: string }[] };

const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, Math.round(n)))) + '☆'.repeat(5 - Math.max(0, Math.min(5, Math.round(n))));

/**
 * Parent reviews, newest first, grouped by activity. Vendor, activity and star
 * filters are all multi-select and apply to the loaded list, so changing one is
 * instant. Empty selection = everything.
 */
export default function ReviewsView() {
  const [data, setData] = useState<ReviewsData | null>(() => peekCache<ReviewsData>('/api/admin/reviews') ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [vendors, setVendors] = useState<string[]>([]);
  const [activities, setActivities] = useState<string[]>([]);
  const [ratings, setRatings] = useState<string[]>([]);

  useEffect(() => {
    adminFetch<ReviewsData>('/api/admin/reviews').then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // Activities on offer: those of the chosen vendors (all of them when no vendor is chosen).
  const activityOptions = useMemo<MultiOption[]>(() => {
    if (!data) return [];
    const seen = new Map<string, MultiOption>();
    for (const r of data.rows) {
      if (vendors.length && !vendors.includes(r.vendorKey)) continue;
      if (!seen.has(r.activityId)) seen.set(r.activityId, { id: r.activityId, label: r.activityTitle, sub: r.vendorName });
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [data, vendors]);

  // Drop chosen activities that a vendor change has taken out of the list.
  useEffect(() => {
    setActivities((cur) => {
      const ok = new Set(activityOptions.map((o) => o.id));
      const next = cur.filter((a) => ok.has(a));
      return next.length === cur.length ? cur : next;
    });
  }, [activityOptions]);

  const groups = useMemo(() => {
    if (!data) return [];
    const byActivity = new Map<string, { id: string; title: string; slug: string | null; vendor: string; reviews: ReviewRow[] }>();
    for (const r of data.rows) {
      if (vendors.length && !vendors.includes(r.vendorKey)) continue;
      if (activities.length && !activities.includes(r.activityId)) continue;
      if (ratings.length && !ratings.includes(String(Math.round(r.rating)))) continue;
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
  const filtered = vendors.length + activities.length + ratings.length > 0;
  const clearAll = () => { setVendors([]); setActivities([]); setRatings([]); };

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
          <MultiSelect label="Vendor" placeholder={`All vendors (${data.vendors.length})`} width="fill" selected={vendors} onChange={setVendors}
            options={data.vendors.map((v) => ({ id: v.key, label: v.name }))} />
          <MultiSelect label="Activity" placeholder={`All activities (${activityOptions.length})`} width="fill" selected={activities} onChange={setActivities}
            options={activityOptions} />
          <MultiSelect label="Stars" placeholder="All ratings" width="fill" selected={ratings} onChange={setRatings}
            options={[5, 4, 3, 2, 1].map((n) => ({ id: String(n), label: `${'★'.repeat(n)}${'☆'.repeat(5 - n)}  ${n} star${n === 1 ? '' : 's'}` }))} />
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
