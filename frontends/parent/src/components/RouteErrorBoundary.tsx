import { Component, type ReactNode } from "react";

/* Catches anything thrown while rendering — a component fault, or (far more
 * often) a lazy chunk that fails to download because this tab's index.html
 * predates a redeploy and points at hashed files that no longer exist.
 * Without it that unwinds past React 18 and leaves #root empty: a blank
 * screen with no way back but a manual reload.
 *
 * Two rules keep it reliable across every page:
 *   1. It NEVER renders blank. Worst case is a visible "Reload / go home"
 *      panel — a button the user can press always beats an empty void.
 *   2. A stale-chunk error triggers ONE automatic reload (which pulls the
 *      fresh index + chunks), rate-limited so a genuinely broken build shows
 *      the panel instead of reload-looping, and self-resetting so a fresh
 *      failure later still gets its own reload.
 *
 * Used both around the routed page (keyed by route, so navigating away clears
 * a caught error) and once at the very top in main.tsx, above the providers. */

const CHUNK_RE =
  /Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed|error loading dynamically imported module|failed to fetch dynamically imported module|Unable to preload|import\(\) failed|module script failed/i;

export function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  return e.name === "ChunkLoadError" || CHUNK_RE.test(e.message ?? "");
}

/* Reload budget, shared with the global handlers in main.tsx via sessionStorage.
 * Allow a couple of quick reloads (deploy propagation can lag a few seconds),
 * then stop and let the panel take over. The record ages out, so a failure an
 * hour later starts fresh. */
const KEY = "bb-chunk-reload";
const MAX_RELOADS = 2;
const WINDOW_MS = 60_000;

export function reloadForChunkError(): boolean {
  let n = 0;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const rec = JSON.parse(raw) as { ts: number; n: number };
      if (Date.now() - rec.ts < WINDOW_MS) n = rec.n;
    }
  } catch {
    /* storage unavailable / bad JSON — treat as first try */
  }
  if (n >= MAX_RELOADS) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), n: n + 1 }));
  } catch {
    /* ignore */
  }
  window.location.reload();
  return true;
}

/** Clears the reload budget so a later, unrelated stale-chunk failure gets its
 *  own reloads. Call only once the app is genuinely up — not merely mounted,
 *  since a nested boundary can be showing its panel while its parent mounted
 *  fine. main.tsx calls this a few seconds after load if nothing threw. */
export function clearChunkReloadBudget(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Set by the boundary when it catches, read by main.tsx's delayed clear so a
 *  loop (route throws on every mount) never resets its own rate limit. */
export function markRouteError(): void {
  (window as unknown as { __bbRouteError?: boolean }).__bbRouteError = true;
}
export function hadRouteError(): boolean {
  return (window as unknown as { __bbRouteError?: boolean }).__bbRouteError === true;
}

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  reloading: boolean;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, reloading: false };
  }

  componentDidUpdate(_prev: Props, prevState: State) {
    // Recovered from a caught error (navigated away, or a retry rendered) —
    // safe to hand the reload budget back.
    if (prevState.error && !this.state.error) clearChunkReloadBudget();
  }

  componentDidCatch(error: Error) {
    markRouteError();
    if (isChunkLoadError(error) && reloadForChunkError()) {
      // A reload is in flight — swap the panel for a calm "updating" line so
      // the sub-second flash doesn't read as a hard error.
      this.setState({ reloading: true });
      return;
    }
    console.error("Route error boundary caught:", error);
  }

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;

    if (reloading) {
      return (
        <main className="mx-auto max-w-[560px] px-6 py-24 text-center">
          <p className="text-sm font-semibold text-[#68718f]">Updating to the latest version…</p>
        </main>
      );
    }

    return (
      <main className="mx-auto max-w-[560px] px-6 py-20 text-center">
        <p className="text-lg font-black text-[#4a5680]">This page didn&rsquo;t load</p>
        <p className="mt-2 text-sm font-semibold text-[#68718f]">
          Something went wrong showing this page. Reloading usually fixes it.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={() => {
              clearChunkReloadBudget();
              window.location.reload();
            }}
            className="rounded-[10px] bg-[#FA4D8D] px-5 py-2.5 text-sm font-black text-white"
          >
            Reload
          </button>
          <a
            href="/"
            className="rounded-[10px] border border-[#EBE3E5] bg-white px-5 py-2.5 text-sm font-black text-[#4a5680]"
          >
            Go home
          </a>
        </div>
      </main>
    );
  }
}
