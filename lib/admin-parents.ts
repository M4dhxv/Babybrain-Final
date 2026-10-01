import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll, isTestEmail, vendorAccountIds } from '@/lib/admin-test-data';

/**
 * The admin Parents list, built once and held in memory for a short while.
 *
 * Building it reads parent_profiles, children, bookings and subscriptions in
 * full, which is the slow part. Filtering, sorting and paging then run on the
 * cached rows, so changing a filter or turning a page doesn't re-read the
 * database. Marking a parent as test calls invalidateParents() so the change
 * shows straight away.
 */

export type Plan = 'free' | 'plus' | 'plus_past_due' | 'plus_canceled';

export type AdminParent = {
  id: string; name: string; email: string; phone: string | null; area: string | null;
  children: { name: string; ageMonths: number }[];
  plan: Plan; bookings: number; upcoming: number; spend: number; lastBookingAt: string | null;
  marketing: 'consented' | 'withdrawn' | 'none'; onboarded: boolean; joinedAt: string;
  isTest: boolean;
  /** 'manual' = flagged by an admin, 'auto' = test-looking email or a vendor login. */
  testSource: 'manual' | 'auto' | null;
};

type ParentRow = {
  id: string; full_name: string | null; email: string; phone: string | null; postal_code: string | null;
  onboarding_completed_at: string | null; marketing_consent_at: string | null;
  marketing_consent_withdrawn_at: string | null; created_at: string; is_test?: boolean | null;
};

const TTL_MS = 30_000;
let cache: { at: number; rows: AdminParent[] } | null = null;
let inflight: Promise<AdminParent[]> | null = null;

export const ageMonths = (dob: string, now: number) => {
  const d = new Date(dob), n = new Date(now);
  return (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth()) - (n.getDate() < d.getDate() ? 1 : 0);
};

export function invalidateParents() { cache = null; }

export async function loadParents(admin: SupabaseClient, fresh = false): Promise<AdminParent[]> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < TTL_MS) return cache.rows;
  if (!fresh && inflight) return inflight;
  inflight = build(admin, now).then((rows) => { cache = { at: Date.now(), rows }; return rows; })
    .finally(() => { inflight = null; });
  return inflight;
}

async function build(admin: SupabaseClient, now: number): Promise<AdminParent[]> {
  const cols = 'id, full_name, email, phone, postal_code, onboarding_completed_at, marketing_consent_at, marketing_consent_withdrawn_at, created_at';
  const [parents, kids, bookings, sessions, subs, vendorAccounts] = await Promise.all([
    // is_test comes from migration 00207; until it is applied, read without it.
    (async () => {
      const withFlag = await admin.from('parent_profiles').select(`${cols}, is_test`).range(0, 0);
      const select: string = withFlag.error ? cols : `${cols}, is_test`;
      return fetchAll<ParentRow>((f, t) => admin.from('parent_profiles').select(select as string).range(f, t) as unknown as PromiseLike<{ data: ParentRow[] | null; error: { message: string } | null }>);
    })(),
    fetchAll<{ parent_id: string; name: string; date_of_birth: string }>((f, t) =>
      admin.from('children').select('parent_id, name, date_of_birth').range(f, t)),
    fetchAll<{ user_id: string; session_id: string; status: string; payment_status: string; amount: number | null; created_at: string }>((f, t) =>
      admin.from('bookings').select('user_id, session_id, status, payment_status, amount, created_at').range(f, t)),
    // Only future sessions matter (for "upcoming"), which is far fewer rows than all of them.
    fetchAll<{ id: string }>((f, t) =>
      admin.from('activity_sessions').select('id').gt('starts_at', new Date(now).toISOString()).range(f, t)),
    fetchAll<{ user_id: string; plan: string; status: string }>((f, t) =>
      admin.from('customer_subscriptions').select('user_id, plan, status').eq('plan', 'plus').range(f, t)),
    vendorAccountIds(admin),
  ]);

  const kidsBy = new Map<string, { name: string; ageMonths: number }[]>();
  for (const k of kids) {
    const list = kidsBy.get(k.parent_id) ?? [];
    list.push({ name: k.name, ageMonths: ageMonths(k.date_of_birth, now) });
    kidsBy.set(k.parent_id, list);
  }
  const future = new Set(sessions.map((s) => s.id));
  const planBy = new Map<string, Plan>();
  for (const s of subs) {
    planBy.set(s.user_id, s.status === 'past_due' ? 'plus_past_due'
      : s.status === 'canceled' ? 'plus_canceled'
      : s.status === 'active' || s.status === 'trialing' ? 'plus' : 'free');
  }
  type Agg = { bookings: number; upcoming: number; spend: number; last: number | null };
  const aggBy = new Map<string, Agg>();
  for (const b of bookings) {
    // Cancelled and waitlisted seats aren't bookings the parent actually holds.
    if (b.status === 'cancelled' || b.status === 'waitlisted') continue;
    const a = aggBy.get(b.user_id) ?? { bookings: 0, upcoming: 0, spend: 0, last: null };
    a.bookings += 1;
    if (future.has(b.session_id) && b.status !== 'completed') a.upcoming += 1;
    if (b.payment_status === 'paid') a.spend += Number(b.amount ?? 0);
    const at = Date.parse(b.created_at);
    if (a.last === null || at > a.last) a.last = at;
    aggBy.set(b.user_id, a);
  }

  return parents.map((p) => {
    const a = aggBy.get(p.id);
    const auto = isTestEmail(p.email) || vendorAccounts.has(p.id);
    const manual = !!p.is_test;
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
      isTest: manual || auto,
      testSource: manual ? 'manual' : auto ? 'auto' : null,
    };
  });
}
