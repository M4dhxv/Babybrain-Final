import type { FormAnswers } from "./eventForm";

/**
 * What a parent has filled in on the booking page, held across the login hop.
 *
 * Pressing Pay while logged out sends the parent to /login and back (see
 * loginHref in BookingPage). The slot and party size ride in the URL, but
 * everything they typed lived only in component state and came back blank.
 *
 * sessionStorage, not the URL: a medical note has no business in a query
 * string or the browser history. One-shot (the page clears it once read) and
 * short-lived, so it never resurfaces on a later, unrelated visit.
 */
export type BookingDraft = {
  slug: string;
  at: number;
  guestNames: string[];
  medicalNote: string;
  infoResponse: string;
  acceptedPolicies: string[];
  payWith: string;
  pickedDays: string[];
  /** The Wix event the ticket type and answers belong to (each date of a series is its own event). */
  eventId: string | null;
  ticketTypeId: string | null;
  formAnswers: FormAnswers;
};

const KEY = "bb:booking-draft";
const MAX_AGE_MS = 30 * 60 * 1000;

export function saveBookingDraft(draft: Omit<BookingDraft, "at">): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...draft, at: Date.now() }));
  } catch {
    // Storage full or disabled (private browsing) — the parent retypes, as before.
  }
}

/** The draft for this activity, if a fresh one is waiting. Pure read: call clearBookingDraft once it is in state. */
export function readBookingDraft(slug: string | null): BookingDraft | null {
  if (!slug) return null;
  try {
    const d = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as BookingDraft | null;
    if (!d || d.slug !== slug || Date.now() - d.at > MAX_AGE_MS) return null;
    return d;
  } catch {
    return null;
  }
}

export function clearBookingDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
