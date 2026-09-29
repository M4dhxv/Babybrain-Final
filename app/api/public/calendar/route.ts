import { NextResponse } from 'next/server';

/**
 * Public, stateless: returns a one-event .ics for "Add to calendar".
 *
 * Why this exists: the parent app used to build the .ics in the browser (a Blob
 * URL with a `download` attribute) and click it. iOS Safari — and the in-app
 * browsers people open emails and links in — handles that unreliably: nothing
 * happens, or a blank page opens. A plain link that answers with
 * `Content-Type: text/calendar` is the path iOS supports natively: it opens the
 * "Add to Calendar" sheet directly.
 *
 * Nothing is looked up: the event is built from the query string, which carries
 * only what the parent already sees on their booking (activity title, start,
 * end, venue) — no names, no ids, no account data. Input is length-limited and
 * every text field is escaped, so it can't inject extra iCalendar lines.
 *
 * Query: ?t=<title>&s=<start ISO>&e=<end ISO, optional>&v=<venue, optional>
 *   or, for several events (bulk export, up to 60): ?d=<base64url JSON [{t,s,e?,v?}]>
 */
function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function esc(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
}

// Long lines are folded at 75 octets (RFC 5545); calendar apps are lenient but
// some are not.
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  out.push(rest);
  return out.join('\r\n');
}

type Ev = { t: string; s: Date; e: Date; v: string };

/** One event from raw fields, or null if it isn't valid. */
function parseEv(t: unknown, s: unknown, e: unknown, v: unknown): Ev | null {
  const title = String(t ?? '').trim().slice(0, 200);
  const start = new Date(String(s ?? ''));
  if (!title || Number.isNaN(start.getTime())) return null;
  let end = e ? new Date(String(e)) : new Date(NaN);
  // Same default as the in-app export: a session without an end is one hour.
  if (Number.isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + 60 * 60 * 1000);
  return { t: title, s: start, e: end, v: String(v ?? '').trim().slice(0, 300) };
}

const MAX_EVENTS = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const events: Ev[] = [];

  const d = searchParams.get('d');
  if (d) {
    // Bulk export: `d` is base64url of a JSON array of {t, s, e?, v?}.
    if (d.length > 8_000) return NextResponse.json({ error: 'd is too large' }, { status: 400 });
    try {
      const arr = JSON.parse(Buffer.from(d, 'base64url').toString('utf8'));
      if (!Array.isArray(arr)) throw new Error('not an array');
      for (const x of arr.slice(0, MAX_EVENTS)) {
        const ev = parseEv(x?.t, x?.s, x?.e, x?.v);
        if (ev) events.push(ev);
      }
    } catch {
      return NextResponse.json({ error: 'd must be base64url JSON' }, { status: 400 });
    }
  } else {
    const ev = parseEv(searchParams.get('t'), searchParams.get('s'), searchParams.get('e'), searchParams.get('v'));
    if (ev) events.push(ev);
  }
  if (events.length === 0) {
    return NextResponse.json({ error: 'Provide t and s (one event) or d (several)' }, { status: 400 });
  }

  const stamp = icsDate(new Date());
  const body = events.flatMap((ev) => [
    'BEGIN:VEVENT',
    // Stable per event, so adding the same class twice updates it rather than
    // duplicating it.
    `UID:${icsDate(ev.s)}-${Buffer.from(ev.t).toString('hex').slice(0, 24)}@babybrain.sg`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsDate(ev.s)}`,
    `DTEND:${icsDate(ev.e)}`,
    `SUMMARY:${esc(ev.t)}`,
    ev.v ? `LOCATION:${esc(ev.v)}` : '',
    'DESCRIPTION:Booked via BabyBrain',
    'END:VEVENT',
  ]);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BabyBrain//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...body,
    'END:VCALENDAR',
  ].filter(Boolean);

  const filename =
    events.length > 1
      ? 'babybrain-schedule.ics'
      : (events[0].t.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'class') + '.ics';
  return new NextResponse(lines.map(fold).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      // inline (not attachment): iOS then offers "Add to Calendar" instead of
      // saving a file into Files.
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
