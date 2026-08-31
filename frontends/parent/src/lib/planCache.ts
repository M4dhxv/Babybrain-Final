/** Last-known parent plan, held both in memory (for the tab) and in
 *  localStorage (across hard refreshes), so a returning parent renders their
 *  real plan on the first paint instead of assuming `free` for the few seconds
 *  the Stripe subscription lookup takes — it sits downstream of the whole auth
 *  cold-start. `usePlan` in lib/data owns the fetch; this module is just the
 *  cache, kept separate so non-hook code (e.g. sign-out) can clear it without
 *  pulling in the hook.
 *
 *  This module is the single owner of the value: clearing it here drops both
 *  the in-memory copy and the persisted one, so a different account signing in
 *  on the same browser never inherits the previous parent's plan. */

export type Plan = "free" | "plus";

export interface PlanCacheEntry {
  plan: Plan;
  at: number;
}

const STORAGE_KEY = "bb:parent-plan";

function readStorage(): PlanCacheEntry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { plan?: unknown; at?: unknown };
    if ((parsed.plan === "free" || parsed.plan === "plus") && typeof parsed.at === "number") {
      return { plan: parsed.plan, at: parsed.at };
    }
  } catch {
    /* storage blocked or value corrupt — fall through to a fresh fetch */
  }
  return null;
}

let cache: PlanCacheEntry | null = readStorage();

/** The current in-memory cache entry (seeded from localStorage at load). */
export function getPlanCache(): PlanCacheEntry | null {
  return cache;
}

/** Record an authoritative plan value in both memory and localStorage. */
export function setPlanCache(plan: Plan): PlanCacheEntry {
  cache = { plan, at: Date.now() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* non-fatal: we just lose the fast path on the next hard refresh */
  }
  return cache;
}

/** Forget the plan entirely — in memory and in localStorage. */
export function clearPlanCache() {
  cache = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
