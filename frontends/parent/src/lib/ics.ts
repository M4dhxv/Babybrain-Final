/** Build an .ics calendar file for a booking and trigger a download. No deps. */

function toIcsDate(iso: string): string {
  // → YYYYMMDDTHHMMSSZ (UTC)
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function esc(s: string): string {
  return s.replace(/([,;\\])/g, "\\$1").replace(/\r?\n/g, "\\n");
}

export function downloadBookingIcs(opts: {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  venue?: string;
}): void {
  const start = toIcsDate(opts.startsAt);
  // Default to a 1-hour event when the session has no end time.
  const end = toIcsDate(
    opts.endsAt ?? new Date(new Date(opts.startsAt).getTime() + 60 * 60 * 1000).toISOString()
  );
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BabyBrain//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${opts.id}@babybrain.sg`,
    `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${esc(opts.title)}`,
    opts.venue ? `LOCATION:${esc(opts.venue)}` : "",
    "DESCRIPTION:Booked via BabyBrain",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${opts.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "class"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
