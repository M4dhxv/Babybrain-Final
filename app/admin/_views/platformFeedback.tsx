'use client';

import { useEffect, useState } from 'react';
import { C, Skeleton, adminFetch, card, peekCache, sgTime } from '../_lib/core';

type FeedbackRow = {
  id: string; rating: number; comment: string | null; createdAt: string; updatedAt: string;
  name: string | null; email: string | null;
};
type FeedbackData = { rows: FeedbackRow[]; missing: boolean };

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
/** Rows shown before "Show all". */
const PREVIEW = 5;

/**
 * Top of /admin → Reviews: what parents think of BabyBrain itself (the
 * "Rate BabyBrain" button on their profile Overview, migration 00253). Average, how the
 * stars split, and every comment, newest first. Activity reviews are below it,
 * unchanged.
 */
export function PlatformFeedback() {
  const [data, setData] = useState<FeedbackData | null>(() => peekCache<FeedbackData>('/api/admin/platform-feedback') ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    adminFetch<FeedbackData>('/api/admin/platform-feedback').then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const box: React.CSSProperties = { ...card(), marginBottom: 18 };
  const head = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
      <h3 style={{ fontWeight: 900, fontSize: 16 }}>BabyBrain feedback</h3>
      <span style={{ color: C.muted, fontSize: 13 }}>Parents rating the platform itself, from "Rate BabyBrain" on their profile</span>
    </div>
  );

  if (err) return <div style={box}>{head}<p style={{ color: C.pink, marginTop: 8 }}>{err}</p></div>;
  if (!data) return <div style={box}>{head}<div style={{ marginTop: 10 }}><Skeleton rows={2} /></div></div>;
  if (data.missing) {
    return (
      <div style={box}>
        {head}
        <p style={{ color: C.muted, fontSize: 13, marginTop: 8 }}>Starts collecting once migration 00253 (platform_feedback) is applied.</p>
      </div>
    );
  }

  const n = data.rows.length;
  const avg = n ? data.rows.reduce((s, r) => s + r.rating, 0) / n : 0;
  const split = [5, 4, 3, 2, 1].map((s) => ({ s, count: data.rows.filter((r) => r.rating === s).length }));
  const shown = all ? data.rows : data.rows.slice(0, PREVIEW);

  return (
    <div style={box}>
      {head}
      {n === 0 ? (
        <p style={{ color: C.muted, fontSize: 13, marginTop: 8 }}>No ratings yet.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 32, fontWeight: 900, lineHeight: 1 }}>{avg.toFixed(1)}</div>
              <div style={{ color: '#FFD77A', letterSpacing: 1, marginTop: 4 }}>{stars(Math.round(avg))}</div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{n} rating{n === 1 ? '' : 's'}</div>
            </div>
            <div style={{ display: 'grid', gap: 4, minWidth: 220, flex: '1 1 220px', maxWidth: 360 }}>
              {split.map(({ s, count }) => (
                <div key={s} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 32px', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ color: C.muted }}>{s} ★</span>
                  <span style={{ height: 8, borderRadius: 4, background: C.panel2, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${(count / n) * 100}%`, background: '#FFD77A' }} />
                  </span>
                  <span style={{ color: C.muted, textAlign: 'right' }}>{count}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            {shown.map((r) => (
              <div key={r.id} style={{ borderTop: `1px solid ${C.border}`, padding: '10px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                  <span>
                    <span style={{ color: '#FFD77A', letterSpacing: 1 }}>{stars(r.rating)}</span>{' '}
                    <strong>{r.name ?? 'A parent'}</strong>
                    {r.email && <span style={{ color: C.muted }}> · {r.email}</span>}
                  </span>
                  <span style={{ color: C.muted }}>
                    {sgTime(r.updatedAt)}{r.updatedAt.slice(0, 16) !== r.createdAt.slice(0, 16) ? ' (edited)' : ''}
                  </span>
                </div>
                {r.comment
                  ? <p style={{ marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 13 }}>{r.comment}</p>
                  : <p style={{ marginTop: 6, color: C.muted, fontSize: 12 }}>Rating only, no comment.</p>}
              </div>
            ))}
          </div>
          {n > PREVIEW && (
            <button type="button" onClick={() => setAll((v) => !v)}
              style={{ background: 'none', border: 'none', color: C.blue, font: 'inherit', fontSize: 13, fontWeight: 800, cursor: 'pointer', padding: '6px 0 0' }}>
              {all ? 'Show fewer' : `Show all ${n}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
