import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { logAdminAction } from '@/lib/admin-audit';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseRegistration, type RegisterResult } from '@/lib/launch-event';

const SLUG = /^[a-z0-9-]{1,60}$/;

/** One event: its slots with seat counts, and every registration (newest first). */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { slug } = await params;
  if (!SLUG.test(slug)) return NextResponse.json({ error: 'No such event.' }, { status: 404 });

  const db = createAdminClient() as unknown as SupabaseClient;
  const [event, slots, regs] = await Promise.all([
    db.from('events').select('slug, title, starts_on, venue').eq('slug', slug).maybeSingle(),
    db.from('event_slots').select('slot_key, label, capacity, sort').eq('event_slug', slug).order('sort'),
    db.from('event_registrations')
      .select('id, slot_key, name, email, phone, adults, children, party_size, status, source, over_capacity, adult_names, child_details, notes, created_at, status_changed_at, changed_by')
      .eq('event_slug', slug)
      .order('created_at', { ascending: false }),
  ]);
  const failed = event.error ?? slots.error ?? regs.error;
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
  if (!event.data) return NextResponse.json({ error: 'No such event.' }, { status: 404 });

  type Reg = { slot_key: string; status: string; party_size: number };
  const rows = (regs.data ?? []) as Reg[];
  const slotSummary = (slots.data ?? []).map((s: { slot_key: string; label: string; capacity: number }) => {
    const mine = rows.filter((r) => r.slot_key === s.slot_key);
    const taken = mine.filter((r) => r.status === 'confirmed').reduce((n, r) => n + r.party_size, 0);
    return {
      ...s,
      confirmedSeats: taken,
      seatsLeft: Math.max(s.capacity - taken, 0),
      waitlisted: mine.filter((r) => r.status === 'waitlisted').length,
    };
  });
  return NextResponse.json({ event: event.data, slots: slotSummary, registrations: regs.data ?? [] });
}

/**
 * Add a registration by hand (a phone call, a walk-in, a friend of the team).
 *   body: the same fields as the public form (name, email?, phone, slot, secondAdult?, children[])
 *         plus  status?: 'confirmed' | 'waitlisted'  (omit it to let capacity decide)  and  notes?.
 * Forcing 'confirmed' past the slot's capacity is allowed here on purpose - it is flagged on the row.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { slug } = await params;
  if (!SLUG.test(slug)) return NextResponse.json({ error: 'No such event.' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = parseRegistration(body, 'admin');
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const force = body?.status;
  if (force != null && force !== 'confirmed' && force !== 'waitlisted') {
    return NextResponse.json({ error: 'Status must be confirmed or waitlisted.' }, { status: 400 });
  }
  const v = parsed.value;

  const db = createAdminClient() as unknown as SupabaseClient;
  const { data, error } = await db.rpc('register_for_event', {
    p_event: slug,
    p_slot: v.slot,
    p_name: v.name,
    p_email: v.email,
    p_phone: v.phone,
    p_adult_names: v.adultNames,
    p_children: v.children,
    p_source: 'admin',
    p_force_status: force ?? null,
    p_actor: auth.user.email ?? 'admin',
    p_notes: v.notes,
  });
  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('unknown_slot')) return NextResponse.json({ error: 'That time slot does not exist for this event.' }, { status: 400 });
    if (msg.includes('invalid_party')) return NextResponse.json({ error: 'A registration needs 1-2 adults and 1-3 children.' }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const r = data as RegisterResult;
  if (r.duplicate) {
    return NextResponse.json({ error: `That email is already registered (${r.status}).` }, { status: 409 });
  }

  await logAdminAction(db, { ...auth.user, role: auth.role }, {
    action: 'event_registration.add',
    entityType: 'event_registration',
    entityId: r.id,
    summary: `Added ${v.name} to ${slug} by hand — ${r.status}${r.over_capacity ? ' (over capacity)' : ''}`,
    details: { slot: v.slot, party_size: r.party_size, forced: force ?? null },
  });
  return NextResponse.json({ ok: true, status: r.status, id: r.id, overCapacity: r.over_capacity === true });
}
