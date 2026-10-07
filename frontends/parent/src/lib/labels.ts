/**
 * Gives every visible form <label> a real link to its field.
 *
 * Most of the app's forms render `<label>Email</label><input …/>` side by side,
 * with no `for`/`id` pair and no wrapping. To a screen reader the field then has
 * no name at all, and tapping the label text doesn't focus the field. This
 * watches the page and, for a bare label, finds the first field that follows it
 * (in the label's own block, or the block around it — the "Password" row nests
 * its label next to a "Forgot password?" link) and links them with a generated id.
 *
 * It never touches a label that already has `for`, wraps a field, or whose field
 * has its own name (`aria-label`); and never one that has no field after it.
 * Source-level `htmlFor` is the tidier fix for new forms — this keeps the existing
 * ones (and anything added later) from regressing.
 */
const FIELD = "input:not([type=hidden]), select, textarea";
let seq = 0;

function linkLabel(label: HTMLLabelElement) {
  if (label.htmlFor || label.control || label.querySelector(FIELD)) return;
  let scope: HTMLElement | null = label.parentElement;
  for (let depth = 0; scope && depth < 2; depth++, scope = scope.parentElement) {
    const field = Array.from(scope.querySelectorAll<HTMLElement>(FIELD)).find(
      (f) => label.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (!field) continue;
    // Checkboxes/radios carry their own text; a label that isn't theirs must not steal them.
    if (field.getAttribute("aria-label") || field.getAttribute("aria-labelledby")) return;
    if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) return;
    if (!field.id) field.id = `bb-f${++seq}`;
    if (!document.querySelector(`label[for="${field.id}"]`)) label.htmlFor = field.id;
    return;
  }
}

function scan(root: ParentNode) {
  root.querySelectorAll<HTMLLabelElement>("label").forEach(linkLabel);
}

export function installLabelLinking(): void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  let queued = false;
  const run = () => {
    queued = false;
    scan(document);
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    // Batch a render's worth of changes into one pass. A timer, not
    // requestAnimationFrame: frames don't run in a background tab.
    window.setTimeout(run, 0);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan(document);
}
