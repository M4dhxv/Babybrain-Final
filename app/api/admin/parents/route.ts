import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadParents, type AdminParent } from '@/lib/admin-parents';

/**
 * Admin → Parents. One row per parent_profiles row with the numbers the
 * founder actually asks about (children, plan, bookings, spend, marketing
 * consent). The rows are built and briefly cached in lib/admin-parents.ts;
 * filtering, sorting and paging happen here so the browser only gets one page.
 *
 * Read-only. Test accounts (marked by an admin, or test-looking emails and
 * vendor logins) are hidden unless asked for:
 *   ?test=hide (default) | show | only
 *
 * `&format=csv` returns every row matching the filters (no paging).
 */

const DAY = 864e5;
const num = (v: string | null) => (v !== null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const dateMs = (v: string | null, endOfDay = false) => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  // Singapore calendar day, since that's what the founder reads.
  const ms = Date.parse(`${v}T00:00:00+08:00`);
  return Number.isNaN(ms) ? null : endOfDay ? ms + DAY - 1 : ms;
};
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sp = new URL(request.url).searchParams;
  const admin = createAdminClient() as unknown as SupabaseClient;
  const now = Date.now();
  let rows = [...(await loadParents(admin, sp.get('fresh') === '1'))];

  // ---- filters -------------------------------------------------------------
  const test = sp.get('test');
  if (test === 'only') rows = rows.filter((r) => r.isTest);
  else if (test !== 'show') rows = rows.filter((r) => !r.isTest);

  const q = (sp.get('q') ?? '').trim().toLowerCase();
  if (q) rows = rows.filter((r) => [r.name, r.email, r.phone ?? '', r.area ?? ''].some((v) => v.toLowerCase().includes(q)));

  const region = sp.get('region');
  if (region) rows = rows.filter((r) => r.regions.includes(region));

  const account = sp.get('account');
  if (account === 'vendor') rows = rows.filter((r) => r.isVendor);
  else if (account === 'parent') rows = rows.filter((r) => !r.isVendor);

  const plan = sp.get('plan');
  if (plan === 'free' || plan === 'plus' || plan === 'plus_past_due' || plan === 'plus_canceled') rows = rows.filter((r) => r.plan === plan);

  const marketing = sp.get('marketing');
  if (marketing === 'consented' || marketing === 'withdrawn' || marketing === 'not_consented') rows = rows.filter((r) => r.marketing === marketing);

  const from = dateMs(sp.get('joined_from')), to = dateMs(sp.get('joined_to'), true);
  if (from !== null) rows = rows.filter((r) => Date.parse(r.joinedAt) >= from);
  if (to !== null) rows = rows.filter((r) => Date.parse(r.joinedAt) <= to);

  const activity = sp.get('activity');
  if (activity === 'never') rows = rows.filter((r) => r.bookings === 0);
  else if (activity === 'once') rows = rows.filter((r) => r.bookings === 1);
  else if (activity === 'repeat') rows = rows.filter((r) => r.bookings >= 2);
  else if (activity === 'recent30') rows = rows.filter((r) => r.lastBookingAt && now - Date.parse(r.lastBookingAt) <= 30 * DAY);
  else if (activity === 'dormant60') rows = rows.filter((r) => r.lastBookingAt && now - Date.parse(r.lastBookingAt) > 60 * DAY);

  const hasKids = sp.get('has_children');
  if (hasKids === 'yes') rows = rows.filter((r) => r.children.length > 0);
  else if (hasKids === 'no') rows = rows.filter((r) => r.children.length === 0);

  const cMin = num(sp.get('child_min')), cMax = num(sp.get('child_max'));
  if (cMin !== null || cMax !== null) {
    rows = rows.filter((r) => r.children.some((c) => (cMin === null || c.ageMonths >= cMin) && (cMax === null || c.ageMonths <= cMax)));
  }

  const onboarded = sp.get('onboarded');
  if (onboarded === 'yes') rows = rows.filter((r) => r.onboarded);
  else if (onboarded === 'no') rows = rows.filter((r) => !r.onboarded);

  const minSpend = num(sp.get('min_spend'));
  if (minSpend !== null) rows = rows.filter((r) => r.spend >= minSpend);

  const area = (sp.get('area') ?? '').trim();
  if (area) rows = rows.filter((r) => (r.area ?? '').startsWith(area));

  // ---- sort ----------------------------------------------------------------
  const dir = sp.get('dir') === 'asc' ? 1 : -1;
  const key = sp.get('sort') ?? 'joined';
  const val = (r: AdminParent): number | string => {
    switch (key) {
      case 'name': return (r.name || r.email).toLowerCase();
      case 'children': return r.children.length;
      case 'bookings': return r.bookings;
      case 'spend': return r.spend;
      case 'last': return r.lastBookingAt ? Date.parse(r.lastBookingAt) : 0;
      default: return Date.parse(r.joinedAt);
    }
  };
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });

  if (sp.get('format') === 'csv') {
    const head = ['Name', 'Email', 'Phone', 'Postal code', 'Children', 'Plan', 'Bookings', 'Upcoming', 'Spend (SGD)',
      'Last booking', 'Marketing', 'Onboarded', 'Joined', 'Vendor', 'Preferred areas', 'Test account'];
    const body = rows.map((r) => [r.name, r.email, r.phone, r.area,
      r.children.map((c) => `${c.name} (${c.ageMonths < 24 ? `${c.ageMonths}m` : `${Math.floor(c.ageMonths / 12)}y`})`).join('; '),
      r.plan, r.bookings, r.upcoming, r.spend.toFixed(2), r.lastBookingAt?.slice(0, 10) ?? '', r.marketing,
      r.onboarded ? 'yes' : 'no', r.joinedAt.slice(0, 10), r.vendorNames.join('; '), r.regions.join('; '), r.isTest ? 'yes' : 'no'].map(csvCell).join(','));
    return new NextResponse([head.join(','), ...body].join('\n') + '\n', {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="parents.csv"' },
    });
  }

  const pageSize = 50;
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(num(sp.get('page')) ?? 1)), pages);
  return NextResponse.json({ rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize });
}
