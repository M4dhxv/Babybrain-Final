import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchWixOnlineLogin, fetchWixOrders, getProviderWixCredentials } from '@/lib/wix/client';

/**
 * A parent's Wix Events ticket, with download links that work *now*.
 *
 * Wix signs the PDF and Apple-Wallet links it returns and they expire within
 * about a day, so BabyBrain stores only the ticket number and the permanent QR
 * target (the check-in URL) and fetches the links fresh from the vendor's Wix
 * each time a parent asks. Only the order's own parent can ask.
 *
 * GET ?orderId=<event_ticket_orders.id>
 * -> { ticketsPdf, online, tickets: [{ ticketNumber, checkInUrl, pdfUrl, walletPassUrl }] }
 * GET ?rsvpId=<event_rsvps.id>
 * -> { online }   (the link to join an online RSVP event)
 */
export const maxDuration = 30;

export async function GET(request: Request) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const orderId = params.get('orderId');
  const rsvpId = params.get('rsvpId');
  if (!orderId && !rsvpId) return NextResponse.json({ error: 'orderId or rsvpId required' }, { status: 400 });

  const admin = createAdminClient();

  // An RSVP-type event has no ticket — only (for an online event) a link to join.
  if (rsvpId) {
    const { data: rsvp } = await admin
      .from('event_rsvps')
      .select('id, event_id, wix_rsvp_id')
      .eq('id', rsvpId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!rsvp?.wix_rsvp_id) return NextResponse.json({ error: 'No RSVP found' }, { status: 404 });
    const { data: ev } = await admin.from('wix_events').select('provider_id').eq('id', rsvp.event_id).maybeSingle();
    const rsvpCreds = ev ? await getProviderWixCredentials(admin, ev.provider_id) : null;
    if (!rsvpCreds) return NextResponse.json({ error: 'The organiser’s Wix account isn’t reachable' }, { status: 409 });
    try {
      return NextResponse.json({ tickets: [], ticketsPdf: null, online: await fetchWixOnlineLogin(rsvpCreds, { rsvpId: rsvp.wix_rsvp_id }) });
    } catch (e) {
      console.error('[wix events ticket] could not read the online link', rsvp.wix_rsvp_id, e);
      return NextResponse.json({ error: 'Could not reach the organiser’s Wix — try again in a moment' }, { status: 502 });
    }
  }

  const { data: order } = await admin
    .from('event_ticket_orders')
    .select('id, event_id, wix_order_number')
    .eq('id', orderId as string)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!order?.wix_order_number) return NextResponse.json({ error: 'No ticket for this order yet' }, { status: 404 });

  const { data: event } = await admin
    .from('wix_events')
    .select('provider_id, wix_event_id, location_type')
    .eq('id', order.event_id)
    .maybeSingle();
  const creds = event ? await getProviderWixCredentials(admin, event.provider_id) : null;
  if (!event || !creds) return NextResponse.json({ error: 'The organiser’s Wix account isn’t reachable' }, { status: 409 });

  try {
    const orders = await fetchWixOrders(creds, { eventIds: [event.wix_event_id], searchPhrase: order.wix_order_number, maxOrders: 50 });
    const wixOrder = orders.find((o) => o.orderNumber === order.wix_order_number);
    if (!wixOrder) return NextResponse.json({ error: 'The organiser’s Wix doesn’t list this ticket any more' }, { status: 404 });
    // An online event's join link is per guest on Wix; read it fresh, and never let a failure here hide the ticket.
    const online =
      event.location_type === 'ONLINE'
        ? await fetchWixOnlineLogin(creds, { orderNumber: order.wix_order_number }).catch(() => null)
        : null;
    return NextResponse.json({
      ticketsPdf: wixOrder.ticketsPdf,
      online,
      tickets: wixOrder.tickets.map((t) => ({
        ticketNumber: t.ticketNumber,
        checkInUrl: t.checkInUrl,
        pdfUrl: t.pdfUrl,
        walletPassUrl: t.walletPassUrl,
      })),
    });
  } catch (e) {
    console.error('[wix events ticket] could not read the order from Wix', order.wix_order_number, e);
    return NextResponse.json({ error: 'Could not reach the organiser’s Wix — try again in a moment' }, { status: 502 });
  }
}
