/** Shared sign-up / edit-profile validation.
 *
 *  All of these came out of the founder QA round: passwords were unrestricted,
 *  non-Singapore postcodes were accepted, and a child's date of birth could be
 *  in the future or decades in the past.
 */

/** BabyBrain covers children up to 11, so we don't accept a DOB before 2014. */
export const MIN_CHILD_DOB = "2014-01-01";
export const todayIso = () => new Date().toISOString().slice(0, 10);

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

export function dobError(iso: string): string | null {
  if (!iso) return "Enter a date of birth as DD/MM/YYYY.";
  if (iso > todayIso()) return "A date of birth can't be in the future.";
  if (iso < MIN_CHILD_DOB) {
    return "BabyBrain is for children up to 11 — please check the year.";
  }
  return null;
}

export const emailError = (email: string) =>
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) ? null : "Enter a valid email address.";
