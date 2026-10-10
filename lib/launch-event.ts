/**
 * Launch-event registration: input validation shared by the public registration route
 * (/api/events/launch/register) and the admin "add by hand" route. The capacity decision
 * itself lives in the database (register_for_event, migration 00231) so it is atomic.
 */

export const LAUNCH_EVENT_SLUG = 'launch-2026';

/** The ages the form offers: under 1, then 1-9. */
export const CHILD_AGES = ['<1', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export const MAX_CHILDREN = 3;

export type ChildInput = { name: string; age: (typeof CHILD_AGES)[number] };

export type RegistrationInput = {
  slot: string;
  name: string;
  email: string | null;
  phone: string;
  /** The registrant first, then an optional second adult. */
  adultNames: string[];
  children: ChildInput[];
  notes: string | null;
};

type Parsed = { ok: true; value: RegistrationInput } | { ok: false; error: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Singapore number -> "+65 XXXX XXXX" (6 = landline, 8/9 = mobile). Null when it isn't one. */
export function normaliseSgPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let d = raw.replace(/\D/g, '');
  if (d.length > 8 && d.startsWith('65')) d = d.slice(2);
  if (!/^[689]\d{7}$/.test(d)) return null;
  return `+65 ${d.slice(0, 4)} ${d.slice(4)}`;
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= max ? t : null;
};

/**
 * Validate a registration body.
 *   mode 'public' - what a parent sends: email and accepted terms are mandatory.
 *   mode 'admin'  - an entry added by hand: email optional, no terms tick.
 */
export function parseRegistration(body: unknown, mode: 'public' | 'admin'): Parsed {
  const b = (body ?? {}) as Record<string, unknown>;

  const name = clean(b.name, 80);
  if (!name) return { ok: false, error: 'Please enter a name.' };

  let email: string | null = null;
  if (typeof b.email === 'string' && b.email.trim() !== '') {
    email = b.email.trim().toLowerCase();
    if (email.length > 160 || !EMAIL.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
  } else if (mode === 'public') {
    return { ok: false, error: 'Please enter a valid email address.' };
  }

  const phone = normaliseSgPhone(b.phone);
  if (!phone) return { ok: false, error: 'Please enter a Singapore number: 8 digits starting with 6, 8 or 9.' };

  if (typeof b.slot !== 'string' || !/^[0-9a-z-]{1,40}$/i.test(b.slot)) return { ok: false, error: 'Please pick a time.' };

  if (mode === 'public' && b.termsAccepted !== true) {
    return { ok: false, error: 'Please accept the Terms and Conditions to continue.' };
  }

  const adultNames = [name];
  if (b.secondAdult != null && b.secondAdult !== '') {
    const second = clean(b.secondAdult, 80);
    if (!second) return { ok: false, error: "Please enter the second adult's name, or leave it out." };
    adultNames.push(second);
  }

  if (!Array.isArray(b.children) || b.children.length < 1) {
    return { ok: false, error: 'Please add at least one child.' };
  }
  if (b.children.length > MAX_CHILDREN) return { ok: false, error: `You can register up to ${MAX_CHILDREN} children.` };
  const children: ChildInput[] = [];
  for (const c of b.children as Array<Record<string, unknown>>) {
    const cn = clean(c?.name, 60);
    const age = typeof c?.age === 'string' && (CHILD_AGES as readonly string[]).includes(c.age) ? (c.age as ChildInput['age']) : null;
    if (!cn || !age) return { ok: false, error: "Please enter each child's name and age." };
    children.push({ name: cn, age });
  }

  const notes = mode === 'admin' ? clean(b.notes, 500) : null;
  return { ok: true, value: { slot: b.slot, name, email, phone, adultNames, children, notes } };
}

/** What the register_for_event RPC returns. */
export type RegisterResult = {
  status: 'confirmed' | 'waitlisted' | 'cancelled';
  id: string;
  duplicate: boolean;
  party_size: number;
  slot_key: string;
  seats_left?: number;
  over_capacity?: boolean;
};

/** The wording shown to a registrant once they are on the waitlist. */
export const WAITLIST_HEADING = 'You are on the waitlist!';
export const WAITLIST_MESSAGE = 'We will notify you if a spot becomes available';
