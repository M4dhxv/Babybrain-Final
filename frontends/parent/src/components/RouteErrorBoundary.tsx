import { Component, type ReactNode } from "react";

/* Wraps the routed page. Without it, any error thrown while rendering a route —
 * including a lazy-route chunk that fails to download — unwinds past React 18
 * and leaves #root empty, i.e. a blank/black screen with no way back but a
 * manual reload. QA hit exactly that clicking Profile from the header.
 *
 * A failed chunk is almost always a stale build: this tab's index.html was
 * served before a redeploy and the hashed filenames it points at no longer
 * exist. One reload pulls the fresh index and its chunks, so we do that
 * automatically — once, guarded, so a genuinely broken build can't loop. Any
 * other error renders a real "reload / go home" panel instead of nothing. */

const CHUNK_RE =
  /Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed|error loading dynamically imported module|failed to fetch dynamically imported module|Unable to preload/i;

function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  return e.name === "ChunkLoadError" || CHUNK_RE.test(e.message ?? "");
}

const RELOAD_GUARD = "bb-route-chunk-reload";

function clearGuard() {
  try {
    sessionStorage.removeItem(RELOAD_GUARD);
  } catch {
    /* private mode / storage disabled */
  }
}

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidMount() {
    // Reached a route without throwing — clear the one-shot reload guard so a
    // future stale-chunk failure is allowed its own auto-reload.
    if (!this.state.error) clearGuard();
  }

  componentDidUpdate(_prev: Props, prevState: State) {
    if (prevState.error && !this.state.error) clearGuard();
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error)) {
      let already = "0";
      try {
        already = sessionStorage.getItem(RELOAD_GUARD) ?? "0";
      } catch {
        /* ignore */
      }
      if (already !== "1") {
        try {
          sessionStorage.setItem(RELOAD_GUARD, "1");
        } catch {
          /* ignore */
        }
        window.location.reload();
        return;
      }
    }
    console.error("Route render error:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A stale-chunk reload is already in flight — don't flash the panel.
    if (isChunkLoadError(error)) return null;

    return (
      <main className="mx-auto max-w-[560px] px-6 py-20 text-center">
        <p className="text-lg font-black text-[#4a5680]">This page didn&rsquo;t load</p>
        <p className="mt-2 text-sm font-semibold text-[#68718f]">
          Something went wrong showing this page. Reloading usually fixes it.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={() => window.location.reload()}
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
