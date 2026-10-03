import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileCheck, Gift, Info, MessageSquare,
  Search, Shield, SlidersHorizontal, XCircle, Clock,
} from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { MultiSelectField } from '@/components/ui/multi-select-field';
import { SelectField, Opt } from '@/components/ui/select-field';
import { DatePicker } from '@/components/ui/date-picker';
import { RainbowLoader } from '@/components/ui/rainbow-loader';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { cacheGet, cacheSet } from '@/lib/queryCache';
import { apiPost, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import type { Database } from '@/lib/database.types';

/**
 * Bookings "Tabular view": every booking across all of the provider's sessions in
 * one table, with multi-select Filter, Sort and Group by that all apply together.
 * One row per booking group (a multi-child party is a single row, each child with
 * its own status). Clicking the parent's name opens a detail drawer.
 *
 * Data comes from provider_bookings_table (migration 00216): the last
 * PAST_DAYS days onward, capped at ROW_CAP rows. Everything else is client-side.
 */

type TableRow = Database['public']['Functions']['provider_bookings_table']['Returns'][number];
type Seat = TableRow['children'][number];

const PAST_DAYS = 30;
const ROW_CAP = 2000;
const PAGE = 100;
const TZ = 'Asia/Singapore';

const sgDateKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const sgTodayKey = () => sgDateKey(new Date().toISOString());
const sgKeyShift = (key: string, days: number) => {
  const d = new Date(`${key}T00:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
};
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-SG', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtBooked = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const ageLabel = (m: number | null) => (m == null ? '' : m < 24 ? `${m}m` : `${Math.round(m / 12)}y`);

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed', pending: 'Pending', waitlisted: 'Waitlisted', cancelled: 'Cancelled', completed: 'Completed',
};
const STATUS_RANK: Record<string, number> = { confirmed: 0, pending: 1, completed: 2, waitlisted: 3, cancelled: 4 };
const STATUS_CLS: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-800',
  waitlisted: 'bg-amber-100 text-amber-800',
  cancelled: 'bg-red-100 text-red-700',
  completed: 'bg-gray-100 text-gray-600',
};
const PAY_DETAIL: Record<string, string> = {
  cash: 'Paid', credit: 'Package credit', token: 'Make-up token', refunded: 'Refunded', free: 'Free', none: 'Unpaid',
};

type DateBucket = 'today' | 'week' | 'later' | 'past';
const DATE_OPTS: { value: DateBucket; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Next 7 days' },
  { value: 'later', label: 'Later' },
  { value: 'past', label: `Past ${PAST_DAYS} days` },
];

type FilterKey = 'status' | 'activity' | 'source' | 'date' | 'location';
type SortKey = 'slot' | 'parent' | 'activity' | 'booked' | 'location' | 'status';
type GroupKey = 'activity' | 'slot' | 'location' | 'status' | 'source';
type SortSpec = { key: SortKey; dir: 'asc' | 'desc' };
const EMPTY_FILTERS: Record<FilterKey, string[]> = { status: [], activity: [], source: [], location: [], date: [] };
const DEFAULT_SORT: SortSpec[] = [{ key: 'slot', dir: 'asc' }];

const SORT_LABEL: Record<SortKey, string> = {
  slot: 'Slot date', parent: 'Parent name', activity: 'Activity', booked: 'Booking date', location: 'Location', status: 'Status',
};
const GROUP_LABEL: Record<GroupKey, string> = {
  activity: 'Activity', slot: 'Slot date', location: 'Location', status: 'Status', source: 'Source',
};

const parentName = (g: TableRow) => g.parent_name || g.children[0]?.name || 'Guest';
const sourceOf = (g: TableRow) => (g.wix_service_type ? 'Wix' : g.is_manual ? 'Manual' : 'BabyBrain');
const locationOf = (g: TableRow) => g.location || 'No location';
const bucketOf = (g: TableRow, today: string): DateBucket => {
  const k = sgDateKey(g.starts_at);
  if (k === today) return 'today';
  if (k < today) return 'past';
  return k <= sgKeyShift(today, 7) ? 'week' : 'later';
};
const bestStatus = (g: TableRow) =>
  g.children.reduce((best, c) => (STATUS_RANK[c.status] < STATUS_RANK[best] ? c.status : best), g.children[0]?.status ?? 'cancelled');
// A party whose seats sit in different states groups under "Mixed".
const groupStatus = (g: TableRow) => {
  const set = new Set(g.children.map((c) => c.status));
  return set.size > 1 ? 'Mixed' : STATUS_LABEL[bestStatus(g)] ?? bestStatus(g);
};

function cmp(a: TableRow, b: TableRow, key: SortKey): number {
  switch (key) {
    case 'slot': return a.starts_at.localeCompare(b.starts_at);
    case 'parent': return parentName(a).localeCompare(parentName(b), undefined, { sensitivity: 'base' });
    case 'activity': return a.activity_title.localeCompare(b.activity_title, undefined, { sensitivity: 'base' });
    case 'booked': return a.booked_at.localeCompare(b.booked_at);
    case 'location': return locationOf(a).localeCompare(locationOf(b), undefined, { sensitivity: 'base' });
    case 'status': return STATUS_RANK[bestStatus(a)] - STATUS_RANK[bestStatus(b)];
  }
}

/** Label plus a sortable key for one group-by level. */
function groupOf(g: TableRow, key: GroupKey): { label: string; sort: string } {
  switch (key) {
    case 'activity': return { label: g.activity_title, sort: g.activity_title.toLowerCase() };
    case 'slot': return { label: fmtDay(g.starts_at) + ' ' + new Date(g.starts_at).toLocaleDateString('en-SG', { timeZone: TZ, year: 'numeric' }), sort: sgDateKey(g.starts_at) };
    case 'location': return { label: locationOf(g), sort: locationOf(g).toLowerCase() };
    case 'status': return { label: groupStatus(g), sort: String(STATUS_RANK[bestStatus(g)] ?? 9) };
    case 'source': return { label: sourceOf(g), sort: sourceOf(g) };
  }
}

type GroupNode = { id: string; label: string; depth: number; count: number };
type FlatItem = { kind: 'group'; node: GroupNode } | { kind: 'row'; row: TableRow; depth: number };

function buildFlat(rows: TableRow[], keys: GroupKey[], collapsed: Set<string>): FlatItem[] {
  if (!keys.length) return rows.map((row) => ({ kind: 'row', row, depth: 0 }));
  const out: FlatItem[] = [];
  const walk = (list: TableRow[], level: number, path: string) => {
    if (level === keys.length) {
      list.forEach((row) => out.push({ kind: 'row', row, depth: level }));
      return;
    }
    const buckets = new Map<string, { label: string; sort: string; rows: TableRow[] }>();
    for (const r of list) {
      const { label, sort } = groupOf(r, keys[level]);
      const b = buckets.get(label) ?? { label, sort, rows: [] };
      b.rows.push(r);
      buckets.set(label, b);
    }
    [...buckets.values()]
      .sort((a, b) => a.sort.localeCompare(b.sort))
      .forEach((b) => {
        const id = `${path}/${keys[level]}:${b.label}`;
        out.push({ kind: 'group', node: { id, label: b.label, depth: level, count: b.rows.length } });
        if (!collapsed.has(id)) walk(b.rows, level + 1, id);
      });
  };
  walk(rows, 0, '');
  return out;
}

function StatusChip({ seat }: { seat: Seat }) {
  const base = STATUS_LABEL[seat.status] ?? seat.status;
  const label = seat.status === 'waitlisted' && seat.waitlist_position ? `Waitlist #${seat.waitlist_position}` : base;
  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS_CLS[seat.status] ?? 'bg-gray-100 text-gray-600')}>
      {label}
    </span>
  );
}

const Tag = ({ className, children }: { className: string; children: React.ReactNode }) => (
  <span className={cn('ml-1.5 rounded px-1.5 py-0.5 align-middle text-[10px] font-medium', className)}>{children}</span>
);

export default function BookingsTable({ providerId, canManage }: { providerId: string; canManage: boolean }) {
  const cacheKey = `bk-table:${providerId}`;
  const warm = cacheGet<TableRow[]>(cacheKey);
  const [rows, setRows] = useState<TableRow[]>(warm?.data ?? []);
  const [loading, setLoading] = useState(!warm);
  const [error, setError] = useState<string | null>(null);

  // No date chosen = "today onward" (see `visible`), so the default view stays upcoming.
  const [filters, setFilters] = useState<Record<FilterKey, string[]>>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [more, setMore] = useState(false);
  const [sorts, setSorts] = useState<SortSpec[]>(DEFAULT_SORT);
  const [groupBy, setGroupBy] = useState<GroupKey[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [openKey, setOpenKey] = useState<string | null>(null);

  /* Opening "More filters" makes the page taller, which would add a scrollbar to
     the portal's scroll area mid-click, narrow everything by its width and reflow
     the toolbar. Reserve that space for as long as this view is on screen. */
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = rootRef.current?.closest('main');
    if (!scroller) return;
    const prev = scroller.style.scrollbarGutter;
    scroller.style.scrollbarGutter = 'stable';
    return () => { scroller.style.scrollbarGutter = prev; };
  }, []);

  const load = useCallback(async () => {
    const from = new Date(`${sgKeyShift(sgTodayKey(), -PAST_DAYS)}T00:00:00+08:00`).toISOString();
    const { data, error: err } = await supabase.rpc('provider_bookings_table', {
      p_provider: providerId, p_from: from, p_limit: ROW_CAP,
    });
    if (err) { setError(err.message); setLoading(false); return; }
    setError(null);
    const list = (data ?? []) as TableRow[];
    setRows(list);
    cacheSet(cacheKey, list);
    setLoading(false);
  }, [providerId, cacheKey]);
  useEffect(() => { load(); }, [load]);

  const today = sgTodayKey();
  const options = useMemo(() => ({
    activity: [...new Set(rows.map((r) => r.activity_title))].sort(),
    location: [...new Set(rows.map(locationOf))].sort(),
  }), [rows]);

  const visible = useMemo(() => {
    const f = filters;
    const q = search.trim().toLowerCase();
    const anyDate = f.date.length > 0 || !!from || !!to;
    const list = rows.filter((g) => {
      const day = sgDateKey(g.starts_at);
      return (
        (!q || parentName(g).toLowerCase().includes(q) || g.children.some((c) => c.name.toLowerCase().includes(q))) &&
        (!f.status.length || g.children.some((c) => f.status.includes(c.status))) &&
        (!f.activity.length || f.activity.includes(g.activity_title)) &&
        (!f.source.length || f.source.includes(sourceOf(g))) &&
        (!f.location.length || f.location.includes(locationOf(g))) &&
        (anyDate ? (!f.date.length || f.date.includes(bucketOf(g, today))) : bucketOf(g, today) !== 'past') &&
        (!from || day >= from) && (!to || day <= to)
      );
    });
    return list.sort((a, b) => {
      for (const s of sorts) {
        const c = cmp(a, b, s.key);
        if (c) return s.dir === 'asc' ? c : -c;
      }
      return 0;
    });
  }, [rows, filters, search, from, to, sorts, today]);

  const flat = useMemo(() => buildFlat(visible, groupBy, collapsed), [visible, groupBy, collapsed]);
  // Page by booking rows, not by group headers, so a collapsed group never eats the budget.
  const items = useMemo(() => {
    let n = 0;
    const out: FlatItem[] = [];
    for (const it of flat) {
      if (it.kind === 'row') { if (n >= shown) break; n++; }
      out.push(it);
    }
    return out;
  }, [flat, shown]);
  const rowCount = flat.filter((i) => i.kind === 'row').length;

  const setFilter = (key: FilterKey, v: string[]) => setFilters((p) => ({ ...p, [key]: v }));
  const toggleIn = (key: FilterKey, v: string) => setFilter(key, filters[key].includes(v) ? filters[key].filter((x) => x !== v) : [...filters[key], v]);
  const sortIsDefault = sorts.length === 1 && sorts[0].key === 'slot' && sorts[0].dir === 'asc';
  // What the "More filters" button counts: everything inside the panel, not the two inline filters.
  const moreCount =
    filters.activity.length + filters.location.length + filters.date.length + (from ? 1 : 0) + (to ? 1 : 0) +
    groupBy.length + (sortIsDefault ? 0 : sorts.length);
  const toggleSort = (key: SortKey) =>
    setSorts((p) => (p.some((s) => s.key === key) ? p.filter((s) => s.key !== key) : [...p, { key, dir: 'asc' }]));
  const flipSort = (key: SortKey) =>
    setSorts((p) => p.map((s) => (s.key === key ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' } : s)));
  const toggleGroup = (key: GroupKey) => {
    setGroupBy((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]));
    setCollapsed(new Set());
  };
  const resetAll = () => {
    setFilters(EMPTY_FILTERS); setSearch(''); setFrom(''); setTo(''); setSorts(DEFAULT_SORT); setGroupBy([]); setCollapsed(new Set());
  };
  const anyActive = moreCount > 0 || filters.status.length > 0 || filters.source.length > 0 || !!search;

  const open = rows.find((r) => r.group_key === openKey) ?? null;
  const colSpan = 6;

  return (
    <div ref={rootRef}>
      {/* A fixed grid, not a wrapping flex row, so no control changes position when
          the panel below opens or the More filters label gains a count. */}
      <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_12rem_11rem]">
        <div className="relative min-w-0">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search parent or child…"
            aria-label="Search bookings"
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-pink-300"
          />
        </div>
        <div className="min-w-0">
          <MultiSelectField values={filters.status} onChange={(v) => setFilter('status', v)} allLabel="All statuses" placeholder="All statuses" aria-label="Status" className="w-full">
            {Object.entries(STATUS_LABEL).map(([v, l]) => <Opt key={v} value={v}>{l}</Opt>)}
          </MultiSelectField>
        </div>
        <div className="min-w-0">
          <MultiSelectField values={filters.source} onChange={(v) => setFilter('source', v)} allLabel="All sources" placeholder="All sources" aria-label="Source" className="w-full">
            {['BabyBrain', 'Wix', 'Manual'].map((v) => <Opt key={v} value={v}>{v}</Opt>)}
          </MultiSelectField>
        </div>
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          className={cn(
            'inline-flex h-[42px] w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border px-3 text-sm font-medium hover:bg-gray-50',
            more || moreCount ? 'border-[#FA4D8D] bg-pink-50 text-[#C90044]' : 'border-gray-200 bg-white text-gray-700',
          )}
        >
          <SlidersHorizontal className="h-4 w-4" />
          More filters{moreCount ? ` · ${moreCount}` : ''}
          <ChevronDown className={cn('h-4 w-4 transition-transform', more && 'rotate-180')} />
        </button>
      </div>

      {more && (
        <div className="mt-3 space-y-5 rounded-xl border border-gray-200 bg-white p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <MoreField label="Activity">
              <MultiSelectField values={filters.activity} onChange={(v) => setFilter('activity', v)} allLabel="All activities" placeholder="All activities" aria-label="Activity" className="w-full">
                {options.activity.map((v) => <Opt key={v} value={v}>{v}</Opt>)}
              </MultiSelectField>
            </MoreField>
            <MoreField label="Location">
              <MultiSelectField values={filters.location} onChange={(v) => setFilter('location', v)} allLabel="All locations" placeholder="All locations" aria-label="Location" className="w-full">
                {options.location.map((v) => <Opt key={v} value={v}>{v}</Opt>)}
              </MultiSelectField>
            </MoreField>
            <MoreField label="Quick date range">
              <MultiSelectField values={filters.date} onChange={(v) => setFilter('date', v)} allLabel="Today onward" placeholder="Today onward" aria-label="Quick date range" className="w-full">
                {DATE_OPTS.map((o) => <Opt key={o.value} value={o.value}>{o.label}</Opt>)}
              </MultiSelectField>
            </MoreField>
            <MoreField label="Slot from">
              <DatePicker value={from} onChange={setFrom} min={sgKeyShift(today, -PAST_DAYS)} max={to || undefined} aria-label="Slot from" className="w-full px-3 py-2" />
            </MoreField>
            <MoreField label="Slot to">
              <DatePicker value={to} onChange={setTo} min={from || sgKeyShift(today, -PAST_DAYS)} aria-label="Slot to" className="w-full px-3 py-2" />
            </MoreField>
          </div>

          <div className="grid gap-5 border-t border-gray-100 pt-4 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium text-gray-500">Sort by</div>
              <p className="mb-2 text-xs text-gray-400">Pick several; they apply in the order you pick them. Use the arrow to flip direction.</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => {
                  const idx = sorts.findIndex((s) => s.key === k);
                  const on = idx >= 0;
                  return (
                    <span key={k} className={cn('inline-flex items-center overflow-hidden rounded-lg border text-sm', on ? 'border-[#FA4D8D] bg-pink-50 text-[#C90044]' : 'border-gray-200 bg-white text-gray-700')}>
                      <button type="button" onClick={() => toggleSort(k)} aria-pressed={on} className="px-3 py-1.5 hover:bg-black/[0.03]">
                        {on && <span className="mr-1.5 text-xs font-medium">{idx + 1}</span>}{SORT_LABEL[k]}
                      </button>
                      {on && (
                        <button
                          type="button"
                          onClick={() => flipSort(k)}
                          aria-label={`${SORT_LABEL[k]}: ${sorts[idx].dir === 'asc' ? 'ascending' : 'descending'}. Flip`}
                          className="border-l border-[#FA4D8D]/30 px-2 py-2 hover:bg-black/[0.03]"
                        >
                          {sorts[idx].dir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-gray-500">Group by</div>
              <p className="mb-2 text-xs text-gray-400">Pick several to nest groups in the order you pick them.</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(GROUP_LABEL) as GroupKey[]).map((k) => {
                  const idx = groupBy.indexOf(k);
                  const on = idx >= 0;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggleGroup(k)}
                      aria-pressed={on}
                      className={cn('rounded-lg border px-3 py-1.5 text-sm', on ? 'border-[#FA4D8D] bg-pink-50 text-[#C90044]' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50')}
                    >
                      {on && <span className="mr-1.5 text-xs font-medium">{idx + 1}</span>}{GROUP_LABEL[k]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex justify-end border-t border-gray-100 pt-3">
            <button
              type="button"
              onClick={resetAll}
              disabled={!anyActive && sortIsDefault}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Clear all filters
            </button>
          </div>
        </div>
      )}

      <div className="mb-3 mt-4 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 text-sm text-gray-500">{rowCount} {rowCount === 1 ? 'booking' : 'bookings'}</span>
        {(['activity', 'location', 'date'] as FilterKey[]).flatMap((k) =>
          filters[k].map((v) => (
            <button
              key={`${k}:${v}`}
              onClick={() => toggleIn(k, v)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-50"
            >
              <span className="capitalize text-gray-400">{k}:</span>
              {k === 'date' ? DATE_OPTS.find((o) => o.value === v)?.label : v} ×
            </button>
          )),
        )}
        {(from || to) && (
          <button
            onClick={() => { setFrom(''); setTo(''); }}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-50"
          >
            <span className="text-gray-400">Slot:</span>{from || 'any'} to {to || 'any'} ×
          </button>
        )}
        {groupBy.length > 0 && <span className="ml-1 text-gray-500">Grouped by {groupBy.map((k) => GROUP_LABEL[k]).join(' › ')}</span>}
      </div>

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Couldn't load bookings. {error}</p>}
      {loading && <RainbowLoader className="py-6" label="Loading bookings" />}

      {!loading && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full min-w-[860px] table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[16%]" /><col className="w-[22%]" /><col className="w-[18%]" />
              <col className="w-[14%]" /><col className="w-[15%]" /><col className="w-[15%]" />
            </colgroup>
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500">
                <th className="px-3 py-2.5">Parent</th>
                <th className="px-3 py-2.5">Children and status</th>
                <th className="px-3 py-2.5">Activity</th>
                <th className="px-3 py-2.5">Slot</th>
                <th className="px-3 py-2.5">Location</th>
                <th className="px-3 py-2.5">Booked on</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) =>
                it.kind === 'group' ? (
                  <tr key={it.node.id} className="border-y-2 border-gray-300 bg-gray-50">
                    <td colSpan={colSpan} className="p-0">
                      <button
                        onClick={() => setCollapsed((p) => { const n = new Set(p); if (!n.delete(it.node.id)) n.add(it.node.id); return n; })}
                        style={{ paddingLeft: 12 + it.node.depth * 20 }}
                        className="flex w-full items-center gap-1.5 py-2 pr-3 text-left text-sm font-medium text-gray-800"
                      >
                        {collapsed.has(it.node.id) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        {it.node.label}
                        <span className="font-normal text-gray-500">· {it.node.count}</span>
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={it.row.group_key} className="border-t border-gray-100 align-top hover:bg-gray-50/60">
                    <td className="px-3 py-2.5" style={{ paddingLeft: 12 + it.depth * 20 }}>
                      <button
                        onClick={() => setOpenKey(it.row.group_key)}
                        className="max-w-full truncate text-left font-medium text-[#C90044] underline decoration-pink-200 underline-offset-4 hover:decoration-[#FA4D8D]"
                      >
                        {parentName(it.row)}
                      </button>
                      {it.row.is_manual && <Tag className="bg-blue-100 text-blue-700">Manual</Tag>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="space-y-1">
                        {it.row.children.map((c) => (
                          <div key={c.booking_id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-gray-800">{c.name}{c.age_months != null && <span className="text-gray-400">, {ageLabel(c.age_months)}</span>}</span>
                            <StatusChip seat={c} />
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-800">
                      <span className="break-words">{it.row.activity_title}</span>
                      {it.row.wix_service_type && <Tag className="bg-blue-100 text-blue-800">Wix</Tag>}
                      {it.row.children.length > 1 && <Tag className="bg-purple-100 text-purple-800">Party</Tag>}
                    </td>
                    <td className="px-3 py-2.5 text-gray-800">
                      <div>{fmtDay(it.row.starts_at)}</div>
                      <div className="text-xs text-gray-500">{fmtTime(it.row.starts_at)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-700"><span className="break-words">{it.row.location || '—'}</span></td>
                    <td className="px-3 py-2.5 text-gray-700">{fmtBooked(it.row.booked_at)}</td>
                  </tr>
                ),
              )}
              {rowCount === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-gray-400">
                    {rows.length === 0 ? 'No bookings yet.' : 'No bookings match these filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && shown < rowCount && (
        <div className="mt-3 text-center">
          <button
            onClick={() => setShown((n) => n + PAGE)}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Show more ({rowCount - shown} left)
          </button>
        </div>
      )}
      {!loading && rows.length >= ROW_CAP && (
        <p className="mt-3 text-xs text-gray-500">Showing the first {ROW_CAP} bookings in this period. Narrow the date filter to see the rest.</p>
      )}

      <Sheet open={!!open} onOpenChange={(o) => { if (!o) setOpenKey(null); }}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto bg-white sm:max-w-md">
          {open && <ParentDrawer group={open} providerId={providerId} canManage={canManage} onChanged={load} onClose={() => setOpenKey(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ---------------------------------- drawer ---------------------------------- */

function ParentDrawer({ group, providerId, canManage, onChanged, onClose }: {
  group: TableRow; providerId: string; canManage: boolean; onChanged: () => void; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [messaging, setMessaging] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);

  // Same route and wording as the Roster view's "Message parent".
  async function messageParent() {
    if (!group.user_id) return;
    setMessageError(null);
    setMessaging(true);
    try {
      const { channelId } = await apiPost<{ channelId: string }>('/api/vendor/chat/open', {
        provider_id: providerId, parent_user_id: group.user_id,
      });
      if (!channelId) { setMessageError('Chat could not be opened just now. Try again.'); return; }
      navigate(`/messages?channel=${channelId}`);
    } catch (e) {
      setMessageError(
        e instanceof ApiError && e.status === 401
          ? 'Your session has expired. Sign out and back in, then try again.'
          : e instanceof ApiError && e.message ? e.message : 'Could not open the chat. Try again.',
      );
    } finally {
      setMessaging(false);
    }
  }

  return (
    <>
      <SheetHeader className="border-b border-gray-100 p-5 pr-12">
        <SheetTitle className="text-lg text-gray-900">{parentName(group)}</SheetTitle>
        <SheetDescription className="text-sm text-gray-500">
          {group.is_manual ? `Manual booking${group.parent_contact ? ` · ${group.parent_contact}` : ''}` : 'Parent account'}
        </SheetDescription>
        <div className="mt-2 space-y-1 text-sm text-gray-700">
          <div>
            <span className="font-medium">{group.activity_title}</span>
            {group.wix_service_type && <Tag className="bg-blue-100 text-blue-800">Wix</Tag>}
            {group.children.length > 1 && <Tag className="bg-purple-100 text-purple-800">Party</Tag>}
          </div>
          <div className="text-gray-600">{fmtDateTime(group.starts_at)}{group.location ? ` · ${group.location}` : ''}</div>
          <div className="text-xs text-gray-500">Booked {fmtBooked(group.booked_at)}</div>
        </div>
        <div className="mt-3">
          {group.user_id ? (
            <button
              onClick={messageParent}
              disabled={messaging}
              className="inline-flex items-center gap-2 rounded-lg bg-[#FA4D8D] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              <MessageSquare className="h-4 w-4" /> {messaging ? 'Opening chat…' : 'Message parent'}
            </button>
          ) : (
            <button disabled title="Manual bookings have no parent account to message"
              className="inline-flex cursor-not-allowed items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-400">
              <MessageSquare className="h-4 w-4" /> Message parent
            </button>
          )}
          {messageError && <p className="mt-2 text-xs font-medium text-red-600">{messageError}</p>}
        </div>
      </SheetHeader>

      <div className="space-y-5 p-5">
        {group.children.map((seat) => (
          <SeatCard
            key={seat.booking_id}
            seat={seat}
            group={group}
            heading={group.children.length > 1}
            canManage={canManage}
            providerId={providerId}
            onChanged={onChanged}
            onClose={onClose}
          />
        ))}
      </div>
    </>
  );
}

function SeatCard({ seat, group, heading, canManage, providerId, onChanged, onClose }: {
  seat: Seat; group: TableRow; heading: boolean; canManage: boolean; providerId: string;
  onChanged: () => void; onClose: () => void;
}) {
  const navigate = useNavigate();
  const { session } = useAuth();

  const [waivers, setWaivers] = useState<{ policy_id: string; policy_title: string; accepted_at: string }[] | null>(null);
  const [tokenStatus, setTokenStatus] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const [{ data: w }, { data: t }] = await Promise.all([
        seat.policies_accepted > 0
          ? supabase.from('booking_policy_acceptances').select('policy_id, policy_title, accepted_at').eq('booking_id', seat.booking_id).order('accepted_at')
          : Promise.resolve({ data: [] as { policy_id: string; policy_title: string; accepted_at: string }[] }),
        supabase.from('make_up_tokens').select('status').eq('origin_booking_id', seat.booking_id).limit(1),
      ]);
      if (!live) return;
      setWaivers(w ?? []);
      setTokenStatus(t?.[0]?.status ?? null);
    })();
    return () => { live = false; };
  }, [seat.booking_id, seat.policies_accepted]);

  /* Cancel — same update the Roster view makes: the compensate_cancelled_booking
     trigger hands back a package credit / make-up token when `refund` is chosen. */
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelMode, setCancelMode] = useState<'refund' | 'none'>('refund');
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function cancel() {
    if (cancelMode === 'none' && !cancelReason.trim()) { setErr('A reason is required when cancelling with no refund.'); return; }
    setBusy(true);
    const { error } = await supabase.from('bookings').update({
      status: 'cancelled',
      cancel_refund_mode: cancelMode,
      cancel_reason: cancelMode === 'none' ? cancelReason.trim() : null,
      cancelled_by: session?.user.id ?? null,
    }).eq('id', seat.booking_id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setErr(null);
    setCancelOpen(false);
    onChanged();
    if (group.children.length === 1) onClose();
  }

  /* Make-up token — same insert and expiry choices as the Roster view. */
  const [expiry, setExpiry] = useState('60');
  const [expiryDate, setExpiryDate] = useState('');
  const [issuing, setIssuing] = useState(false);
  async function issueToken() {
    if (!group.user_id) { setErr("This booking has no parent account, so a token can't be issued for it."); return; }
    let expiresAt: string | null;
    if (expiry === 'none') expiresAt = null;
    else if (expiry === 'custom') {
      const d = expiryDate ? new Date(`${expiryDate}T23:59:59+08:00`) : null;
      if (!d || Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) { setErr('Pick an expiry date in the future.'); return; }
      expiresAt = d.toISOString();
    } else expiresAt = new Date(Date.now() + Number(expiry) * 864e5).toISOString();
    setIssuing(true);
    setErr(null);
    const { error } = await supabase.from('make_up_tokens').insert({
      provider_id: providerId,
      user_id: group.user_id,
      child_id: seat.child_id,
      origin_booking_id: seat.booking_id,
      status: 'issued',
      issued_by: session?.user.id ?? null,
      expires_at: expiresAt,
    });
    setIssuing(false);
    if (error) { setErr(error.message); return; }
    setTokenStatus('issued');
  }

  const payKey = seat.paid_via && seat.paid_via in PAY_DETAIL ? seat.paid_via : 'none';

  return (
    <section className={cn('space-y-4', heading && 'rounded-xl border border-gray-200 p-4')}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900">
          {seat.name}{seat.age_months != null && <span className="font-normal text-gray-500">, {ageLabel(seat.age_months)}</span>}
        </h3>
        <StatusChip seat={seat} />
      </div>

      <Field label="Payment">{PAY_DETAIL[payKey]}</Field>

      <Field label="Medical disclosure">
        <div className={cn('flex items-start gap-2 rounded-lg px-3 py-2', seat.has_medical ? 'bg-purple-50' : 'bg-gray-50')}>
          <Shield className={cn('mt-0.5 h-4 w-4 shrink-0', seat.has_medical ? 'text-purple-600' : 'text-gray-400')} />
          <span className={cn('whitespace-pre-wrap text-sm', seat.has_medical ? 'text-purple-700' : 'text-gray-500')}>
            {seat.medical_disclosure || (seat.has_medical ? 'On file' : 'None provided')}
          </span>
        </div>
      </Field>

      {seat.info_response && (
        <Field label="Information you requested">
          <div className="flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
            <span className="whitespace-pre-wrap text-sm text-blue-800">{seat.info_response}</span>
          </div>
        </Field>
      )}

      <Field label="Waivers and consents">
        {seat.policies_accepted > 0 ? (
          <div className="space-y-1.5 rounded-lg bg-green-50 px-3 py-2">
            {waivers === null ? (
              <RainbowLoader size="sm" className="justify-start py-0.5" label="Loading waivers" />
            ) : (
              waivers.map((p) => (
                <div key={p.policy_id} className="flex items-start gap-2">
                  <FileCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  <div className="text-sm text-green-700">
                    {p.policy_title}
                    <span className="block text-xs text-green-600/80">Accepted {fmtDateTime(p.accepted_at)}</span>
                  </div>
                </div>
              ))
            )}
            <button
              type="button"
              onClick={() => navigate('/settings?tab=policies')}
              className="text-xs font-medium text-green-700 underline underline-offset-2 hover:text-green-800"
            >
              View waivers and consents →
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
            <FileCheck className="h-4 w-4 text-gray-400" />
            <span className="text-sm text-gray-500">{group.is_manual ? 'Manual booking, collected offline' : 'None on file'}</span>
          </div>
        )}
      </Field>

      <Field label="Attendance">
        <div className="flex items-center gap-2 text-sm capitalize text-gray-700">
          <Clock className="h-4 w-4 text-yellow-500" />{seat.attendance_status ?? 'Not marked'}
        </div>
      </Field>

      {canManage && (
        <Field label="Make-up token">
          {tokenStatus ? (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Gift className="h-4 w-4" />{tokenStatus === 'redeemed' ? 'Redeemed' : `Issued${tokenStatus !== 'issued' ? ` (${tokenStatus})` : ''}`}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">Expires</span>
                <SelectField value={expiry} onChange={setExpiry} aria-label="Token expiry" className="px-2 py-1 text-xs text-gray-700">
                  <Opt value="30">in 30 days</Opt>
                  <Opt value="60">in 60 days</Opt>
                  <Opt value="90">in 90 days</Opt>
                  <Opt value="180">in 6 months</Opt>
                  <Opt value="365">in 12 months</Opt>
                  <Opt value="custom">on a set date…</Opt>
                  <Opt value="none">never</Opt>
                </SelectField>
                {expiry === 'custom' && (
                  <DatePicker value={expiryDate} onChange={setExpiryDate} aria-label="Token expiry date" className="px-2 py-1 text-xs text-gray-700" />
                )}
              </div>
              <button
                onClick={issueToken}
                disabled={issuing}
                className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 disabled:opacity-60"
              >
                <Gift className="h-4 w-4" /> {issuing ? 'Issuing…' : 'Issue make-up token'}
              </button>
            </div>
          )}
        </Field>
      )}

      {canManage && seat.status !== 'cancelled' && (
        <div className="border-t border-gray-100 pt-3">
          {cancelOpen ? (
            <div className="space-y-3">
              <div className="text-sm font-medium text-gray-900">Cancel {seat.name}&rsquo;s booking</div>
              <p className="text-xs text-gray-500">The parent is notified and the place is freed either way.</p>
              <SelectField value={cancelMode} onChange={(v) => setCancelMode(v as 'refund' | 'none')} aria-label="Refund" className="h-9 w-full px-3">
                <Opt value="refund">Refund as package credit / make-up token</Opt>
                <Opt value="none">No refund</Opt>
              </SelectField>
              {cancelMode === 'none' && (
                <div className="space-y-2">
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                    Payment for this activity is non-refundable, if cancelled. No package credit or make-up token is returned.
                  </p>
                  <textarea
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    rows={2}
                    placeholder="Why is no refund being given?"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={cancel}
                  disabled={busy || (cancelMode === 'none' && !cancelReason.trim())}
                  className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {busy ? 'Cancelling…' : 'Confirm cancellation'}
                </button>
                <button
                  onClick={() => { setCancelOpen(false); setErr(null); }}
                  className="h-9 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Keep booking
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setErr(null); setCancelMode('refund'); setCancelReason(''); setCancelOpen(true); }}
              className="inline-flex items-center gap-2 text-sm font-medium text-red-600 hover:text-red-700"
            >
              <XCircle className="h-4 w-4" /> Cancel this booking
            </button>
          )}
        </div>
      )}
      {err && <p className="text-xs font-medium text-red-600">{err}</p>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-gray-500">{label}</div>
      <div className="text-sm text-gray-700">{children}</div>
    </div>
  );
}

function MoreField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-gray-500">{label}</div>
      {children}
    </div>
  );
}
