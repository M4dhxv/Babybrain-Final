import type { WixEvent, WixTicketDefinition } from './client';

/**
 * Can a parent actually book this Wix event through BabyBrain right now?
 *
 * Wix does not make this easy to find out the cheap way. Creating a ticket
 * reservation only fails for a missing event or ticket type — it happily
 * reserves tickets for an event whose registration is closed, paused or
 * members-only, and the refusal only comes at checkout, which for a paid
 * ticket is after the parent's card has been charged. So everything that
 * would make Wix refuse the order is checked here, before any money moves,
 * from the event's own registration block.
 *
 * Pure on purpose: the same rules run live in the checkout/RSVP routes (fresh
 * event from Wix), in the background snapshot written onto each activity
 * (so the parent page can say "registration closed" instead of letting them
 * try), and in the vendor portal (so the vendor sees *why* an event can't take
 * bookings and what to change in Wix).
 */

export type WixBlockerCode =
  | 'event_canceled'
  | 'event_over'
  | 'event_draft'
  | 'registration_external'
  | 'registration_none'
  | 'registration_closed'
  | 'registration_full'
  | 'registration_paused'
  | 'members_only'
  | 'tax_not_supported'
  | 'ticket_hidden'
  | 'sale_not_open'
  | 'sale_ended'
  | 'donation_ticket'
  | 'seating_not_supported';

export interface WixEventBlocker {
  code: WixBlockerCode;
  /** For the vendor: what is wrong and where to change it in Wix. */
  vendorMessage: string;
  /** For the parent, shown where they would have booked. */
  parentMessage: string;
}

const blocker = (code: WixBlockerCode, vendorMessage: string, parentMessage: string): WixEventBlocker => ({
  code,
  vendorMessage,
  parentMessage,
});

function isRegistrationOpen(reg: NonNullable<WixEvent['registration']>): boolean {
  if (reg.type === 'RSVP') return reg.status === 'OPEN_RSVP';
  return reg.status === 'OPEN_TICKETS';
}

/** Everything about the event itself that stops a ticket being bought (or an RSVP made). */
export function evaluateWixEvent(event: Pick<WixEvent, 'status' | 'registration'>): WixEventBlocker[] {
  const out: WixEventBlocker[] = [];

  if (event.status === 'CANCELED') {
    out.push(blocker('event_canceled', 'This event is cancelled in Wix.', 'This event has been cancelled.'));
  } else if (event.status === 'ENDED') {
    out.push(blocker('event_over', 'This event has already ended in Wix.', 'This event has already taken place.'));
  } else if (event.status === 'DRAFT') {
    out.push(blocker('event_draft', 'This event is still a draft in Wix — publish it there first.', 'This event isn’t open for booking yet.'));
  }

  const reg = event.registration;
  if (!reg) return out;

  // RSVP events (free, no tickets) and EXTERNAL ones (registration happens on the
  // organiser's own site) have their own flows. Only an event with no registration at
  // all — or an external one with nowhere to send the parent — can't be booked.
  if (reg.type === 'NONE') {
    out.push(
      blocker(
        'registration_none',
        'This event has no registration in Wix — it is information only.',
        'This event doesn’t take bookings — it is for information only.'
      )
    );
    return out;
  }
  if (reg.type === 'EXTERNAL') {
    if (!reg.externalUrl) {
      out.push(
        blocker(
          'registration_external',
          'Registration for this event is set to another website in Wix, but no web address is set.',
          'Registration for this event happens on the organiser’s own website.'
        )
      );
    }
    return out; // booked on the organiser's site: nothing else of ours applies
  }
  if (reg.type && reg.type !== 'TICKETING' && reg.type !== 'RSVP') {
    out.push(blocker('registration_closed', `Wix registration type “${reg.type}” isn’t supported.`, 'This event can’t be booked online.'));
    return out;
  }
  const isRsvp = reg.type === 'RSVP';

  if (reg.paused || reg.disabled) {
    out.push(
      blocker(
        'registration_paused',
        'Registration is paused in Wix — resume it there for parents to book.',
        'Booking for this event is paused right now.'
      )
    );
  } else if (reg.type === 'RSVP' && reg.status === 'OPEN_RSVP_WAITLIST_ONLY') {
    // Wix events have no BabyBrain waitlist (00107): a full RSVP event is simply full.
    out.push(blocker('registration_full', 'The RSVP list is full in Wix (only its waitlist is open).', 'This event is full.'));
  } else if (reg.status && !isRegistrationOpen(reg)) {
    const closed = reg.status.startsWith('CLOSED');
    out.push(
      blocker(
        'registration_closed',
        closed
          ? 'Registration is closed in Wix — re-open it there for parents to book.'
          : `Registration isn’t open in Wix (status ${reg.status}).`,
        closed ? 'Booking for this event is closed.' : 'Booking for this event isn’t open yet.'
      )
    );
  }

  if (reg.allowedGuestTypes === 'MEMBER') {
    out.push(
      blocker(
        'members_only',
        'This event is for site members only in Wix. BabyBrain parents aren’t Wix site members, so it can’t be booked here — allow “visitors” in Wix.',
        'This event is for the organiser’s members only.'
      )
    );
  }

  // Tax that Wix adds on top at checkout makes the order dearer than the
  // ticket price + service fee we charge the parent for. Tax already included
  // in the price changes nothing.
  const taxRate = Number(reg.taxRate ?? 0);
  if ((reg.taxType === 'ADDED' || reg.taxType === 'ADDED_AT_CHECKOUT') && taxRate > 0) {
    out.push(
      blocker(
        'tax_not_supported',
        `Wix adds ${reg.taxRate}% tax on top of the ticket price at checkout, which BabyBrain can’t charge yet. Set tax to “included in the price” in Wix.`,
        'This event can’t be booked online yet.'
      )
    );
  }

  return out;
}

/** What stops *this ticket type* being bought, independent of the event. */
export function evaluateWixTicket(
  ticket: Pick<WixTicketDefinition, 'hidden' | 'saleStatus' | 'pricingType' | 'free'> & { hasSeating?: boolean }
): WixEventBlocker[] {
  const out: WixEventBlocker[] = [];
  if (ticket.hidden) {
    out.push(blocker('ticket_hidden', 'This ticket type is hidden in Wix.', 'This ticket isn’t available.'));
  }
  if (ticket.saleStatus === 'SALE_SCHEDULED') {
    out.push(blocker('sale_not_open', 'Ticket sales haven’t started yet in Wix.', 'Tickets aren’t on sale yet.'));
  } else if (ticket.saleStatus === 'SALE_ENDED') {
    out.push(blocker('sale_ended', 'Ticket sales have ended in Wix.', 'Ticket sales for this event have ended.'));
  }
  if (ticket.hasSeating) {
    out.push(
      blocker(
        'seating_not_supported',
        'This event has a seating plan in Wix (guests pick a seat). BabyBrain can’t offer seat selection yet, so it can’t be booked here — use general admission tickets for BabyBrain parents.',
        'This event can’t be booked online yet.'
      )
    );
  }
  if (ticket.pricingType === 'DONATION' && !ticket.free) {
    out.push(
      blocker(
        'donation_ticket',
        'This is a donation (pay-what-you-want) ticket, which BabyBrain can’t sell yet.',
        'This ticket can’t be booked online yet.'
      )
    );
  }
  return out;
}

/** True when the event can take a ticketed booking: no event-level blocker and
 *  at least one ticket type a parent could buy. */
export function wixEventBookable(
  event: Pick<WixEvent, 'status' | 'registration'>,
  tickets: Pick<WixTicketDefinition, 'hidden' | 'saleStatus' | 'pricingType' | 'free'>[]
): { bookable: boolean; blockers: WixEventBlocker[] } {
  const eventBlockers = evaluateWixEvent(event);
  if (eventBlockers.length) return { bookable: false, blockers: eventBlockers };
  if (!tickets.length) return { bookable: true, blockers: [] }; // nothing to judge; sync fills ticket types separately
  const perTicket = tickets.map(evaluateWixTicket);
  if (perTicket.every((b) => b.length > 0)) {
    // Every ticket is blocked: surface the first ticket's reasons (they're usually the same).
    return { bookable: false, blockers: perTicket[0] };
  }
  return { bookable: true, blockers: [] };
}

/** First parent-facing sentence for a list of blockers. */
export function parentBlockerMessage(blockers: WixEventBlocker[]): string | null {
  return blockers[0]?.parentMessage ?? null;
}
