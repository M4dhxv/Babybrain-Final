/** Shared sign-up / edit-profile validation.
 *
 *  All of these came out of the founder QA round: passwords were unrestricted,
 *  non-Singapore postcodes were accepted, and a child's date of birth could be
 *  in the future or decades in the past.
 */

/** BabyBrain covers children up to 12. A rolling window rather than a fixed
 *  date, so the cut-off doesn't drift out of date as the years pass. */
export const MAX_CHILD_AGE_YEARS = 12;
export const todayIso = () => new Date().toISOString().slice(0, 10);

export function minChildDob(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - MAX_CHILD_AGE_YEARS);
  return d.toISOString().slice(0, 10);
}

export const PASSWORD_RULES: { label: string; missing: string; test: (pw: string) => boolean }[] = [
  { label: "At least 10 characters", missing: "at least 10 characters", test: (pw) => pw.length >= 10 },
  { label: "One capital letter", missing: "a capital letter", test: (pw) => /[A-Z]/.test(pw) },
  { label: "One number", missing: "a number", test: (pw) => /\d/.test(pw) },
  { label: "One symbol", missing: "a symbol", test: (pw) => /[^A-Za-z0-9]/.test(pw) },
];

export function passwordError(pw: string): string | null {
  const missing = PASSWORD_RULES.filter((r) => !r.test(pw)).map((r) => r.missing);
  if (!missing.length) return null;
  return `Your password needs ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}.`;
}

/** Singapore postcodes are six digits, and sectors 74 and 84–99 are unused. */
export function postcodeError(code: string): string | null {
  const value = code.trim();
  if (!/^\d{6}$/.test(value)) return "Enter a 6-digit Singapore postcode.";
  const sector = Number(value.slice(0, 2));
  if (sector === 0 || sector === 74 || sector > 82) {
    return "That doesn't look like a Singapore postcode.";
  }
  return null;
}

/** QA: entering a future or long-past date reported "enter a date of birth as
 *  DD/MM/YYYY", which reads as though the format were wrong. The field now
 *  hands us any real calendar date, so each problem gets its own message. */
export function dobError(iso: string): string | null {
  if (!iso) return "Enter a date of birth as DD/MM/YYYY.";
  if (iso > todayIso()) return "Date of birth needs to be in the past.";
  if (iso < minChildDob()) {
    return `Date of birth needs to be in the last ${MAX_CHILD_AGE_YEARS} years.`;
  }
  return null;
}

export const emailError = (email: string) =>
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) ? null : "Enter a valid email address.";
