import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Public, read-only: how many bookings count against each session's
 * capacity — mirrors the vendor Bookings page's own `booked` filter
 * (status 'confirmed' or 'completed'; 'pending'/'waitlisted'/'cancelled'
 * don't hold a seat). Used to turn a session's raw `capacity` into
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
  const ids = (searchParams.get('sessionIds') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (ids.length === 0) return NextResponse.json({ counts: {} });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('bookings')
    .select('session_id')
    .in('session_id', ids)
    .in('status', ['confirmed', 'completed']);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const counts: Record<string, number> = {};
  for (const row of data ?? []) counts[row.session_id] = (counts[row.session_id] ?? 0) + 1;
  return NextResponse.json({ counts });
}
