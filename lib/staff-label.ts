/** Placeholder text a vendor may have typed into the teacher / studio fields
 *  (00042 invited "N/A" for classes with neither). It means "nothing to show",
 *  so it is dropped rather than printed. */
const PLACEHOLDER = /^(n\/?a|not applicable|none|nil|-+|–+|—+)$/i;

/** "Ms Tan · Studio 2", skipping blank or placeholder parts. "" when nothing
 *  is left, so the caller can hide the whole row. */
export function staffLabel(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p && !PLACEHOLDER.test(p))
    .join(" · ");
}
