import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveBookingChild } from '@/lib/wix/booking-child';
import {
  WixApiError,
  createWixRsvp,
  fetchWixEvent,
  getProviderWixCredentials,
  wixApplicationErrorCode,
} from '@/lib/wix/client';
import { evaluateWixEvent, parentBlockerMessage } from '@/lib/wix/event-eligibility';
import {
  wixFormProblemBody,
  formAllowsAdditionalGuests,
  resolveWixEventGuestForm,
  sanitiseWixFormAnswers,
  validateWixFormAnswers,
  wixFormMissingParentMessage,
} from '@/lib/wix/event-form';
import { findEventSessionId } from '@/lib/wix/finalize-event-checkout';
import { resolveWixContact } from '@/lib/wix/sync';

/**
 * A parent RSVPs to a Wix RSVP-type event — free, no tickets, no payment (so the
 * RSVP is made on Wix and recorded here in one request). Not to be confused with
 * /api/wix/events/rsvp, which books a *free ticket* on a ticketed event.
 *
 * The party is the RSVP plus any additional guests (only when the event's own
 * form has a guests control): one `bookings` row per person, like every other
 * multi-seat booking, so the roster and the parent's card count them.
 *
 * Wix events have no BabyBrain waitlist (00107): a full event is reported as
 * full, never parked on Wix's own waitlist where nothing here would ever
 * promote it.
 *
 * Body: { eventId, childId?, count?, guestNames?, medicalDisclosure?, policiesAccepted?, infoResponse?, formAnswers? }
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: string;
    childId?: string | null;
    count?: number;
    guestNames?: string[];
    medicalDisclosure?: string;
    policiesAccepted?: string[];
    infoResponse?: string;
    formAnswers?: unknown;
  };
  if (!body.eventId) return NextResponse.json({ error: 'eventId required' }, { status: 400 });

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const child = await resolveBookingChild(admin, user.id, body.childId);
  if (!child.ok) return NextResponse.json({ error: child.error }, { status: child.status });

  const { data: event } = await admin
    .from('wix_events')
    .select('id, provider_id, wix_event_id, is_published, wix_removed_at, registration_type')
    .eq('id', body.eventId)
    .maybeSingle();
  if (!event || !event.is_published || event.wix_removed_at) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  const creds = await getProviderWixCredentials(admin, event.provider_id);
  if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });

  // Live state from Wix, checked before anything is created: is this really an RSVP event, is
  // it open, and what does its form ask?
  const live = await fetchWixEvent(creds, event.wix_event_id).catch(() => undefined);
  if (live === null) return NextResponse.json({ error: 'This event is no longer available.' }, { status: 404 });
  if (live && live.registration?.type !== 'RSVP') {
    return NextResponse.json({ error: 'This event doesn’t take RSVPs.' }, { status: 409 });
  }
  const blockers = live ? evaluateWixEvent(live) : [];
  if (blockers.length) {
    return NextResponse.json({ error: parentBlockerMessage(blockers), code: blockers[0].code }, { status: 409 });
  }

  // One live RSVP per parent per event (Wix itself refuses the same email twice).
  const { data: existing } = await admin
    .from('event_rsvps')
    .select('id')
    .eq('user_id', user.id)
    .eq('event_id', event.id)
    .in('status', ['yes', 'waitlist'])
    .maybeSingle();
  if (existing) return NextResponse.json({ error: 'You’ve already RSVP’d to this event.' }, { status: 409 });

  const allowsGuests = live ? formAllowsAdditionalGuests(live.formInputs) : false;
  const party = Math.min(Math.max(Math.trunc(body.count ?? 1), 1), allowsGuests ? 11 : 1);
  const guestCount = party - 1;
  const guestNames = Array.from({ length: guestCount }, (_u, i) => body.guestNames?.[i]?.trim() || 'Guest');

  const contact = await resolveWixContact(admin, user.id);
  const answers = live ? sanitiseWixFormAnswers(live.formInputs, body.formAnswers) : {};
  if (live) {
    const problems = validateWixFormAnswers(live.formInputs, answers, { fallbackAnswer: !!body.infoResponse?.trim() });
    if (problems.length) {
      return NextResponse.json(wixFormProblemBody(live.formInputs, problems), { status: 422 });
    }
  }
  const guestForm = await resolveWixEventGuestForm(admin, creds, event.wix_event_id, {
    contact,
    childId: child.childId,
    infoResponse: body.infoResponse ?? null,
    answers,
    inputs: live ? live.formInputs : undefined,
  });
  if (guestForm.missing.length) {
    return NextResponse.json({ error: wixFormMissingParentMessage(guestForm.missing, false) }, { status: 409 });
  }

  // The guests control's own inputs (count + names) belong to additionalGuestDetails, not the form body.
  const inputValues = guestForm.inputValues.filter((v) => v.inputName !== 'additionalGuests' && v.inputName !== 'guestNames');

  let rsvp;
  try {
    rsvp = await createWixRsvp(creds, {
      eventId: event.wix_event_id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      inputValues,
      guestCount,
      guestNames,
    });
  } catch (e) {
    const code = wixApplicationErrorCode(e);
    if (code === 'GUEST_LIMIT_EXCEEDED' || code === 'RSVP_LIMIT_EXCEEDED' || code === 'WAITING_LIST_UNAVAILABLE') {
      return NextResponse.json({ error: 'This event is full.' }, { status: 409 });
    }
    if (code === 'RSVPS_CLOSED' || code === 'RSVPS_NOT_STARTED') {
      return NextResponse.json({ error: 'RSVPs for this event aren’t open right now.' }, { status: 409 });
    }
    if (code === 'MEMBER_EMAIL_ALREADY_REGISTERED' || code === 'MEMBER_ALREADY_REGISTERED') {
      return NextResponse.json({ error: 'You’ve already RSVP’d to this event.' }, { status: 409 });
    }
    console.error('[wix events register] Wix refused the RSVP', event.wix_event_id, e instanceof WixApiError ? e.body : e);
    return NextResponse.json({ error: 'Could not reach the organiser’s Wix — try again in a moment.' }, { status: 502 });
  }

  const { data: saved, error: saveError } = await admin
    .from('event_rsvps')
    .insert({
      user_id: user.id,
      child_id: child.childId,
      event_id: event.id,
      status: 'yes',
      guest_count: guestCount,
      guest_names: guestNames,
      wix_rsvp_id: rsvp.rsvpId,
      medical_disclosure: body.medicalDisclosure?.trim() || null,
      policies_accepted: body.policiesAccepted ?? [],
      info_response: body.infoResponse?.trim() || null,
      form_response: answers,
    })
    .select('id')
    .single();
  if (saveError || !saved) {
    console.error('RSVP’d on Wix but failed to save the local RSVP', rsvp.rsvpId, saveError);
    return NextResponse.json({ error: 'RSVP’d on Wix but failed to save locally — contact support' }, { status: 500 });
  }

  // One seat per person so the roster and My Bookings count the whole party.
  const sessionId = await findEventSessionId(admin, event.provider_id, event.id);
  if (!sessionId) {
    console.error('[wix events register] RSVP recorded but no session to seat it on', saved.id);
    return NextResponse.json({ id: saved.id, status: 'confirmed', seated: false });
  }
  const groupId = party > 1 ? randomUUID() : null;
  const rows = Array.from({ length: party }, (_u, i) => ({
    user_id: user.id,
    child_id: i === 0 ? child.childId : null,
    guest_name: i === 0 ? null : guestNames[i - 1],
    booking_group_id: groupId,
    session_id: sessionId,
    status: 'confirmed' as const,
    payment_status: 'none' as const,
    policies_accepted: i === 0 ? body.policiesAccepted ?? [] : [],
    medical_disclosure: i === 0 ? body.medicalDisclosure?.trim() || null : null,
    info_response: i === 0 ? body.infoResponse?.trim() || null : null,
    wix_booking_id: rsvp.rsvpId,
  }));
  const { data: seats, error: seatError } = await admin.from('bookings').insert(rows).select('id, status');
  if (seatError || !seats?.length) {
    console.error('[wix events register] RSVP recorded but the seats could not be written', saved.id, seatError);
    return NextResponse.json({ id: saved.id, status: 'confirmed', seated: false });
  }
  return NextResponse.json({ id: seats[0].id, status: 'confirmed', waitlistedCount: 0 });
}
