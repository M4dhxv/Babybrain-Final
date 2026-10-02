import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/admin-test-data';
import { loadParents } from '@/lib/admin-parents';
import { isNeverConfirmed, refundOutcome, type RefundOutcome } from '@/lib/admin-test-rules';

/**
 * The admin Bookings list. One entry per booking as a parent sees it: a multi-child booking is
 * several rows sharing a booking_group_id, which is shown as one entry with a child count.
 *
 * Like the Parents list it is built once and held in memory for a short while; filtering, sorting
 * and paging then run on the cached entries. Read-only.
 */

/**
 * How a booking was paid. 'unpaid' = a priced class that is pending or was cancelled before any payment;
 * 'manual' = added by a vendor with no parent account (shown with hyphens).
 */
export type PayVia = 'amount' | 'credit' | 'token' | 'free' | 'unpaid' | 'manual';

export type AdminBooking = {
  /** The booking group id, or the booking id for a single booking. */
  id: string;
  isManual: boolean;
  /** Belongs to a test parent or a test vendor (hidden by default). */
  isTest: boolean;
  /** Cancelled while still pending or waitlisted (an abandoned checkout): not counted as a booking in Metrics. */
  neverConfirmed: boolean;
  parent: { id: string; name: string; email: string; postal: string | null } | null;
  /** For manual bookings: what the vendor typed. */
  guestName: string | null;
  guestContact: string | null;
  vendorId: string | null;
  vendorName: string | null;
  activityId: string | null;
  activityTitle: string | null;
  sessionAt: string | null;
  bookedAt: string;
  status: string;
  childCount: number;
  childNames: string[];
  payVia: PayVia;
  /** Money paid, when it was paid per class (payVia 'amount'). */
  amount: number | null;
  /** Package credits used (payVia 'credit') and make-up tokens redeemed (payVia 'token'). */
  credits: number;
  tokens: number;
  /** The class's list price, whatever way it was paid. */
  classPrice: number | null;
  venue: { name: string | null; address: string | null; postal: string | null } | null;
  /** What a cancellation gave back; null unless the booking is cancelled. */
  refund: RefundOutcome | null;
  details: {
    seatCount: number; paymentStatus: string; stripePaymentIntent: string | null;
    packageName: string | null; packageCreditsRemaining: number | null; packageCreditsTotal: number | null;
    cancelReason: string | null; cancelledBy: string | null; cancelRefundMode: string | null;
    policiesAccepted: number; hasMedicalDisclosure: boolean; hasInfoResponse: boolean; waitlistPosition: number | null;
  };
};

type BookingRow = {
  id: string; user_id: string | null; child_id: string | null; session_id: string; provider_id: string | null; status: string;
  waitlist_position: number | null; payment_status: string; amount: number | null; stripe_payment_intent: string | null;
  package_purchase_id: string | null; guest_name: string | null; guest_contact: string | null; booking_group_id: string | null;
  created_at: string; cancel_reason: string | null; cancelled_by: string | null; cancel_refund_mode: string | null;
  medical_disclosure: string | null; info_response: string | null; policies_accepted: string[] | null;
  cancelled_from_status?: string | null;
};

const TTL_MS = 30_000;
let cache: { at: number; rows: AdminBooking[] } | null = null;
let inflight: Promise<AdminBooking[]> | null = null;

export function invalidateBookings() { cache = null; }

export async function loadBookings(admin: SupabaseClient, fresh = false): Promise<AdminBooking[]> {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < TTL_MS) return cache.rows;
  if (!fresh && inflight) return inflight;
  inflight = build(admin, fresh).then((rows) => { cache = { at: Date.now(), rows }; return rows; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Read rows whose id is in `ids`, in small batches so the request URL stays short. */
async function byIds<T>(admin: SupabaseClient, table: string, cols: string, ids: string[]): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));
  const parts = await Promise.all(chunks.map(async (c) => {
    const { data } = await admin.from(table).select(cols).in('id', c);
    return (data ?? []) as unknown as T[];
  }));
  return parts.flat();
}

async function build(admin: SupabaseClient, fresh: boolean): Promise<AdminBooking[]> {
  // cancelled_from_status comes from migration 00210; read it when it exists.
  const hasCancelOrigin = !(await admin.from('bookings').select('cancelled_from_status').limit(1)).error;
  const bookingCols = `id, user_id, child_id, session_id, provider_id, status, waitlist_position, payment_status, amount, stripe_payment_intent, package_purchase_id, guest_name, guest_contact, booking_group_id, created_at, cancel_reason, cancelled_by, cancel_refund_mode, medical_disclosure, info_response, policies_accepted${hasCancelOrigin ? ', cancelled_from_status' : ''}`;
  const [bookings, parents] = await Promise.all([
    fetchAll<BookingRow>((f, t) => admin.from('bookings')
      .select(bookingCols)
      .order('created_at', { ascending: false }).range(f, t) as unknown as PromiseLike<{ data: BookingRow[] | null; error: { message: string } | null }>),
    loadParents(admin, fresh),
  ]);

  type Session = { id: string; activity_id: string; starts_at: string; price: number | null; location_id: string | null };
  type Activity = {
    id: string; title: string; provider_id: string; price: number | null;
    location_id: string | null; address: string | null; postal_code: string | null;
    is_custom_location: boolean | null; custom_location_label: string | null;
  };
  const sessions = await byIds<Session>(admin, 'activity_sessions', 'id, activity_id, starts_at, price, location_id', bookings.map((b) => b.session_id));
  const activities = await byIds<Activity>(admin, 'activities', 'id, title, provider_id, price, location_id, address, postal_code, is_custom_location, custom_location_label', sessions.map((s) => s.activity_id));
  const providerIds = [...activities.map((a) => a.provider_id), ...bookings.map((b) => b.provider_id ?? '')];
  const [providers, locations, children, purchases, tokens] = await Promise.all([
    byIds<{ id: string; business_name: string; is_test: boolean | null }>(admin, 'providers', 'id, business_name, is_test', providerIds),
    byIds<{ id: string; name: string | null; address: string | null; postal_code: string | null }>(admin, 'provider_locations', 'id, name, address, postal_code', [...sessions.map((s) => s.location_id ?? ''), ...activities.map((a) => a.location_id ?? '')]),
    byIds<{ id: string; name: string }>(admin, 'children', 'id, name', bookings.map((b) => b.child_id ?? '')),
    byIds<{ id: string; package_id: string; credits_total: number; credits_remaining: number }>(admin, 'package_purchases', 'id, package_id, credits_total, credits_remaining', bookings.map((b) => b.package_purchase_id ?? '')),
    fetchAll<{ origin_booking_id: string | null; redeemed_booking_id: string | null }>((f, t) =>
      admin.from('make_up_tokens').select('origin_booking_id, redeemed_booking_id').range(f, t)),
  ]);
  const packages = await byIds<{ id: string; name: string }>(admin, 'packages', 'id, name', purchases.map((p) => p.package_id));

  const sessionBy = new Map(sessions.map((s) => [s.id, s]));
  const activityBy = new Map(activities.map((a) => [a.id, a]));
  const providerBy = new Map(providers.map((p) => [p.id, p]));
  const locationBy = new Map(locations.map((l) => [l.id, l]));
  const childBy = new Map(children.map((c) => [c.id, c.name]));
  const purchaseBy = new Map(purchases.map((p) => [p.id, p]));
  const packageBy = new Map(packages.map((p) => [p.id, p.name]));
  const parentBy = new Map(parents.map((p) => [p.id, p]));
  const redeemed = new Set(tokens.filter((t) => t.redeemed_booking_id).map((t) => t.redeemed_booking_id as string));
  // Bookings that a make-up token was issued for when they were cancelled.
  const compensated = new Set(tokens.filter((t) => t.origin_booking_id).map((t) => t.origin_booking_id as string));

  // One entry per booking group; a booking with no group is its own entry.
  const groups = new Map<string, BookingRow[]>();
  for (const b of bookings) {
    const key = b.booking_group_id ?? b.id;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }

  const out: AdminBooking[] = [];
  for (const [key, seats] of groups) {
    const first = seats[0];
    const session = sessionBy.get(first.session_id);
    const activity = session ? activityBy.get(session.activity_id) : undefined;
    const provider = providerBy.get(activity?.provider_id ?? first.provider_id ?? '');
    const parent = first.user_id ? parentBy.get(first.user_id) : undefined;
    const isManual = !first.user_id;
    // Where the class is held. Most venues are stored on the activity, not the session, so look in order:
    // the session's own venue, the activity's venue, a private-session label (the customer's own address),
    // and finally the address text saved on the activity.
    const sessionLoc = session?.location_id ? locationBy.get(session.location_id) : undefined;
    const activityLoc = activity?.location_id ? locationBy.get(activity.location_id) : undefined;
    const loc = sessionLoc ?? activityLoc;
    const venue: AdminBooking['venue'] = loc ? { name: loc.name, address: loc.address, postal: loc.postal_code }
      : activity?.is_custom_location ? { name: activity.custom_location_label ?? 'Private session at a custom location', address: null, postal: null }
      : activity?.address ? { name: null, address: activity.address, postal: activity.postal_code }
      : null;

    const paidSeats = seats.filter((s) => s.payment_status === 'paid' && Number(s.amount ?? 0) > 0);
    const credits = seats.filter((s) => s.package_purchase_id).length;
    const tokenCount = seats.filter((s) => redeemed.has(s.id)).length;
    const amount = paidSeats.reduce((t, s) => t + Number(s.amount ?? 0), 0);
    const live = seats.filter((s) => s.status !== 'cancelled');
    const status = live.length === 0 ? 'cancelled' : live[0].status;
    const classPrice = session?.price ?? activity?.price ?? null;
    const unpaidPriced = (status === 'pending' || status === 'cancelled') && Number(classPrice ?? 0) > 0;
    const payVia: PayVia = isManual ? 'manual' : tokenCount > 0 ? 'token' : credits > 0 ? 'credit' : paidSeats.length > 0 ? 'amount' : unpaidPriced ? 'unpaid' : 'free';

    const purchase = seats.map((s) => (s.package_purchase_id ? purchaseBy.get(s.package_purchase_id) : undefined)).find(Boolean);
    const childNames = seats.map((s) => (s.child_id ? childBy.get(s.child_id) : null) ?? s.guest_name ?? (isManual ? null : 'Guest child')).filter((n): n is string => !!n);

    out.push({
      id: key,
      isManual,
      isTest: provider?.is_test === true || (!!parent && parent.kind === 'test'),
      neverConfirmed: seats.every((s) => isNeverConfirmed(s)),
      parent: parent ? { id: parent.id, name: parent.name || parent.email, email: parent.email, postal: parent.area } : null,
      guestName: isManual ? first.guest_name : null,
      guestContact: isManual ? first.guest_contact : null,
      vendorId: provider?.id ?? null,
      vendorName: provider?.business_name ?? null,
      activityId: activity?.id ?? null,
      activityTitle: activity?.title ?? null,
      sessionAt: session?.starts_at ?? null,
      bookedAt: seats.reduce((m, s) => (s.created_at < m ? s.created_at : m), first.created_at),
      status,
      childCount: seats.length,
      childNames,
      payVia,
      amount: payVia === 'amount' ? Math.round(amount * 100) / 100 : null,
      credits: payVia === 'credit' || payVia === 'token' ? credits : 0,
      tokens: tokenCount,
      classPrice,
      venue,
      refund: refundOutcome({
        status, paymentStatus: first.payment_status, packagePurchaseId: seats.find((s) => s.package_purchase_id)?.package_purchase_id ?? null,
        hasCompensationToken: seats.some((s) => compensated.has(s.id)), cancelRefundMode: seats.map((s) => s.cancel_refund_mode).find(Boolean) ?? null,
      }),
      details: {
        seatCount: seats.length,
        paymentStatus: first.payment_status,
        stripePaymentIntent: seats.map((s) => s.stripe_payment_intent).find(Boolean) ?? null,
        packageName: purchase ? packageBy.get(purchase.package_id) ?? null : null,
        packageCreditsRemaining: purchase?.credits_remaining ?? null,
        packageCreditsTotal: purchase?.credits_total ?? null,
        cancelReason: seats.map((s) => s.cancel_reason).find(Boolean) ?? null,
        cancelledBy: seats.map((s) => s.cancelled_by).find(Boolean) ?? null,
        cancelRefundMode: seats.map((s) => s.cancel_refund_mode).find(Boolean) ?? null,
        policiesAccepted: first.policies_accepted?.length ?? 0,
        // Whether they were given is shown; the text itself is health information and stays out of the admin list.
        hasMedicalDisclosure: seats.some((s) => !!s.medical_disclosure?.trim()),
        hasInfoResponse: seats.some((s) => !!s.info_response?.trim()),
        waitlistPosition: first.waitlist_position,
      },
    });
  }
  return out;
}
