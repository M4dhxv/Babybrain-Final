/**
 * Pure-logic checks for the Wix Events integration — no network, no database, so they can be run any
 * time:   npx tsx scripts/validate-wix-events-logic.mts
 *
 * Covers the decisions that cost real money or data when they go wrong:
 *   - lib/wix/event-eligibility  can this event / ticket take a booking right now?
 *   - lib/wix/event-form         filling the event's own registration form, validating a parent's answers
 *   - lib/wix/events-series      folding a recurring series into one activity
 *
 * (The Wix API calls and the database writes around them are exercised against real accounts, not here.)
 */
import {
  evaluateWixEvent,
  evaluateWixTicket,
  wixEventBookable,
} from '../lib/wix/event-eligibility';
import {
  buildWixEventGuestForm,
  classifyWixFormInput,
  describeWixAnswerProblems,
  describeWixFormHandling,
  formAllowsAdditionalGuests,
  mandatoryQuestionLabels,
  questionsForParent,
  rememberedAnswers,
  sanitiseWixFormAnswers,
  validateWixFormAnswers,
  wixChildAgeText,
  wixFormProblemBody,
} from '../lib/wix/event-form';
import { pruneAnswers } from '../frontends/parent/src/lib/eventForm';
import { pickAddressHit } from '../lib/geocode';
import {
  groupEventsForPicker,
  planSeries,
  representativeEventIds,
  type SeriesActivityRow,
  type SeriesOccurrence,
  type SeriesSessionRow,
} from '../lib/wix/events-series';
import type { WixEventFormInput } from '../lib/wix/client';
import { deriveEarning } from '../lib/commercials';
import { localParts, placePlan, planDayBooking, splitMultiDay, ticketDaysCovered } from '../lib/wix/event-days';

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
};

// ---------------------------------------------------------------- eligibility
const ev = (reg: Record<string, unknown> = {}, status = 'UPCOMING') => ({
  status,
  registration: {
    type: 'TICKETING', initialType: 'TICKETING', status: 'OPEN_TICKETS', paused: false, disabled: false,
    allowedGuestTypes: 'VISITOR_OR_MEMBER', guestsAssignedSeparately: false, reservationMinutes: 20,
    ticketLimitPerOrder: 50, soldOut: false, taxType: null, taxRate: null, rsvp: null, externalUrl: null, ...reg,
  },
});
const code = (b: { code: string }[]) => b[0]?.code;

check(evaluateWixEvent(ev()).length === 0, 'open ticketed event: no blockers');
check(code(evaluateWixEvent(ev({ status: 'CLOSED_MANUALLY' }))) === 'registration_closed', 'closed registration blocks');
check(code(evaluateWixEvent(ev({ paused: true }))) === 'registration_paused', 'paused registration blocks');
check(code(evaluateWixEvent(ev({ allowedGuestTypes: 'MEMBER' }))) === 'members_only', 'members-only blocks');
check(code(evaluateWixEvent(ev({ taxType: 'ADDED', taxRate: '7' }))) === 'tax_not_supported', 'tax added at checkout blocks');
check(evaluateWixEvent(ev({ taxType: 'INCLUDED', taxRate: '7' })).length === 0, 'tax included in the price is fine');
check(code(evaluateWixEvent(ev({}, 'CANCELED'))) === 'event_canceled', 'cancelled event blocks');
check(code(evaluateWixEvent(ev({}, 'ENDED'))) === 'event_over', 'ended event blocks');
check(evaluateWixEvent(ev({ type: 'RSVP', status: 'OPEN_RSVP' })).length === 0, 'open RSVP event: no blockers');
check(code(evaluateWixEvent(ev({ type: 'RSVP', status: 'OPEN_RSVP_WAITLIST_ONLY' }))) === 'registration_full', 'RSVP list full (waitlist only) is "full" — Wix events have no waitlist here');
check(code(evaluateWixEvent(ev({ type: 'RSVP', status: 'CLOSED_AUTOMATICALLY' }))) === 'registration_closed', 'closed RSVP blocks');
check(evaluateWixEvent(ev({ type: 'EXTERNAL', status: 'OPEN_EXTERNAL', externalUrl: 'https://x.test' })).length === 0, 'external event with a URL: routed to the organiser, no blocker');
check(code(evaluateWixEvent(ev({ type: 'EXTERNAL', externalUrl: null }))) === 'registration_external', 'external event with no URL blocks');
check(code(evaluateWixEvent(ev({ type: 'NONE' }))) === 'registration_none', 'information-only event blocks');
check(code(evaluateWixTicket({ hidden: false, saleStatus: 'SALE_SCHEDULED', pricingType: 'STANDARD', free: false })) === 'sale_not_open', 'sale not started');
check(code(evaluateWixTicket({ hidden: false, saleStatus: 'SALE_ENDED', pricingType: 'STANDARD', free: false })) === 'sale_ended', 'sale ended');
check(code(evaluateWixTicket({ hidden: true, saleStatus: 'SALE_STARTED', pricingType: 'STANDARD', free: false })) === 'ticket_hidden', 'hidden ticket');
check(code(evaluateWixTicket({ hidden: false, saleStatus: 'SALE_STARTED', pricingType: 'DONATION', free: false })) === 'donation_ticket', 'donation ticket blocks');
check(code(evaluateWixTicket({ hidden: false, saleStatus: 'SALE_STARTED', pricingType: 'STANDARD', free: false, hasSeating: true })) === 'seating_not_supported', 'a seating plan blocks (no seat can be chosen)');
check(evaluateWixTicket({ hidden: false, saleStatus: 'SALE_STARTED', pricingType: 'DONATION', free: true }).length === 0, 'a free donation-type ticket is fine');
const open = { hidden: false, saleStatus: 'SALE_STARTED', pricingType: 'STANDARD', free: false };
check(!wixEventBookable(ev(), [{ ...open, hidden: true }]).bookable, 'every ticket blocked => not bookable');
check(wixEventBookable(ev(), [{ ...open, hidden: true }, open]).bookable, 'one purchasable ticket => bookable');

// ---------------------------------------------------------------- forms
const input = (name: string, label: string, mandatory = true, extra: Partial<WixEventFormInput> = {}): WixEventFormInput => ({ name, label, mandatory, ...extra });
const contact = { firstName: 'Katie', lastName: 'Crowson', email: 'k@x.test', phone: '80335696' };

// BeAlere's real "The Crest" form: first/last name slots relabelled to child name / child age.
const crest = [input('firstName', 'Child name'), input('lastName', 'Child age'), input('email', 'Email'), input('phone-04f5', 'Phone')];
const crestForm = buildWixEventGuestForm(crest, { contact, child: { name: 'Alfie', dateOfBirth: '2025-09-07' }, infoResponse: null });
check(JSON.stringify(crestForm.inputValues.map((v) => [v.inputName, v.value])) === JSON.stringify([['firstName', 'Alfie'], ['lastName', wixChildAgeText('2025-09-07')], ['email', 'k@x.test'], ['phone-04f5', '80335696']]), 'BeAlere form: child name/age fill the relabelled name slots');
check(crestForm.missing.length === 0, 'BeAlere form: nothing left unanswered');
check(wixChildAgeText('2025-09-07', new Date('2026-10-04')) === '12 months', 'age under 2 reads in months');
check(wixChildAgeText('2022-01-10', new Date('2026-10-04')) === '4 years', 'age over 2 reads in years');
check(classifyWixFormInput(input('x', 'Child name & age')) === 'childNameAndAge', '"Child name & age" is one combined field');
check(classifyWixFormInput(input('x', "Child's age")) === 'childAge', '"Child\'s age"');
check(classifyWixFormInput(input('firstName', 'Parent name')) === 'parentFirst', '"Parent name" in the first-name slot is the parent');
check(classifyWixFormInput(input('p2', 'Emergency contact phone')) === 'extra', 'an emergency-contact phone is asked, not filled with the parent\'s own');
check(classifyWixFormInput(input('p3', "Second parent's email")) === 'extra', 'another person\'s email is asked, not filled');
check(classifyWixFormInput(input('p4', 'Mobile number')) === 'phone' && classifyWixFormInput(input('e', 'Email address')) === 'email', 'the parent\'s own phone / email are still filled');

// A label is auto-filled only when it is plainly the child's name / age; anything with extra words is ASKED, because
// a wrong auto-filled answer is invisible to the parent and accepted by Wix.
const kindOf = (label: string, name = 'c1') => classifyWixFormInput(input(name, label));
check(kindOf('Does your child have any allergies?') === 'extra', 'an allergy question is asked');
check(kindOf("Child's allergies / dietary requirements") === 'extra', 'allergies / dietary requirements is asked');
check(kindOf('Does your child have any old injuries or medical conditions?') === 'extra', '"old injuries" is not the child\'s age');
check(kindOf('Is your baby over 6 months old?') === 'extra', 'a yes/no question about age is asked, not answered with the age');
check(kindOf("Name of your child's school or nursery") === 'extra', "the child's school is not the child's name");
check(kindOf("Child's nickname") === 'extra' && kindOf("Child's T-shirt size") === 'extra', 'other child details are asked');
check(kindOf("Name of your other child") === 'extra' && kindOf("Sibling's age") === 'extra', "another child's details are asked");
check(kindOf("Child's date of birth") === 'extra' && kindOf('Date of birth') === 'extra', 'a date of birth is asked (we only know the age text, which a date field would refuse)');
check(kindOf('Your age') === 'extra', "\"Your age\" is not the child's");
check(kindOf('Age') === 'childAge' && kindOf('Age of child') === 'childAge' && kindOf('Child age (in years)') === 'childAge', 'a plain age field is still filled');
check(kindOf('How old is your child?') === 'childAge', '"How old is your child?" is the age');
check(kindOf('Name of your child') === 'childName' && kindOf("Child's full name") === 'childName' && kindOf('Participant name') === 'childName', 'a plain child name is still filled');
check(kindOf('Child name and age') === 'childNameAndAge', '"Child name and age" is still one combined field');
check(kindOf("Children's names") === 'extra', 'several children are asked, not filled with one');
check(kindOf("Name of your child's school", 'firstName') === 'extra', 'a name slot relabelled into another question is asked, not filled with the parent\'s name');
check(kindOf('Name of the other parent', 'lastName') === 'extra', "another person's name in a name slot is asked");
check(kindOf('Your name', 'firstName') === 'parentFirst' && kindOf('First name', 'firstName') === 'parentFirst' && kindOf('Surname', 'lastName') === 'parentLast', "the parent's own name slots are still filled");
check(kindOf('Full name') === 'parentFull' && kindOf('Name') === 'parentFull', 'a plain name field is the parent\'s');
check(kindOf('', 'firstName') === 'parentFirst' && kindOf('', 'lastName') === 'parentLast', 'untouched blank name slots are the parent\'s');
check(kindOf('Name of the venue') === 'extra', 'a name that is not a person\'s is asked');


const dietary = input('diet', 'Dietary needs', true);
const day = input('day', 'Which day?', true, { controlType: 'DROPDOWN', options: ['Mon', 'Tue'] });
const extras = input('extras', 'Add-ons', false, { controlType: 'CHECKBOX', multi: true, options: ['Lunch', 'Shirt'] });
const guests = input('additionalGuests', 'Additional guests', false, { controlType: 'GUEST_CONTROL' });
const form = [input('firstName', 'First name'), input('lastName', 'Last name'), input('email', 'Email'), dietary, day, extras, guests];
check(questionsForParent(form).map((q) => q.name).join() === 'diet,day,extras', 'questions asked: everything we cannot fill, minus the guests control');
check(formAllowsAdditionalGuests(form), 'a guests control means extra guests are allowed');
check(mandatoryQuestionLabels(form).join() === 'Dietary needs,Which day?', 'mandatory questions listed for the vendor');

const handling = describeWixFormHandling([...crest, dietary, day, extras, guests]);
const handlingOf = (n: string) => handling.find((h) => h.name === n)!;
check(handling.length === 8, 'one row per form input');
check(handlingOf('firstName').handling === 'filled' && /child’s name/.test(handlingOf('firstName').note), 'a relabelled name slot is shown as the child\'s name');
check(handlingOf('diet').handling === 'asked' && /must answer/.test(handlingOf('diet').note), 'a mandatory question is shown as required');
check(handlingOf('extras').handling === 'asked' && /optional/.test(handlingOf('extras').note) && /several/.test(handlingOf('extras').note), 'an optional multi-choice question says so');
check(handlingOf('day').options?.join() === 'Mon,Tue', 'the options of a dropdown are carried across');
check(handlingOf('additionalGuests').handling === 'guests', 'the guests control is its own row');
check(handling.filter((h) => h.handling === 'asked').map((h) => h.name).join() === questionsForParent([...crest, dietary, day, extras, guests]).map((q) => q.name).join(), 'the vendor table lists exactly the questions parents are asked');

const clean = sanitiseWixFormAnswers(form, { diet: '  no nuts ', day: 'Tue', extras: ['Lunch', 'Shirt'], rubbish: 'x', firstName: 'Mallory' });
check(clean.diet === 'no nuts' && clean.day === 'Tue', 'answers trimmed');
check(!('rubbish' in clean) && !('firstName' in clean), 'answers to questions that do not exist (or that we fill ourselves) are dropped');
check(Array.isArray(clean.extras) && clean.extras.length === 2, 'a checkbox group keeps several values');
check(validateWixFormAnswers(form, clean).length === 0, 'complete, valid answers pass');
check(validateWixFormAnswers(form, {}).map((p) => p.name).join() === 'diet,day', 'unanswered mandatory questions are reported');
check(validateWixFormAnswers(form, { diet: 'x', day: 'Sat' })[0]?.problem === 'option', 'a value outside the dropdown options is rejected (Wix would refuse it)');
check(validateWixFormAnswers(form, { day: 'Tue' }, { fallbackAnswer: true }).length === 0, 'the activity-level answer stands in for one unanswered mandatory question');
check(validateWixFormAnswers(form, {}, { fallbackAnswer: true }).length === 2, 'but it cannot cover two or more unanswered questions');
check(/Please answer/.test(describeWixAnswerProblems(validateWixFormAnswers(form, {}))), 'a readable message for the parent');

// A refusal carries the LIVE questions, so a booking page with an out-of-date copy can redraw its form
// (the organiser added "diet" / changed the day options since the page loaded) instead of leaving the parent stuck.
const refusal = wixFormProblemBody(form, validateWixFormAnswers(form, {}));
check(refusal.fields.join() === 'diet,day' && /Please answer/.test(refusal.error), 'the refusal names what is missing');
check(refusal.questions.map((q) => q.name).join() === 'diet,day,extras', 'and carries every live question the parent is asked (not the ones we fill ourselves)');
const kept = pruneAnswers(refusal.questions, { diet: 'x', day: 'Sat', extras: ['Lunch', 'Gone'], gone: 'y' });
check(kept.diet === 'x' && !('day' in kept) && !('extras' in kept) && !('gone' in kept), 'a redrawn form drops answers whose question or option no longer exists (they would show blank yet still be sent)');
check(JSON.stringify(pruneAnswers(refusal.questions, { day: 'Tue', extras: ['Lunch'] })) === JSON.stringify({ day: 'Tue', extras: ['Lunch'] }), 'and keeps the ones that still fit');

// Prefilling from earlier bookings: matched by wording (input names differ between events), typed answers only.
const allergyQ = input('new-1', 'Does your child have any allergies?', true);
const schoolQ = input('new-2', 'School / nursery', false);
const birthQ = input('new-3', 'Date of birth', true, { inputType: 'DATE', controlType: 'DATE' });
const startQ = input('new-4', 'Preferred start date', false, { inputType: 'DATE', controlType: 'DATE' });
const sizeQ = input('new-5', 'T-shirt size', true, { controlType: 'DROPDOWN', options: ['S', 'M'] });
const nowForm = [input('firstName', 'First name'), input('email', 'Email'), allergyQ, schoolQ, birthQ, startQ, sizeQ];
const earlier = { answers: { a1: ' Peanuts ', s1: 'Little Stars', b1: '2025-09-07', d1: '2026-01-05', z1: 'M', email: 'x@y.test' }, questions: [
  { name: 'a1', label: 'Does your child have any allergies' }, { name: 's1', label: 'school/nursery' }, { name: 'b1', label: 'Date of birth' },
  { name: 'd1', label: 'Preferred start date' }, { name: 'z1', label: 'T-shirt size' }, { name: 'email', label: 'Email' } ] };
const carried = rememberedAnswers(nowForm, [earlier]);
check(carried['new-1'] === 'Peanuts', 'an allergy answer carries over to the same question worded slightly differently');
check(carried['new-2'] === 'Little Stars', 'a school carries over');
check(carried['new-3'] === '2025-09-07', 'a date of birth carries over');
check(!('new-4' in carried), 'a date picked for one event does not');
check(!('new-5' in carried), 'a dropdown choice is specific to one event and does not');
check(!('firstName' in carried) && !('email' in carried), 'fields we fill ourselves are not part of it');
const newer = { answers: { x: 'Dairy' }, questions: [{ name: 'x', label: 'Does your child have any allergies?' }] };
check(rememberedAnswers(nowForm, [newer, earlier])['new-1'] === 'Dairy', 'the newest answer wins');
const blank = { answers: { x: '  ' }, questions: [{ name: 'x', label: 'Does your child have any allergies?' }] };
check(rememberedAnswers(nowForm, [blank, earlier])['new-1'] === 'Peanuts', 'a blank answer is skipped for the last real one');
const arr = { answers: { x: ['a', 'b'] }, questions: [{ name: 'x', label: 'Does your child have any allergies?' }] };
check(!('new-1' in rememberedAnswers(nowForm, [arr])), 'a multi-value answer is never carried');
check(Object.keys(rememberedAnswers(nowForm, [])).length === 0 && Object.keys(rememberedAnswers(nowForm, [{ answers: null, questions: [] }])).length === 0, 'no history, nothing to carry');
check(!('new-1' in rememberedAnswers(nowForm, [{ answers: { x: 'Peanuts' }, questions: [{ name: 'x', label: 'Does your child eat peanuts?' }] }])), 'a different question is not matched');

// A venue Wix sent without a postal code is looked up by its address — but only a CERTAIN match is used.
const crestHit = { BLK_NO: '103', ROAD_NAME: 'PRINCE CHARLES CRESCENT', POSTAL: '159018', LATITUDE: '1.292754716342545', LONGITUDE: '103.8198559062187' };
check(pickAddressHit('103 Prince Charles Cres', 1, [crestHit])?.postalCode === '159018', 'one OneMap match is taken (The Crest -> 159018)');
check(pickAddressHit('103 Prince Charles Cres', 3, [crestHit, { ...crestHit, POSTAL: '159999' }, crestHit])?.postalCode === '159018', 'several matches: the first is taken when its block and road are the address');
check(pickAddressHit('10 Prince Charles Cres', 3, [crestHit, crestHit, crestHit]) === null, 'several matches, a different block number: not guessed');
check(pickAddressHit('103 Orchard Road', 2, [crestHit, crestHit]) === null, 'several matches, a different road: not guessed');
check(pickAddressHit('Tanglin', 5, [crestHit]) === null && pickAddressHit('Tanglin', 0, []) === null, 'an area name or no match gives nothing');
check(pickAddressHit('103 Prince Charles Cres', 1, [{ ...crestHit, POSTAL: 'NIL' }]) === null, 'a hit without a real postal code is refused');

const built = buildWixEventGuestForm(form, { contact, child: null, infoResponse: null, answers: clean });
const byName = Object.fromEntries(built.inputValues.map((v) => [v.inputName, v]));
check(byName.diet?.value === 'no nuts' && byName.day?.value === 'Tue', 'answers go into the form');
check(JSON.stringify(byName.extras?.values) === JSON.stringify(['Lunch', 'Shirt']), 'multi-value answers use `values`');
check(built.missing.length === 0, 'nothing left missing');
const optionalOnly = buildWixEventGuestForm([...form.slice(0, 3), extras], { contact, child: null, infoResponse: 'SECRET', answers: {} });
check(!optionalOnly.inputValues.some((v) => v.value === 'SECRET'), 'the activity-level answer never fills an optional question');
const fallback = buildWixEventGuestForm([...form.slice(0, 3), dietary], { contact, child: null, infoResponse: 'vegan', answers: {} });
check(fallback.inputValues.find((v) => v.inputName === 'diet')?.value === 'vegan', 'the activity-level answer fills an unanswered mandatory question');

// ---------------------------------------------------------------- series
const occ = (n: number, start: string): SeriesOccurrence => ({ localEventId: `L${n}`, wixEventId: `W${n}`, startDate: start, endDate: start });
const act = (id: string, eventId: string | null, o: Partial<SeriesActivityRow> = {}): SeriesActivityRow => ({
  id, wixEventId: eventId, wixSeriesId: null, isPublished: false, createdAt: `2026-10-0${id.length}T00:00:00Z`, liveBookings: 0, ...o,
});
const sess = (id: string, activityId: string, wixEventId: string | null, start: string, status: string | null = 'scheduled'): SeriesSessionRow => ({
  id, activityId, wixEventId, status, startsAt: start, endsAt: start,
});
const D = (n: number) => `2026-10-${String(n).padStart(2, '0')}T08:00:00Z`;

{
  // Three per-date activities of one series, one with a booking; two more dates on Wix not yet imported.
  const plans = planSeries({
    occurrencesBySeries: new Map([['S', [occ(1, D(6)), occ(2, D(13)), occ(3, D(20)), occ(4, D(27)), occ(5, D(28))]]]),
    localEventIdsBySeries: new Map([['S', new Set(['L1', 'L2', 'L3', 'L4', 'L5'])]]),
    goneLocalEventIds: new Set(),
    activities: [act('a', 'L1'), act('bb', 'L2', { liveBookings: 1 }), act('ccc', 'L3', { isPublished: true })],
    sessions: [sess('s1', 'a', null, D(6)), sess('s2', 'bb', null, D(13)), sess('s3', 'ccc', null, D(20))],
  });
  const p = plans[0];
  check(plans.length === 1, 'one series planned');
  check(p.canonicalActivityId === 'ccc', 'the published activity survives');
  check(p.convertCanonical && p.mergeActivityIds.sort().join() === 'a,bb', 'the others are folded in');
  check(p.moveSessions.length === 3, 'all three sessions end up under the series activity, stamped with their event');
  check(p.createSessions.map((o) => o.localEventId).join() === 'L4,L5', 'the two un-imported dates are added');
  check(p.updateSessions.length === 0 && p.cancelSessions.length === 0, 'nothing else changes');
}
{
  // Without a published one, the activity holding a live booking wins.
  const p = planSeries({
    occurrencesBySeries: new Map([['S', [occ(1, D(6)), occ(2, D(13))]]]),
    localEventIdsBySeries: new Map([['S', new Set(['L1', 'L2'])]]),
    goneLocalEventIds: new Set(),
    activities: [act('a', 'L1'), act('bb', 'L2', { liveBookings: 2 })],
    sessions: [sess('s1', 'a', null, D(6)), sess('s2', 'bb', null, D(13))],
  })[0];
  check(p.canonicalActivityId === 'bb', 'with no published activity, the one holding bookings survives');
}
{
  // Already a series activity: a date moves, one disappears from Wix, one is new — and it is stable.
  const input = {
    occurrencesBySeries: new Map([['S', [occ(1, D(7)), occ(3, D(20))]]]), // L1 moved 6 -> 7; L2 gone from Wix
    localEventIdsBySeries: new Map([['S', new Set(['L1', 'L2', 'L3'])]]),
    goneLocalEventIds: new Set(['L2']),
    activities: [act('series', null, { wixSeriesId: 'S', isPublished: true })],
    sessions: [sess('s1', 'series', 'L1', D(6)), sess('s2', 'series', 'L2', D(13)), sess('s3', 'series', 'L3', D(20)), sess('s0', 'series', 'L0', D(1), 'cancelled')],
  };
  const p = planSeries(input)[0];
  check(!p.convertCanonical && p.mergeActivityIds.length === 0, 'an existing series activity is kept as is');
  check(p.updateSessions.length === 1 && p.updateSessions[0].sessionId === 's1', 'a date Wix moved is updated');
  check(p.cancelSessions.join() === 's2', 'a date Wix dropped is cancelled (once)');
  check(p.createSessions.length === 0, 'no phantom new dates');
  const again = planSeries({ ...input, sessions: input.sessions.map((s) => (s.id === 's2' ? { ...s, status: 'cancelled' } : s.id === 's1' ? { ...s, startsAt: D(7), endsAt: D(7) } : s)) })[0];
  check(again.updateSessions.length === 0 && again.cancelSessions.length === 0 && again.createSessions.length === 0, 're-planning after applying changes nothing (idempotent)');
}
{
  const p = planSeries({
    occurrencesBySeries: new Map([['S', [occ(1, D(6))]]]),
    localEventIdsBySeries: new Map([['S', new Set(['L1'])]]),
    goneLocalEventIds: new Set(),
    activities: [], // never imported
    sessions: [],
  });
  check(p.length === 0, 'a series the vendor never imported is left alone');
}
{
  // A date that comes back after being cancelled gets a fresh session.
  const p = planSeries({
    occurrencesBySeries: new Map([['S', [occ(1, D(6))]]]),
    localEventIdsBySeries: new Map([['S', new Set(['L1'])]]),
    goneLocalEventIds: new Set(),
    activities: [act('series', null, { wixSeriesId: 'S' })],
    sessions: [sess('old', 'series', 'L1', D(6), 'cancelled')],
  })[0];
  check(p.createSessions.length === 1, 'a revived date gets a new session');
}

const events = [
  { id: 'W1', title: 'Class', startDate: D(13), recurrence: { status: 'RECURRING', seriesId: 'S' } },
  { id: 'W2', title: 'Class', startDate: D(6), recurrence: { status: 'RECURRING_UPCOMING', seriesId: 'S' } },
  { id: 'W3', title: 'One-off', startDate: D(9), recurrence: { status: 'ONE_TIME', seriesId: null } },
];
const groups = groupEventsForPicker(events);
check(groups.length === 2, 'picker: a series is one row, a one-off is one row');
const g = groups.find((x) => x.seriesId === 'S')!;
check(g.occurrences === 2 && g.id === 'series:S' && g.startDate === D(6), 'picker: the series row shows its date count and first date');
check(representativeEventIds(['series:S', 'W3'], events).sort().join() === 'W2,W3', 'a picked series is mirrored through its earliest date; a plain event as is');

// ---------------------------------------------------------------- multi-day events (BeAlere's Nature Holiday Camp)
{
  // One Wix event: Mon 12 Oct 9:00 -> Fri 16 Oct 12:00 (Singapore). Really five days of 9-12.
  const camp = { startDate: '2026-10-12T01:00:00Z', endDate: '2026-10-16T04:00:00Z', timeZoneId: 'Asia/Singapore' };
  const days = splitMultiDay(camp)!;
  check(!!days && days.length === 5, 'a Mon 9:00 -> Fri 12:00 event is five days');
  check(days.map((d) => d.day).join() === '2026-10-12,2026-10-13,2026-10-14,2026-10-15,2026-10-16', 'the days are Mon-Fri in the event\'s own time zone');
  check(days.every((d) => (Date.parse(d.endDate) - Date.parse(d.startDate)) / 60000 === 180), 'each day is 9:00-12:00, 180 minutes (not one 5,940-minute block)');
  check(localParts(days[2].startDate, 'Asia/Singapore').time === '09:00:00' && localParts(days[2].endDate, 'Asia/Singapore').time === '12:00:00', 'start and end times of day are preserved');
  check(splitMultiDay({ startDate: '2026-10-12T01:00:00Z', endDate: '2026-10-12T04:00:00Z' }) === null, 'a one-day event is not split');
  check(splitMultiDay({ startDate: '2026-10-12T14:00:00Z', endDate: '2026-10-13T22:00:00Z', timeZoneId: 'Asia/Singapore' }) === null, 'an overnight event (22:00 -> 06:00) is not split into invented days');
  check(splitMultiDay({ startDate: '2026-10-12T01:00:00Z', endDate: '2027-03-12T04:00:00Z' }) === null, 'an open-ended event is not split into hundreds of sessions');
  check(ticketDaysCovered('Single Day') === 1 && ticketDaysCovered('3 Day Package') === 3 && ticketDaysCovered('5 Day Package') === 5, 'ticket names are read: Single Day / 3 Day / 5 Day');
  check(ticketDaysCovered('General Admission') === null, 'a ticket that does not say how many days is unknown, not zero');
  const ed = days.map((d) => d.day);
  const single2 = planDayBooking({ ticketName: 'Single Day', partySize: 1, days: [ed[0], ed[2]], eventDays: ed });
  check(single2.ok && single2.tickets === 2 && single2.places === 2, 'two single days = two single-day tickets, two places');
  const twoKids = planDayBooking({ ticketName: 'Single Day', partySize: 2, days: [ed[0], ed[1], ed[2]], eventDays: ed });
  check(twoKids.ok && twoKids.tickets === 6 && twoKids.places === 6, 'two children on three single days = six tickets, six places');
  const pkg = planDayBooking({ ticketName: '3 Day Package', partySize: 1, days: [ed[0], ed[1], ed[4]], eventDays: ed });
  check(pkg.ok && pkg.tickets === 1 && pkg.places === 3 && pkg.daysPerTicket === 3, 'a 3-day package: one ticket, three places');
  check(!planDayBooking({ ticketName: '3 Day Package', partySize: 1, days: [ed[0]], eventDays: ed }).ok, 'a 3-day package needs exactly three days');
  check(!planDayBooking({ ticketName: 'Single Day', partySize: 1, days: ['2026-12-25'], eventDays: ed }).ok, 'a day outside the event is refused');
  check(!planDayBooking({ ticketName: 'Single Day', partySize: 1, days: [], eventDays: ed }).ok, 'no days chosen is refused');
  check(!planDayBooking({ ticketName: 'Single Day', partySize: 6, days: ed, eventDays: ed, ticketLimitPerOrder: 20 }).ok, 'more tickets than one order allows is refused (6 children x 5 days = 30)');
  const plan = placePlan(2, [ed[0], ed[2]]);
  check(plan.length === 4 && plan.filter((p) => p.childIndex === 1).length === 2, 'places: each child gets every chosen day');
  // planner: a one-event "series" of days, replacing the old single 99-hour session
  const occ = days.map((d) => ({ localEventId: 'CAMP', wixEventId: 'WCAMP', startDate: d.startDate, endDate: d.endDate, day: d.day }));
  const planDays = planSeries({
    occurrencesBySeries: new Map([['md:WCAMP', occ]]),
    localEventIdsBySeries: new Map([['md:WCAMP', new Set(['CAMP'])]]),
    goneLocalEventIds: new Set(),
    activities: [act('aa', 'CAMP')],
    sessions: [sess('span', 'aa', null, camp.startDate)],
  })[0];
  check(planDays.convertCanonical && planDays.createSessions.length === 5 && planDays.createSessions.every((o) => !!o.day), 'the camp becomes five day sessions');
  check(planDays.retireSessions.join() === 'span', 'and the old single-span session is retired');
  const settled = planSeries({
    occurrencesBySeries: new Map([['md:WCAMP', occ]]),
    localEventIdsBySeries: new Map([['md:WCAMP', new Set(['CAMP'])]]),
    goneLocalEventIds: new Set(),
    activities: [act('aa', null, { wixSeriesId: 'md:WCAMP' })],
    sessions: days.map((d, i) => ({ ...sess('d' + i, 'aa', 'CAMP', d.startDate), endsAt: d.endDate, wixDay: d.day })),
  })[0];
  check(settled.createSessions.length === 0 && settled.retireSessions.length === 0 && settled.cancelSessions.length === 0 && settled.updateSessions.length === 0, 'once split, re-planning changes nothing');
  const shortened = planSeries({
    occurrencesBySeries: new Map([['md:WCAMP', occ.slice(0, 3)]]), // vendor cut Thu+Fri
    localEventIdsBySeries: new Map([['md:WCAMP', new Set(['CAMP'])]]),
    goneLocalEventIds: new Set(),
    activities: [act('aa', null, { wixSeriesId: 'md:WCAMP' })],
    sessions: days.map((d, i) => ({ ...sess('d' + i, 'aa', 'CAMP', d.startDate), endsAt: d.endDate, wixDay: d.day })),
  })[0];
  check(shortened.cancelSessions.join() === 'd3,d4', 'days the vendor removed from the event are cancelled (parents on them are told)');
}

// ---------------------------------------------------------------- earnings ledger
{
  // BeAlere's terms: 10% commission, vendor bears Stripe's fee. Katie's S$46.13 ticket.
  const terms = { commissionRate: 0.1, commissionFlatCents: 0, feePayer: 'vendor', commissionOnPackages: true } as const;
  const noStripe = { grossCents: null, applicationFeeCents: null, stripeFeeCents: null, transferId: null, currency: null, livemode: null };
  const estimate = deriveEarning(4613, noStripe, terms, 'booking');
  check(estimate.status === 'platform_owed' && !estimate.routedToConnect, "without Stripe's facts a sale is recorded as held by BabyBrain (the case that mis-stated Katie's row)");
  check(estimate.netCents === 3945 && estimate.commissionCents === 461, 'the estimate matches the split checkout would have taken (net 39.45, commission 4.61)');
  const real = deriveEarning(4613, { grossCents: 4613, applicationFeeCents: 668, stripeFeeCents: 207, transferId: 'tr_123', currency: 'sgd', livemode: true }, terms, 'booking');
  check(real.status === 'pending' && real.routedToConnect, 'with a Stripe transfer the vendor was already paid: routed to Connect, not "we owe vendor"');
  check(real.netCents === 3945 && real.commissionCents === 461, 'the real figures agree with the estimate when terms are unchanged');
  const other = deriveEarning(4613, { ...noStripe, grossCents: 5000 }, terms, 'booking');
  check(other.gross === 5000, "Stripe's gross wins over the app's");
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
