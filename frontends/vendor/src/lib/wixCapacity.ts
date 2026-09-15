/** Local booking statuses that occupy a real seat on a session — must match
 *  handle_booking_insert's own capacity check (00008_vendor_functions.sql):
 *  a new booking only gets waitlisted once `pending + confirmed` already
 *  reaches capacity, so a 'pending' row (payment in flight) already holds a
 *  seat exactly like 'confirmed' does — it isn't a queue position the way
 *  'waitlisted' is. 'completed' is just what a confirmed booking becomes
 *  after the session runs, included so a past session still reads as fully
 *  booked. DashboardPage/BookingsPage/SchedulePage each used to define this
 *  set by hand and had drifted (two of them excluded 'pending', silently
 *  undercounting how full a session with an in-progress payment actually
 *  was) — this is the one place it's defined now. */
export const HELD_BOOKING_STATUSES = new Set(['pending', 'confirmed', 'completed']);

export function isHeldBookingStatus(status: string): boolean {
  return HELD_BOOKING_STATUSES.has(status);
}

export interface WixCapacityInputs {
  /** `activity_sessions.wix_slot_key` — null/undefined for a session that
   *  isn't Wix-materialized, in which case wix_remaining_capacity is never
   *  trusted even if it happened to be non-null. */
  wixSlotKey: string | null | undefined;
  wixRemainingCapacity: number | null | undefined;
  capacity: number | null | undefined;
  /** The session's activity's `wix_service_type` — only a Wix CLASS can
   *  legitimately run "over capacity" as BabyBrain-side promoted overflow
   *  (00108); everything else reports 0 overflow regardless of the numbers. */
  wixServiceType: string | null | undefined;
  /** Count of this session's local bookings with a held status (see
   *  {@link isHeldBookingStatus}) — the caller's own query, since each page
   *  fetches/joins bookings differently. */
  localHeldCount: number;
}

export interface WixCapacityResult {
  /** The number to show as "booked" — the higher of Wix's own filled figure
   *  and our held local rows (00108). A slot can be booked directly on Wix's
   *  own site, so the local count alone under-reports it; conversely Wix's
   *  own availability figure has been observed to lag a booking just made
   *  through BabyBrain, so trusting it exclusively can under-report the
   *  other way. Taking the higher of the two covers both directions. */
  booked: number;
  /** How much of `booked` sits past `capacity` — always 0 unless this is a
   *  Wix CLASS with a known capacity, since capacity mirrors Wix and can't
   *  be raised locally for one (00108): a paid seat past it is BabyBrain's
   *  own promoted overflow, not a mistake. */
  overflow: number;
}

export function computeWixAwareCapacity(input: WixCapacityInputs): WixCapacityResult {
  const wixDerived =
    !!input.wixSlotKey && input.wixRemainingCapacity != null && input.capacity != null
      ? Math.max(0, input.capacity - input.wixRemainingCapacity)
      : 0;
  const booked = Math.max(input.localHeldCount, wixDerived);
  const overflow =
    input.wixServiceType === 'CLASS' && input.capacity != null ? Math.max(0, booked - input.capacity) : 0;
  return { booked, overflow };
}
