'use client';

import { useEffect, useState } from 'react';
import type { ParentFilters } from './parents';
import { C, CardsSkeleton, TestDataBar, adminFetch, card, pctText, sgd, sgdDollars, tabBtn, peekCache } from '../_lib/core';

// ---- types mirrored from the /api/admin/* routes ----
type Metrics = {
  totals: {
    parents: number; providers: number; activeProviders: number; bookings: number;
    plusSubscribers: number; growthSubscribers: number; reviews: number; activities: number;
  };
  bookings: { today: number; last7: number };
  signups: { today: number; last7: number };
  daily: { date: string; bookings: number; manual: number; signups: number; sales: number }[];
  includeTest: boolean;
  excluded: { vendors: number; parents: number; bookings: number; sales: number };
  revenue: {
    sales: number; gross: number; commission: number; vendorNet: number; stripeFees: number;
    commissionCollected: number; commissionToCollect: number; refunded: number;
    last7: { sales: number; gross: number; commission: number };
    last30: { sales: number; gross: number; commission: number };
  };
  growth: { newParents7: number; newParents30: number; newVendors30: number; parentsWhoBooked: number; activatedVendors: number };
  health: {
    bookingSplit: { manual: number; paid: number; paidAmount: number; other: number };
    bookings30: number; cancelled30: number; cancellationRate: number | null;
    waitlisted: number; upcomingFillRate: number | null; upcomingSessions: number;
  };
  subscriptions: {
    plusActive: number; plusPastDue: number; plusCanceled: number;
    vendorPro: number; vendorPremium: number; vendorPastDue: number; vendorCanceled: number;
  };
};

// ---- Activity chart: range, series toggles, hover tooltip, pinned day, click-through ----
type DailyPoint = { date: string; bookings: number; manual: number; signups: number; sales: number };
type SeriesKey = 'bookings' | 'manual' | 'signups' | 'sales';
const SERIES: { key: SeriesKey; label: string; color: string; hint: string }[] = [
  { key: 'bookings', label: 'Bookings', color: '#ff5a9a', hint: 'Made by parents' },
  { key: 'manual', label: 'Manual bookings', color: '#f5b942', hint: 'Added by vendors, no parent account' },
  { key: 'signups', label: 'Signups', color: '#4a90ff', hint: 'New parent accounts' },
  { key: 'sales', label: 'Sales', color: '#34c77b', hint: 'Gross sales taken, SGD (right axis)' },
];
const RANGES = [7, 14, 30, 90] as const;

/** A tidy axis maximum (1, 2, 5 × a power of ten) at or above `v`. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].map((m) => m * pow).find((x) => x >= v) ?? v);
}
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00+08:00`).toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' });
const money = (cents: number) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD', maximumFractionDigits: 0 }).format(cents / 100);

type OpenBookings = (f: Record<string, string>) => void;

function ActivityChart({ daily, onOpenParents, onOpenBookings }: { daily: DailyPoint[]; onOpenParents: (f: Partial<ParentFilters>) => void; onOpenBookings: OpenBookings }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(14);
  const [on, setOn] = useState<Record<SeriesKey, boolean>>({ bookings: true, manual: false, signups: true, sales: true });
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  const pts = daily.slice(-range);
  const n = pts.length;
  const W = 1000, H = 280, L = 46, R = on.sales ? 58 : 14, T = 12, B = 30;
  const plotW = W - L - R, plotH = H - T - B, colW = plotW / n;
  const bars = SERIES.filter((s) => s.key !== 'sales' && on[s.key]);
  const maxCount = niceMax(Math.max(0, ...pts.map((p) => Math.max(...bars.map((s) => p[s.key]), 0))));
  const maxSales = niceMax(Math.max(0, ...pts.map((p) => p.sales)));
  const barW = Math.max(3, Math.min(20, (colW * 0.78) / Math.max(1, bars.length)));
  const x = (i: number) => L + colW * i + colW / 2;
  const yCount = (v: number) => T + plotH - (v / maxCount) * plotH;
  const ySales = (v: number) => T + plotH - (v / maxSales) * plotH;
  const ticks = [0, 1, 2, 3, 4].map((t) => t / 4);
  const labelEvery = Math.ceil(n / 10);
  const totals = SERIES.map((s) => ({ ...s, total: pts.reduce((t, p) => t + p[s.key], 0) }));
  const active = hover ?? pinned;
  const sel = active != null ? pts[active] : null;
  const toggle = (k: SeriesKey) => setOn((p) => (Object.values({ ...p, [k]: !p[k] }).some(Boolean) ? { ...p, [k]: !p[k] } : p));
  const chipBtn = (isOn: boolean, color?: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 12, fontWeight: 700,
    border: `1px solid ${isOn ? color ?? C.blue : C.border}`, background: isOn ? 'rgba(74,144,255,.10)' : 'transparent', color: isOn ? C.text : C.muted,
  });

  return (
    <div style={{ ...card(), marginTop: 22, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 800 }}>Activity · last {range} days</div>
        <div role="group" aria-label="Date range" style={{ display: 'flex', gap: 6 }}>
          {RANGES.map((r) => (
            <button key={r} type="button" onClick={() => { setRange(r); setHover(null); setPinned(null); }} aria-pressed={range === r}
              style={{ ...tabBtn(range === r), padding: '4px 12px', fontSize: 12 }}>{r}d</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        {totals.map((s) => (
          <button key={s.key} type="button" onClick={() => toggle(s.key)} aria-pressed={on[s.key]} title={`${s.hint} — click to ${on[s.key] ? 'hide' : 'show'}`}
            style={chipBtn(on[s.key], s.color)}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: on[s.key] ? s.color : C.border }} />
            {s.label}
            <span style={{ color: C.muted, fontWeight: 600 }}>{s.key === 'sales' ? money(s.total) : s.total}</span>
          </button>
        ))}
      </div>

      <div style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }} role="img"
          aria-label={`Bookings, signups and sales for the last ${range} days`}>
          {ticks.map((t) => {
            const y = T + plotH - t * plotH;
            return (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y} y2={y} stroke={C.border} strokeWidth={1} strokeDasharray={t === 0 ? undefined : '3 4'} />
                {bars.length > 0 && <text x={L - 8} y={y + 4} textAnchor="end" fontSize={11} fill={C.muted}>{Math.round(t * maxCount * 10) / 10}</text>}
                {on.sales && <text x={W - R + 8} y={y + 4} textAnchor="start" fontSize={11} fill={C.green}>{money(t * maxSales)}</text>}
              </g>
            );
          })}

          {active != null && <rect x={L + colW * active} y={T} width={colW} height={plotH} fill="rgba(74,144,255,.10)" rx={4} />}

          {pts.map((p, i) => bars.map((s, bi) => {
            const v = p[s.key];
            const h = v ? Math.max(3, plotH - (yCount(v) - T)) : 0;
            return h ? (
              <rect key={`${p.date}-${s.key}`} x={x(i) - (bars.length * barW) / 2 + bi * barW} y={T + plotH - h} width={barW - 1} height={h}
                rx={2} fill={s.color} opacity={active == null || active === i ? 1 : 0.45} />
            ) : null;
          }))}

          {on.sales && (
            <>
              <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${ySales(p.sales)}`).join(' ')} fill="none" stroke={C.green} strokeWidth={2} strokeLinejoin="round" />
              {pts.map((p, i) => p.sales > 0 && <circle key={p.date} cx={x(i)} cy={ySales(p.sales)} r={active === i ? 5 : 3} fill={C.green} />)}
            </>
          )}

          {pts.map((p, i) => i % labelEvery === 0 && (
            <text key={p.date} x={x(i)} y={H - 10} textAnchor="middle" fontSize={11} fill={active === i ? C.text : C.muted}>{p.date.slice(5)}</text>
          ))}

          {pts.map((p, i) => (
            <rect key={`hit-${p.date}`} x={L + colW * i} y={T} width={colW} height={plotH + B} fill="transparent" style={{ cursor: 'pointer', outline: 'none' }}
              tabIndex={0} role="button" aria-label={`${dayLabel(p.date)}: ${p.bookings} bookings, ${p.manual} manual, ${p.signups} signups, ${money(p.sales)} sales`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              onClick={() => setPinned((cur) => (cur === i ? null : i))}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinned((cur) => (cur === i ? null : i)); } }} />
          ))}
        </svg>

        {hover != null && (
          <div style={{ position: 'absolute', top: 0, left: `${Math.min(78, Math.max(0, ((x(hover) / W) * 100) - 10))}%`, pointerEvents: 'none', zIndex: 5,
            background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 10px', fontSize: 12, minWidth: 150, boxShadow: '0 6px 20px rgba(0,0,0,.35)' }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>{dayLabel(pts[hover].date)}</div>
            {SERIES.map((s) => (
              <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: on[s.key] ? C.text : C.muted, opacity: on[s.key] ? 1 : 0.6 }}>
                <span><span style={{ color: s.color }}>■</span> {s.label}</span>
                <strong>{s.key === 'sales' ? money(pts[hover][s.key]) : pts[hover][s.key]}</strong>
              </div>
            ))}
            <div style={{ color: C.muted, marginTop: 4 }}>Click to pin</div>
          </div>
        )}
      </div>

      {pinned != null && sel && pts[pinned] && (
        <div style={{ ...card(), marginTop: 12, padding: '10px 14px', background: C.bg, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <strong>{dayLabel(pts[pinned].date)}</strong>
            <span style={{ color: C.muted }}> · {pts[pinned].bookings} bookings · {pts[pinned].manual} manual · {pts[pinned].signups} signups · {money(pts[pinned].sales)} sales</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {pts[pinned].bookings > 0 && (
              <button type="button" style={{ ...tabBtn(false), padding: '4px 12px', fontSize: 12 }}
                onClick={() => onOpenBookings({ date_by: 'booked', from: pts[pinned].date, to: pts[pinned].date, pay: 'amount,credit,token,free,unpaid', hide_abandoned: '1' })}>
                View {pts[pinned].bookings} booking{pts[pinned].bookings === 1 ? '' : 's'} →
              </button>
            )}
            {pts[pinned].manual > 0 && (
              <button type="button" style={{ ...tabBtn(false), padding: '4px 12px', fontSize: 12 }}
                onClick={() => onOpenBookings({ date_by: 'booked', from: pts[pinned].date, to: pts[pinned].date, pay: 'manual', hide_abandoned: '1' })}>
                View {pts[pinned].manual} manual →
              </button>
            )}
            {pts[pinned].signups > 0 && (
              <button type="button" style={{ ...tabBtn(false), padding: '4px 12px', fontSize: 12 }}
                onClick={() => onOpenParents({ joined_from: pts[pinned].date, joined_to: pts[pinned].date })}>
                View {pts[pinned].signups} signup{pts[pinned].signups === 1 ? '' : 's'} →
              </button>
            )}
            <button type="button" style={{ ...tabBtn(false), padding: '4px 12px', fontSize: 12 }} onClick={() => setPinned(null)}>Clear</button>
          </div>
        </div>
      )}
      <div style={{ color: C.muted, fontSize: 11, marginTop: 10 }}>
        Hover or tab to a day for details, click to pin it. Click a legend chip to show or hide a series. Counts are by the day they were made (Singapore time).
      </div>
    </div>
  );
}

type AttentionItem = { id: string; severity: 'warn' | 'info'; title: string; detail: string; tab: string; filters?: Record<string, string> };

/** What is waiting on a person, each item opening the place that fixes it. */
function AttentionCard({ onOpenParents, onGoTab }: { onOpenParents: (f: Partial<ParentFilters>) => void; onGoTab: (tab: string) => void }) {
  const [items, setItems] = useState<AttentionItem[] | null>(() => peekCache<{ items: AttentionItem[] }>('/api/admin/attention')?.items ?? null);
  useEffect(() => {
    adminFetch<{ items: AttentionItem[] }>('/api/admin/attention').then((r) => setItems(r.items)).catch(() => setItems((cur) => cur ?? []));
  }, []);
  if (items === null) return <div className="bb-skel" style={{ height: 64, marginBottom: 6 }} />;
  return (
    <div style={{ ...card(), marginBottom: 6 }}>
      <div style={{ fontWeight: 800, fontSize: 14, marginBottom: items.length ? 8 : 0 }}>
        Needs attention {items.length > 0 && <span style={{ color: C.muted, fontWeight: 600 }}>· {items.length}</span>}
      </div>
      {items.length === 0 && <div style={{ color: C.green, fontSize: 13, fontWeight: 700, marginTop: 4 }}>All clear — nothing is waiting on you.</div>}
      {items.map((it) => (
        <button key={it.id} type="button" onClick={() => (it.filters ? onOpenParents(it.filters as Partial<ParentFilters>) : onGoTab(it.tab))}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, textAlign: 'left', padding: '8px 4px', background: 'transparent', border: 'none',
            borderTop: `1px solid ${C.border}`, cursor: 'pointer', color: C.text, font: 'inherit' }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, flex: 'none', background: it.severity === 'warn' ? C.pink : C.blue }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{it.title}</span>
            <span style={{ display: 'block', color: C.muted, fontSize: 12 }}>{it.detail}</span>
          </span>
          <span style={{ color: C.blue, fontWeight: 800, fontSize: 12, flex: 'none' }}>Open →</span>
        </button>
      ))}
    </div>
  );
}

export default function MetricsView({ onOpenParents, onOpenBookings, onGoTab }: { onOpenParents: (f: Partial<ParentFilters>) => void; onOpenBookings: OpenBookings; onGoTab: (tab: string) => void }) {
  const [m, setM] = useState<Metrics | null>(() => peekCache<Metrics>('/api/admin/metrics') ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [includeTest, setIncludeTest] = useState(false);
  useEffect(() => {
    let stale = false;
    setErr(null);
    adminFetch<Metrics>(`/api/admin/metrics${includeTest ? '?include_test=1' : ''}`)
      .then((r) => { if (!stale) setM(r); })
      .catch((e) => { if (!stale) setErr(String(e.message ?? e)); });
    return () => { stale = true; };
  }, [includeTest]);

  if (err) return <p style={{ color: C.pink }}>{err}</p>;
  if (!m) return <CardsSkeleton />;

  // A row's optional 5th item makes the card a link to the Parents tab with those filters on.
  // A row's optional 5th item makes the card a link: to the Parents tab, or to the Bookings tab, with those filters on.
  type CardLink = { to: 'parents'; filters: Partial<ParentFilters> } | { to: 'bookings'; filters: Record<string, string> };
  const P = (filters: Partial<ParentFilters>): CardLink => ({ to: 'parents', filters });
  // The Bookings list defaults to paid / credit / token only, so a card that counts every booking asks for all payment types (pay=all).
  const B = (filters: Record<string, string>): CardLink => ({ to: 'bookings', filters: { hide_abandoned: '1', pay: 'all', ...filters } });
  type Row = [string, number | string, string, string?, CardLink?];
  const sgDay_ = (msAgo: number) => new Date(Date.now() - msAgo).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const section = (title: string, rows: Row[]) => (
    <div>
      <div style={{ fontWeight: 800, fontSize: 14, margin: '22px 0 10px' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
        {rows.map(([label, value, color, sub, link]) => {
          const inner = (<>
            <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 900, color, marginTop: 6 }}>{value}</div>
            {sub && <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{sub}</div>}
            {link && <div className="bb-cardlink" style={{ color: C.blue, fontSize: 12, fontWeight: 800, marginTop: 6 }}>{link.to === 'bookings' ? 'View bookings →' : 'View parents →'}</div>}
          </>);
          return link ? (
            <button key={label} type="button" className="bb-cardbtn" onClick={() => (link.to === 'bookings' ? onOpenBookings(link.filters) : onOpenParents(link.filters))}
              title={link.to === 'bookings' ? 'Open these bookings in the Bookings tab' : 'Open these parents in the Parents tab'} style={{ ...card(), textAlign: 'left', cursor: 'pointer', font: 'inherit', color: C.text }}>
              {inner}
            </button>
          ) : <div key={label} style={card()}>{inner}</div>;
        })}
      </div>
    </div>
  );

  const r = m.revenue;
  const ex = m.excluded;
  const excludedText = [
    ex.vendors ? `${ex.vendors} vendor${ex.vendors === 1 ? '' : 's'}` : '',
    ex.parents ? `${ex.parents} parent${ex.parents === 1 ? '' : 's'}` : '',
    ex.bookings ? `${ex.bookings} booking${ex.bookings === 1 ? '' : 's'}` : '',
    ex.sales ? `${ex.sales} sale${ex.sales === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');

  return (
    <div>
      <AttentionCard onOpenParents={onOpenParents} onGoTab={onGoTab} />

      {section('Revenue and commission', [
        ['Gross sales', sgd(r.gross), C.text, `${r.sales} paid sale${r.sales === 1 ? '' : 's'}`],
        ['BabyBrain commission', sgd(r.commission), C.green, 'Before Stripe fees'],
        ['Commission collected', sgd(r.commissionCollected), C.green, 'Taken automatically by Stripe'],
        ['Commission to collect', sgd(r.commissionToCollect), C.pink, 'On sales we settle manually'],
        ["Stripe's fees", sgd(r.stripeFees), C.muted],
        ['Vendor net', sgd(r.vendorNet), C.text],
        ['Last 7 days', sgd(r.last7.gross), C.blue, `${r.last7.sales} sales · ${sgd(r.last7.commission)} commission`],
        ['Last 30 days', sgd(r.last30.gross), C.blue, `${r.last30.sales} sales · ${sgd(r.last30.commission)} commission`],
      ])}

      {section('Growth', [
        ['Parents', m.totals.parents, C.blue, undefined, P({})],
        ['New parents (7d)', m.growth.newParents7, C.blue, undefined, P({ joined_from: sgDay_(7 * 864e5) })],
        ['New parents (30d)', m.growth.newParents30, C.blue, undefined, P({ joined_from: sgDay_(30 * 864e5) })],
        ['Parents who booked', m.growth.parentsWhoBooked, C.pink, m.totals.parents ? `${pctText(m.growth.parentsWhoBooked / m.totals.parents)} of parents` : undefined, P({ activity: 'booked' })],
        ['Vendors (active)', m.totals.activeProviders, C.green, `${m.totals.providers} in total`],
        ['New vendors (30d)', m.growth.newVendors30, C.blue],
        ['Activated vendors', m.growth.activatedVendors, C.green, 'Live class and a booking'],
      ])}

      {section('Booking health', [
        ['Bookings today', m.bookings.today, C.pink, undefined, B({ date_by: 'booked', from: sgDay_(0), to: sgDay_(0) })],
        ['Bookings (7d)', m.bookings.last7, C.pink, undefined, B({ date_by: 'booked', from: sgDay_(6 * 864e5), to: sgDay_(0) })],
        ['Bookings (30d)', m.health.bookings30, C.pink, undefined, B({ date_by: 'booked', from: sgDay_(30 * 864e5), to: sgDay_(0) })],
        ['Bookings (all)', m.totals.bookings, C.muted, undefined, B({})],
        ['Manual bookings', m.health.bookingSplit.manual, C.blue, 'Added by vendors, no parent account', B({ pay: 'manual' })],
        ['Paid bookings', m.health.bookingSplit.paid, C.green, `${sgdDollars(m.health.bookingSplit.paidAmount)} paid online`, B({ pay: 'amount' })],
        ['Free / package', m.health.bookingSplit.other, C.muted, 'Free classes and package credits', B({ pay: 'free,credit,token,unpaid' })],
        ['Cancellation rate (30d)', pctText(m.health.cancellationRate), C.text, `${m.health.cancelled30} cancelled`, B({ status: 'cancelled', date_by: 'booked', from: sgDay_(30 * 864e5), to: sgDay_(0) })],
        ['Upcoming fill rate', pctText(m.health.upcomingFillRate), C.green, `${m.health.upcomingSessions} sessions with a capacity`],
        ['On waitlists', m.health.waitlisted, C.muted, undefined, B({ status: 'waitlisted' })],
        ['Activities', m.totals.activities, C.muted],
        ['Reviews', m.totals.reviews, C.muted],
      ])}

      {section('Subscriptions', [
        ['Plus subscribers', m.subscriptions.plusActive, C.green, `${m.subscriptions.plusPastDue} past due · ${m.subscriptions.plusCanceled} cancelled`, P({ plan: 'plus' })],
        ['Vendors on Pro', m.subscriptions.vendorPro, C.green],
        ['Vendors on Premium', m.subscriptions.vendorPremium, C.green],
        ['Vendor plans at risk', m.subscriptions.vendorPastDue, C.pink, `${m.subscriptions.vendorCanceled} cancelled`],
      ])}

      <ActivityChart daily={m.daily} onOpenParents={onOpenParents} onOpenBookings={onOpenBookings} />

      <div style={{ marginTop: 22 }}>
        <TestDataBar includeTest={includeTest} setIncludeTest={setIncludeTest} excluded={excludedText} />
      </div>
    </div>
  );
}

