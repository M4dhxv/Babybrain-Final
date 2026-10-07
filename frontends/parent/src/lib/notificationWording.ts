/**
 * Parents see "session", not "class". The notification rows the database
 * writes (and the title the push + email fallback reuse) still carry the older
 * "class" wording, so this rewrites them on the way out — old rows included.
 *
 * Titles are fixed strings, matched exactly. Bodies embed the activity's own
 * name ("Baby Music Class"), which must never change, so only the generic
 * fallback phrases the triggers write around it are rewritten.
 */
const TITLES: Record<string, string> = {
  'Class reminder ⏰': 'Session reminder ⏰',
  'Class details changed': 'Session details changed',
  'How was the class? ⭐': 'How was the session? ⭐',
  'Unfortunately your class has been cancelled': 'Unfortunately your session has been cancelled',
};

const BODY_PHRASES: [RegExp, string][] = [
  [/^A class has been /, 'A session has been '],
  [/^Unfortunately your class has been cancelled/, 'Unfortunately your session has been cancelled'],
  [/\bfor a class( |\.|$)/g, 'for a session$1'],
  [/\bon a class you joined\b/g, 'on a session you joined'],
  [/ provider class\. /g, ' provider session. '],
  [/ the class it was booked on\b/g, ' the session it was booked on'],
];

export function sessionWordingTitle(title: string): string {
  return TITLES[title] ?? title;
}

export function sessionWordingBody<T extends string | null | undefined>(body: T): T {
  if (!body) return body;
  return BODY_PHRASES.reduce((s, [re, to]) => s.replace(re, to), body as string) as T;
}
