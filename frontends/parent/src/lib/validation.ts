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


/** WhatsApp numbers: the parent picks a country code (Singapore by default)
 *  and types the number without it. Stored as E.164 ("+6591234567"). */
export const WHATSAPP_COUNTRIES: { code: string; name: string; dial: string }[] = [
  { code: "SG", name: "Singapore", dial: "65" },
  { code: "MY", name: "Malaysia", dial: "60" },
  { code: "ID", name: "Indonesia", dial: "62" },
  { code: "TH", name: "Thailand", dial: "66" },
  { code: "PH", name: "Philippines", dial: "63" },
  { code: "VN", name: "Vietnam", dial: "84" },
  { code: "HK", name: "Hong Kong", dial: "852" },
  { code: "CN", name: "China", dial: "86" },
  { code: "TW", name: "Taiwan", dial: "886" },
  { code: "JP", name: "Japan", dial: "81" },
  { code: "KR", name: "South Korea", dial: "82" },
  { code: "IN", name: "India", dial: "91" },
  { code: "AE", name: "United Arab Emirates", dial: "971" },
  { code: "AU", name: "Australia", dial: "61" },
  { code: "NZ", name: "New Zealand", dial: "64" },
  { code: "GB", name: "United Kingdom", dial: "44" },
  { code: "IE", name: "Ireland", dial: "353" },
  { code: "FR", name: "France", dial: "33" },
  { code: "DE", name: "Germany", dial: "49" },
  { code: "US", name: "United States / Canada", dial: "1" },
];

export const DEFAULT_WHATSAPP_COUNTRY = "SG";

/** The digits the parent typed, minus spaces, dashes and a leading 0 or the
 *  country code they typed again. */
function nationalDigits(country: string, raw: string): string {
  const dial = WHATSAPP_COUNTRIES.find((c) => c.code === country)?.dial ?? "";
  let d = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+") && dial && d.startsWith(dial)) d = d.slice(dial.length);
  else if (d.startsWith("00" + dial)) d = d.slice(2 + dial.length);
  return d.replace(/^0+/, "");
}

export function whatsappError(country: string, raw: string): string | null {
  if (!raw.trim()) return "Please add your WhatsApp number.";
  const d = nationalDigits(country, raw);
  if (country === "SG") {
    // Singapore mobiles are 8 digits starting 8 or 9 (WhatsApp needs a mobile).
    return /^[89]\d{7}$/.test(d) ? null : "Enter an 8-digit Singapore mobile number starting with 8 or 9.";
  }
  const dial = WHATSAPP_COUNTRIES.find((c) => c.code === country)?.dial ?? "";
  if (d.length < 6 || dial.length + d.length > 15) return "That WhatsApp number doesn't look right. Check the country and the digits.";
  return null;
}

/** E.164, or "" when the number isn't valid yet. */
export function whatsappE164(country: string, raw: string): string {
  if (whatsappError(country, raw)) return "";
  const dial = WHATSAPP_COUNTRIES.find((c) => c.code === country)!.dial;
  return `+${dial}${nationalDigits(country, raw)}`;
}
