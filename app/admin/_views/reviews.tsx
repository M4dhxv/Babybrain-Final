'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, C, Skeleton, adminFetch, card, input, peekCache, sgTime } from '../_lib/core';

type ReviewRow = {
  id: string; rating: number; comment: string | null; createdAt: string; reviewer: string;
  response: string | null; respondedAt: string | null;
  activityId: string; activityTitle: string; activitySlug: string | null; vendorKey: string; vendorName: string;
};
type ReviewsData = { rows: ReviewRow[]; vendors: { key: string; name: string }[] };

const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, Math.round(n)))) + '☆'.repeat(5 - Math.max(0, Math.min(5, Math.round(n))));

/**
 * Parent reviews, filtered by vendor and grouped by activity. The vendor filter
 * is applied here on the loaded list, so changing it is instant.
 */
export default function ReviewsView() {
  const [data, setData] = useState<ReviewsData | null>(() => peekCache<ReviewsData>('/api/admin/reviews') ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [vendor, setVendor] = useState('');

  useEffect(() => {
    adminFetch<ReviewsData>('/api/admin/reviews').then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const groups = useMemo(() => {
    if (!data) return [];
    const byActivity = new Map<string, { id: string; title: string; slug: string | null; vendor: string; reviews: ReviewRow[] }>();
    for (const r of data.rows) {
      if (vendor && r.vendorKey !== vendor) continue;
      const g = byActivity.get(r.activityId) ?? { id: r.activityId, title: r.activityTitle, slug: r.activitySlug, vendor: r.vendorName, reviews: [] };
      g.reviews.push(r);
      byActivity.set(r.activityId, g);
    }
    return [...byActivity.values()]
      .map((g) => ({ ...g, avg: g.reviews.reduce((s, r) => s + r.rating, 0) / g.reviews.length, latest: g.reviews[0].createdAt }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor) || (a.latest < b.latest ? 1 : -1));
  }, [data, vendor]);

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!data) return <Skeleton />;

  const shown = groups.reduce((n, g) => n + g.reviews.length, 0);
  const overall = shown ? groups.reduce((s, g) => s + g.avg * g.reviews.length, 0) / shown : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontWeight: 900, fontSize: 20 }}>Reviews</h2>
        <span style={{ color: C.muted, fontSize: 13 }}>
          {shown} review{shown === 1 ? '' : 's'} · {groups.length} activit{groups.length === 1 ? 'y' : 'ies'}
          {shown > 0 && <> · average {overall.toFixed(1)} / 5</>}
        </span>
        <span style={{ flex: 1 }} />
        <select aria-label="Filter by vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} style={{ ...input(), width: 'auto', minWidth: 220 }}>
          <option value="">All vendors ({data.vendors.length})</option>
          {data.vendors.map((v) => <option key={v.key} value={v.key}>{v.name}</option>)}
        </select>
      </div>

      {groups.length === 0 && <p style={{ color: C.muted }}>No reviews{vendor ? ' for this vendor' : ' yet'}.</p>}

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
