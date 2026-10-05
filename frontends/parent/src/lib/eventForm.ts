/**
 * Pure helpers for the Wix event questions on the booking page. No imports, so scripts/validate-wix-events-logic.mts
 * can run them without a browser.
 */
export type FormAnswers = Record<string, string | string[]>;

/** Keeps the answers that still fit a (freshly fetched) list of questions: the question is still on the form
 *  and any dropdown / radio / checkbox value is still one of its options. A value the form no longer allows
 *  would show as blank in its dropdown while still being sent, and be refused every time. */
export function pruneAnswers(questions: { name: string; options?: string[] }[], answers: FormAnswers): FormAnswers {
  const out: FormAnswers = {};
  for (const q of questions) {
    const a = answers[q.name];
    if (a == null) continue;
    const values = Array.isArray(a) ? a : [a];
    if (q.options?.length && values.some((v) => !q.options!.includes(v))) continue;
    out[q.name] = a;
  }
  return out;
}
