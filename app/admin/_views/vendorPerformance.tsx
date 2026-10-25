'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Select } from '../_lib/multiselect';
import { Badge, C, Skeleton, adminFetch, card, input, peekCache, sgDay, sgdDollars, tabBtn, td, th, toast, type Tone } from '../_lib/core';
import type { AdminVendor } from '@/lib/admin-vendors';

/**
 * Admin → Vendor data: how each vendor is doing, in the same shape as the
 * Parents and Bookings tabs (QA: "vendor data is limited for measuring
 * progress"). Headline tiles for the vendors shown, then a sortable table
 * with filters and a CSV of whatever is on screen. Everything runs on the one
 * list from /api/admin/vendors/performance, so changing a filter is instant.
 */

type Data = { rows: AdminVendor[]; builtAt: string };
type SortKey = 'name' | 'live' | 'sessions30' | 'bookings30' | 'bookings' | 'waitlisted' | 'cancelRate' | 'gross30' | 'gross' | 'packs' | 'rating' | 'last' | 'joined';
type Filters = { q: string; listing: string; activity: string; plan: string; payouts: string; includeTest: boolean };
const NO_FILTERS: Filters = { q: '', listing: 'claimed', activity: '', plan: '', payouts: '', includeTest: false };
const URL_PATH = '/api/admin/vendors/performance';

const PAYOUT_BADGE: Record<AdminVendor['payouts'], { label: string; tone: Tone }> = {
  stripe: { label: 'Stripe', tone: 'green' }, manual: { label: 'Manual', tone: 'amber' }, none: { label: 'Not set', tone: 'grey' },
};
const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const DAY = 864e5;

/** "+40%" against the previous 30 days; null when there's nothing to compare with. */
function trend(now: number, prev: number): { text: string; tone: string } | null {
  if (!now && !prev) return null;
  if (!prev) return { text: 'new', tone: C.green };
  const d = (now - prev) / prev;
  if (Math.abs(d) < 0.005) return { text: '±0%', tone: C.muted };
  return { text: `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`, tone: d > 0 ? C.green : C.pink };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function VendorPerformance() {
  const [data, setData] = useState<Data | null>(() => peekCache<Data>(URL_PATH) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>('bookings30');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    try {
      setData(await adminFetch<Data>(`${URL_PATH}${fresh ? '?fresh=1' : ''}`));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const plans = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.plan).filter((p): p is string => !!p))].sort(), [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const now = Date.now();
    const q = f.q.trim().toLowerCase();
    const out = data.rows.filter((r) => {
      if (!f.includeTest && r.isTest) return false;
      if (f.listing === 'claimed' && !r.claimed) return false;
      if (f.listing === 'directory' && r.claimed) return false;
      if (f.plan && (r.plan ?? '') !== f.plan) return false;
      if (f.payouts && r.payouts !== f.payouts) return false;
      if (f.activity === 'live' && r.liveActivities === 0) return false;
      if (f.activity === 'booked30' && r.bookings30 === 0) return false;
      if (f.activity === 'never' && r.bookings > 0) return false;
      if (f.activity === 'dormant60' && (!r.lastBookingAt || now - Date.parse(r.lastBookingAt) < 60 * DAY)) return false;
      if (f.activity === 'growing' && r.bookings30 <= r.bookingsPrev30) return false;
      if (q && ![r.name, r.category ?? '', r.region ?? '', r.slug ?? ''].some((v) => v.toLowerCase().includes(q))) return false;
      return true;
    });
    const val = (r: AdminVendor): number | string => ({
      name: r.name.toLowerCase(), live: r.liveActivities, sessions30: r.sessions30, bookings30: r.bookings30, bookings: r.bookings,
      waitlisted: r.waitlisted, cancelRate: r.cancelRate ?? -1, gross30: r.gross30, gross: r.gross, packs: r.packsSold,
      rating: r.rating ?? -1, last: r.lastBookingAt ?? '', joined: r.joinedAt,
    })[sort];
    return out.sort((a, b) => {
      const x = val(a), y = val(b);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return (dir === 'asc' ? c : -c) || a.name.localeCompare(b.name);
    });
  }, [data, f, sort, dir]);

  const totals = useMemo(() => rows.reduce((t, r) => ({
    live: t.live + r.liveActivities, sessions: t.sessions + r.sessions30, b30: t.b30 + r.bookings30, bPrev: t.bPrev + r.bookingsPrev30,
    gross30: t.gross30 + r.gross30, active: t.active + (r.bookings30 > 0 ? 1 : 0),
  }), { live: 0, sessions: 0, b30: 0, bPrev: 0, gross30: 0, active: 0 }), [rows]);

  const sortBy = (k: SortKey) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir(k === 'name' ? 'asc' : 'desc'); }
  };
  const sortTh = (k: SortKey, label: string, right = true, title?: string) => (
    <th style={{ ...th(), textAlign: right ? 'right' : 'left', cursor: 'pointer', userSelect: 'none' }} title={title}
      aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => sortBy(k)}>
      {label}{sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  function exportCsv() {
    const head = ['Vendor', 'Claimed', 'Category', 'Region', 'Plan', 'Payouts', 'Wix', 'Team logins', 'Live activities', 'All activities',
      'Sessions next 30d', 'Bookings last 30d', 'Bookings previous 30d', 'Bookings all time', 'Waitlisted (upcoming)', 'Cancel rate',
      'Gross last 30d (SGD)', 'Gross all time (SGD)', 'Packs sold', 'Rating', 'Reviews', 'Last booking', 'Joined'];
    const lines = rows.map((r) => [r.name, r.claimed ? 'yes' : 'no', r.category ?? '', r.region ?? '', r.plan ?? '', r.payouts, r.wixLinked ? 'yes' : 'no',
      r.team, r.liveActivities, r.activities, r.sessions30, r.bookings30, r.bookingsPrev30, r.bookings, r.waitlisted,
      r.cancelRate == null ? '' : Math.round(r.cancelRate * 100) + '%', r.gross30.toFixed(2), r.gross.toFixed(2), r.packsSold,
      r.rating ?? '', r.reviews, r.lastBookingAt ? sgDay(r.lastBookingAt) : '', sgDay(r.joinedAt)].map(csvCell).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vendors.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Vendors exported');
  }

  const lab: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 12, color: C.muted, fontWeight: 700 };
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const filtered = JSON.stringify({ ...f, q: f.q.trim() }) !== JSON.stringify(NO_FILTERS);
  const tile = (label: string, value: string, sub?: React.ReactNode) => (
    <div style={{ ...card(), padding: 14 }}>
      <div style={{ color: C.muted, fontSize: 12, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </div>
  );
  const t30 = trend(totals.b30, totals.bPrev);

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>Vendor performance</div>
        <span style={{ color: C.muted, fontSize: 13 }}>Listings, sessions, bookings, money and reviews per vendor. Test vendors are left out unless you include them.</span>
      </div>

      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 14 }}>
          {tile('Vendors shown', String(rows.length), <span style={{ color: C.muted }}>{totals.active} booked in the last 30 days</span>)}
          {tile('Live activities', String(totals.live))}
          {tile('Sessions next 30 days', String(totals.sessions))}
          {tile('Bookings last 30 days', String(totals.b30), t30 && <span style={{ color: t30.tone }}>{t30.text} vs previous 30 days</span>)}
          {tile('Gross last 30 days', sgdDollars(totals.gross30), <span style={{ color: C.muted }}>card bookings and packs, live payments</span>)}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ ...lab, flex: '1 1 220px' }}>Search
          <input value={f.q} onChange={set('q')} placeholder="Vendor, category or region…" style={input()} />
        </label>
        <label style={{ ...lab, width: 170 }}>Listing
          <Select value={f.listing} onChange={set('listing')} style={input()}>
            <option value="claimed">Claimed (default)</option>
            <option value="directory">Directory only</option>
            <option value="">All vendors</option>
          </Select>
        </label>
        <label style={{ ...lab, width: 210 }}>Activity
          <Select value={f.activity} onChange={set('activity')} style={input()}>
            <option value="">Any</option>
            <option value="live">Has live activities</option>
            <option value="booked30">Booked in last 30 days</option>
            <option value="growing">Growing (more than previous 30 days)</option>
            <option value="dormant60">No booking for 60+ days</option>
            <option value="never">Never booked</option>
          </Select>
        </label>
        <label style={{ ...lab, width: 150 }}>Plan
          <Select value={f.plan} onChange={set('plan')} style={input()}>
            <option value="">All plans</option>
            {plans.map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}
          </Select>
        </label>
        <label style={{ ...lab, width: 140 }}>Payouts
          <Select value={f.payouts} onChange={set('payouts')} style={input()}>
            <option value="">Any</option>
            <option value="stripe">Stripe</option>
            <option value="manual">Manual</option>
            <option value="none">Not set</option>
          </Select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, padding: '11px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={f.includeTest} onChange={(e) => setF((p) => ({ ...p, includeTest: e.target.checked }))}
            style={{ flex: 'none', width: 16, height: 16, margin: 0 }} />
          Include test vendors
        </label>
        {filtered && <button type="button" style={tabBtn(false)} onClick={() => setF(NO_FILTERS)}>Clear filters</button>}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 10px', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ color: C.muted, fontSize: 13, fontWeight: 700 }}>
          {data ? `${rows.length} vendor${rows.length === 1 ? '' : 's'}` : ' '}
          {busy && data && <span style={{ color: C.blue, fontWeight: 800, marginLeft: 8 }}>● Updating…</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={tabBtn(false)} onClick={() => void load(true)} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</button>
          <button type="button" style={tabBtn(false)} onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
        </div>
      </div>

      {err && <p style={{ color: C.pink }}>{err}</p>}
      {!data && !err && <Skeleton rows={6} height={46} />}
      {data && (
        <div style={{ ...card(), padding: 0, overflowX: 'auto', opacity: busy ? 0.8 : 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.muted, textAlign: 'left' }}>
                {sortTh('name', 'Vendor', false)}
                <th style={th()}>Plan · payouts</th>
                {sortTh('live', 'Live activities')}
                {sortTh('sessions30', 'Sessions 30d', true, 'Sessions starting in the next 30 days')}
                {sortTh('bookings30', 'Bookings 30d', true, 'Places booked in the last 30 days, against the 30 days before')}
                {sortTh('bookings', 'All bookings')}
                {sortTh('waitlisted', 'Waitlist', true, 'Waitlisted places on sessions still to come')}
                {sortTh('cancelRate', 'Cancelled', true, 'Share of held bookings later cancelled (abandoned checkouts left out)')}
                {sortTh('gross30', 'Gross 30d', true, 'Live card payments and pack sales in the last 30 days, refunds left out')}
                {sortTh('gross', 'Gross all time')}
                {sortTh('packs', 'Packs sold')}
                {sortTh('rating', 'Rating')}
                {sortTh('last', 'Last booking')}
                {sortTh('joined', 'Joined')}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={14} style={{ ...td(), color: C.muted, textAlign: 'center', padding: 28 }}>No vendors match these filters.</td></tr>
              )}
              {rows.map((r) => {
                const tr = trend(r.bookings30, r.bookingsPrev30);
                const muted = (v: React.ReactNode, show: boolean) => (show ? v : <span style={{ color: C.muted }}>—</span>);
                return (
                  <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={td()}>
                      <div style={{ fontWeight: 700 }}>
                        {r.name}
                        {!r.claimed && <span style={{ marginLeft: 8 }}><Badge tone="grey">Directory</Badge></span>}
                        {r.isTest && <span style={{ marginLeft: 8 }}><Badge tone="amber">Test</Badge></span>}
                        {r.wixLinked && <span style={{ marginLeft: 8 }}><Badge tone="blue">Wix</Badge></span>}
                      </div>
                      <div style={{ color: C.muted, fontSize: 12 }}>
                        {[r.category && titleCase(r.category), r.region && titleCase(r.region), r.team ? `${r.team} login${r.team === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </td>
                    <td style={{ ...td(), whiteSpace: 'nowrap' }}>
                      <div>{r.plan ? titleCase(r.plan) : <span style={{ color: C.muted }}>—</span>}{r.planStatus && r.planStatus !== 'active' && <span style={{ color: C.muted }}> · {r.planStatus}</span>}</div>
                      <div style={{ marginTop: 3 }}><Badge tone={PAYOUT_BADGE[r.payouts].tone}>{PAYOUT_BADGE[r.payouts].label}</Badge></div>
                    </td>
                    <td style={{ ...td(), textAlign: 'right' }}>{r.liveActivities}<span style={{ color: C.muted }}> / {r.activities}</span></td>
                    <td style={{ ...td(), textAlign: 'right' }}>{muted(r.sessions30, r.sessions30 > 0)}</td>
                    <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {muted(r.bookings30, r.bookings30 > 0)}
                      {tr && <div style={{ color: tr.tone, fontSize: 12 }}>{tr.text}</div>}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' }}>{muted(r.bookings, r.bookings > 0)}</td>
                    <td style={{ ...td(), textAlign: 'right' }}>{muted(r.waitlisted, r.waitlisted > 0)}</td>
                    <td style={{ ...td(), textAlign: 'right' }}>{muted(pct(r.cancelRate), r.cancelRate != null)}</td>
                    <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }}>{muted(sgdDollars(r.gross30), r.gross30 > 0)}</td>
                    <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }}>{muted(sgdDollars(r.gross), r.gross > 0)}</td>
                    <td style={{ ...td(), textAlign: 'right' }}>{muted(r.packsSold, r.packsSold > 0)}</td>
                    <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {r.rating != null ? <>★ {r.rating.toFixed(1)}<span style={{ color: C.muted }}> ({r.reviews})</span></> : <span style={{ color: C.muted }}>—</span>}
                    </td>
                    <td style={{ ...td(), whiteSpace: 'nowrap' }}>{r.lastBookingAt ? sgDay(r.lastBookingAt) : <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={{ ...td(), whiteSpace: 'nowrap' }}>{sgDay(r.joinedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
