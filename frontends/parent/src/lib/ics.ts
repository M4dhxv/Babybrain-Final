/** Build .ics calendar files for bookings and trigger a download. No deps. */

export interface IcsEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  venue?: string;
}

function toIcsDate(iso: string): string {
  // → YYYYMMDDTHHMMSSZ (UTC)
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function esc(s: string): string {
  return s.replace(/([,;\\])/g, "\\$1").replace(/\r?\n/g, "\\n");
}

function eventLines(ev: IcsEvent): string[] {
  const start = toIcsDate(ev.startsAt);
  // Default to a 1-hour event when the session has no end time.
  const end = toIcsDate(
    ev.endsAt ?? new Date(new Date(ev.startsAt).getTime() + 60 * 60 * 1000).toISOString()
  );
  return [
    "BEGIN:VEVENT",
    `UID:${ev.id}@babybrain.sg`,
    `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${esc(ev.title)}`,
    ev.venue ? `LOCATION:${esc(ev.venue)}` : "",
    "DESCRIPTION:Booked via BabyBrain",
    "END:VEVENT",
  ].filter(Boolean);
}

function downloadIcs(events: IcsEvent[], filename: string): void {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BabyBrain//EN",
    "CALSCALE:GREGORIAN",
    ...events.flatMap(eventLines),
    "END:VCALENDAR",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Export a single booking as a one-event .ics file. */
export function downloadBookingIcs(ev: IcsEvent): void {
  downloadIcs([ev], `${ev.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "class"}.ics`);
}

/** Export several bookings as one multi-event .ics (the parent's schedule). */
export function downloadScheduleIcs(events: IcsEvent[]): void {
  if (events.length === 0) return;
  downloadIcs(events, "babybrain-schedule.ics");
}
