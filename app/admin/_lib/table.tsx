'use client';

import { useMemo, useState } from 'react';
import { C, tabBtn } from './core';

/**
 * Shared table behaviour for the admin lists: click a header to sort, a sticky header, paging and
 * a CSV export of exactly what is on screen (all matching rows, not just the current page).
 * The views keep rendering their own cells, so nothing about how a row looks or edits changes.
 */

export type Col<T> = {
  key: string;
  label: string;
  align?: 'left' | 'right';
  /** What the column sorts and exports by. Omit to make the column unsortable. */
  value?: (row: T) => string | number | null | undefined;
};

export function useTable<T>(rows: T[], cols: Col<T>[], opts: { pageSize?: number; sortKey?: string; dir?: 'asc' | 'desc' } = {}) {
  const [sortKey, setSortKey] = useState<string | null>(opts.sortKey ?? null);
  const [dir, setDir] = useState<'asc' | 'desc'>(opts.dir ?? 'asc');
  const [page, setPage] = useState(1);
  const pageSize = opts.pageSize ?? 25;

  const sorted = useMemo(() => {
    const col = cols.find((c) => c.key === sortKey);
    if (!col?.value) return rows;
    const get = col.value;
    const sign = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a) ?? '', y = get(b) ?? '';
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * sign;
    });
    // `cols` is rebuilt every render by the callers, so key off what actually changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, dir]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages);
  const pageRows = sorted.slice((current - 1) * pageSize, current * pageSize);

  const sortBy = (key: string) => {
    if (sortKey === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setDir('asc'); }
    setPage(1);
  };
  return { sorted, pageRows, sortKey, dir, sortBy, page: current, pages, setPage, pageSize, total: sorted.length };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function downloadCsv<T>(filename: string, cols: Col<T>[], rows: T[]) {
  const exportable = cols.filter((c) => c.value);
  const text = [exportable.map((c) => csvCell(c.label)).join(','), ...rows.map((r) => exportable.map((c) => csvCell(c.value!(r))).join(','))].join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A header cell that sorts on click and shows the direction. Sticks to the top of a scrolling table. */
export function SortTh<T>({ col, table, style }: { col: Col<T>; table: { sortKey: string | null; dir: 'asc' | 'desc'; sortBy: (k: string) => void }; style?: React.CSSProperties }) {
  const sortable = !!col.value;
  const active = table.sortKey === col.key;
  return (
    <th aria-sort={active ? (table.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={sortable ? () => table.sortBy(col.key) : undefined}
      style={{ padding: '10px 12px', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', textAlign: col.align ?? 'left',
        position: 'sticky', top: 0, zIndex: 1, background: C.panel, cursor: sortable ? 'pointer' : 'default', userSelect: 'none', ...style }}>
      {col.label}{active ? (table.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
}

/** Row count, paging and CSV export, shown under a table. */
export function TableFooter({ total, page, pages, setPage, onExport, noun = 'rows' }: {
  total: number; page: number; pages: number; setPage: (n: number) => void; onExport?: () => void; noun?: string;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', borderTop: `1px solid ${C.border}` }}>
      <span style={{ color: C.muted, fontSize: 12, fontWeight: 700 }}>{total} {total === 1 ? noun.replace(/s$/, '') : noun}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {pages > 1 && (
          <>
            <button type="button" style={{ ...tabBtn(false), padding: '4px 10px', fontSize: 12 }} disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
            <span style={{ color: C.muted, fontSize: 12, fontWeight: 700 }}>Page {page} of {pages}</span>
            <button type="button" style={{ ...tabBtn(false), padding: '4px 10px', fontSize: 12 }} disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
          </>
        )}
        {onExport && <button type="button" style={{ ...tabBtn(false), padding: '4px 10px', fontSize: 12 }} onClick={onExport}>Export CSV</button>}
      </div>
    </div>
  );
}

/** Modal overlay: closes on Esc or a click outside. */
export function Modal({ title, onClose, children, width = 560 }: { title?: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(5,9,18,.6)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: `min(${width}px, 100%)`, maxHeight: '90vh', overflowY: 'auto', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18 }}>
        {title && <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** A friendly empty list. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '28px 16px', color: C.muted }}>
      <div style={{ fontWeight: 800, color: C.text, marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 13 }}>{hint}</div>}
    </div>
  );
}
