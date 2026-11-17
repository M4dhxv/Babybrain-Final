import type { SupabaseClient } from '@supabase/supabase-js';
import type { createAdminClient } from '@/lib/supabase/admin';

/**
 * Add-ons: extra people on a booking, priced on top of the class (migration 00273).
 *
 * Add-ons are headcount, not seats — they never touch capacity or the waitlist. The price is always
 * read from the vendor's catalogue here, never trusted from the client, and copied onto the purchase
 * row so a later price change can't rewrite what a parent paid.
 *
 * The tables are newer than the generated database types, so the client is used loosely here.
 */
type Admin = ReturnType<typeof createAdminClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = SupabaseClient<any, 'public', any>;
const loose = (admin: Admin) => admin as unknown as Loose;

export const MAX_ADDON_QUANTITY = 10;

function rangeText(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `ages ${min} to ${max}`;
  return max !== null ? `ages ${max} and under` : `ages ${min} and over`;
}

export interface AddonPick {
  addon_id: string;
  quantity: number;
  /** One name per person, blank allowed. */
  names?: string[];
  /** One age in whole years per person (null = not given). Required when the add-on has an age range. */
  ages?: Array<number | null>;
}

/** A whole-year age 0..120, or null for anything else. */
export function cleanAge(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 120 ? n : null;
}

export interface StripeLineItem {
  price_data: {
    currency: 'sgd';
    unit_amount: number;
    product_data: { name: string };
  };
  quantity: number;
}

export type PrepareResult =
  | {
      ok: true;
      /** The pending purchase rows just created. */
      rowIds: string[];
      /** What each row costs in cents, same order as rowIds (for paying part of it with make-up credit). */
      rowCents: number[];
      /** Stripe line items for the paid ones (free add-ons carry no line). */
      lineItems: StripeLineItem[];
      totalCents: number;
    }
  | { ok: false; status: number; error: string };

/** Tidy a client-supplied selection: whole quantities 1..10, duplicates merged, junk dropped. */
export function normalisePicks(raw: unknown): AddonPick[] {
  if (!Array.isArray(raw)) return [];
  const merged = new Map<string, AddonPick>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { addon_id, quantity, names, ages } = item as Partial<AddonPick>;
    if (typeof addon_id !== 'string' || !addon_id) continue;
    const q = Math.floor(Number(quantity));
    if (!Number.isFinite(q) || q < 1) continue;
    const cleanNames = Array.isArray(names)
      ? names.map((n) => (typeof n === 'string' ? n.trim().slice(0, 80) : ''))
      : [];
    const cleanAges = Array.isArray(ages) ? ages.map(cleanAge) : [];
    const prev = merged.get(addon_id);
    if (prev) {
      prev.quantity += q;
      prev.names = [...(prev.names ?? []), ...cleanNames];
      prev.ages = [...(prev.ages ?? []), ...cleanAges];
    } else {
      merged.set(addon_id, { addon_id, quantity: q, names: cleanNames, ages: cleanAges });
    }
  }
  return [...merged.values()];
}

/**
 * Validate a parent's add-on selection for one booking and write it as pending purchase rows.
 *
 * Checks, all server-side: each add-on belongs to this booking's activity and is still on offer;
 * the quantity respects the vendor's per-booking cap counting what the booking already holds paid.
 */
export async function prepareAddonRows(
  admin: Admin,
  opts: {
    bookingId: string;
    /** Every seat of the party this booking belongs to: the cap counts add-ons held on any of them. */
    partyBookingIds?: string[];
    userId: string;
    activityId: string;
    activityTitle: string;
    providerId: string;
    picks: AddonPick[];
  }
): Promise<PrepareResult> {
  const db = loose(admin);
  if (opts.picks.length === 0) return { ok: false, status: 400, error: 'Pick at least one add-on.' };

  // Additional people are the vendor's opt-in (off by default), and are never part of a pack: a booking
  // made with a pack credit takes companions only.
  const { data: act } = await db.from('activities').select('allow_additional_people').eq('id', opts.activityId).maybeSingle();
  if (!act || (act as { allow_additional_people: boolean | null }).allow_additional_people !== true) {
    return { ok: false, status: 409, error: "This provider isn't offering additional people on this class." };
  }
  const { data: packSeat } = await db
    .from('bookings')
    .select('id')
    .in('id', opts.partyBookingIds?.length ? opts.partyBookingIds : [opts.bookingId])
    .not('package_purchase_id', 'is', null)
    .limit(1);
  if (packSeat && packSeat.length > 0) {
    return { ok: false, status: 409, error: "Additional people can't be added to a booking made with a pack. A pack booking includes the class's companion only." };
  }

  const { data: offered, error: offeredError } = await db
    .from('activity_addons')
    .select('id, name, price_cents, max_per_booking, min_age, max_age, active')
    .eq('activity_id', opts.activityId)
    .in('id', opts.picks.map((p) => p.addon_id));
  if (offeredError) return { ok: false, status: 500, error: 'Could not load the add-ons — please try again.' };
  const byId = new Map(
    ((offered ?? []) as Array<{ id: string; name: string; price_cents: number; max_per_booking: number | null; min_age: number | null; max_age: number | null; active: boolean }>).map((a) => [a.id, a])
  );

  const { data: held } = await db
    .from('booking_addons')
    .select('addon_id, quantity')
    .in('booking_id', opts.partyBookingIds?.length ? opts.partyBookingIds : [opts.bookingId])
    .eq('payment_status', 'paid');
  const alreadyHeld = new Map<string, number>();
  for (const r of (held ?? []) as Array<{ addon_id: string | null; quantity: number }>) {
    if (r.addon_id) alreadyHeld.set(r.addon_id, (alreadyHeld.get(r.addon_id) ?? 0) + r.quantity);
  }

  const inserts: Array<Record<string, unknown>> = [];
  const lineItems: StripeLineItem[] = [];
  let totalCents = 0;
  for (const pick of opts.picks) {
    const addon = byId.get(pick.addon_id);
    if (!addon || !addon.active) {
      return { ok: false, status: 409, error: 'One of those add-ons is no longer offered — please refresh and try again.' };
    }
    const cap = Math.min(addon.max_per_booking ?? MAX_ADDON_QUANTITY, MAX_ADDON_QUANTITY);
    const room = cap - (alreadyHeld.get(addon.id) ?? 0);
    if (pick.quantity > room) {
      return {
        ok: false,
        status: 409,
        error:
          room <= 0
            ? `This booking already has the most "${addon.name}" allowed.`
            : `You can add ${room} more "${addon.name}" to this booking.`,
      };
    }
    // When the vendor set an age range, every person needs an age inside it: a child price can't be
    // bought for an adult. The app warns and blocks first; this is the check that can't be bypassed.
    const hasRange = addon.min_age !== null || addon.max_age !== null;
    const ages = Array.from({ length: pick.quantity }, (_, i) => cleanAge(pick.ages?.[i]));
    if (hasRange && ages.some((a) => a === null)) {
      return { ok: false, status: 400, error: `Enter an age for each "${addon.name}" so the provider knows who is coming.` };
    }
    const outside = ages.find((a) => a !== null && ((addon.min_age !== null && a < addon.min_age) || (addon.max_age !== null && a > addon.max_age)));
    if (outside !== undefined) {
      return { ok: false, status: 400, error: `"${addon.name}" is for ${rangeText(addon.min_age, addon.max_age)}, but one person is ${outside}. Please choose the add-on that matches their age.` };
    }
    inserts.push({
      booking_id: opts.bookingId,
      user_id: opts.userId,
      provider_id: opts.providerId,
      addon_id: addon.id,
      kind: 'additional',
      name: addon.name,
      unit_price_cents: addon.price_cents,
      quantity: pick.quantity,
      person_names: Array.from({ length: pick.quantity }, (_, i) => pick.names?.[i] ?? ''),
      person_ages: ages,
      age_min: addon.min_age,
      age_max: addon.max_age,
      payment_status: 'pending',
    });
    totalCents += addon.price_cents * pick.quantity;
    if (addon.price_cents > 0) {
      lineItems.push({
        price_data: {
          currency: 'sgd',
          unit_amount: addon.price_cents,
          product_data: { name: `${opts.activityTitle} — ${addon.name}` },
        },
        quantity: pick.quantity,
      });
    }
  }

  const { data: created, error: insertError } = await db.from('booking_addons').insert(inserts).select('id');
  if (insertError || !created) return { ok: false, status: 500, error: 'Could not save the add-ons — please try again.' };
  return {
    ok: true,
    rowIds: (created as Array<{ id: string }>).map((r) => r.id),
    rowCents: inserts.map((r) => Number(r.unit_price_cents) * Number(r.quantity)),
    lineItems,
    totalCents,
  };
}

/**
 * Mark add-on purchases paid. Idempotent (webhook and reconcile both call it), and deliberately
 * accepts a row an overlapping attempt cancelled: if Stripe took the money, the parent holds the add-on.
 * Returns the gross cents just settled, so the caller can add it to the vendor's earnings ledger.
 */
export async function settleAddonRows(
  admin: Admin,
  rowIds: string[],
  paymentIntent: string | null,
  scopeUserId?: string
): Promise<{ settledCents: number; creditCents: number; providerId: string | null; bookingId: string | null }> {
  const ids = rowIds.filter(Boolean);
  if (ids.length === 0) return { settledCents: 0, creditCents: 0, providerId: null, bookingId: null };
  const db = loose(admin);
  let q = db
    .from('booking_addons')
    .update({ payment_status: 'paid', paid_at: new Date().toISOString(), stripe_payment_intent: paymentIntent })
    .in('id', ids)
    .neq('payment_status', 'paid');
  if (scopeUserId) q = q.eq('user_id', scopeUserId);
  const { data } = await q.select('unit_price_cents, quantity, provider_id, booking_id, credit_cents');
  const rows = (data ?? []) as Array<{ unit_price_cents: number; quantity: number; provider_id: string; booking_id: string; credit_cents: number | null }>;
  return {
    settledCents: rows.reduce((s, r) => s + r.unit_price_cents * r.quantity, 0),
    // The part of it that make-up credit paid (00276): no card money, so not new earnings for the vendor.
    creditCents: rows.reduce((s, r) => s + Number(r.credit_cents ?? 0), 0),
    providerId: rows[0]?.provider_id ?? null,
    bookingId: rows[0]?.booking_id ?? null,
  };
}

/** An abandoned or expired checkout: its unpaid add-on rows are dropped (a paid row is never touched). */
export async function releaseAddonRows(admin: Admin, rowIds: string[]): Promise<void> {
  const ids = rowIds.filter(Boolean);
  if (ids.length === 0) return;
  await loose(admin).from('booking_addons').delete().in('id', ids).eq('payment_status', 'pending');
}

/** The ids stamped on a Stripe session's metadata by whichever checkout created them. */
export function addonRowIdsFromMetadata(metadata: Record<string, string> | null | undefined): string[] {
  return (metadata?.addon_row_ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
