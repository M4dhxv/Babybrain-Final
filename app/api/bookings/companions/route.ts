import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { companionSettingsFor, saveCompanions, validateCompanions } from '@/lib/companions';

/**
 * Save the free companions a parent entered for a booking they hold (migration 00273, companion mode).
 *
 * Called by the booking page right after the booking exists, whichever way it was paid (card, free,
 * pack credit, make-up token). Body: { companions: [{ seat, name, age }], session_id? | group_id? | booking_id? }
 * `seat` is the 0-based ticket number within the booking. The activity decides how many companions a
 * ticket includes and whether they are an adult or a child; the age is checked against that here, so
 * the rule can't be skipped by editing the page. Companions use no class place and cost nothing.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    booking_id?: string;
    group_id?: string;
    session_id?: string;
    seat_order?: unknown;
    companions?: unknown;
  };

  const { supabase, user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // The caller's own bookings only (RLS), in ticket order.
  let seatQuery = supabase
    .from('bookings')
    .select('id, session_id, created_at, booking_group_id')
    .eq('user_id', user.id)
    .in('status', ['pending', 'confirmed', 'waitlisted'])
    .order('created_at', { ascending: true });
  if (body.booking_id) seatQuery = seatQuery.eq('id', body.booking_id);
  else if (body.group_id) seatQuery = seatQuery.eq('booking_group_id', body.group_id);
  else if (body.session_id) seatQuery = seatQuery.eq('session_id', body.session_id);
  else return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  const { data: found } = await seatQuery;
  // A session_id lookup means "my latest booking on that session".
  const lead = body.session_id && !body.booking_id && !body.group_id ? found?.[found.length - 1] : found?.[0];
  if (!lead || !lead.session_id) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });

  const admin = createAdminClient();
  let seats = [lead];
  if (lead.booking_group_id) {
    const { data: party } = await admin
      .from('bookings')
      .select('id, session_id, created_at, booking_group_id')
      .eq('booking_group_id', lead.booking_group_id)
      .eq('user_id', user.id)
      .in('status', ['pending', 'confirmed', 'waitlisted'])
      .order('created_at', { ascending: true });
    if (party?.length) seats = party;
  }

  const { data: sess } = await admin
    .from('activity_sessions')
    .select('starts_at, activities(id, provider_id)')
    .eq('id', lead.session_id)
    .maybeSingle();
  const activity = (sess?.activities ?? null) as unknown as { id: string; provider_id: string | null } | null;
  if (!sess || !activity?.provider_id) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
  if (new Date(sess.starts_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'This session has already started.' }, { status: 409 });
  }

  // The "My bookings" editor lists seats in its own order, so it can name them: `seat_order` is the
  // booking ids in the order `seat` counts them. It must be exactly this party's live seats.
  if (Array.isArray(body.seat_order)) {
    const wanted = body.seat_order.filter((x): x is string => typeof x === 'string');
    const byId = new Map(seats.map((s) => [s.id, s]));
    if (wanted.length !== seats.length || new Set(wanted).size !== wanted.length || wanted.some((id) => !byId.has(id))) {
      return NextResponse.json({ error: 'Those tickets do not match this booking.' }, { status: 400 });
    }
    seats = wanted.map((id) => byId.get(id)!);
  }

  const settings = await companionSettingsFor(admin, activity.id);
  if (!settings) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });

  const checked = validateCompanions(settings, seats.length, body.companions);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const saved = await saveCompanions(admin, {
    userId: user.id,
    providerId: activity.provider_id,
    seatIds: seats.map((s) => s.id),
    type: settings.companion_type,
    list: checked.list,
  });
  if (!saved.ok) return NextResponse.json({ error: 'Could not save the companions — please try again.' }, { status: 500 });
  return NextResponse.json({ saved: checked.list.length });
}
