import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { planDayBooking, type DayBookingPlan } from './event-days';

/**
 * Booking days of a multi-day Wix event (see event-days.ts). The reconcile job turns the event into one
 * session per day; this reads which days can still be booked and turns a parent's choice into tickets.
 */
type Admin = SupabaseClient<Database>;

/** The days of this event a parent can still book: its day sessions that haven't started or been cancelled. */
export async function loadBookableDays(admin: Admin, localEventId: string): Promise<string[]> {
  const { data } = await admin
    .from('activity_sessions')
    .select('wix_day, starts_at')
    .eq('wix_event_id', localEventId)
    .not('wix_day', 'is', null)
    .neq('status', 'cancelled')
    .gt('starts_at', new Date().toISOString());
  return [...new Set((data ?? []).map((r) => r.wix_day as string))].sort();
}

export type DaySelection =
  /** Not a day-by-day event: book a plain quantity of tickets. */
  | { multiDay: false }
  | { multiDay: true; plan: Extract<DayBookingPlan, { ok: true }>; days: string[] }
  | { multiDay: true; error: string };

/**
 * Decides tickets and places for a booking. For an ordinary event this just says "not multi-day"; for a
 * day-by-day one it validates the chosen days against the days still on offer and the ticket type.
 */
export async function resolveDaySelection(
  admin: Admin,
  params: {
    localEventId: string;
    ticketName: string;
    /** Children attending. */
    partySize: number;
    /** What the parent chose (YYYY-MM-DD). */
    days: unknown;
    ticketLimitPerOrder: number;
  }
): Promise<DaySelection> {
  const eventDays = await loadBookableDays(admin, params.localEventId);
  if (!eventDays.length) return { multiDay: false };
  const days = Array.isArray(params.days) ? params.days.filter((d): d is string => typeof d === 'string') : [];
  const plan = planDayBooking({
    ticketName: params.ticketName,
    partySize: params.partySize,
    days,
    eventDays,
    ticketLimitPerOrder: params.ticketLimitPerOrder,
  });
  if (!plan.ok) return { multiDay: true, error: plan.error };
  return { multiDay: true, plan, days: [...new Set(days)].sort() };
}

/** "Mon 12 Oct, Wed 14 Oct" for a list of YYYY-MM-DD days. */
export function describeDays(days: string[]): string {
  return days
    .map((d) =>
      new Intl.DateTimeFormat('en-SG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))
    )
    .join(', ');
}
