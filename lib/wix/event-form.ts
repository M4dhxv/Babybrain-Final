import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { fetchWixEventForm, type WixCredentials, type WixEventFormInput } from './client';
import type { WixContact } from './sync';

/**
 * A Wix event carries its own registration form, and a vendor can make any
 * of its fields mandatory — BeAlere's asks for "Child name", "Child age"
 * (their first/last name slots relabelled) plus a mandatory phone. Wix
 * refuses a checkout whose guest form misses a mandatory field
 * (INVALID_FORM_RESPONSE), and we used to send only parent first/last name +
 * email, so every ticket for such an event failed *after* the parent had paid.
 *
 * This module reads the form's fields and fills what BabyBrain already knows
 * (parent contact, the child on the booking). Whatever it cannot know — a
 * dietary question, a T-shirt size, a dropdown of sessions — becomes a question
 * the parent is asked on the booking page, rendered from the vendor's own form
 * (label, mandatory flag, and the fixed options of a dropdown / radio / checkbox
 * control, since Wix rejects a value outside them). Their answers travel with
 * the order and fill the form at checkout.
 */

export type WixFormFieldKind =
  | 'email'
  | 'phone'
  | 'childName'
  | 'childAge'
  | 'childNameAndAge'
  | 'parentFirst'
  | 'parentLast'
  | 'parentFull'
  | 'extra';

const CHILD = /\b(child|children|kid|kids|baby|babies|toddler|infant|son|daughter|participant|attendee)\b|child'?s/i;
const AGE = /\b(age|aged|old|birth|birthday|dob|born)\b/i;
const NAME = /\bname\b/i;
const OTHER_PERSON =
  /\b(emergency|alternat\w*|other|second|2nd|spouse|partner|husband|wife|father|mother|dad|mum|mom|guardian|grand\w*|friend|doctor|nanny|helper|maid|carer|caregiver)\b/i;

/** What a single form input is asking for. The input's `name` is Wix's own
 *  slot id (firstName/lastName/email/phone-xxxx); the *label* is what the
 *  vendor wrote, and is the one that tells a relabelled slot apart. */
export function classifyWixFormInput(input: Pick<WixEventFormInput, 'name' | 'label'>): WixFormFieldKind {
  const label = (input.label ?? '').trim();
  const name = input.name ?? '';
  const both = `${label} ${name}`;

  // A phone / email question about SOMEONE ELSE (emergency contact, the other parent…) is the parent's to
  // answer, not ours to fill with their own number.
  const aboutSomeoneElse = OTHER_PERSON.test(label);
  if (/e-?mail/i.test(both)) return aboutSomeoneElse ? 'extra' : 'email';
  if (/phone|mobile|whatsapp|contact (no|number)|tel\b/i.test(both)) return aboutSomeoneElse ? 'extra' : 'phone';

  if (CHILD.test(label)) {
    const asksAge = AGE.test(label);
    const asksName = NAME.test(label);
    if (asksAge && asksName) return 'childNameAndAge';
    if (asksAge) return 'childAge';
    if (asksName) return 'childName';
  }
  // "Age" / "Date of birth" on its own, with no child wording, is still the
  // child's: nothing else on a kids' booking has an age.
  if (AGE.test(label) && !NAME.test(label)) return 'childAge';

  if (name === 'firstName' || name === 'lastName') {
    // An untouched system name slot ("First name", "Last name", or blank).
    if (/last|sur|family/i.test(label) || (!label && name === 'lastName')) return 'parentLast';
    if (/first|given/i.test(label) || (!label && name === 'firstName')) return 'parentFirst';
    // A relabelled slot that is neither child nor age ("Your name")…
    if (NAME.test(label)) return name === 'firstName' ? 'parentFirst' : 'parentLast';
    return 'extra';
  }
  if (/^(full )?name$/i.test(label) || /your name|parent'?s? name|guest name/i.test(label)) return 'parentFull';
  return 'extra';
}

/** A parent's answers to the event's own questions, keyed by Wix input name.
 *  A checkbox group (or any multi-value input) holds several values. */
export type WixFormAnswers = Record<string, string | string[]>;

/** One value for Wix's checkout / RSVP form response. */
export interface WixFormValue {
  inputName: string;
  value?: string;
  values?: string[];
}

/** The questions the parent is asked on the booking page: every input BabyBrain
 *  cannot fill from the account and the child (mandatory or not). */
export function questionsForParent(inputs: WixEventFormInput[]): WixEventFormInput[] {
  // The "additional guests" control of an RSVP form is handled by the party size on the
  // booking page (and RSVP's own additionalGuestDetails), not asked as a free question.
  return inputs.filter((i) => classifyWixFormInput(i) === 'extra' && i.controlType !== 'GUEST_CONTROL');
}

/** Does this RSVP form let a guest bring others? */
export function formAllowsAdditionalGuests(inputs: WixEventFormInput[]): boolean {
  return inputs.some((i) => i.controlType === 'GUEST_CONTROL');
}

/** Labels of the *mandatory* questions the parent must answer — what the vendor
 *  portal tells them parents will be asked. */
export function mandatoryQuestionLabels(inputs: WixEventFormInput[]): string[] {
  return questionsForParent(inputs)
    .filter((i) => i.mandatory)
    .map((i) => i.label || i.name);
}

const MAX_ANSWER_LENGTH = 5000;

/** Keeps only answers to questions that really exist on the form, as trimmed
 *  strings (or arrays of them for multi-value inputs) — whatever the browser
 *  sent. Never trusts the client's shape. */
export function sanitiseWixFormAnswers(inputs: WixEventFormInput[], raw: unknown): WixFormAnswers {
  const out: WixFormAnswers = {};
  if (!raw || typeof raw !== 'object') return out;
  const given = raw as Record<string, unknown>;
  for (const input of questionsForParent(inputs)) {
    const v = given[input.name];
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, MAX_ANSWER_LENGTH)).filter(Boolean);
      if (items.length) out[input.name] = input.multi ? items.slice(0, 100) : items.join(', ');
    } else if (typeof v === 'string' && v.trim()) {
      out[input.name] = input.multi ? [v.trim().slice(0, MAX_ANSWER_LENGTH)] : v.trim().slice(0, MAX_ANSWER_LENGTH);
    }
  }
  return out;
}

export interface WixAnswerProblem {
  name: string;
  label: string;
  problem: 'missing' | 'option';
}

/** What is wrong with the parent's answers, before anything is reserved or
 *  charged: a mandatory question left blank, or a value outside the fixed
 *  options a dropdown / radio / checkbox control allows (Wix refuses those). */
export function validateWixFormAnswers(
  inputs: WixEventFormInput[],
  answers: WixFormAnswers,
  /** When the activity's single "extra information" answer exists it stands in for ONE
   *  unanswered mandatory question (older bookings), so that one isn't a problem. */
  opts: { fallbackAnswer?: boolean } = {}
): WixAnswerProblem[] {
  const problems: WixAnswerProblem[] = [];
  for (const input of questionsForParent(inputs)) {
    const a = answers[input.name];
    const values = a == null ? [] : Array.isArray(a) ? a : [a];
    if (!values.length) {
      if (input.mandatory) problems.push({ name: input.name, label: input.label || input.name, problem: 'missing' });
      continue;
    }
    if (input.options?.length && values.some((v) => !input.options!.includes(v))) {
      problems.push({ name: input.name, label: input.label || input.name, problem: 'option' });
    }
  }
  if (opts.fallbackAnswer) {
    const missing = problems.filter((p) => p.problem === 'missing');
    if (missing.length === 1) return problems.filter((p) => p !== missing[0]);
  }
  return problems;
}

/** One sentence for the parent about what to fix. */
export function describeWixAnswerProblems(problems: WixAnswerProblem[]): string {
  const missing = problems.filter((p) => p.problem === 'missing').map((p) => `“${p.label}”`);
  const option = problems.filter((p) => p.problem === 'option').map((p) => `“${p.label}”`);
  const parts: string[] = [];
  if (missing.length) parts.push(`Please answer ${missing.join(', ')}.`);
  if (option.length) parts.push(`Please choose one of the listed options for ${option.join(', ')}.`);
  return parts.join(' ');
}

/** What a parent sees when {@link buildWixEventGuestForm} left a mandatory
 *  field empty. A missing phone is the parent's to fix; anything else is the
 *  vendor's form asking for something BabyBrain doesn't collect. */
export function wixFormMissingParentMessage(missing: WixEventFormInput[], charged: boolean): string {
  if (missing.every((m) => classifyWixFormInput(m) === 'phone')) {
    return 'The organiser needs a phone number to book this event — add one to your profile, then try again.';
  }
  return (
    'This event can’t be booked online yet — the organiser’s registration form asks for details BabyBrain doesn’t collect. ' +
    (charged ? 'Nothing has been charged. ' : '') +
    'Please contact the organiser.'
  );
}

export interface WixEventGuestChild {
  name: string;
  dateOfBirth: string | null;
}

/** "11 months" / "3 years" — the form field is free text, so say it the way
 *  a parent would. */
export function wixChildAgeText(dateOfBirth: string | null | undefined, now = new Date()): string {
  if (!dateOfBirth) return '-';
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return '-';
  let months = (now.getFullYear() - dob.getFullYear()) * 12 + (now.getMonth() - dob.getMonth());
  if (now.getDate() < dob.getDate()) months -= 1;
  months = Math.max(months, 0);
  if (months < 24) return `${months} ${months === 1 ? 'month' : 'months'}`;
  const years = Math.floor(months / 12);
  return `${years} years`;
}

export interface WixEventGuestForm {
  inputValues: WixFormValue[];
  /** Mandatory inputs left empty — nothing BabyBrain or the parent supplied fits them. */
  missing: WixEventFormInput[];
}

/** Fills the event's form from what we know. Pure — see
 *  {@link resolveWixEventGuestForm} for the version that fetches. */
export function buildWixEventGuestForm(
  inputs: WixEventFormInput[],
  ctx: {
    contact: WixContact;
    child: WixEventGuestChild | null;
    /** The activity-level "extra information" answer — the fallback for a mandatory
     *  question the parent didn't answer individually (older bookings). */
    infoResponse: string | null;
    /** The parent's answers to the event's own questions. */
    answers?: WixFormAnswers;
  }
): WixEventGuestForm {
  const { contact, child } = ctx;
  const extraAnswer = ctx.infoResponse?.trim() || null;
  const childName = child?.name?.trim() || `${contact.firstName} ${contact.lastName}`.trim();
  const childAge = child ? wixChildAgeText(child.dateOfBirth) : '-';

  const inputValues: WixFormValue[] = [];
  const missing: WixEventFormInput[] = [];
  const answers = ctx.answers ?? {};
  for (const input of inputs) {
    let value: string | null = null;
    let values: string[] | null = null;
    switch (classifyWixFormInput(input)) {
      case 'email': value = contact.email; break;
      case 'phone': value = contact.phone; break;
      case 'childName': value = childName; break;
      case 'childAge': value = childAge; break;
      case 'childNameAndAge': value = `${childName} (${childAge})`; break;
      case 'parentFirst': value = contact.firstName; break;
      case 'parentLast': value = contact.lastName; break;
      case 'parentFull': value = `${contact.firstName} ${contact.lastName}`.trim(); break;
      case 'extra': {
        const a = answers[input.name];
        if (Array.isArray(a) && a.length) {
          if (input.multi) values = a;
          else value = a.join(', ');
        } else if (typeof a === 'string' && a) {
          if (input.multi) values = [a];
          else value = a;
        } else if (input.mandatory) {
          // Fall back to the single activity-level answer; never fill an
          // optional question with it.
          value = extraAnswer;
        }
        break;
      }
    }
    if (values) inputValues.push({ inputName: input.name, values });
    else if (value) inputValues.push({ inputName: input.name, value });
    else if (input.mandatory) missing.push(input);
  }
  return { inputValues, missing };
}

/** The guest form for one ticket: fetches the event's live form from Wix and
 *  fills it. When Wix can't be asked (an outage), falls back to the three
 *  fields we always sent so a transient failure never makes things worse. */
export async function resolveWixEventGuestForm(
  admin: SupabaseClient<Database>,
  creds: WixCredentials,
  wixEventId: string,
  params: {
    contact: WixContact;
    childId: string | null;
    infoResponse: string | null;
    answers?: WixFormAnswers;
    /** The event's form inputs when the caller already fetched the event — saves a Wix call. */
    inputs?: WixEventFormInput[];
  }
): Promise<WixEventGuestForm & { formKnown: boolean }> {
  let child: WixEventGuestChild | null = null;
  if (params.childId) {
    const { data } = await admin.from('children').select('name, date_of_birth').eq('id', params.childId).maybeSingle();
    if (data) child = { name: data.name, dateOfBirth: data.date_of_birth };
  }

  let inputs: WixEventFormInput[] | null = params.inputs ?? null;
  if (!inputs) {
    try {
      inputs = await fetchWixEventForm(creds, wixEventId);
    } catch (e) {
      console.error('[wix-event-form] could not read the event form, using the default fields', wixEventId, e);
    }
  }
  if (!inputs) {
    const { contact } = params;
    return {
      formKnown: false,
      missing: [],
      inputValues: [
        { inputName: 'firstName', value: contact.firstName },
        { inputName: 'lastName', value: contact.lastName },
        { inputName: 'email', value: contact.email },
      ],
    };
  }
  return { formKnown: true, ...buildWixEventGuestForm(inputs, { contact: params.contact, child, infoResponse: params.infoResponse, answers: params.answers }) };
}
