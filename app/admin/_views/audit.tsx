'use client';

import { useEffect, useMemo, useState } from 'react';
import { C, Skeleton, adminFetch, card, input, peekCache } from '../_lib/core';
import { type Col, EmptyState, SortTh, TableFooter, downloadCsv, useTable } from '../_lib/table';

// ---- Audit log: who changed what in the admin ----

type AuditRow = {
  id: number; at: string; actor_email: string; actor_role: string | null; action: string;
  entity_type: string | null; entity_id: string | null; summary: string; details: Record<string, unknown> | null;
};
type AuditData = { rows: AuditRow[]; missing: boolean };

const when = (iso: string) => new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' });

export default function AuditView() {
  const [data, setData] = useState<AuditData | null>(() => peekCache<AuditData>('/api/admin/audit?limit=300') ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    adminFetch<AuditData>('/api/admin/audit?limit=300').then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = data?.rows ?? [];
    return needle ? all.filter((r) => `${r.actor_email} ${r.action} ${r.summary}`.toLowerCase().includes(needle)) : all;
  }, [data, q]);
  const cols: Col<AuditRow>[] = [
    { key: 'at', label: 'When', value: (r) => r.at },
    { key: 'actor', label: 'Who', value: (r) => r.actor_email },
    { key: 'action', label: 'Action', value: (r) => r.action },
    { key: 'summary', label: 'What happened', value: (r) => r.summary },
  ];
  const t = useTable(rows, cols, { sortKey: 'at', dir: 'desc', pageSize: 25 });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card()}>
        <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>Audit log</div>
        <p style={{ color: C.muted, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
          Who changed what in the admin: marking parents or vendors as test, editing commission terms,
          creating or editing vendors and running syncs. Newest first. Only admins can see this page.
        </p>
      </div>
      {err && <div style={{ ...card(), borderColor: C.pink, color: C.pink }}>{err}</div>}
      {!data && !err && <Skeleton />}
      {data?.missing && (
        <div style={{ ...card(), borderColor: C.pink, color: C.text }}>
          The audit log isn&apos;t set up yet — apply migration <code>00211_admin_audit_log.sql</code>. Actions are not being recorded until then.
        </div>
      )}
      {data && !data.missing && (
        <div style={{ ...card(), padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px' }}>
            <input style={{ ...input(), maxWidth: 320 }} placeholder="Search who, action or what happened…" value={q}
              onChange={(e) => { setQ(e.target.value); t.setPage(1); }} />
          </div>
          <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ color: C.muted }}>{cols.map((c) => <SortTh key={c.key} col={c} table={t} />)}</tr></thead>
              <tbody>
                {t.pageRows.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{when(r.at)}</td>
                    <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>{r.actor_email}{r.actor_role === 'support' && <span style={{ color: C.muted }}> (support)</span>}</td>
                    <td style={{ padding: '10px 12px', verticalAlign: 'top' }}><code style={{ fontSize: 12 }}>{r.action}</code></td>
                    <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>{r.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {t.total === 0 && <EmptyState title="Nothing recorded yet" hint="Actions will appear here as they happen." />}
          </div>
          <TableFooter total={t.total} page={t.page} pages={t.pages} setPage={t.setPage} noun="entries"
            onExport={() => downloadCsv('audit-log.csv', cols, t.sorted)} />
        </div>
      )}
    </div>
  );
}
