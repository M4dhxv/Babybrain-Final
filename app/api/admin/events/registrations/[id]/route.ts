import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { logAdminAction } from '@/lib/admin-audit';
import { createAdminClient } from '@/lib/supabase/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Change a registration's status by hand.
 *   { status: 'confirmed' }                    promote from the waitlist / accept - only if the whole
 *                                              party fits the slot's free seats
 *   { status: 'confirmed', override: true }    confirm even past capacity (flagged on the row)
 *   { status: 'waitlisted' }                   put a party back on the waitlist (frees its seats)
 *   { status: 'cancelled' }                    cancel it (frees its seats)
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such registration.' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { status?: unknown; override?: unknown } | null;
  const status = body?.status;
  if (status !== 'confirmed' && status !== 'waitlisted' && status !== 'cancelled') {
    return NextResponse.json({ error: 'Status must be confirmed, waitlisted or cancelled.' }, { status: 400 });
  }
  const override = body?.override === true;

  const db = createAdminClient() as unknown as SupabaseClient;
  const { data, error } = await db.rpc('set_event_registration_status', {
    p_id: id,
    p_status: status,
    p_override: override,
    p_actor: auth.user.email ?? 'admin',
  });
  if (error) {
    if ((error.message ?? '').includes('not_found')) return NextResponse.json({ error: 'No such registration.' }, { status: 404 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const r = data as { ok: boolean; error?: string; seats_left?: number; party_size?: number; over_capacity?: boolean };
  if (!r.ok) {
    return NextResponse.json({
      error: `Not enough free seats: this party needs ${r.party_size}, ${r.seats_left} left in that slot. Use "Confirm anyway" to go over capacity.`,
      code: 'no_capacity',
      seatsLeft: r.seats_left ?? 0,
    }, { status: 409 });
  }

  await logAdminAction(db, { ...auth.user, role: auth.role }, {
    action: 'event_registration.status',
    entityType: 'event_registration',
    entityId: id,
    summary: `Set an event registration to ${status}${r.over_capacity ? ' (over capacity)' : ''}`,
    details: { status, override },
  });
  return NextResponse.json({ ok: true, status, overCapacity: r.over_capacity === true });
}
