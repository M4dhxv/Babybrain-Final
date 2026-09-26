import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;

/** Was this booking made by redeeming a make-up token? (redeemed_booking_id
 *  is cleared when such a booking is cancelled — 00081 — so this only ever
 *  matches a live one.) Every row needs this — an active booking can be
 *  paid_with "token" same as a cancelled one can. */
async function redeemedTokensFor(admin: Admin, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const { data } = await admin.from('make_up_tokens').select('redeemed_booking_id').in('redeemed_booking_id', ids);
  return new Set((data ?? []).map((t) => t.redeemed_booking_id).filter((id): id is string => !!id));
}

/** For a cancelled booking, did an auto make-up token get minted to
 *  compensate it? (00080) Only cancelled bookings ever carry a
 *  `compensation` value, and cancelled bookings only ever live in the
 *  `history` scope — an active-scope caller never needs this lookup. */
async function autoCompensatedFor(admin: Admin, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const { data } = await admin
    .from('make_up_tokens')
    .select('origin_booking_id')
    .in('origin_booking_id', ids)
    .eq('auto_issued', true);
  return new Set((data ?? []).map((t) => t.origin_booking_id).filter((id): id is string => !!id));
}

/** Which of the caller's *waitlisted* bookings can be paid for right now to
 *  claim a seat — a paid class, this booking still unsettled, the session
 *  has a free seat, and it's near enough the front of the queue to be in
 *  line for one. Fully derived, so it vanishes the instant the seat fills. */
async function claimableSeats(admin: Admin, rows: Array<{ status: string; session_id: string | null }>) {
  const claimable = new Set<string>();
  const wlSessionIds = [
    ...new Set(rows.filter((r) => r.status === 'waitlisted').map((r) => r.session_id).filter(Boolean)),
  ] as string[];
  if (!wlSessionIds.length) return claimable;

  const [{ data: sess }, { data: sessBookings }] = await Promise.all([
    admin
      .from('activity_sessions')
      .select('id, capacity, price, activities(price)')
      .in('id', wlSessionIds),
    admin
      .from('bookings')
      .select('id, session_id, status, payment_status, package_purchase_id, waitlist_position, waitlist_pay_invited, created_at')
      .in('session_id', wlSessionIds),
  ]);
  const wlBookingIds = (sessBookings ?? [])
    .filter((b) => b.status === 'waitlisted')
    .map((b) => b.id);
  let redeemedWl = new Set<string>();
  if (wlBookingIds.length) {
    const { data: rt } = await admin
      .from('make_up_tokens')
      .select('redeemed_booking_id')
      .eq('status', 'redeemed')
      .in('redeemed_booking_id', wlBookingIds);
    redeemedWl = new Set((rt ?? []).map((t) => t.redeemed_booking_id).filter((id): id is string => !!id));
  }
  const isSettled = (b: { id: string; payment_status: string | null; package_purchase_id: string | null }) =>
    b.payment_status === 'paid' || b.package_purchase_id != null || redeemedWl.has(b.id);
  for (const s of sess ?? []) {
    const price = Number(s.price ?? (s.activities as { price?: number | null } | null)?.price ?? 0);
    if (price <= 0) continue; // free class: promotion is automatic
    const onSession = (sessBookings ?? []).filter((b) => b.session_id === s.id);
    const wl = onSession.filter((b) => b.status === 'waitlisted');

    // A vendor who used "Promote" on an unpaid booking has offered the seat
    // explicitly — show "Pay now" even if the class is at capacity.
    for (const b of wl) {
      if (b.waitlist_pay_invited && !isSettled(b)) claimable.add(b.id);
    }

    const taken = onSession.filter((b) => b.status === 'confirmed' || b.status === 'pending').length;
    const free = s.capacity == null ? Number.POSITIVE_INFINITY : s.capacity - taken;
    if (free <= 0) continue;
    const queue = wl.sort(
      (a, b) =>
        (a.waitlist_position ?? 1e9) - (b.waitlist_position ?? 1e9) ||
        String(a.created_at).localeCompare(String(b.created_at))
    );
    for (let i = 0; i < Math.min(free, queue.length); i++) {
      if (!isSettled(queue[i])) claimable.add(queue[i].id);
    }
  }
  return claimable;
}

const BOOKING_COLUMNS =
  'id, status, created_at, child_id, guest_name, booking_group_id, package_purchase_id, payment_status, cancel_refund_mode, session_id, children(name), activity_sessions(starts_at, ends_at, activity_id, teacher_name, studio, allow_cancellation, allow_rescheduling, cancellation_cutoff_hours, cancellation_refund_mode, reschedule_cutoff_hours, provider_locations(name, address), activities(title, slug, image_urls, address, allow_cancellation, allow_rescheduling, cancellation_cutoff_hours, cancellation_refund_mode, reschedule_cutoff_hours, wix_removed_at, wix_missing_since, wix_service_type, wix_service_id))';

// A booking whose session started this long ago is treated as settled
// history rather than something that still needs a fresh read every visit —
// generous enough to comfortably cover a still-running multi-week course
// (whose *first* session can be well in the past while the course itself
// isn't over), so this is purely a caching boundary, not the exact
// upcoming-vs-past line the frontend itself draws per booking (that still
// happens client-side, against the merged result of both scopes — see
// ProfilePage's isPast/isUpcoming, which are course-aware in a way a single
// SQL cutoff can't cheaply be).
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** cancelled or pending/waitlisted are never "settled" — cancelled because
 *  the My Bookings tab keeps showing it (however old) alongside upcoming
 *  ones, pending/waitlisted because they're mid-flight and need to stay
 *  fresh regardless of how old the session date is. Everything else
 *  (confirmed) is settled once its session is more than ACTIVE_WINDOW_MS in
 *  the past. */
function isActive(r: { status: string; startsAt: string | null }, boundaryMs: number): boolean {
  if (r.status === 'cancelled') return false;
  if (r.status !== 'confirmed') return true;
  return !r.startsAt || new Date(r.startsAt).getTime() >= boundaryMs;
}

/**
 * The signed-in parent's own booking history, split into two independently
 * cacheable scopes (`?scope=active|history`).
 *
 * This used to be one unbounded query over a parent's *entire* booking
 * history plus two more full-history lookups chained after it — for a
 * long-time family that's a lot of rows re-joined and re-shipped on every
 * single visit, even though a cancelled or long-past booking never changes
 * again. The frontend fetches `active` fresh every time and caches `history`
 * far longer (lib/sessionCache.ts) than the rest of this page's reads, since
 * redoing that whole join buys nothing when the answer can't have changed.
 *
 * The direct client-side query this replaces relied on RLS's "published
 * activities are public" policy, which has no exception for a parent looking
 * at their own past booking — so once a vendor removes/unpublishes an
 * activity, the nested activities/activity_sessions join silently came back
 * null and My Bookings fell back to a bare "Class" placeholder with no date.
 *
 * This route runs the equivalent of "select own bookings" (bookings.user_id
 * = the caller) through the service role instead, so the join isn't subject
 * to the activities/activity_sessions publish-gated policies at all.
 */
export async function GET(request: Request) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const scope = new URL(request.url).searchParams.get('scope');
  if (scope !== 'active' && scope !== 'history') {
    return NextResponse.json({ error: 'scope must be "active" or "history"' }, { status: 400 });
  }

  const admin = createAdminClient();

  // A lightweight pass to classify every booking without paying for the big
  // multi-table join on rows this request doesn't even want — then the real
  // select below only ever touches the ids that matched.
  const { data: classifyRows, error: classifyError } = await admin
    .from('bookings')
    .select('id, status, activity_sessions(starts_at)')
    .eq('user_id', user.id);
  if (classifyError) return NextResponse.json({ error: classifyError.message }, { status: 500 });

  const boundaryMs = Date.now() - ACTIVE_WINDOW_MS;
  const matchingIds = (classifyRows ?? [])
    .filter((r) => {
      const active = isActive({ status: r.status, startsAt: r.activity_sessions?.starts_at ?? null }, boundaryMs);
      return scope === 'active' ? active : !active;
    })
    .map((r) => r.id);

  if (!matchingIds.length) return NextResponse.json({ bookings: [] });

  const { data, error } = await admin
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .in('id', matchingIds)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  /* Most recently booked first, so a class the parent just booked is at the
     top of the list rather than buried under earlier-dated ones. Class start
     time is the tiebreak (later session first) for two bookings made at the
     same moment. Sorted here rather than in the query: activity_sessions is a
     to-one embed, and PostgREST's `referencedTable` ordering sorts the
     embedded rows, not the bookings that carry them. */
  const rows = (data ?? []).slice().sort((a, b) => {
    const c = String(b.created_at).localeCompare(String(a.created_at));
    if (c !== 0) return c;
    const at = (a as { activity_sessions?: { starts_at?: string } }).activity_sessions?.starts_at ?? '';
    const bt = (b as { activity_sessions?: { starts_at?: string } }).activity_sessions?.starts_at ?? '';
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
  const allIds = rows.map((r) => r.id);

  // These read completely disjoint tables and never touch each other's
  // results, so they run together rather than one after the other. Which
  // ones are even needed depends on the scope: `autoCompensated` only ever
  // labels a cancelled booking (history-only), `claimableSeats` only ever
  // matches a waitlisted one (active-only, isActive above always keeps
  // waitlisted rows out of history) — running either for the scope that
  // can't use it would just be a wasted round trip.
  const [redeemedByToken, autoCompensated, claimable] = await Promise.all([
    redeemedTokensFor(admin, allIds),
    scope === 'history' ? autoCompensatedFor(admin, allIds) : Promise.resolve(new Set<string>()),
    scope === 'active' ? claimableSeats(admin, rows) : Promise.resolve(new Set<string>()),
  ]);

  const bookings = rows.map((r) => {
    // A session-level policy override (migration 00133) wins over the
    // activity's default; null on the session means "inherit". Folded into
    // the returned `activities` object so the frontend's existing
    // act.allow_cancellation-style reads stay correct without change.
    const sess = r.activity_sessions;
    const act = sess?.activities;
    const effectiveActivity =
      act && sess
        ? {
            ...act,
            allow_cancellation: sess.allow_cancellation ?? act.allow_cancellation,
            allow_rescheduling: sess.allow_rescheduling ?? act.allow_rescheduling,
            cancellation_cutoff_hours: sess.cancellation_cutoff_hours ?? act.cancellation_cutoff_hours,
            reschedule_cutoff_hours: sess.reschedule_cutoff_hours ?? act.reschedule_cutoff_hours,
            cancellation_refund_mode: sess.cancellation_refund_mode ?? act.cancellation_refund_mode,
          }
        : act;

    // The refund decision for this booking: what it was cancelled with, else
    // the class default, else the historical 'refund'. Drives both the
    // pre-cancel heads-up and the permanent line on a cancelled card.
    const refundMode: 'refund' | 'none' =
      (r.cancel_refund_mode as 'refund' | 'none' | null) ??
      ((effectiveActivity?.cancellation_refund_mode as 'refund' | 'none' | undefined) ??
        'refund');
    return {
      ...r,
      activity_sessions: sess ? { ...sess, activities: effectiveActivity } : sess,
      // What paid for this booking — drives the cancel-confirm heads-up.
      paid_with: redeemedByToken.has(r.id)
        ? 'token'
        : r.package_purchase_id
          ? 'credit'
          : r.payment_status === 'paid'
            ? 'cash'
            : 'free',
      // What this class gives back on cancellation.
      refund_mode: refundMode,
      // A waitlisted booking with a seat waiting for it — show "Pay now".
      can_claim: claimable.has(r.id),
      // How a cancelled booking was made good (00080/00081) — the permanent
      // line on the card. 'none' when the provider withheld a refund, so the
      // card doesn't imply a credit came back off a lingering
      // package_purchase_id.
      compensation:
        r.status !== 'cancelled'
          ? null
          : refundMode === 'none'
            ? 'none'
            : autoCompensated.has(r.id)
              ? 'token'
              : r.package_purchase_id
                ? 'credit'
                : null,
    };
  });

  return NextResponse.json({ bookings });
}
