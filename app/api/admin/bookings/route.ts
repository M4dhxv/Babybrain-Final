import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadBookings, type AdminBooking } from '@/lib/admin-bookings';

/**
 * Admin → Bookings. One entry per booking (a multi-child booking is one entry), filtered, sorted and
 * paged here from a short-lived in-memory build (lib/admin-bookings.ts). Read-only. Admin only.
 *
 *   q          text in name, email, vendor or activity
 *   vendor     vendor ids, comma separated (several allowed)
 *   activity   activity ids, comma separated (several allowed)
 *   pay        amount | credit | token | free | unpaid | manual   (several allowed, comma separated)
 *   hide_abandoned=1   leave out bookings cancelled before they were confirmed or paid (what Metrics counts)
 *   date_by    class (default) | booked      from / to  YYYY-MM-DD (to defaults to from: "on a date")
 *   price_min / price_max   what was paid, or the class price when nothing was paid per class
 *   postal     parent postal code starts with
 *   status     confirmed | completed | pending | waitlisted | cancelled | active
 *   test       hide (default) | show | only
 *   sort       booked (default) | class | name | vendor | activity | children | amount     dir  asc | desc
 *   facets=1   also return the vendor and activity options for the multi-selects
 *   format=csv every matching row, no paging
 */
const DAY = 864e5;
const num = (v: string | null) => (v !== null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const dayStart = (v: string | null) => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const ms = Date.parse(`${v}T00:00:00+08:00`);
  return Number.isNaN(ms) ? null : ms;
};
const list = (v: string | null) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sp = new URL(request.url).searchParams;
  const db = createAdminClient() as unknown as SupabaseClient;
  const all = await loadBookings(db, sp.get('fresh') === '1');
  let rows: AdminBooking[] = [...all];

  // ---- test data ----
  const test = sp.get('test');
  if (test === 'only') rows = rows.filter((r) => r.isTest);
  else if (test !== 'show') rows = rows.filter((r) => !r.isTest);

  // Facets are built from the test-filtered set, before the user's own filters, so the options stay stable.
  let facets: { vendors: { id: string; name: string; count: number }[]; activities: { id: string; title: string; vendor: string; count: number }[] } | undefined;
  if (sp.get('facets') === '1') {
    const v = new Map<string, { id: string; name: string; count: number }>();
    const a = new Map<string, { id: string; title: string; vendor: string; count: number }>();
    for (const r of rows) {
      if (r.vendorId) v.set(r.vendorId, { id: r.vendorId, name: r.vendorName ?? '(unknown)', count: (v.get(r.vendorId)?.count ?? 0) + 1 });
      if (r.activityId) a.set(r.activityId, { id: r.activityId, title: r.activityTitle ?? '(unknown)', vendor: r.vendorName ?? '', count: (a.get(r.activityId)?.count ?? 0) + 1 });
    }
    facets = {
      vendors: [...v.values()].sort((x, y) => x.name.localeCompare(y.name)),
      activities: [...a.values()].sort((x, y) => x.title.localeCompare(y.title)),
    };
  }

  // ---- filters ----
  const q = (sp.get('q') ?? '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => [r.parent?.name, r.parent?.email, r.guestName, r.guestContact, r.vendorName, r.activityTitle]
      .some((x) => (x ?? '').toLowerCase().includes(q)));
  }
  const vendors = list(sp.get('vendor'));
  if (vendors.length) rows = rows.filter((r) => r.vendorId && vendors.includes(r.vendorId));
  const activities = list(sp.get('activity'));
  if (activities.length) rows = rows.filter((r) => r.activityId && activities.includes(r.activityId));
  const pays = list(sp.get('pay')).filter((x) => ['amount', 'credit', 'token', 'free', 'unpaid', 'manual'].includes(x));
  if (pays.length) rows = rows.filter((r) => pays.includes(r.payVia));
  if (sp.get('hide_abandoned') === '1') rows = rows.filter((r) => !r.neverConfirmed);

  const from = dayStart(sp.get('from'));
  const toStart = dayStart(sp.get('to')) ?? from;
  if (from !== null && toStart !== null) {
    const lo = Math.min(from, toStart), hi = Math.max(from, toStart) + DAY - 1;
    const byBooked = sp.get('date_by') === 'booked';
    rows = rows.filter((r) => {
      const iso = byBooked ? r.bookedAt : r.sessionAt;
      if (!iso) return false;
      const t = Date.parse(iso);
      return t >= lo && t <= hi;
    });
  }
  const pMin = num(sp.get('price_min')), pMax = num(sp.get('price_max'));
  if (pMin !== null || pMax !== null) {
    rows = rows.filter((r) => {
      const price = r.amount ?? r.classPrice;
      return price !== null && (pMin === null || price >= pMin) && (pMax === null || price <= pMax);
    });
  }
  const postal = (sp.get('postal') ?? '').trim();
  if (postal) rows = rows.filter((r) => (r.parent?.postal ?? '').startsWith(postal));
  const status = sp.get('status');
  if (status === 'active') rows = rows.filter((r) => r.status === 'confirmed' || r.status === 'completed');
  else if (status && ['confirmed', 'completed', 'pending', 'waitlisted', 'cancelled'].includes(status)) rows = rows.filter((r) => r.status === status);

  // ---- sort ----
  const dir = sp.get('dir') === 'asc' ? 1 : -1;
  const key = sp.get('sort') ?? 'booked';
  const val = (r: AdminBooking): number | string => {
    switch (key) {
      case 'class': return r.sessionAt ? Date.parse(r.sessionAt) : 0;
      case 'name': return (r.parent?.name ?? r.guestName ?? '').toLowerCase();
      case 'vendor': return (r.vendorName ?? '').toLowerCase();
      case 'activity': return (r.activityTitle ?? '').toLowerCase();
      case 'children': return r.childCount;
      case 'amount': return r.amount ?? (r.credits + r.tokens) ;
      default: return Date.parse(r.bookedAt);
    }
  };
  rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });

  if (sp.get('format') === 'csv') {
    const head = ['Name', 'Email', 'Vendor', 'Activity', 'Class date', 'Booked on', 'Children', 'Paid via', 'Amount (SGD)', 'Credits', 'Make-up tokens', 'Class price', 'Status', 'Parent postal code', 'Manual booking'];
    const body = rows.map((r) => [
      r.parent?.name ?? r.guestName ?? '', r.parent?.email ?? r.guestContact ?? '', r.vendorName ?? '', r.activityTitle ?? '',
      r.sessionAt ?? '', r.bookedAt, r.childCount, r.payVia, r.amount ?? '', r.credits || '', r.tokens || '', r.classPrice ?? '',
      r.status, r.parent?.postal ?? '', r.isManual ? 'yes' : 'no',
    ].map(csvCell).join(','));
    return new NextResponse([head.join(','), ...body].join('\n') + '\n', {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="bookings.csv"' },
    });
  }

  const pageSize = 50;
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(num(sp.get('page')) ?? 1)), pages);
  return NextResponse.json({ rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize, ...(facets ? { facets } : {}) });
}
