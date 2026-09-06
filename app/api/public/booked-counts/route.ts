import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Public, read-only: how many bookings count against each session's
 * capacity — mirrors what handle_booking_insert() counts when it decides a
 * session is full ('pending' and 'confirmed', plus 'completed' for a past
 * session; 'waitlisted' and 'cancelled' hold no seat). Used to turn a
 * session's raw `capacity` into
 * remaining spots on the activity detail and booking pages — the count was
 * previously shown as-is with no allowance for who's already booked ("10
 * spots" stayed 10 even with 3 confirmed bookings against it).
 *
 * "select own bookings" RLS (bookings.user_id = auth.uid()) means a parent
 * can't count bookings belonging to other families directly, so this goes
 * through the service role and returns only aggregate counts — no booker
 * identities — which is the same information already implied by a listing's
 * publicly-shown capacity.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Keep only well-formed UUIDs. This is a public endpoint, so a malformed id
  // must not reach Postgres and come back as a raw "invalid input syntax for
  // type uuid" 500 that leaks the column type — a non-UUID is simply ignored.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = (searchParams.get('sessionIds') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID.test(s))
    .slice(0, 50);
  if (ids.length === 0) return NextResponse.json({ counts: {} });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('bookings')
    .select('session_id')
    .in('session_id', ids)
    // Must match what handle_booking_insert() counts when it decides whether a
    // session is full ('pending','confirmed'), or the two disagree: a class
    // held entirely by paid bookings mid-checkout showed parents its full
    // capacity as "spots left", then waitlisted them the moment they booked.
    // 'completed' is a past session's confirmed booking, so it counts too.
    .in('status', ['pending', 'confirmed', 'completed']);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const counts: Record<string, number> = {};
  for (const row of data ?? []) counts[row.session_id] = (counts[row.session_id] ?? 0) + 1;
  return NextResponse.json({ counts });
}
