import { wixLocalToUtcIso } from './client';

/**
 * Multi-day Wix events.
 *
 * Wix stores a camp that runs 9am–12pm for five days as ONE event: it starts Monday 9:00 and ends Friday
 * 12:00. There is no per-day structure on the event (no schedule items, no occurrences) — the daily
 * pattern is implicit in the start and end clock times. Copied literally that is a single 99-hour
 * "session", which is useless for choosing days. This module decodes it back into the days it really is:
 * each calendar day from the start date to the end date, between the start's time of day and the end's.
 *
 * What the vendor sells for such an event is ticket types (Single Day / 3 Day Package / 5 Day Package…)
 * and the parent says which days. {@link planDayBooking} turns "these ticket type + these days" into how
 * many Wix tickets to buy and how many places to seat, so one or several days can be booked.
 *
 * Pure, no I/O.
 */

export interface EventDay {
  /** The calendar day in the event's own time zone, YYYY-MM-DD. */
  day: string;
  startDate: string; // ISO instant
  endDate: string; // ISO instant
}

const DEFAULT_TZ = 'Asia/Singapore';
/** A guard against a malformed or open-ended event turning into hundreds of sessions. */
const MAX_DAYS = 62;

/** A clock reading in `timeZone`: `date` is YYYY-MM-DD, `time` is HH:MM:SS. */
export function localParts(iso: string, timeZone: string = DEFAULT_TZ): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * The days of a multi-day event, or null when it is not one (it starts and ends on the same day) or its
 * clock times don't describe a daily window (an overnight event, or one that ends at the time it starts):
 * those stay a single span rather than inventing days.
 */
export function splitMultiDay(event: { startDate: string; endDate: string; timeZoneId?: string | null }): EventDay[] | null {
  if (!event.startDate || !event.endDate) return null;
  const tz = event.timeZoneId || DEFAULT_TZ;
  const start = localParts(event.startDate, tz);
  const end = localParts(event.endDate, tz);
  if (start.date >= end.date) return null;
  if (!(start.time < end.time)) return null; // not a "9–12 each day" pattern

  const days: EventDay[] = [];
  for (let d = start.date; d <= end.date; d = addDays(d, 1)) {
    if (days.length >= MAX_DAYS) return null;
    days.push({
      day: d,
      startDate: wixLocalToUtcIso(`${d}T${start.time}`, tz),
      endDate: wixLocalToUtcIso(`${d}T${end.time}`, tz),
    });
  }
  return days;
}

const WORD_NUMBERS: Record<string, number> = { one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/**
 * How many days one ticket of this type covers, read from its name ("Single Day", "3 Day Package",
 * "Five-Day Pass"); null when the name doesn't say. The vendor names their tickets, so this is a
 * reading of a human label — callers treat null as "unknown", never as zero.
 */
export function ticketDaysCovered(name: string): number | null {
  const n = name.toLowerCase();
  const digits = n.match(/(\d+)\s*[- ]?\s*days?\b/);
  if (digits) return Math.max(1, Number(digits[1]));
  const word = n.match(/\b(one|single|two|three|four|five|six|seven|eight|nine|ten)\s*[- ]?\s*days?\b/);
  if (word) return WORD_NUMBERS[word[1]];
  if (/\b(day pass|per day|daily)\b/.test(n)) return 1;
  return null;
}

export type DayBookingPlan =
  | {
      ok: true;
      /** Wix tickets to reserve and charge for. */
      tickets: number;
      /** Children attending (each gets a place on every chosen day). */
      partySize: number;
      /** Days each ticket covers: 1 for a single-day ticket, the package size for a package, or the number of days chosen. */
      daysPerTicket: number;
      /** Total places to seat = partySize × days. */
      places: number;
    }
  | { ok: false; error: string };

/**
 * Turns "this ticket type, these children, these days" into tickets and places.
 *
 *  - A single-day ticket covers one day: each child on each chosen day is a ticket, so booking several
 *    days buys several of them.
 *  - An N-day package covers N days: exactly N days must be chosen, one ticket per child.
 *  - A ticket whose name doesn't say: one ticket per child covers however many days were chosen.
 */
export function planDayBooking(input: {
  ticketName: string;
  partySize: number;
  days: string[];
  eventDays: string[];
  ticketLimitPerOrder?: number | null;
}): DayBookingPlan {
  const chosen = [...new Set(input.days)].sort();
  if (!chosen.length) return { ok: false, error: 'Please choose which days you’re booking.' };
  const valid = new Set(input.eventDays);
  if (chosen.some((d) => !valid.has(d))) return { ok: false, error: 'One of those days isn’t part of this event.' };
  const party = Math.max(1, Math.trunc(input.partySize));
  const covers = ticketDaysCovered(input.ticketName);

  let tickets: number;
  let daysPerTicket: number;
  if (covers === 1) {
    tickets = party * chosen.length;
    daysPerTicket = 1;
  } else if (covers != null && covers > 1) {
    if (chosen.length !== covers) {
      return { ok: false, error: `This ticket covers ${covers} days — please choose exactly ${covers}.` };
    }
    tickets = party;
    daysPerTicket = covers;
  } else {
    tickets = party;
    daysPerTicket = chosen.length;
  }
  if (input.ticketLimitPerOrder && tickets > input.ticketLimitPerOrder) {
    return { ok: false, error: `That’s more than the organiser allows in one order (${input.ticketLimitPerOrder} tickets).` };
  }
  return { ok: true, tickets, partySize: party, daysPerTicket, places: party * chosen.length };
}

/**
 * Which (child, day) each place is. Place i is child floor(i / days) on day i % days — the same rule that
 * hands out tickets, so a single-day order's i-th ticket is the i-th place.
 */
export function placePlan(partySize: number, days: string[]): { childIndex: number; day: string }[] {
  const chosen = [...new Set(days)].sort();
  return Array.from({ length: partySize * chosen.length }, (_u, i) => ({
    childIndex: Math.floor(i / chosen.length),
    day: chosen[i % chosen.length],
  }));
}
