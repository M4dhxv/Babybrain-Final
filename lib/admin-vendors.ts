import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll, testProviderIds } from '@/lib/admin-test-data';
import { isLiveEarning } from '@/lib/admin-test-rules';

/**
 * The admin "Vendor data" performance list: one row per vendor with the numbers
 * that show whether a vendor is growing (listings, sessions, bookings, money,
 * reviews), in the same spirit as the Parents and Bookings tabs.
 *
 * Built once and held in memory for a short while, like lib/admin-parents.ts:
 * it reads providers, activities, future sessions, bookings, earnings, pack
 * purchases, reviews and plans in full, which is the slow part. Filtering,
 * sorting and CSV happen in the page on the cached rows. Read-only.
 */

export type VendorPayouts = 'stripe' | 'manual' | 'none';

export type AdminVendor = {
  id: string; name: string; slug: string | null; category: string | null; region: string | null;
  /** providers.status (active / pending / suspended…). */
  status: string;
  /** Claimed by the business itself, or a directory listing. */
  claimed: boolean;
  isTest: boolean;
  plan: string | null; planStatus: string | null;
  payouts: VendorPayouts;
  wixLinked: boolean;
  /** Active team logins (provider_members). */
  team: number;
  activities: number; liveActivities: number;
  /** Not cancelled, starting in the next 30 days. */
  sessions30: number;
  /** Held bookings (not cancelled or waitlisted), one per place. */
  bookings: number; bookings30: number; bookingsPrev30: number;
  /** Waitlisted places on sessions still to come. */
  waitlisted: number;
  /** Cancelled after being held (abandoned checkouts left out), share of all held + cancelled. */
  cancelRate: number | null;
  /** Live (non-test, not refunded) money parents paid, SGD: card bookings and packs. */
  gross: number; gross30: number;
  packsSold: number;
  rating: number | null; reviews: number;
  lastBookingAt: string | null;
  joinedAt: string;
};

const DAY = 864e5;
const TTL_MS = 60_000;
let cache: { at: number; rows: AdminVendor[] } | null = null;
let inflight: Promise<AdminVendor[]> | null = null;

export async function loadVendorPerformance(admin: SupabaseClient, fresh = false): Promise<AdminVendor[]> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < TTL_MS) return cache.rows;
  if (!fresh && inflight) return inflight;
  inflight = build(admin, now).then((rows) => { cache = { at: Date.now(), rows }; return rows; })
    .finally(() => { inflight = null; });
  return inflight;
}

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

async function build(admin: SupabaseClient, now: number): Promise<AdminVendor[]> {
  const nowIso = new Date(now).toISOString();
  const in30 = new Date(now + 30 * DAY).toISOString();
  const ago30 = new Date(now - 30 * DAY).toISOString();
  const ago60 = new Date(now - 60 * DAY).toISOString();

  type Prov = {
    id: string; business_name: string; slug: string | null; vendor_category: string | null; region: string | null;
    status: string; is_claimed: boolean; payouts_enabled: boolean; allow_manual_payouts: boolean;
    stripe_account_id: string | null; wix_site_id: string | null; created_at: string;
  };
  type Earn = Record<string, unknown>;
  const [providers, testIds, activities, sessions, bookings, earnings, packs, reviews, subs, members] = await Promise.all([
    fetchAll<Prov>((f, t) => admin.from('providers')
      .select('id, business_name, slug, vendor_category, region, status, is_claimed, payouts_enabled, allow_manual_payouts, stripe_account_id, wix_site_id, created_at')
      .range(f, t) as unknown as Page<Prov>),
    testProviderIds(admin),
    fetchAll<{ id: string; provider_id: string; is_published: boolean; archived_at: string | null }>((f, t) =>
      admin.from('activities').select('id, provider_id, is_published, archived_at').range(f, t) as never),
    fetchAll<{ id: string; activity_id: string; starts_at: string }>((f, t) =>
      admin.from('activity_sessions').select('id, activity_id, starts_at').neq('status', 'cancelled').gte('starts_at', nowIso).range(f, t) as never),
    fetchAll<{ provider_id: string | null; session_id: string; status: string; payment_status: string; amount: number | null; package_purchase_id: string | null; created_at: string }>((f, t) =>
      admin.from('bookings').select('provider_id, session_id, status, payment_status, amount, package_purchase_id, created_at').range(f, t) as never, 60),
    // livemode (00161) and is_test (00212) may not exist yet; read whichever do.
    (async () => {
      let cols = 'provider_id, gross_cents, status, created_at';
      for (const extra of [', livemode, is_test', ', livemode']) {
        if (!(await admin.from('provider_earnings').select(`${cols}${extra}`).limit(1)).error) { cols = `${cols}${extra}`; break; }
      }
      return fetchAll<Earn>((f, t) => admin.from('provider_earnings').select(cols).range(f, t) as unknown as Page<Earn>);
    })(),
    fetchAll<{ provider_id: string }>((f, t) => admin.from('package_purchases').select('provider_id').range(f, t) as never),
    fetchAll<{ activity_id: string; rating: number }>((f, t) => admin.from('reviews').select('activity_id, rating').range(f, t) as never),
    fetchAll<{ provider_id: string; plan: string; status: string }>((f, t) => admin.from('subscriptions').select('provider_id, plan, status').range(f, t) as never),
    fetchAll<{ provider_id: string }>((f, t) => admin.from('provider_members').select('provider_id').eq('status', 'active').range(f, t) as never),
  ]);

  const providerOfActivity = new Map(activities.map((a) => [a.id, a.provider_id]));
  const sessionsByProvider = new Map<string, number>();
  const futureSession = new Set<string>();
  for (const s of sessions) {
    futureSession.add(s.id);
    if (s.starts_at > in30) continue;
    const p = providerOfActivity.get(s.activity_id);
    if (p) sessionsByProvider.set(p, (sessionsByProvider.get(p) ?? 0) + 1);
  }

  type Acc = {
    activities: number; live: number; bookings: number; b30: number; bPrev: number; waitlisted: number;
    cancelled: number; gross: number; gross30: number; packs: number; ratingSum: number; reviews: number;
    lastBookingAt: string | null; team: number;
  };
  const acc = new Map<string, Acc>();
  const get = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = { activities: 0, live: 0, bookings: 0, b30: 0, bPrev: 0, waitlisted: 0, cancelled: 0, gross: 0, gross30: 0, packs: 0, ratingSum: 0, reviews: 0, lastBookingAt: null, team: 0 };
      acc.set(id, a);
    }
    return a;
  };

  for (const a of activities) {
    const x = get(a.provider_id);
    x.activities++;
    if (a.is_published && !a.archived_at) x.live++;
  }
  for (const b of bookings) {
    if (!b.provider_id) continue;
    const x = get(b.provider_id);
    if (b.status === 'waitlisted') {
      if (futureSession.has(b.session_id)) x.waitlisted++;
      continue;
    }
    if (b.status === 'cancelled') {
      // An abandoned checkout was never a booking (see isNeverConfirmed): leave it out of the rate.
      const neverHeld = b.payment_status === 'none' && Number(b.amount ?? 0) > 0 && !b.package_purchase_id;
      if (!neverHeld) x.cancelled++;
      continue;
    }
    x.bookings++;
    if (b.created_at >= ago30) x.b30++;
    else if (b.created_at >= ago60) x.bPrev++;
    if (!x.lastBookingAt || b.created_at > x.lastBookingAt) x.lastBookingAt = b.created_at;
  }
  for (const e of earnings) {
    const pid = String(e.provider_id ?? '');
    if (!pid || e.status === 'refunded') continue;
    if (!isLiveEarning({ vendorIsTest: false, livemode: e.livemode as boolean | null | undefined, flaggedTest: e.is_test as boolean | null | undefined })) continue;
    const x = get(pid);
    const sgd = Number(e.gross_cents ?? 0) / 100;
    x.gross += sgd;
    if (String(e.created_at) >= ago30) x.gross30 += sgd;
  }
  for (const p of packs) get(p.provider_id).packs++;
  for (const r of reviews) {
    const pid = providerOfActivity.get(r.activity_id);
    if (!pid) continue;
    const x = get(pid);
    x.reviews++;
    x.ratingSum += Number(r.rating ?? 0);
  }
  for (const m of members) get(m.provider_id).team++;
  const subBy = new Map(subs.map((s) => [s.provider_id, s]));

  return providers.map((p): AdminVendor => {
    const x = get(p.id);
    const sub = subBy.get(p.id);
    const heldOrCancelled = x.bookings + x.cancelled;
    return {
      id: p.id, name: p.business_name?.trim() || 'Unnamed vendor', slug: p.slug, category: p.vendor_category, region: p.region,
      status: p.status, claimed: p.is_claimed, isTest: testIds.has(p.id),
      plan: sub?.plan ?? null, planStatus: sub?.status ?? null,
      payouts: p.payouts_enabled ? 'stripe' : p.allow_manual_payouts ? 'manual' : 'none',
      wixLinked: !!p.wix_site_id,
      team: x.team,
      activities: x.activities, liveActivities: x.live,
      sessions30: sessionsByProvider.get(p.id) ?? 0,
      bookings: x.bookings, bookings30: x.b30, bookingsPrev30: x.bPrev,
      waitlisted: x.waitlisted,
      cancelRate: heldOrCancelled ? x.cancelled / heldOrCancelled : null,
      gross: Math.round(x.gross * 100) / 100, gross30: Math.round(x.gross30 * 100) / 100,
      packsSold: x.packs,
      rating: x.reviews ? Math.round((x.ratingSum / x.reviews) * 10) / 10 : null, reviews: x.reviews,
      lastBookingAt: x.lastBookingAt,
      joinedAt: p.created_at,
    };
  });
}
