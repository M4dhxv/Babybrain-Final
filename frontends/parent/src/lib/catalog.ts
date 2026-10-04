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

export async function catalogRpc(
  fn: CatalogFn,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ data: unknown[] | null; error: unknown }> {
  try {
    const res = await fetch(`${API_BASE}/api/explore/${fn}?a=${encodeURIComponent(canonical(args))}`, { signal });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return { data, error: null };
      // 200 with something else (a dev server's HTML shell): not our endpoint.
    } else if (res.status === 502) {
      const body = await res.json().catch(() => null);
      if (body?.upstream) return { data: null, error: new Error("Catalogue unavailable") };
    } else if (res.status === 400) {
      // We sent something the endpoint rejects; the SQL function may still
      // accept it, so fall through rather than fail the parent's search.
    }
  } catch (e) {
    if (signal.aborted) return { data: null, error: e };
    // network error or unparsable body: fall back below
  }
  const { data, error } = await supabase.rpc(fn, args as never).abortSignal(signal);
  return { data: (data as unknown[] | null) ?? null, error };
}
