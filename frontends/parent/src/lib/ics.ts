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
  // Revoking straight away cancels the download on iOS Safari and some Android
  // browsers before it has started; give it time.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** iPhone / iPad (incl. iPadOS, which reports itself as a Mac) / Mac. */
export function isAppleDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Macintosh/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function endOf(ev: IcsEvent): string {
  return ev.endsAt ?? new Date(new Date(ev.startsAt).getTime() + 60 * 60 * 1000).toISOString();
}

/** A real link that answers with a calendar file — the route iOS supports
 *  natively (it opens "Add to Calendar"), unlike a Blob download. Served by
 *  the Next.js API next to this app. */
export function calendarFileUrl(ev: IcsEvent): string {
  const base = (import.meta.env.VITE_API_BASE as string) || "";
  const q = new URLSearchParams({ t: ev.title, s: ev.startsAt, e: endOf(ev) });
  if (ev.venue) q.set("v", ev.venue);
  return `${base}/api/public/calendar?${q.toString()}`;
}

/** Phones and Macs, where a link that answers with a calendar file opens the
 *  calendar app directly ("Add all"). Elsewhere a plain download is the
 *  dependable route. */
export function opensCalendarFromLink(): boolean {
  return isAppleDevice() || (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent));
}

/** Link for a whole schedule (many events in one file), or null when it is too
 *  big to carry in a URL — the caller then falls back to the file download. */
export function scheduleFileUrl(events: IcsEvent[]): string | null {
  if (events.length === 0 || events.length > 60) return null;
  const json = JSON.stringify(
    events.map((e) => ({ t: e.title, s: e.startsAt, e: endOf(e), v: e.venue || undefined }))
  );
  // base64url of UTF-8 (titles can contain non-ASCII).
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const d = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // Kept well under Node's ~16KB request-header limit: the browser adds its
  // cookies and other headers on top of this URL, and past the limit the server
  // answers 431 with no calendar. Roughly 40 events; more falls back to the
  // file download.
  if (d.length > 6_000) return null;
  const base = (import.meta.env.VITE_API_BASE as string) || "";
  return `${base}/api/public/calendar?d=${d}`;
}

/** An iPhone / iPad browser other than Safari (Chrome, Firefox, Edge, or an in-app browser such as Instagram or
 *  WhatsApp). They cannot pass a webcal:// link on to the Calendar app. */
export function isNonSafariIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) && /CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|MicroMessenger|GSA\//.test(ua);
}

/** Android (phones and tablets). There is no native "subscribe to this link" on
 *  Android and browsers cannot write to the device calendar, so Android users
 *  subscribe through their Google account instead (see googleSubscribeUrl). */
export function isAndroidDevice(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/** Google's "add calendar from URL" link: opens Google Calendar with the feed
 *  ready to subscribe to. The subscription lives on the parent's Google
 *  account, so it also appears in the Calendar app on their Android phone and
 *  updates itself (Google re-reads the feed every 12-24 hours). */
export function googleSubscribeUrl(feedUrl: string): string {
  return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(feedUrl)}`;
}

export function googleCalendarUrl(ev: IcsEvent): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${toIcsDate(ev.startsAt)}/${toIcsDate(endOf(ev))}`,
    details: "Booked via BabyBrain",
  });
  if (ev.venue) q.set("location", ev.venue);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function outlookCalendarUrl(ev: IcsEvent): string {
  const q = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: ev.title,
    startdt: new Date(ev.startsAt).toISOString(),
    enddt: new Date(endOf(ev)).toISOString(),
    body: "Booked via BabyBrain",
  });
  if (ev.venue) q.set("location", ev.venue);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${q.toString()}`;
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
