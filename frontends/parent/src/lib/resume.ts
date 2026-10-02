/**
 * Coming back to the app after it was backgrounded.
 *
 * An installed (or just long-open) tab that is brought forward after a while
 * can resume with its compositor layers discarded: the page is alive but the
 * WebView paints nothing — black — until something forces a repaint, which on
 * some Android builds is only the user touching the screen. Repaint on the
 * way back instead of waiting for that.
 *
 * Deliberately paint-only: no reload, no navigation, no state reset. The live
 * app, its scroll position and any form the parent was filling in are left
 * exactly as they were.
 */
const MIN_HIDDEN_MS = 2_000;

function kickRepaint() {
  const root = document.documentElement;
  // Promote then demote the root layer: forces a fresh composite of the whole
  // page without changing layout. Two frames so the compositor really sees both states.
  root.style.willChange = "transform";
  requestAnimationFrame(() => {
    void root.offsetHeight;
    requestAnimationFrame(() => {
      root.style.willChange = "";
    });
  });
}

export function installResumeRepaint() {
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt >= MIN_HIDDEN_MS) kickRepaint();
    hiddenAt = 0;
  });
  // Restored from the back/forward cache: no visibilitychange necessarily fires.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) kickRepaint();
  });
}
