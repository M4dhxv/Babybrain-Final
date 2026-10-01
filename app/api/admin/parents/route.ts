import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAll, isTestEmail, vendorAccountIds } from '@/lib/admin-test-data';

/**
 * Admin → Parents. One row per parent_profiles row with the numbers the
 * founder actually asks about (children, plan, bookings, spend, marketing
 * consent), filtered / sorted / paged here so the browser only gets one page.
 *
 * Read-only. Test accounts use the same rule as /api/admin/metrics
 * (isTestEmail or a vendor's own login) and are hidden unless asked for:
 *   ?test=hide (default) | show | only
 *
 * `&format=csv` returns every row matching the filters (no paging).
 */

type ParentRow = {
  id: string; full_name: string | null; email: string; phone: string | null; postal_code: string | null;
  onboarding_completed_at: string | null; marketing_consent_at: string | null;
  marketing_consent_withdrawn_at: string | null; created_at: string;
};
type Plan = 'free' | 'plus' | 'plus_past_due' | 'plus_canceled';

export type AdminParent = {
  id: string; name: string; email: string; phone: string | null; area: string | null;
  children: { name: string; ageMonths: number }[];
  plan: Plan; bookings: number; upcoming: number; spend: number; lastBookingAt: string | null;
  marketing: 'consented' | 'withdrawn' | 'none'; onboarded: boolean; joinedAt: string; isTest: boolean;
};

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
const ageMonths = (dob: string, now: number) => {
  const d = new Date(dob), n = new Date(now);
  return (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth()) - (n.getDate() < d.getDate() ? 1 : 0);
};

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sp = new URL(request.url).searchParams;
  const admin = createAdminClient() as unknown as SupabaseClient;
  const now = Date.now();

  const [parents, kids, bookings, sessions, subs, vendorAccounts] = await Promise.all([
    fetchAll<ParentRow>((f, t) => admin.from('parent_profiles')
      .select('id, full_name, email, phone, postal_code, onboarding_completed_at, marketing_consent_at, marketing_consent_withdrawn_at, created_at')
      .range(f, t)),
    fetchAll<{ parent_id: string; name: string; date_of_birth: string }>((f, t) =>
      admin.from('children').select('parent_id, name, date_of_birth').range(f, t)),
    fetchAll<{ user_id: string; session_id: string; status: string; payment_status: string; amount: number | null; created_at: string }>((f, t) =>
      admin.from('bookings').select('user_id, session_id, status, payment_status, amount, created_at').range(f, t)),
    fetchAll<{ id: string; starts_at: string }>((f, t) => admin.from('activity_sessions').select('id, starts_at').range(f, t)),
    fetchAll<{ user_id: string; plan: string; status: string }>((f, t) =>
      admin.from('customer_subscriptions').select('user_id, plan, status').range(f, t)),
    vendorAccountIds(admin),
  ]);

  const kidsBy = new Map<string, { name: string; ageMonths: number }[]>();
  for (const k of kids) {
    const list = kidsBy.get(k.parent_id) ?? [];
    list.push({ name: k.name, ageMonths: ageMonths(k.date_of_birth, now) });
    kidsBy.set(k.parent_id, list);
  }
  const startsAt = new Map(sessions.map((s) => [s.id, Date.parse(s.starts_at)]));
  const planBy = new Map<string, Plan>();
  for (const s of subs) {
    if (s.plan !== 'plus') continue;
    planBy.set(s.user_id, s.status === 'past_due' ? 'plus_past_due'
      : s.status === 'canceled' ? 'plus_canceled'
      : s.status === 'active' || s.status === 'trialing' ? 'plus' : 'free');
  }
  type Agg = { bookings: number; upcoming: number; spend: number; last: number | null; last30: boolean; ever: boolean };
  const aggBy = new Map<string, Agg>();
  for (const b of bookings) {
    // Cancelled and waitlisted seats aren't bookings the parent actually holds.
    if (b.status === 'cancelled' || b.status === 'waitlisted') continue;
    const a = aggBy.get(b.user_id) ?? { bookings: 0, upcoming: 0, spend: 0, last: null, last30: false, ever: true };
    a.bookings += 1;
    if ((startsAt.get(b.session_id) ?? 0) > now && b.status !== 'completed') a.upcoming += 1;
    if (b.payment_status === 'paid') a.spend += Number(b.amount ?? 0);
    const at = Date.parse(b.created_at);
    if (a.last === null || at > a.last) a.last = at;
    aggBy.set(b.user_id, a);
  }

  let rows: AdminParent[] = parents.map((p) => {
    const a = aggBy.get(p.id);
    return {
      id: p.id,
      name: p.full_name?.trim() || '',
      email: p.email,
      phone: p.phone,
      area: p.postal_code,
      children: (kidsBy.get(p.id) ?? []).sort((x, y) => x.ageMonths - y.ageMonths),
      plan: planBy.get(p.id) ?? 'free',
      bookings: a?.bookings ?? 0,
      upcoming: a?.upcoming ?? 0,
      spend: Math.round((a?.spend ?? 0) * 100) / 100,
      lastBookingAt: a?.last ? new Date(a.last).toISOString() : null,
      marketing: p.marketing_consent_at ? 'consented' : p.marketing_consent_withdrawn_at ? 'withdrawn' : 'none',
      onboarded: !!p.onboarding_completed_at,
      joinedAt: p.created_at,
      isTest: isTestEmail(p.email) || vendorAccounts.has(p.id),
    };
  });

  // ---- filters -------------------------------------------------------------
  const test = sp.get('test');
  if (test === 'only') rows = rows.filter((r) => r.isTest);
  else if (test !== 'show') rows = rows.filter((r) => !r.isTest);

  const q = (sp.get('q') ?? '').trim().toLowerCase();
  if (q) rows = rows.filter((r) => [r.name, r.email, r.phone ?? '', r.area ?? ''].some((v) => v.toLowerCase().includes(q)));

  const plan = sp.get('plan');
  if (plan === 'free' || plan === 'plus' || plan === 'plus_past_due' || plan === 'plus_canceled') rows = rows.filter((r) => r.plan === plan);

  const marketing = sp.get('marketing');
  if (marketing === 'consented' || marketing === 'withdrawn' || marketing === 'none') rows = rows.filter((r) => r.marketing === marketing);

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
      'Last booking', 'Marketing', 'Onboarded', 'Joined', 'Test account'];
    const body = rows.map((r) => [r.name, r.email, r.phone, r.area,
      r.children.map((c) => `${c.name} (${c.ageMonths < 24 ? `${c.ageMonths}m` : `${Math.floor(c.ageMonths / 12)}y`})`).join('; '),
      r.plan, r.bookings, r.upcoming, r.spend.toFixed(2), r.lastBookingAt?.slice(0, 10) ?? '', r.marketing,
      r.onboarded ? 'yes' : 'no', r.joinedAt.slice(0, 10), r.isTest ? 'yes' : 'no'].map(csvCell).join(','));
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
