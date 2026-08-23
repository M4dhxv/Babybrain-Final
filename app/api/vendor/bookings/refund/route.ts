import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { refundBooking } from '@/lib/refunds';

/**
 * Refund a paid booking. Manager+, and only for their own business.
 *
 * Cancelling a booking has never moved money — `cancel_booking` just flips the
 * status, and the parent's notification says "any refund follows the
 * provider's policy", i.e. sort it out off-platform. This is the on-platform
 * version: it unwinds the Connect split properly (see lib/refunds.ts) rather
 * than leaving BabyBrain to absorb the parent's money back.
 *
 * Body: { provider_id, booking_id, amount_cents? }  — omit amount for a full
 * refund.
 */
export async function POST(request: Request) {
  const {
    provider_id: providerId,
    booking_id: bookingId,
    amount_cents: amountCents,
  } = (await request.json().catch(() => ({}))) as {
    provider_id?: string;
    booking_id?: string;
    amount_cents?: number;
  };

  if (!providerId || !bookingId) {
    return NextResponse.json({ error: 'provider_id and booking_id required' }, { status: 400 });
  }
  // Refunds move money, so managers and owners only — not general staff.
  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();

  // The booking must belong to this business. provider_id is stamped on insert
  // by handle_booking_insert, so this is a reliable check.
  const { data: booking } = await admin
    .from('bookings')
    .select('id, provider_id')
    .eq('id', bookingId)
    .maybeSingle();
  if (!booking || booking.provider_id !== providerId) {
    return NextResponse.json({ error: 'Booking not found for this business' }, { status: 404 });
  }

  const result = await refundBooking(admin, bookingId, amountCents);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({
    ok: true,
    refund_id: result.refundId ?? null,
    amount_cents: result.amountCents ?? 0,
  });
}
