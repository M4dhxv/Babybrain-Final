/**
 * Where tapping a notification's push should open.
 *
 * The push used to open the notification's raw `data.url`, while its email
 * (lib/emails/render.ts) and the parent app's Notifications tab
 * (notificationTarget in frontends/parent/src/pages/ProfilePage.tsx) already
 * worked out a better page from the same data: a cancelled booking under Past
 * activities rather than Bookings, where it is not listed; the booking itself
 * flashed with ?highlight=; a vendor's new booking on that session's roster.
 * This is the push side of the same rules.
 */

type Data = Record<string, unknown>;

/** A path on this site ("/profile?tab=bookings"), never another host: no
 *  "//host", no backslash (browsers read "/\host" as "//host"), no control
 *  characters (a tab or newline is dropped from a URL, so "/\t/host" is also
 *  "//host"). */
export function isSitePath(v: unknown): v is string {
  return typeof v === 'string' && /^\/(?![/\\])/.test(v) && !/[\\\u0000-\u001f\u007f]/.test(v);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function pushLink(type: string, data: Data, opts: { sessionId?: string | null } = {}): string | undefined {
  const url = isSitePath(data.url) ? data.url : undefined;
  const bookingId = str(data.booking_id);
  const enc = encodeURIComponent;

  // A cancelled booking is listed under Past activities (with how it was made
  // good), not under Bookings, which is where its data.url points.
  if (type === 'booking_cancelled' || type === 'class_cancelled') {
    return bookingId ? `/profile?tab=past&highlight=${enc(bookingId)}` : '/profile?tab=past';
  }

  // The bookings list flashes the booking the notification is about.
  if (bookingId && url?.startsWith('/profile?tab=bookings') && !url.includes('highlight=')) {
    return `${url}&highlight=${enc(bookingId)}`;
  }

  // A vendor's new booking: that session's roster with the family highlighted
  // (BookingsPage reads ?session= and ?booking=), not the portal's front page.
  if (type === 'provider_booking_received' && bookingId && opts.sessionId) {
    return `/vendor/#/bookings?session=${enc(opts.sessionId)}&booking=${enc(bookingId)}`;
  }

  // Support replies were stored with /support, a page the app never had; the
  // conversation is on the Messages tab.
  if (type === 'support_message' && (!url || url === '/support')) return '/profile?tab=messages';

  return url;
}
