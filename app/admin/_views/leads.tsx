'use client';

import { useEffect, useState } from 'react';
import { Badge, C, Skeleton, adminFetch, card, peekCache, primaryBtn, sgTime, supabase, td, th, toast } from '../_lib/core';

type LeadRow = { id: string; email: string; source: string; childAgeMonths: number | null; createdAt: string; isParent: boolean; duplicate: boolean };
type LeadsData = { rows: LeadRow[]; total: number; unique: number; alreadyParents: number; bySource: Record<string, number> };

const SOURCE_LABEL: Record<string, string> = {
  'explore-popup': 'Explore pop-up',
  'home-landing': 'Home page',
};

/**
 * Email leads: people who left an email without creating an account, from the
 * Explore pop-up and the home page. Read through /api/admin/leads because the
 * table is closed to every client role.
 */
export default function LeadsView() {
  const [data, setData] = useState<LeadsData | null>(() => peekCache<LeadsData>('/api/admin/leads') ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [hideDupes, setHideDupes] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminFetch<LeadsData>('/api/admin/leads').then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function downloadCsv() {
    setBusy(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      const res = await fetch('/api/admin/leads?format=csv', { headers: { Authorization: `Bearer ${s.session?.access_token ?? ''}` } });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'babybrain-leads.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  }

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!data) return <Skeleton />;

  const rows = hideDupes ? data.rows.filter((r) => !r.duplicate) : data.rows;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontWeight: 900, fontSize: 20 }}>Leads</h2>
        <span style={{ color: C.muted, fontSize: 13 }}>
          {data.unique} unique email{data.unique === 1 ? '' : 's'} · {data.total} submission{data.total === 1 ? '' : 's'}
          {data.alreadyParents > 0 && <> · {data.alreadyParents} already signed up</>}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={primaryBtn()} disabled={busy || data.total === 0} onClick={downloadCsv}>{busy ? 'Preparing…' : 'Download CSV'}</button>
      </div>

      <div style={{ ...card(), marginBottom: 12, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        {Object.entries(data.bySource).map(([s, n]) => (
          <span key={s} style={{ fontSize: 13 }}><strong>{n}</strong> <span style={{ color: C.muted }}>{SOURCE_LABEL[s] ?? s}</span></span>
        ))}
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 13, color: C.muted, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={hideDupes} onChange={(e) => setHideDupes(e.target.checked)} /> Hide repeat submissions
        </label>
      </div>

      <p style={{ color: C.muted, fontSize: 12, marginBottom: 10, lineHeight: 1.6 }}>
        Leads have not ticked a marketing-consent box, so check this before importing them anywhere.
      </p>

      {rows.length === 0 ? <p style={{ color: C.muted }}>No leads yet.</p> : (
        <div style={{ ...card(), padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ color: C.muted, textAlign: 'left' }}>
              <th style={th()}>Email</th><th style={th()}>Source</th><th style={th()}>Status</th><th style={th()}>Captured</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ ...td(), wordBreak: 'break-all' }}>{r.email}{r.duplicate && <span style={{ color: C.muted }}> · repeat</span>}</td>
                  <td style={td()}>{SOURCE_LABEL[r.source] ?? r.source}</td>
                  <td style={td()}>{r.isParent ? <Badge tone="green">Signed up</Badge> : <Badge tone="grey">Lead only</Badge>}</td>
                  <td style={{ ...td(), whiteSpace: 'nowrap' }}>{sgTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
