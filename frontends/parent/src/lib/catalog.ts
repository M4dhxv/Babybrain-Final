import { supabase } from "./supabase";

/**
 * Explore's catalogue reads, routed through the edge-cached /api/explore/<fn>
 * endpoint (app/api/explore/[fn]/route.ts) instead of straight to Postgres.
 * The answer is the same for every visitor, so the edge serves it to everyone
 * and the database only sees roughly one query per distinct filter combination
 * per minute, not three per tap per parent.
 *
 * Behaviour is identical to calling the SQL function directly — same rows, same
 * counts, same order. Fallback rules:
 *  - The endpoint is unreachable or missing (a local dev server, an older
 *    deploy, a network blip to our own host): call the function directly.
 *  - The endpoint answered but said the database failed (`upstream`): do NOT
 *    call the database directly; that would double the load on the very thing
 *    that is struggling. Report the error and let the caller's retry/backoff
 *    decide.
 */
export type CatalogFn = "search_activities" | "matching_activities" | "search_activity_facets";

const API_BASE = (import.meta.env.VITE_API_BASE as string) || "";

/** Sorted keys, no nulls: the same query always produces the same URL, which
 *  is what lets the edge cache serve one parent's answer to the next. */
function canonical(args: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (v !== null && v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}

/** One short line saying what went wrong, for the on-screen "Details" and for
 *  analytics. Never contains user data: only error names, codes and statuses. */
export function describeError(e: unknown): string {
  if (!e) return "unknown";
  const o = e as { name?: string; code?: string | number; status?: number; message?: string };
  return [o.name, o.code, o.status, (o.message ?? "").replace(/\s+/g, " ").slice(0, 90)].filter(Boolean).join(" ") || "unknown";
}

/** The most recent catalogue failure, shown under the error banner so a parent
 *  can read it out and we can tell a blocked request from a slow database. */
export let lastCatalogFailure: string | null = null;

/** At most this many catalogue requests in flight from one browser. The
 *  database is small and falls over at about ten at once, so a parent's burst
 *  of taps (three queries each) queues here instead of arriving together. */
const MAX_IN_FLIGHT = 2;
let active = 0;
const waiters: Array<() => void> = [];

function acquire(signal: AbortSignal): Promise<boolean> {
  if (active < MAX_IN_FLIGHT) {
    active++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const turn = () => {
      active++;
      resolve(true);
    };
    waiters.push(turn);
    signal.addEventListener(
      "abort",
      () => {
        const i = waiters.indexOf(turn);
        if (i >= 0) {
          waiters.splice(i, 1);
          resolve(false); // gave up waiting: the query was superseded
        }
      },
      { once: true },
    );
  });
}

function release() {
  active--;
  waiters.shift()?.();
}

export async function catalogRpc(
  fn: CatalogFn,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ data: unknown[] | null; error: unknown }> {
  if (!(await acquire(signal))) return { data: null, error: new DOMException("Aborted", "AbortError") };
  try {
    return await catalogRpcNow(fn, args, signal);
  } finally {
    release();
  }
}

async function catalogRpcNow(
  fn: CatalogFn,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ data: unknown[] | null; error: unknown }> {
  let apiNote = "";
  try {
    const res = await fetch(`${API_BASE}/api/explore/${fn}?a=${encodeURIComponent(canonical(args))}`, { signal });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return { data, error: null };
      apiNote = "api returned a non-list";
      // 200 with something else (a dev server's HTML shell): not our endpoint.
    } else if (res.status === 502) {
      const body = await res.json().catch(() => null);
      if (body?.upstream) {
        lastCatalogFailure = `${fn}: api 502 (${body.detail ?? "database unavailable"})`;
        return { data: null, error: new Error("Catalogue unavailable") };
      }
      apiNote = "api 502";
    } else {
      // 400 = we sent something the endpoint rejects (the SQL function may
      // still accept it); 404 = route not deployed; others = edge trouble.
      apiNote = `api ${res.status}`;
    }
  } catch (e) {
    if (signal.aborted) {
      lastCatalogFailure = `${fn}: no answer in time (${describeError(e)})`;
      return { data: null, error: e };
    }
    apiNote = `api ${describeError(e)}`; // network error or unparsable body
  }
  const { data, error } = await supabase.rpc(fn, args as never).abortSignal(signal);
  if (error) lastCatalogFailure = `${fn}: ${apiNote ? apiNote + " -> " : ""}direct ${describeError(error)}`;
  return { data: (data as unknown[] | null) ?? null, error };
}

/** Tell analytics a load failed (best effort; a blocker may swallow it). */
export function reportCatalogFailure(where: string, error: unknown) {
  const detail = lastCatalogFailure ?? describeError(error);
  const nav = navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } };
  void import("./posthog").then((m) =>
    m.captureEvent("explore_load_failed", {
      where,
      detail,
      online: navigator.onLine,
      network: nav.connection?.effectiveType,
      save_data: nav.connection?.saveData,
      standalone: window.matchMedia?.("(display-mode: standalone)").matches,
    }),
  );
}
