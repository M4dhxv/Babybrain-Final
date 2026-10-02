import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/admin-test-data';
import { classifyParent, type AccountKind } from '@/lib/admin-test-rules';
import { getStripe } from '@/lib/stripe';

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

export type { AccountKind };
/** How an admin has overridden the automatic test rules for an account. */
export type TestOverride = 'auto' | 'test' | 'real';

export type DeviceOs = 'ios' | 'android' | 'macos' | 'windows' | 'chromeos' | 'linux' | 'other';
/** Whether the parent opens BabyBrain as the installed app or in a browser. 'unknown' = not reported yet. */
export type Surface = 'app' | 'web' | 'both' | 'unknown';
export type ParentDevice = { os: DeviceOs; surface: Surface; lastSeenAt: string };

export const DEVICE_LABEL: Record<DeviceOs, string> = {
  ios: 'iPhone / iPad (iOS)', android: 'Android', macos: 'Mac', windows: 'Windows PC', chromeos: 'Chromebook', linux: 'Linux', other: 'Other',
};

const surfaceOf = (app: boolean, web: boolean): Surface => (app && web ? 'both' : app ? 'app' : web ? 'web' : 'unknown');

/** Rows of parent_devices (migration 00215) -> what the admin shows for one parent. */
export function summariseDevices(rows: { os: string; surface: string; last_seen_at: string }[]): { devices: ParentDevice[]; surface: Surface; lastSeenAt: string | null } {
  const byOs = new Map<DeviceOs, { app: boolean; web: boolean; last: string }>();
  let app = false, web = false, last: string | null = null;
  for (const r of rows) {
    const os = (r.os in DEVICE_LABEL ? r.os : 'other') as DeviceOs;
    const cur = byOs.get(os) ?? { app: false, web: false, last: r.last_seen_at };
    if (r.surface === 'app') { cur.app = true; app = true; }
    if (r.surface === 'web') { cur.web = true; web = true; }
    if (r.last_seen_at > cur.last) cur.last = r.last_seen_at;
    byOs.set(os, cur);
    if (!last || r.last_seen_at > last) last = r.last_seen_at;
  }
  const devices = [...byOs.entries()]
    .map(([os, v]) => ({ os, surface: surfaceOf(v.app, v.web), lastSeenAt: v.last }))
    .sort((x, y) => (x.lastSeenAt < y.lastSeenAt ? 1 : -1));
  return { devices, surface: surfaceOf(app, web), lastSeenAt: last };
}

export type AdminParent = {
  id: string; name: string; email: string; phone: string | null; area: string | null;
  children: { name: string; ageMonths: number }[];
  plan: Plan; bookings: number; upcoming: number;
  /** Everything paid: class bookings, class packages bought, and Plus subscription invoices. */
  spend: number; bookingSpend: number; packageSpend: number; planPaid: number; lastBookingAt: string | null;
  marketing: 'consented' | 'withdrawn' | 'not_consented'; onboarded: boolean; joinedAt: string;
  /** Areas they asked for at sign-up: central, east, north-east, north, west, sentosa. */
  regions: string[];
  /** The one status shown for the account. */
  kind: AccountKind;
  /** Holds an active seat at a vendor (owner or staff), with the business names. */
  isVendor: boolean; vendorNames: string[];
  isTest: boolean;
  /** automatic (the rules decide), forced test, or forced real parent. */
  override: TestOverride;
  /** 'manual' = flagged by an admin, 'auto' = decided by the rules below. */
  testSource: 'manual' | 'auto' | null;
  testReason: string | null;
  /** Devices they have signed in from, most recent first. */
  devices: ParentDevice[];
  /** App (installed), web (browser), both, or unknown until they next open the app. */
  surface: Surface;
  lastSeenAt: string | null;
};

type ParentRow = {
  id: string; full_name: string | null; email: string; phone: string | null; postal_code: string | null;
  onboarding_completed_at: string | null; marketing_consent_at: string | null;
  marketing_consent_withdrawn_at: string | null; created_at: string; is_test?: boolean | null; is_real_override?: boolean | null;
};

const TTL_MS = 30_000;
let cache: { at: number; rows: AdminParent[] } | null = null;
let inflight: Promise<AdminParent[]> | null = null;

export const ageMonths = (dob: string, now: number) => {
  const d = new Date(dob), n = new Date(now);
  return (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth()) - (n.getDate() < d.getDate() ? 1 : 0);
};

export function invalidateParents() { cache = null; }

/**
 * Plus subscription money actually collected, per Stripe customer (SGD).
 * Stripe is the only place it's recorded, so read paid invoices and sum them.
 * Held for 10 minutes on its own so the list stays quick; the Refresh button
 * bypasses it. If Stripe can't be reached the list still loads, without it.
 */
let paidCache: { at: number; map: Map<string, number> } | null = null;
async function plusPaidByCustomer(fresh: boolean): Promise<Map<string, number>> {
  if (!fresh && paidCache && Date.now() - paidCache.at < 10 * 60_000) return paidCache.map;
  const map = new Map<string, number>();
  try {
    let n = 0;
    for await (const inv of getStripe().invoices.list({ status: 'paid', limit: 100 })) {
      if (inv.currency === 'sgd' && typeof inv.customer === 'string' && inv.amount_paid > 0) {
        map.set(inv.customer, (map.get(inv.customer) ?? 0) + inv.amount_paid);
      }
      if (++n >= 5000) break;
    }
    paidCache = { at: Date.now(), map };
  } catch {
    return paidCache?.map ?? map;
  }
  return map;
}

export async function loadParents(admin: SupabaseClient, fresh = false): Promise<AdminParent[]> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < TTL_MS) return cache.rows;
  if (!fresh && inflight) return inflight;
  inflight = build(admin, now, fresh).then((rows) => { cache = { at: Date.now(), rows }; return rows; })
    .finally(() => { inflight = null; });
  return inflight;
}

async function build(admin: SupabaseClient, now: number, fresh: boolean): Promise<AdminParent[]> {
  const cols = 'id, full_name, email, phone, postal_code, onboarding_completed_at, marketing_consent_at, marketing_consent_withdrawn_at, created_at';
  const [parents, kids, prefs, bookings, sessions, subs, seats, testPaid, stripePaid, pkgEarnings, pkgBuyers, deviceRows] = await Promise.all([
    // is_test comes from migration 00207 and is_real_override from 00212; read whichever exist.
    (async () => {
      let select: string = cols;
      for (const extra of [', is_test, is_real_override', ', is_test']) {
        if (!(await admin.from('parent_profiles').select(`${cols}${extra}`).range(0, 0)).error) { select = `${cols}${extra}`; break; }
      }
      return fetchAll<ParentRow>((f, t) => admin.from('parent_profiles').select(select as string).range(f, t) as unknown as PromiseLike<{ data: ParentRow[] | null; error: { message: string } | null }>);
    })(),
    fetchAll<{ parent_id: string; name: string; date_of_birth: string }>((f, t) =>
      admin.from('children').select('parent_id, name, date_of_birth').range(f, t)),
    fetchAll<{ user_id: string; preferred_regions: string[] | null }>((f, t) =>
      admin.from('user_preferences').select('user_id, preferred_regions').range(f, t)),
    fetchAll<{ id: string; user_id: string; session_id: string; status: string; payment_status: string; amount: number | null; created_at: string }>((f, t) =>
      admin.from('bookings').select('id, user_id, session_id, status, payment_status, amount, created_at').range(f, t)),
    // Only future sessions matter (for "upcoming"), which is far fewer rows than all of them.
    fetchAll<{ id: string }>((f, t) =>
      admin.from('activity_sessions').select('id').gt('starts_at', new Date(now).toISOString()).range(f, t)),
    fetchAll<{ user_id: string; plan: string; status: string; stripe_customer_id: string | null }>((f, t) =>
      admin.from('customer_subscriptions').select('user_id, plan, status, stripe_customer_id').eq('plan', 'plus').range(f, t)),
    // Vendor seats, so vendor staff can be tagged (and told apart from vendor-only logins).
    fetchAll<{ user_id: string; provider: { business_name: string | null; is_test: boolean | null } | null }>((f, t) =>
      admin.from('provider_members').select('user_id, provider:providers(business_name, is_test)').eq('status', 'active').range(f, t) as unknown as PromiseLike<{ data: { user_id: string; provider: { business_name: string | null; is_test: boolean | null } | null }[] | null; error: { message: string } | null }>),
    // Bookings paid in Stripe test mode (provider_earnings.livemode = false) aren't real spend.
    // livemode comes from migration 00161; if the read fails nothing is excluded.
    fetchAll<{ booking_id: string | null }>((f, t) =>
      admin.from('provider_earnings').select('booking_id').eq('livemode', false).not('booking_id', 'is', null).range(f, t)),
    plusPaidByCustomer(fresh),
    // Class packages bought: the money is recorded as a package earning (not on any booking), so
    // Spend reads it from there. Refunded and Stripe test-mode purchases don't count.
    // provider_earnings.is_test (migration 00212) flags a single payment as test; read it when it exists.
    (async () => {
      const hasFlag = !(await admin.from('provider_earnings').select('is_test').limit(1)).error;
      const cols2 = `package_purchase_id, gross_cents, status, livemode${hasFlag ? ', is_test' : ''}`;
      return fetchAll<{ package_purchase_id: string | null; gross_cents: number | null; status: string | null; livemode?: boolean | null; is_test?: boolean | null }>((f, t) =>
        admin.from('provider_earnings').select(cols2).eq('source', 'package').range(f, t) as unknown as PromiseLike<{ data: { package_purchase_id: string | null; gross_cents: number | null; status: string | null; livemode?: boolean | null; is_test?: boolean | null }[] | null; error: { message: string } | null }>);
    })(),
    fetchAll<{ id: string; user_id: string }>((f, t) => admin.from('package_purchases').select('id, user_id').range(f, t)),
    // Devices (migration 00215). Until it is applied the read fails and every parent just shows no device.
    fetchAll<{ user_id: string; os: string; surface: string; last_seen_at: string }>((f, t) =>
      admin.from('parent_devices').select('user_id, os, surface, last_seen_at').range(f, t)).catch(() => []),
  ]);
  const devicesBy = new Map<string, { os: string; surface: string; last_seen_at: string }[]>();
  for (const d of deviceRows) {
    const list = devicesBy.get(d.user_id) ?? [];
    list.push(d);
    devicesBy.set(d.user_id, list);
  }
  const packageSpendBy = new Map<string, number>();
  {
    const buyer = new Map(pkgBuyers.map((r) => [r.id, r.user_id]));
    for (const e of pkgEarnings) {
      const uid = e.package_purchase_id ? buyer.get(e.package_purchase_id) : undefined;
      if (!uid || e.status === 'refunded' || e.livemode === false || e.is_test) continue;
      packageSpendBy.set(uid, (packageSpendBy.get(uid) ?? 0) + Number(e.gross_cents ?? 0) / 100);
    }
  }
  const testPaidIds = new Set(testPaid.map((r) => r.booking_id));

  const kidsBy = new Map<string, { name: string; ageMonths: number }[]>();
  for (const k of kids) {
    const list = kidsBy.get(k.parent_id) ?? [];
    list.push({ name: k.name, ageMonths: ageMonths(k.date_of_birth, now) });
    kidsBy.set(k.parent_id, list);
  }
  const regionsBy = new Map(prefs.map((r) => [r.user_id, r.preferred_regions ?? []]));
  const seatsBy = new Map<string, { business_name: string | null; is_test: boolean | null }[]>();
  for (const s of seats) {
    if (!s.provider) continue;
    const list = seatsBy.get(s.user_id) ?? [];
    list.push(s.provider);
    seatsBy.set(s.user_id, list);
  }
  const future = new Set(sessions.map((s) => s.id));
  const planBy = new Map<string, Plan>();
  const planPaidBy = new Map<string, number>();
  for (const s of subs) {
    if (s.stripe_customer_id) planPaidBy.set(s.user_id, (stripePaid.get(s.stripe_customer_id) ?? 0) / 100);
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
    if (b.payment_status === 'paid' && !testPaidIds.has(b.id)) a.spend += Number(b.amount ?? 0);
    const at = Date.parse(b.created_at);
    if (a.last === null || at > a.last) a.last = at;
    aggBy.set(b.user_id, a);
  }

  return parents.map((p) => {
    const a = aggBy.get(p.id);
    const seatList = seatsBy.get(p.id) ?? [];
    const isVendor = seatList.length > 0;
    const hasParentActivity = (kidsBy.get(p.id)?.length ?? 0) > 0 || (a?.bookings ?? 0) > 0;
    // One shared rule decides test / vendor login / vendor + parent / parent (lib/admin-test-rules.ts).
    const cls = classifyParent({
      email: p.email, manualTest: p.is_test, forcedReal: p.is_real_override,
      seats: seatList.map((v) => ({ isTestVendor: !!v.is_test })), hasParentActivity,
    });
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
      bookingSpend: Math.round((a?.spend ?? 0) * 100) / 100,
      packageSpend: Math.round((packageSpendBy.get(p.id) ?? 0) * 100) / 100,
      planPaid: planPaidBy.get(p.id) ?? 0,
      spend: Math.round(((a?.spend ?? 0) + (packageSpendBy.get(p.id) ?? 0) + (planPaidBy.get(p.id) ?? 0)) * 100) / 100,
      lastBookingAt: a?.last ? new Date(a.last).toISOString() : null,
      marketing: p.marketing_consent_at ? 'consented' : p.marketing_consent_withdrawn_at ? 'withdrawn' : 'not_consented',
      onboarded: !!p.onboarding_completed_at,
      joinedAt: p.created_at,
      regions: regionsBy.get(p.id) ?? [],
      kind: cls.kind,
      isVendor: cls.isVendor,
      vendorNames: [...new Set(seatList.map((v) => v.business_name).filter((n): n is string => !!n))],
      isTest: cls.kind === 'test',
      override: p.is_test ? 'test' : p.is_real_override ? 'real' : 'auto',
      testSource: cls.testSource,
      testReason: cls.testReason,
      ...(() => { const d = summariseDevices(devicesBy.get(p.id) ?? []); return { devices: d.devices, surface: d.surface, lastSeenAt: d.lastSeenAt }; })(),
    };
  });
}
