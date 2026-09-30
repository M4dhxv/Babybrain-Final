import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { rateLimited } from '@/lib/rate-limit';

/**
 * A parent's private, subscribable calendar feed: /api/public/calendar-feed/<token>.ics
 *
 * Google / Apple / Outlook Calendar "subscribe to a URL" re-read this on their
 * own schedule, so a rescheduled booking moves and a cancelled one disappears
 * without the parent exporting anything again. (How often the calendar app
 * re-reads is its choice, not ours: Google roughly every 12-24 hours, Outlook a
 * few hours, Apple as often as the user sets. The feed asks for hourly.)
 *
 * The token in the URL is the only credential (calendar apps cannot log in), so:
 *   - an unknown token answers 404 exactly like a malformed one;
 *   - it is rate limited per token;
 *   - the response is `private` + `noindex` so nothing caches or indexes it;
 *   - a parent can rotate the token (POST /api/customer/calendar-link), which
 *     kills the old link.
 *
 * Confirmed bookings only, from 30 days back onwards. Cancelled, waitlisted and
 * unpaid-pending bookings are left out, so a cancellation makes the event
 * vanish on the next refresh. Every event has a stable UID from the booking id
 * and a SEQUENCE that rises whenever the booking row changes, which is what
 * makes calendar apps update the existing event instead of adding a copy.
 */
const PAST_DAYS = 30;
const MAX_EVENTS = 500;

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function esc(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
}

// Fold at 75 octets (RFC 5545), counting bytes so non-ASCII titles stay valid.
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 74) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

type Row = {
  id: string;
  updated_at: string;
  children: { name: string } | null;
  activity_sessions: {
    starts_at: string;
    ends_at: string | null;
    status: string;
    provider_locations: { name: string | null; address: string | null } | null;
    activities: { title: string; address: string | null } | null;
  } | null;
};

const notFound = () => new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const raw = (await params).token ?? '';
  const token = raw.replace(/\.ics$/i, '');
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return notFound();

  const admin = createAdminClient();

  // Calendar apps poll a few times a day; this is only a brake on abuse.
  if (await rateLimited(admin, `calfeed:${token.slice(0, 16)}`, 60, 3600)) {
    return new NextResponse('Too many requests', { status: 429, headers: { 'Retry-After': '3600' } });
  }

  // calendar_feed_tokens is not in the generated types (service-role-only table).
  const { data: owner } = await (admin as unknown as {
    from: (t: string) => {
      select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { user_id: string } | null }> } };
    };
  })
    .from('calendar_feed_tokens')
    .select('user_id')
    .eq('token', token)
    .maybeSingle();
  if (!owner) return notFound();

  const since = new Date(Date.now() - PAST_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('bookings')
    .select(
      'id, updated_at, children(name), activity_sessions!inner(starts_at, ends_at, status, provider_locations(name, address), activities(title, address))'
    )
    .eq('user_id', owner.user_id)
    .eq('status', 'confirmed')
    .neq('activity_sessions.status', 'cancelled')
    .gte('activity_sessions.starts_at', since)
    .limit(MAX_EVENTS);
  if (error) {
    console.error('Calendar feed query failed', error);
    return new NextResponse('Calendar unavailable', { status: 503, headers: { 'Retry-After': '300' } });
  }

  const stamp = icsDate(new Date());
  const events = ((data ?? []) as unknown as Row[])
    .filter((r) => r.activity_sessions)
    .sort((a, b) => a.activity_sessions!.starts_at.localeCompare(b.activity_sessions!.starts_at))
    .flatMap((r) => {
      const s = r.activity_sessions!;
      const start = new Date(s.starts_at);
      let end = s.ends_at ? new Date(s.ends_at) : new Date(NaN);
      if (Number.isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + 60 * 60 * 1000);
      const title = s.activities?.title ?? 'BabyBrain class';
      const child = r.children?.name?.trim();
      const venue = [s.provider_locations?.name, s.provider_locations?.address ?? s.activities?.address]
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .join(', ');
      const modified = new Date(r.updated_at);
      return [
        'BEGIN:VEVENT',
        `UID:booking-${r.id}@babybrain.sg`,
        `DTSTAMP:${stamp}`,
        `LAST-MODIFIED:${icsDate(modified)}`,
        // Rises every time the booking row changes (a move, a location fix...).
        `SEQUENCE:${Math.floor(modified.getTime() / 1000)}`,
        `DTSTART:${icsDate(start)}`,
        `DTEND:${icsDate(end)}`,
        `SUMMARY:${esc(child ? `${title} (${child})` : title)}`,
        venue ? `LOCATION:${esc(venue)}` : '',
        'DESCRIPTION:Booked via BabyBrain',
        'END:VEVENT',
      ];
    });

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BabyBrain//Schedule feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:BabyBrain schedule',
    // Hints: how often the calendar app should re-read. Apps may ignore them.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...events,
    'END:VCALENDAR',
  ].filter(Boolean);

  return new NextResponse(lines.map(fold).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="babybrain-schedule.ics"',
      // The URL is a secret: never let a shared cache keep or serve it.
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
