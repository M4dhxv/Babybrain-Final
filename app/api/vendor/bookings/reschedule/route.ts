import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { getProviderWixCredentials } from '@/lib/wix/client';
import { rescheduleWixClassBookingToSession } from '@/lib/wix/sync';

/**
 * A vendor moves a family's booking to another session of the same class (client, 2026-10-21) —
 * the vendor-side twin of the parent's own reschedule, as a vendor can already cancel.
 *
 * Body: { provider_id, booking_id, new_session_id, increase_capacity? }
 *
 * The move itself (whole party, capacity under a lock, the parent's "Booking moved" notice) is
 * vendor_reschedule_booking (migration 00249). A Wix-linked CLASS booking is moved in Wix first —
 * the same call the parent route uses — so Wix's calendar and seat counts stay right; its capacity
 * is Wix's, so it can't be raised from here.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    provider_id?: string; booking_id?: string; new_session_id?: string; increase_capacity?: boolean;
  };
  const { provider_id: providerId, booking_id: bookingId, new_session_id: newSessionId } = body;
  if (!providerId || !bookingId || !newSessionId) {
    return NextResponse.json({ error: 'provider_id, booking_id and new_session_id are required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data: booking } = await admin
    .from('bookings')
    .select('id, session_id, status, booking_group_id, wix_booking_id, activity_sessions!inner(activity_id, activities!inner(provider_id, wix_service_id, wix_service_type))')
    .eq('id', bookingId)
    .maybeSingle();
  const act = (booking?.activity_sessions as unknown as {
    activity_id: string; activities: { provider_id: string; wix_service_id: string | null; wix_service_type: string | null };
  } | null)?.activities;
  if (!booking || act?.provider_id !== providerId) {
    return NextResponse.json({ error: 'That booking is not with your business.' }, { status: 404 });
  }

  // Wix-linked class: move it in Wix too (only when the booking is actually in Wix).
  const inWix = !!(act.wix_service_id && act.wix_service_type === 'CLASS' && booking.wix_booking_id);
  if (inWix) {
    if (body.increase_capacity) {
      return NextResponse.json({ error: "This class's capacity is set in Wix — raise it there, then move the booking." }, { status: 400 });
    }
    const { data: target } = await admin
      .from('activity_sessions').select('id, activity_id, starts_at, capacity, wix_slot_key').eq('id', newSessionId).maybeSingle();
    if (!target || target.activity_id !== (booking.activity_sessions as unknown as { activity_id: string }).activity_id) {
      return NextResponse.json({ error: 'You can only move a booking to another session of the same class.' }, { status: 400 });
    }
    if (!target.wix_slot_key) {
      return NextResponse.json({ error: "That session isn't on Wix, so a Wix booking can't be moved there." }, { status: 400 });
    }
    // Room check before touching Wix (the database function checks again, under a lock).
    if (target.capacity != null) {
      const party = booking.booking_group_id
        ? (await admin.from('bookings').select('id', { count: 'exact', head: true })
            .eq('booking_group_id', booking.booking_group_id).in('status', ['pending', 'confirmed'])).count ?? 1
        : 1;
      const { count } = await admin.from('bookings').select('id', { count: 'exact', head: true })
        .eq('session_id', newSessionId).in('status', ['pending', 'confirmed']);
      if ((count ?? 0) + party > target.capacity) {
        return NextResponse.json({ error: 'That session is full. Raise its capacity in Wix first.' }, { status: 409 });
      }
    }
    const creds = await getProviderWixCredentials(admin, providerId);
    if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
    const moved = await rescheduleWixClassBookingToSession(creds, act.wix_service_id!, booking.wix_booking_id!, { wix_slot_key: target.wix_slot_key });
    if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: moved.status });
  }

  const { data, error } = await (admin as unknown as SupabaseClient)
    .rpc('vendor_reschedule_booking', {
      p_provider: providerId,
      p_booking_id: bookingId,
      p_new_session_id: newSessionId,
      p_increase_capacity: !!body.increase_capacity && !inWix,
    })
    .single();
  if (error) {
    if (inWix) console.error('Vendor reschedule: moved in Wix but not on BabyBrain', bookingId, error);
    return NextResponse.json({
      error: inWix ? `Moved in Wix, but BabyBrain couldn't save it: ${error.message}. Contact support.` : error.message,
    }, { status: inWix ? 500 : 400 });
  }
  const r = data as { moved: number; new_starts_at: string; capacity_raised: number };
  return NextResponse.json({ ok: true, moved: r.moved, new_starts_at: r.new_starts_at, capacity_raised: r.capacity_raised, wix: inWix });
}
