import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  fetchWixAvailability,
  fetchWixClassSessions,
  createWixBooking,
  createWixClassBooking,
  decodeWixSlotKey,
  getProviderWixCredentials,
} from '@/lib/wix/client';

/**
 * Parent books a Wix-sourced slot. Re-validates against live Wix
 * availability (never trusts client-supplied slot times) to close the race
 * where a slot fills between the picker loading and "Book" being clicked,
 * creates the booking in Wix, then materializes exactly one
 * activity_sessions row for that slot/session (capacity from Wix — 1 for an
 * appointment, the class's real remaining capacity for a class) and inserts
 * the local booking referencing it — so the existing capacity/waitlist
 * trigger (handle_booking_insert) and every feature reading bookings/
 * activity_sessions keeps working unmodified.
 * Body: { activityId, wixSlotId, childId?, policiesAccepted?, medicalDisclosure? }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    activityId?: string;
    wixSlotId?: string;
    childId?: string | null;
    policiesAccepted?: string[];
    medicalDisclosure?: string;
  };
  const { activityId, wixSlotId } = body;
  if (!activityId || !wixSlotId?.startsWith('wix:')) {
    return NextResponse.json({ error: 'activityId and wixSlotId required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: activity } = await admin
    .from('activities')
    .select('id, provider_id, wix_service_id, wix_resource_id, wix_service_type')
    .eq('id', activityId)
    .maybeSingle();
  if (!activity?.wix_service_id || !activity.provider_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }
  const isClass = activity.wix_service_type === 'CLASS' || activity.wix_service_type === 'COURSE';
  if (!isClass && !activity.wix_resource_id) {
    return NextResponse.json({ error: 'Activity is not linked to a Wix service' }, { status: 404 });
  }

  const key = wixSlotId.slice('wix:'.length);
  const slotKey = decodeWixSlotKey(key);
  if (isClass !== (slotKey.kind === 'class')) {
    return NextResponse.json({ error: 'Slot does not match this activity' }, { status: 400 });
  }

  const creds = await getProviderWixCredentials(admin, activity.provider_id);
  if (!creds) {
    return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });
  }

  const { data: parent } = await admin
    .from('parent_profiles')
    .select('full_name, email, phone')
    .eq('id', user.id)
    .maybeSingle();
  const [firstName, ...rest] = (parent?.full_name || user.email || 'Parent').trim().split(/\s+/);
  const contact = {
    firstName: firstName || 'Parent',
    lastName: rest.join(' ') || '-',
    email: parent?.email || user.email || '',
    phone: parent?.phone || '',
  };

  let startsAt: string;
  let endsAt: string;
  let capacity: number;
  let wixBookingId: string;

  try {
    if (slotKey.kind === 'class') {
      const sessions = await fetchWixClassSessions(creds, activity.wix_service_id);
      const session = sessions.find((s) => s.id === slotKey.sessionId && s.remainingCapacity > 0);
      if (!session) {
        return NextResponse.json({ error: 'That class is no longer available' }, { status: 409 });
      }
      const booking = await createWixClassBooking(creds, session, contact);
      startsAt = session.start;
      endsAt = session.end;
      capacity = session.remainingCapacity;
      wixBookingId = booking.id;
    } else {
      const available = await fetchWixAvailability(creds, activity.wix_service_id);
      const slot = available.find((s) => s.bookable && s.localStartDate === slotKey.s && s.localEndDate === slotKey.e);
      if (!slot) {
        return NextResponse.json({ error: 'That slot is no longer available' }, { status: 409 });
      }
      const booking = await createWixBooking(creds, slot, activity.wix_resource_id!, contact);
      startsAt = slot.localStartDate;
      endsAt = slot.localEndDate;
      capacity = 1;
      wixBookingId = booking.id;
    }
  } catch (e) {
    console.error('Wix booking creation failed', e);
    return NextResponse.json({ error: 'Could not create the booking in Wix' }, { status: 502 });
  }

  // Find-or-create rather than upsert, so a second parent booking the same
  // class occurrence doesn't reset capacity back to "remaining before their
  // booking" on top of the first parent's already-counted seat.
  let sessionId: string;
  const { data: existingSession } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('activity_id', activity.id)
    .eq('wix_slot_key', key)
    .maybeSingle();
  if (existingSession) {
    sessionId = existingSession.id;
  } else {
    const { data: newSession, error: sessionError } = await admin
      .from('activity_sessions')
      .insert({
        activity_id: activity.id,
        starts_at: startsAt,
        ends_at: endsAt,
        capacity,
        wix_slot_key: key,
      })
      .select('id')
      .single();
    if (sessionError || !newSession) {
      console.error('Booked in Wix but failed to materialize the local session', wixBookingId, sessionError);
      return NextResponse.json(
        { error: 'Booked in Wix but failed to save locally — contact support' },
        { status: 500 }
      );
    }
    sessionId = newSession.id;
  }

  const { data: booking, error: bookingError } = await admin
    .from('bookings')
    .insert({
      user_id: user.id,
      child_id: body.childId ?? null,
      session_id: sessionId,
      status: 'confirmed',
      payment_status: 'none',
      policies_accepted: body.policiesAccepted ?? [],
      medical_disclosure: body.medicalDisclosure || null,
      wix_booking_id: wixBookingId,
    })
    .select('id, status')
    .single();
  if (bookingError || !booking) {
    console.error('Booked in Wix but failed to save the local booking', wixBookingId, bookingError);
    return NextResponse.json(
      { error: 'Booked in Wix but failed to save locally — contact support' },
      { status: 500 }
    );
  }

  return NextResponse.json(booking);
}
