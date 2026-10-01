/**
 * The admin portal's rules for "is this a test account / a real booking?", in one place.
 *
 * Metrics, the Parents list, Payments and the attention queue used to each decide this for
 * themselves, and the numbers drifted apart. Everything now goes through these pure functions
 * (no database, no framework), which also makes them testable: see admin-test-rules.test.ts,
 * run with `npm run test:admin`.
 */

/** Emails that are staff, demo or QA logins rather than real families. */
const TEST_EMAIL = /(@babybrain\.(sg|com)$|@example\.(com|org|net)$|\.test$|@mailinator\.com$)/i;

export const isTestEmail = (email: string | null | undefined): boolean =>
  !!email && TEST_EMAIL.test(email.trim());

// ---- accounts -----------------------------------------------------------------------------------

/** One status per account, in this order of precedence: test > vendor login > vendor + parent > parent. */
export type AccountKind = 'test' | 'vendor_login' | 'vendor_parent' | 'parent';

export type ParentRuleInput = {
  email: string | null | undefined;
  /** An admin marked this account as test (parent_profiles.is_test). Always wins. */
  manualTest?: boolean | null;
  /** An admin marked this account as a real parent (parent_profiles.is_real_override): the automatic
   *  test rules are skipped. Ignored if manualTest is also set. */
  forcedReal?: boolean | null;
  /** Active vendor seats this login holds; `isTestVendor` is that business's is_test flag. */
  seats?: { isTestVendor: boolean }[];
  /** Has children saved or at least one booking that counts: i.e. it was used as a parent. */
  hasParentActivity?: boolean;
};

export type ParentClass = {
  kind: AccountKind;
  isVendor: boolean;
  /** 'manual' = flagged by an admin, 'auto' = decided by the rules below. */
  testSource: 'manual' | 'auto' | null;
  testReason: string | null;
};

export function classifyParent(i: ParentRuleInput): ParentClass {
  const seats = i.seats ?? [];
  const isVendor = seats.length > 0;
  const active = !!i.hasParentActivity;
  const kindIfNotTest: AccountKind = isVendor ? (active ? 'vendor_parent' : 'vendor_login') : 'parent';

  if (i.manualTest) return { kind: 'test', isVendor, testSource: 'manual', testReason: 'Marked by an admin' };

  if (i.forcedReal) {
    // The admin said this is a real parent: skip the automatic test rules. A vendor login with no
    // parent activity is still just a vendor login unless it is forced real, in which case it counts.
    return { kind: isVendor ? 'vendor_parent' : 'parent', isVendor, testSource: null, testReason: null };
  }

  if (isTestEmail(i.email)) return { kind: 'test', isVendor, testSource: 'auto', testReason: 'Test-looking email' };
  if (isVendor && seats.every((s) => s.isTestVendor)) {
    return { kind: 'test', isVendor, testSource: 'auto', testReason: 'Works only for test vendors' };
  }
  return { kind: kindIfNotTest, isVendor, testSource: null, testReason: null };
}

/** Does this account count as a parent in the Parents list (by default) and in Metrics? */
export const countsAsParent = (kind: AccountKind): boolean => kind === 'parent' || kind === 'vendor_parent';

// ---- bookings -----------------------------------------------------------------------------------

export type BookingRuleInput = {
  user_id: string | null;
  status: string;
  payment_status: string;
  amount: number | null;
  package_purchase_id: string | null;
  /** Where the booking was cancelled from (migration 00210), when recorded. */
  cancelled_from_status?: string | null;
};

/** A booking a vendor added by hand to their own roster: no parent account behind it. */
export const isManualBooking = (b: Pick<BookingRuleInput, 'user_id'>): boolean => !b.user_id;

/**
 * Cancelled before it was ever confirmed or paid (an abandoned or expired checkout, or a waitlist
 * entry). Never a real booking, so it is left out of booking counts and the cancellation rate.
 * Uses the recorded cancel origin when there is one; otherwise infers it: a priced booking with no
 * payment and no package credit was pending.
 */
export function isNeverConfirmed(b: BookingRuleInput): boolean {
  if (b.status !== 'cancelled') return false;
  if (b.cancelled_from_status) return b.cancelled_from_status === 'pending' || b.cancelled_from_status === 'waitlisted';
  return b.payment_status === 'none' && Number(b.amount ?? 0) > 0 && !b.package_purchase_id;
}

/** A booking made by a real parent through the app (not a manual roster entry), and still held. */
export const isParentBooking = (b: BookingRuleInput): boolean =>
  !isManualBooking(b) && b.status !== 'cancelled' && b.status !== 'waitlisted';

/** Every live booking falls in exactly one bucket, so the three split boxes add up to the total. */
export type BookingBucket = 'manual' | 'paid' | 'other';
export const bookingBucket = (b: BookingRuleInput): BookingBucket =>
  isManualBooking(b) ? 'manual' : b.payment_status === 'paid' ? 'paid' : 'other';

// ---- payments -----------------------------------------------------------------------------------

export type EarningRuleInput = {
  /** The vendor is a test vendor. */
  vendorIsTest: boolean;
  /** Stripe test-mode payment (provider_earnings.livemode = false). */
  livemode?: boolean | null;
  /** An admin flagged this single transaction as test (provider_earnings.is_test). */
  flaggedTest?: boolean | null;
  status?: string | null;
};

/** Does this payment count as live money? (Refunds are handled separately by each total.) */
export const isLiveEarning = (e: EarningRuleInput): boolean =>
  !e.vendorIsTest && e.livemode !== false && !e.flaggedTest;
