import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { logAdminAction } from '@/lib/admin-audit';
import { createAdminClient } from '@/lib/supabase/admin';
import { notifyPromoted } from '@/lib/launch-event-notify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Change a registration's status by hand.
 *   { status: 'confirmed' }                    promote from the waitlist / accept - only if the whole
 *                                              party fits the slot's free seats
 *   { status: 'confirmed', override: true }    confirm even past capacity (flagged on the row)
 *   { status: 'waitlisted' }                   put a party back on the waitlist (frees its seats)
 *   { status: 'cancelled' }                    cancel it (frees its seats)
 *
 * Freeing seats (waitlist / cancel of a confirmed party) automatically promotes the oldest waiting
 * parties that fit (migration 00232). Everyone promoted - automatically or by this call - is then
 * emailed "a spot opened up"; the response says who was promoted and how the emails went.
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

  const r = data as { ok: boolean; error?: string; seats_left?: number; party_size?: number; over_capacity?: boolean; promoted?: { id: string; name: string; party_size: number }[] };
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
    details: { status, override, promoted: (r.promoted ?? []).map((x) => x.id) },
  });
  for (const x of r.promoted ?? []) {
    await logAdminAction(db, { email: 'auto', role: 'system' }, {
      action: 'event_registration.auto_promote',
      entityType: 'event_registration',
      entityId: x.id,
      summary: `Automatically promoted ${x.name} (${x.party_size} seats) from the waitlist after seats were freed`,
      details: { triggeredBy: auth.user.email ?? 'admin' },
    });
  }
  // Email everyone who is now confirmed from the waitlist and hasn't been told yet.
  const notify = await notifyPromoted(db).catch((e) => ({ sent: 0, failed: 0, noEmail: 0, error: e instanceof Error ? e.message : String(e) }));
  return NextResponse.json({
    ok: true, status, overCapacity: r.over_capacity === true,
    promoted: (r.promoted ?? []).map((x) => x.name),
    notify,
  });
}
