'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Badge, C, Skeleton, adminFetch, card, input, sgClock, sgDay, sgdDollars, supabase, tabBtn, td, th, toast, type Tone } from '../_lib/core';
import { MultiSelect } from '../_lib/multiselect';
import type { ParentFilters } from './parents';

// ---- Bookings: every booking, filterable, with a drop-down of full details ----

type PayVia = 'amount' | 'credit' | 'token' | 'free' | 'unpaid' | 'manual';
type BookingRow = {
  id: string; isManual: boolean; isTest: boolean;
  parent: { id: string; name: string; email: string; postal: string | null } | null;
  guestName: string | null; guestContact: string | null;
  vendorId: string | null; vendorName: string | null; activityId: string | null; activityTitle: string | null;
  sessionAt: string | null; bookedAt: string; status: string; childCount: number; childNames: string[];
  payVia: PayVia; amount: number | null; credits: number; tokens: number; classPrice: number | null;
  venue: { name: string | null; address: string | null; postal: string | null } | null;
  details: {
    seatCount: number; paymentStatus: string; stripePaymentIntent: string | null;
    packageName: string | null; packageCreditsRemaining: number | null; packageCreditsTotal: number | null;
    cancelReason: string | null; cancelledBy: string | null; cancelRefundMode: string | null;
    policiesAccepted: number; hasMedicalDisclosure: boolean; hasInfoResponse: boolean; waitlistPosition: number | null;
  };
};
type BookingsPage = {
  rows: BookingRow[]; total: number; page: number; pages: number; pageSize: number;
  facets?: { vendors: { id: string; name: string; count: number }[]; activities: { id: string; title: string; vendor: string; count: number }[] };
};
type Filters = {
  q: string; vendor: string; activity: string; pay: string; date_by: string; from: string; to: string;
  price_min: string; price_max: string; postal: string; status: string; test: string; hide_abandoned: string;
};
const NO_FILTERS: Filters = { q: '', vendor: '', activity: '', pay: '', date_by: 'class', from: '', to: '', price_min: '', price_max: '', postal: '', status: '', test: 'hide', hide_abandoned: '' };
const ADVANCED: (keyof Filters)[] = ['price_min', 'price_max', 'postal', 'status', 'test', 'hide_abandoned'];

function filtersFromUrl(): Filters {
  const sp = new URLSearchParams(window.location.search);
  if (sp.get('tab') !== 'bookings') return NO_FILTERS;
  const out = { ...NO_FILTERS };
  (Object.keys(NO_FILTERS) as (keyof Filters)[]).forEach((k) => { const v = sp.get(k); if (v) out[k] = v; });
  return out;
}

const PAY_LABEL: Record<PayVia, string> = {
  amount: 'Amount', credit: 'Credit', token: 'Make-up token', free: 'Free', unpaid: 'Not paid', manual: '—',
};
const STATUS_TONE: Record<string, Tone> = { confirmed: 'green', completed: 'green', pending: 'amber', waitlisted: 'amber', cancelled: 'grey' };
const dash = <span style={{ color: C.muted }}>—</span>;

/** The Amount column: money for a paid class, credits for a package, a count for make-up tokens. */
function amountText(r: BookingRow): React.ReactNode {
  if (r.payVia === 'amount' && r.amount != null) return sgdDollars(r.amount);
  if (r.payVia === 'credit') return `${r.credits} credit${r.credits === 1 ? '' : 's'}`;
  if (r.payVia === 'token') return `${r.tokens} token${r.tokens === 1 ? '' : 's'}`;
  return dash;
}

export default function BookingsView({ onOpenParents }: { onOpenParents: (f: Partial<ParentFilters> & { open?: string }) => void }) {
  const [f, setF] = useState<Filters>(filtersFromUrl);
  const [q, setQ] = useState(() => filtersFromUrl().q);
  const [sort, setSort] = useState('booked');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BookingsPage | null>(null);
  const [facets, setFacets] = useState<BookingsPage['facets']>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [more, setMore] = useState(() => { const u = filtersFromUrl(); return ADVANCED.some((k) => u[k] && u[k] !== NO_FILTERS[k]); });
  const [openRow, setOpenRow] = useState<string | null>(null);
  const cacheRef = useRef(new Map<string, BookingsPage>());
  const freshRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => { setF((p) => (p.q === q ? p : { ...p, q })); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const qs = useCallback((withPage: boolean) => {
    const sp = new URLSearchParams();
    (Object.keys(f) as (keyof Filters)[]).forEach((k) => { if (f[k]) sp.set(k, f[k]); });
    sp.set('sort', sort); sp.set('dir', dir);
    if (withPage) sp.set('page', String(page));
    return sp;
  }, [f, sort, dir, page]);

  // Keep the filters in the page link so a refresh or a shared link lands on the same view.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('tab') !== 'bookings') return;
    (Object.keys(NO_FILTERS) as (keyof Filters)[]).forEach((k) => {
      if (f[k] && f[k] !== NO_FILTERS[k]) url.searchParams.set(k, f[k]); else url.searchParams.delete(k);
    });
    window.history.replaceState(null, '', url);
  }, [f]);

  useEffect(() => {
    let stale = false;
    const key = qs(true).toString();
    const hit = cacheRef.current.get(key);
    if (hit) setData(hit);
    setBusy(true); setErr(null);
    const fresh = freshRef.current;
    freshRef.current = false;
    adminFetch<BookingsPage>(`/api/admin/bookings?${key}${fresh ? '&fresh=1' : ''}`)
      .then((r) => { cacheRef.current.set(key, r); if (!stale) { setData(r); if (fresh) toast('Bookings refreshed'); } })
      .catch((e) => { if (!stale) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!stale) setBusy(false); });
    return () => { stale = true; };
  }, [qs]);

  // The vendor and activity options for the multi-selects (they follow the test-data choice).
  useEffect(() => {
    let stale = false;
    adminFetch<BookingsPage>(`/api/admin/bookings?facets=1&page=1&test=${f.test}`).then((r) => { if (!stale) setFacets(r.facets); }).catch(() => { /* filters still work by typing */ });
    return () => { stale = true; };
  }, [f.test]);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setF((p) => ({ ...p, [k]: e.target.value })); setPage(1); };
  const csvIds = (s: string) => s.split(',').filter(Boolean);
  const setIds = (k: 'vendor' | 'activity') => (ids: string[]) => { setF((p) => ({ ...p, [k]: ids.join(',') })); setPage(1); };
  const sortBy = (k: string) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSort(k); setDir(k === 'name' || k === 'vendor' || k === 'activity' ? 'asc' : 'desc'); }
    setPage(1);
  };
  const reset = () => { setF(NO_FILTERS); setQ(''); setPage(1); };
  const refresh = () => { cacheRef.current.clear(); freshRef.current = true; setF((p) => ({ ...p })); };
  const active = (Object.keys(f) as (keyof Filters)[]).filter((k) => f[k] && f[k] !== NO_FILTERS[k] && k !== 'q').length;

  async function exportCsv() {
    setExporting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/bookings?${qs(false)}&format=csv`, { headers: session ? { Authorization: `Bearer ${session.access_token}` } : {} });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'bookings.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Bookings exported');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setExporting(false); }
  }

  const lab: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 12, color: C.muted, fontWeight: 700 };
  const sel = (k: keyof Filters, opts: [string, string][]) => (
    <select value={f[k]} onChange={set(k)} style={input()}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
  );
  const sortTh = (k: string, label: string, right?: boolean) => (
    <th style={{ ...th(), textAlign: right ? 'right' : 'left', cursor: 'pointer', userSelect: 'none' }}
      aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => sortBy(k)}>
      {label}{sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  // When vendors are chosen, only offer their activities.
  const chosenVendorNames = new Set((facets?.vendors ?? []).filter((v) => csvIds(f.vendor).includes(v.id)).map((v) => v.name));
  const vendorOptions = (facets?.vendors ?? []).map((v) => ({ id: v.id, label: v.name, sub: `${v.count} booking${v.count === 1 ? '' : 's'}` }));
  const activityOptions = (facets?.activities ?? [])
    .filter((a) => chosenVendorNames.size === 0 || chosenVendorNames.has(a.vendor))
    .map((a) => ({ id: a.id, label: a.title, sub: a.vendor }));

  const field = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: C.muted, fontWeight: 700 }}>{label}</span><span style={{ wordBreak: 'break-word' }}>{value}</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ ...lab, flex: '1 1 220px' }}>Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, vendor or activity…" style={input()} />
        </label>
        <MultiSelect label="Vendor" placeholder="All vendors" options={vendorOptions} selected={csvIds(f.vendor)} onChange={setIds('vendor')} width={190} />
        <MultiSelect label="Activity" placeholder="All activities" options={activityOptions} selected={csvIds(f.activity)} onChange={setIds('activity')} width={190} />
        <label style={{ ...lab, width: 150 }}>Payment type
          {sel('pay', [['', 'Any'], ['amount', 'Amount paid'], ['credit', 'Credit'], ['token', 'Make-up token'], ['free', 'Free'], ['unpaid', 'Not paid'], ['free,credit,token,unpaid', 'Free, credit or token'], ['manual', 'Manual booking']])}
        </label>
        <label style={{ ...lab, width: 130 }}>Date by
          {sel('date_by', [['class', 'Class date'], ['booked', 'Booked on']])}
        </label>
        <label style={{ ...lab, width: 150 }}>On / from
          <input type="date" value={f.from} onChange={set('from')} style={input()} />
        </label>
        <label style={{ ...lab, width: 150 }}>To (optional)
          <input type="date" value={f.to} onChange={set('to')} style={input()} />
        </label>
        <button type="button" style={tabBtn(more)} onClick={() => setMore((m) => !m)}>More filters{active ? ` · ${active}` : ''} {more ? '▴' : '▾'}</button>
      </div>

      {more && (
        <div style={{ ...card(), marginTop: 12, display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
            <label style={lab}>Price from (SGD)
              <input type="number" min={0} value={f.price_min} onChange={set('price_min')} style={input()} placeholder="e.g. 20" />
            </label>
            <label style={lab}>Price to (SGD)
              <input type="number" min={0} value={f.price_max} onChange={set('price_max')} style={input()} placeholder="e.g. 80" />
            </label>
            <label style={lab}>Parent postal code starts with
              <input value={f.postal} onChange={set('postal')} style={input()} placeholder="e.g. 52" />
            </label>
            <label style={lab}>Status
              {sel('status', [['', 'Any'], ['active', 'Active (confirmed / completed)'], ['confirmed', 'Confirmed'], ['completed', 'Completed'], ['pending', 'Pending'], ['waitlisted', 'Waitlisted'], ['cancelled', 'Cancelled']])}
            </label>
            <label style={lab}>Cancelled before payment
              {sel('hide_abandoned', [['', 'Show'], ['1', 'Hide (as Metrics counts)']])}
            </label>
            <label style={lab}>Test data
              {sel('test', [['hide', 'Hide (default)'], ['show', 'Include'], ['only', 'Only test data']])}
            </label>
          </div>
          <div style={{ color: C.muted, fontSize: 12 }}>
            Price is what was paid for the class, or the class&apos;s list price when it was paid with a credit, a make-up token or not at all.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" style={tabBtn(false)} onClick={reset}>Clear all filters</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 10px', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ color: C.muted, fontSize: 13, fontWeight: 700 }}>
          {data ? `${data.total} booking${data.total === 1 ? '' : 's'}` : ' '}
          {busy && data && <span style={{ color: C.blue, fontWeight: 800, marginLeft: 8 }}>● Updating…</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={tabBtn(false)} onClick={refresh} disabled={busy} title="Reload the latest data">{busy ? 'Refreshing…' : 'Refresh'}</button>
          <button type="button" style={tabBtn(false)} onClick={exportCsv} disabled={exporting || !data?.total}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
        </div>
      </div>

      {err && <p style={{ color: C.pink }}>{err}</p>}
      {!data && !err && <Skeleton rows={8} height={46} />}
      {data && (
        <div style={{ ...card(), padding: 0, overflowX: 'auto', position: 'relative', opacity: busy ? 0.75 : 1 }}>
          {busy && <div className="bb-skel" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, borderRadius: 0,
            background: `linear-gradient(90deg, transparent 25%, ${C.blue} 50%, transparent 75%)`, backgroundSize: '400% 100%' }} />}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.muted, textAlign: 'left' }}>
                {sortTh('name', 'Name and email')}
                {sortTh('vendor', 'Vendor')}
                {sortTh('activity', 'Activity')}
                {sortTh('class', 'Class date and time')}
                {sortTh('booked', 'Booked on')}
                {sortTh('children', 'Children')}
                <th style={th()}>Paid via</th>
                {sortTh('amount', 'Amount', true)}
                <th style={{ ...th(), width: 44 }} aria-label="Details" />
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr><td colSpan={9} style={{ ...td(), color: C.muted, textAlign: 'center', padding: 28 }}>No bookings match these filters.</td></tr>
              )}
              {data.rows.map((r) => {
                const open = openRow === r.id;
                const name = r.parent?.name ?? r.guestName;
                return (
                  <Fragment key={r.id}>
                    <tr style={{ borderTop: `1px solid ${C.border}`, background: open ? 'rgba(74,144,255,.06)' : undefined }}>
                      <td style={td()}>
                        <div style={{ fontWeight: 700 }}>
                          {name ?? dash}
                          {r.isManual && <span style={{ marginLeft: 8 }}><Badge tone="grey">Manual</Badge></span>}
                          {r.isTest && <span style={{ marginLeft: 8 }}><Badge tone="amber">Test</Badge></span>}
                          {r.status !== 'confirmed' && r.status !== 'completed' && <span style={{ marginLeft: 8 }}><Badge tone={STATUS_TONE[r.status] ?? 'grey'}>{r.status}</Badge></span>}
                        </div>
                        <div style={{ color: C.muted, fontSize: 12 }}>{r.parent?.email ?? r.guestContact ?? '—'}</div>
                      </td>
                      <td style={td()}>{r.vendorName ?? dash}</td>
                      <td style={td()}>{r.activityTitle ?? dash}</td>
                      <td style={{ ...td(), whiteSpace: 'nowrap' }}>
                        {r.sessionAt ? <>{sgDay(r.sessionAt)}<div style={{ color: C.muted, fontSize: 12 }}>{sgClock(r.sessionAt)}</div></> : dash}
                      </td>
                      <td style={{ ...td(), whiteSpace: 'nowrap' }}>
                        {sgDay(r.bookedAt)}<div style={{ color: C.muted, fontSize: 12 }}>{sgClock(r.bookedAt)}</div>
                      </td>
                      <td style={td()}>{r.isManual && r.childCount === 1 && !r.childNames.length ? dash : r.childCount}</td>
                      <td style={td()}>{r.payVia === 'manual' ? dash : r.payVia === 'unpaid' ? <Badge tone="amber">Not paid</Badge> : PAY_LABEL[r.payVia]}</td>
                      <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }}>{amountText(r)}</td>
                      <td style={td()}>
                        <button type="button" onClick={() => setOpenRow(open ? null : r.id)} aria-expanded={open} aria-label={open ? 'Hide booking details' : 'Show booking details'}
                          style={{ ...tabBtn(open), padding: '2px 9px', fontSize: 14, lineHeight: '20px' }}>{open ? '▴' : '▾'}</button>
                      </td>
                    </tr>
                    {open && (
                      <tr style={{ background: 'rgba(74,144,255,.04)' }}>
                        <td colSpan={9} style={{ padding: '6px 16px 16px 16px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', columnGap: 28 }}>
                            <div>
                              {field('Booked on', `${sgDay(r.bookedAt)} · ${sgClock(r.bookedAt)}`)}
                              {field('Class', r.sessionAt ? `${sgDay(r.sessionAt)} · ${sgClock(r.sessionAt)}` : dash)}
                              {field('Venue', r.venue ? [r.venue.name, r.venue.address].filter(Boolean).join(' — ') || dash : dash)}
                              {field('Status', <Badge tone={STATUS_TONE[r.status] ?? 'grey'}>{r.status}</Badge>)}
                              {r.details.waitlistPosition != null && field('Waitlist position', r.details.waitlistPosition)}
                              {field('Children', r.childNames.length ? r.childNames.join(', ') : dash)}
                              {field('Parent postal code', r.parent?.postal ?? dash)}
                              {r.parent && field('Parent', <button type="button" style={{ background: 'none', border: 'none', padding: 0, color: C.blue, fontWeight: 700, cursor: 'pointer', font: 'inherit' }}
                                onClick={() => onOpenParents({ q: r.parent!.email, account: 'all', open: r.parent!.id })}>Open {r.parent.name} →</button>)}
                              {r.isManual && field('Added by', 'The vendor, by hand (no parent account)')}
                            </div>
                            <div>
                              {field('Payment status', r.details.paymentStatus)}
                              {field('Class price', r.classPrice != null ? sgdDollars(r.classPrice) : dash)}
                              {field('Paid per class', r.amount != null ? sgdDollars(r.amount) : dash)}
                              {field('Package credits used', r.credits ? r.credits : dash)}
                              {r.details.packageName && field('Package', `${r.details.packageName}${r.details.packageCreditsTotal != null ? ` · ${r.details.packageCreditsRemaining} of ${r.details.packageCreditsTotal} credits left` : ''}`)}
                              {field('Make-up tokens used', r.tokens ? r.tokens : dash)}
                              {field('Stripe payment', r.details.stripePaymentIntent ? <code style={{ fontSize: 12 }}>{r.details.stripePaymentIntent}</code> : dash)}
                              {r.status === 'cancelled' && field('Cancellation', [r.details.cancelReason, r.details.cancelRefundMode ? `refund: ${r.details.cancelRefundMode}` : null].filter(Boolean).join(' · ') || dash)}
                              {field('Policies accepted', r.details.policiesAccepted || dash)}
                              {field('Medical disclosure', r.details.hasMedicalDisclosure ? 'Given (text not shown here)' : 'None')}
                              {field('Booking id', <code style={{ fontSize: 12 }}>{r.id}</code>)}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 14 }}>
          <button type="button" style={tabBtn(false)} disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>← Prev</button>
          <span style={{ color: C.muted, fontSize: 13, fontWeight: 700 }}>Page {data.page} of {data.pages}</span>
          <button type="button" style={tabBtn(false)} disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
