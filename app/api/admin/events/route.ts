import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Admin > Events: every event with its per-slot seat counts. New events are just rows in
 * `events` / `event_slots` (migration 00231), so they appear here without code changes.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const db = createAdminClient() as unknown as SupabaseClient;
  const [events, slots, regs] = await Promise.all([
    db.from('events').select('slug, title, starts_on, venue').order('starts_on', { ascending: false }),
    db.from('event_slots').select('event_slug, slot_key, label, capacity, sort').order('sort'),
    db.from('event_registrations').select('event_slug, slot_key, status, party_size'),
  ]);
  const failed = events.error ?? slots.error ?? regs.error;
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });

  type Reg = { event_slug: string; slot_key: string; status: string; party_size: number };
  const out = (events.data ?? []).map((e: { slug: string; title: string; starts_on: string | null; venue: string | null }) => {
    const mine = (regs.data ?? []).filter((r: Reg) => r.event_slug === e.slug);
    return {
      ...e,
      registrations: mine.filter((r: Reg) => r.status !== 'cancelled').length,
      confirmedSeats: mine.filter((r: Reg) => r.status === 'confirmed').reduce((n: number, r: Reg) => n + r.party_size, 0),
      waitlisted: mine.filter((r: Reg) => r.status === 'waitlisted').length,
      capacity: (slots.data ?? []).filter((s: { event_slug: string }) => s.event_slug === e.slug)
        .reduce((n: number, s: { capacity: number }) => n + s.capacity, 0),
    };
  });
  return NextResponse.json({ events: out });
}
