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

const OTHER_PERSON =
  /\b(emergency|alternat\w*|other|second|2nd|spouse|partner|husband|wife|father|mother|dad|mum|mom|guardian|grand\w*|friend|doctor|nanny|helper|maid|carer|caregiver)\b/i;

// Auto-filling a question we shouldn't have is worse than asking one we could have answered: the parent
// never sees the wrong answer, and Wix accepts it. So a label is only auto-filled when EVERY word in it is
// one of these — "Child's age", "Name of your child", nothing more. "Any old injuries?", "Is your baby over 6
// months old?" and "Name of your child's school" each carry a word that isn't here, so the parent is asked.
const CHILD_WORDS = new Set(['child', 'kid', 'baby', 'toddler', 'infant', 'son', 'daughter', 'participant', 'attendee']);
const AGE_UNITS = new Set(['year', 'years', 'yr', 'yrs', 'month', 'months']);
const FILLER = new Set(['your', 'my', 'the', 'a', 'of', 'please', 'enter', 'and', 'in']);
const NAME_QUALIFIERS = new Set(['full', 'first', 'last', 'given']);
const PARENT_WORDS = new Set(['parent', 'parents', 'guest']);
const HOW_OLD_IS_CHILD = /^how old (is|are|will) (your |the |my )?(child|kid|baby|toddler|son|daughter|participant|attendee)( be)?\s*\??$/i;

/** The label as plain lower-case words: "Child's name & age" → ["child", "name", "age"]. */
function labelWords(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** A label that is nothing but the child's name and/or age — or null when it says anything more. */
function plainChildField(label: string): 'childName' | 'childAge' | 'childNameAndAge' | null {
  if (HOW_OLD_IS_CHILD.test(label.trim())) return 'childAge';
  const words = labelWords(label);
  if (!words.length) return null;
  const hasChild = words.some((w) => CHILD_WORDS.has(w));
  const allowed = (w: string) =>
    CHILD_WORDS.has(w) || w === 'name' || w === 'age' || AGE_UNITS.has(w) || NAME_QUALIFIERS.has(w) || FILLER.has(w);
  if (words.some((w) => !allowed(w))) return null;
  const asksName = words.includes('name');
  const asksAge = words.includes('age');
  if (!hasChild) {
    // "Age" on its own is still the child's (nothing else on a kids' booking has an age) — but "Your age" is not.
    if (asksAge && !asksName && !words.some((w) => w === 'your' || w === 'my')) return 'childAge';
    return null;
  }
  if (asksName && asksAge) return 'childNameAndAge';
  if (asksAge) return 'childAge';
  if (asksName) return 'childName';
  return null;
}

/** A label that is nothing but the parent's own name ("Your name", "Parent name", "First name", "Surname"…). */
function plainParentName(label: string): { first: boolean; last: boolean } | null {
  const words = labelWords(label);
  const ok = (w: string) =>
    w === 'name' || w === 'surname' || w === 'family' || NAME_QUALIFIERS.has(w) || PARENT_WORDS.has(w) || FILLER.has(w);
  if (!words.length || words.some((w) => !ok(w))) return null;
  if (!words.some((w) => w === 'name' || w === 'surname' || w === 'family')) return null;
  return {
    first: words.some((w) => w === 'first' || w === 'given'),
    last: words.some((w) => w === 'last' || w === 'surname' || w === 'family'),
  };
}

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

  const child = plainChildField(label);
  if (child) return child;

  if (name === 'firstName' || name === 'lastName') {
    // An untouched system name slot: blank, or plainly "First name" / "Last name" / "Your name".
    if (!label) return name === 'lastName' ? 'parentLast' : 'parentFirst';
    const parent = plainParentName(label);
    if (!parent) return 'extra'; // relabelled into some other question ("Name of your child's school")
    if (parent.last) return 'parentLast';
    if (parent.first) return 'parentFirst';
    return name === 'firstName' ? 'parentFirst' : 'parentLast';
  }
  const parent = plainParentName(label);
  if (parent && !parent.first && !parent.last) return 'parentFull';
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

/** How BabyBrain handles one input of the vendor's Wix form, in the vendor's words —
 *  so they can see which fields are filled for the parent, which are asked on the
 *  booking page, and spot a field whose wording sends it the wrong way. */
export interface WixFormFieldHandling {
  name: string;
  label: string;
  mandatory: boolean;
  /** `filled`: BabyBrain answers it from the account / child profile. `asked`: the parent
   *  answers it on the booking page. `guests`: covered by the guests chosen on the booking page. */
  handling: 'filled' | 'asked' | 'guests';
  note: string;
  options?: string[];
  multi?: boolean;
}

const FILLED_NOTE: Record<Exclude<WixFormFieldKind, 'extra'>, string> = {
  email: 'Filled in from the parent’s account email.',
  phone: 'Filled in from the phone number on the parent’s profile. A parent with no number is asked to add one before booking.',
  childName: 'Filled in with the child’s name from their BabyBrain profile.',
  childAge: 'Filled in with the child’s age from their BabyBrain profile (for example “3 years”).',
  childNameAndAge: 'Filled in with the child’s name and age from their BabyBrain profile.',
  parentFirst: 'Filled in with the parent’s first name.',
  parentLast: 'Filled in with the parent’s last name.',
  parentFull: 'Filled in with the parent’s full name.',
};

/** One row per input of the event's Wix form, saying how a booking answers it. Mirrors
 *  {@link buildWixEventGuestForm} and {@link questionsForParent} — keep them in step. */
export function describeWixFormHandling(inputs: WixEventFormInput[]): WixFormFieldHandling[] {
  return inputs.map((i) => {
    const base = { name: i.name, label: i.label || i.name, mandatory: i.mandatory };
    if (i.controlType === 'GUEST_CONTROL') {
      return { ...base, handling: 'guests' as const, note: 'Covered by the number of people a parent books for on the booking page.' };
    }
    const kind = classifyWixFormInput(i);
    if (kind !== 'extra') return { ...base, handling: 'filled' as const, note: FILLED_NOTE[kind] };
    const choice = i.options?.length ? (i.multi ? ' They can tick several of your options.' : ' They pick one of your options.') : '';
    return {
      ...base,
      handling: 'asked' as const,
      note: `${i.mandatory ? 'Parents must answer this on the booking page.' : 'Parents are asked this on the booking page (optional).'}${choice}`,
      options: i.options,
      multi: i.multi,
    };
  });
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

/** The 422 body for answers that don't fit the event's live form. It carries the live questions: the
 *  booking page shows a copy refreshed every few minutes, so when the vendor has just added a question
 *  (or changed a dropdown's options) the page would otherwise tell the parent to answer something it
 *  has no box for. With these it redraws the form and the parent can carry on. */
export function wixFormProblemBody(inputs: WixEventFormInput[], problems: WixAnswerProblem[]) {
  return {
    error: describeWixAnswerProblems(problems),
    fields: problems.map((p) => p.name),
    questions: questionsForParent(inputs),
  };
}

/** A question's wording reduced to what identifies it: "Does your child have any allergies?" and
 *  "does your child have any allergies" are the same question. */
export function questionLabelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** What a parent answered on an earlier booking: their answers (by that event's Wix input names) and
 *  that event's questions, which say what each input name was asking. */
export interface PastFormAnswers {
  answers: unknown;
  questions: Pick<WixEventFormInput, 'name' | 'label'>[];
}

const BIRTH_DATE = /\b(birth|birthday|dob|born)\b/i;

/** Answers to carry over from earlier bookings for the same child, to prefill this event's questions.
 *  Wix input names differ from one event's form to the next, so a question is matched by its wording.
 *  Only things that stay true from event to event: a typed answer to the same question (allergies, a
 *  school, an emergency contact, a date of birth). Dropdown / checkbox / radio choices are specific to
 *  one event (which day, which add-on), and a date picked for one event is not another's — never carried
 *  over. `history` is newest first; the newest answer wins. */
export function rememberedAnswers(current: WixEventFormInput[], history: PastFormAnswers[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questionsForParent(current)) {
    if (q.options?.length || q.multi) continue;
    const isDate = q.inputType === 'DATE' || q.controlType === 'DATE';
    if (isDate && !BIRTH_DATE.test(q.label)) continue;
    const key = questionLabelKey(q.label || '');
    if (!key) continue;
    for (const past of history) {
      const given = past.answers && typeof past.answers === 'object' ? (past.answers as Record<string, unknown>) : {};
      const asked = past.questions.find((p) => questionLabelKey(p.label || '') === key);
      const value = asked ? given[asked.name] : undefined;
      if (typeof value === 'string' && value.trim()) {
        out[q.name] = value.trim().slice(0, MAX_ANSWER_LENGTH);
        break;
      }
    }
  }
  return out;
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
