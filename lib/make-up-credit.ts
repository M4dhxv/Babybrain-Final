import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { createAdminClient } from '@/lib/supabase/admin';

/**
 * Make-up credit (migration 00276): a parent's make-up tokens with one vendor are a money balance they
 * can spend on anything that vendor sells. Every checkout asks for credit the same way:
 *
 *   1. work out the total in cents and the pieces it splits into (seats, add-on rows, a pack);
 *   2. reserveCredit() takes what the balance covers, soonest-expiring lot first, and marks it 'held';
 *   3. the card is charged for the rest (or nothing, when credit covers it all);
 *   4. when the purchase settles the held credit becomes 'applied'; if it never does it goes back.
 *
 * Seats and add-on rows settle and release themselves in the database (their rows are confirmed,
 * cancelled or deleted). A pack or a Wix ticket has no such row before payment, so it carries a hold id in
 * the Stripe metadata and the webhook settles or releases it.
 *
 * The functions are new, so the client is used loosely, as in booking-addons.ts.
 */
type Admin = ReturnType<typeof createAdminClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = SupabaseClient<any, 'public', any>;
const loose = (admin: Admin) => admin as unknown as Loose;

export const newHoldId = (): string => randomUUID();

/** One piece of a purchase. Exactly one of bookingId / addonRowId, or neither (a pack or ticket). */
export interface CreditItem {
  bookingId?: string | null;
  addonRowId?: string | null;
  cents: number;
}

export interface CreditReservation {
  total: number;
  /** Cents actually reserved for each item, in the order given. */
  items: Array<{ booking_id: string | null; addon_row_id: string | null; cents: number }>;
}

/** What the parent can spend with this vendor right now, in cents. */
export async function creditBalance(admin: Admin, userId: string, providerId: string): Promise<number> {
  const { data, error } = await loose(admin).rpc('make_up_credit_balance', { p_user: userId, p_provider: providerId });
  if (error) {
    console.error('[make-up-credit] balance failed:', error.message);
    return 0;
  }
  return Number(data ?? 0);
}

/**
 * Take credit for a purchase. Never reserves more than asked or more than the balance; returns what it
 * took. A failure reserves nothing (the transaction is the single RPC), so the caller can safely carry on
 * as a plain card payment.
 */
export async function reserveCredit(
  admin: Admin,
  opts: {
    userId: string;
    providerId: string;
    holdId: string;
    refKind: 'booking' | 'package' | 'addon' | 'wix_booking' | 'wix_event';
    refId?: string;
    items: CreditItem[];
  }
): Promise<CreditReservation> {
  const wanted = opts.items.filter((i) => i.cents > 0);
  if (wanted.length === 0) return { total: 0, items: [] };
  const { data, error } = await loose(admin).rpc('reserve_make_up_credit', {
    p_user: opts.userId,
    p_provider: opts.providerId,
    p_hold: opts.holdId,
    p_ref_kind: opts.refKind,
    p_ref_id: opts.refId ?? null,
    p_items: wanted.map((i) => ({
      booking_id: i.bookingId ?? null,
      addon_row_id: i.addonRowId ?? null,
      cents: Math.round(i.cents),
    })),
  });
  if (error) {
    console.error('[make-up-credit] reserve failed:', error.message);
    return { total: 0, items: [] };
  }
  const r = data as CreditReservation | null;
  return r ?? { total: 0, items: [] };
}

/** A checkout that never completed: everything still held for it goes back. Safe to call twice. */
export async function releaseHold(admin: Admin, holdId: string | null | undefined): Promise<void> {
  if (!holdId) return;
  const { error } = await loose(admin).rpc('release_make_up_credit_hold', { p_hold: holdId });
  if (error) console.error('[make-up-credit] release failed for', holdId, error.message);
}

/** A checkout that was paid: held credit becomes applied. Safe to call twice. */
export async function settleHold(admin: Admin, holdId: string | null | undefined): Promise<void> {
  if (!holdId) return;
  const { error } = await loose(admin).rpc('settle_make_up_credit_hold', { p_hold: holdId });
  if (error) console.error('[make-up-credit] settle failed for', holdId, error.message);
}

/** Hand back whatever is still held on one booking seat (a seat that could not be seated, or a retry). */
export async function releaseHeldForBooking(admin: Admin, bookingId: string): Promise<number> {
  const { data, error } = await loose(admin).rpc('return_make_up_credit', {
    p_booking: bookingId,
    p_hold: null,
    p_statuses: ['held'],
  });
  if (error) {
    console.error('[make-up-credit] return failed for', bookingId, error.message);
    return 0;
  }
  return Number(data ?? 0);
}

/**
 * Seats a credit-only booking: confirms them (re-checking capacity for a waitlist claim, under the same
 * session lock a card payment uses). Returns the ids that got a seat; any seat that did not has its
 * credit handed back and stays on the waitlist.
 */
export async function confirmCreditSeats(admin: Admin, seatIds: string[]): Promise<{ confirmedIds: string[]; unseatedIds: string[]; failed?: boolean }> {
  const { data, error } = await loose(admin).rpc('confirm_credit_booking_seats', { p_seat_ids: seatIds });
  if (error || !data) {
    console.error('[make-up-credit] confirm failed:', error?.message ?? 'no rows');
    return { confirmedIds: [], unseatedIds: [], failed: true };
  }
  const rows = data as Array<{ id: string; confirmed: boolean }>;
  const confirmedIds = rows.filter((r) => r.confirmed).map((r) => r.id);
  const unseatedIds = rows.filter((r) => !r.confirmed).map((r) => r.id);
  for (const id of unseatedIds) await releaseHeldForBooking(admin, id);
  return { confirmedIds, unseatedIds };
}

/** Dollars-and-cents for a message, e.g. 1500 -> "$15.00". */
export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
