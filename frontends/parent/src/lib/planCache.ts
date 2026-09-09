/** Last-known parent plan, held both in memory (for the tab) and in
 *  localStorage (across hard refreshes), so a returning parent renders their
 *  real plan on the first paint instead of assuming `free` for the few seconds
 *  the Stripe subscription lookup takes — it sits downstream of the whole auth
 *  cold-start. `usePlan` in lib/data owns the fetch; this module is just the
 *  cache, kept separate so non-hook code (e.g. sign-out) can clear it without
 *  pulling in the hook.
 *
 *  Bound to a user id. The value is only ever returned for the account it was
 *  written under, so a different parent signing in on the same browser can
 *  never render the previous parent's plan — not even for the one frame before
 *  the revalidation fetch resolves, and not if `clearPlanCache()` failed to run
 *  on the way out (its storage write can throw and is swallowed). This mirrors
 *  the vendor portal's `lib/providerCache.ts`, which is keyed the same way.
 *  Also aged out after a day so a long-stale value isn't trusted. */

export type Plan = "free" | "plus";

export interface PlanCacheEntry {
  plan: Plan;
  at: number;
}

interface Stored extends PlanCacheEntry {
  userId: string;
}

const STORAGE_KEY = "bb:parent-plan";
const MAX_AGE_MS = 24 * 60 * 60_000;

let cache: Stored | null = readStorage();

function readStorage(): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { plan?: unknown; at?: unknown; userId?: unknown };
    if (
      (parsed.plan === "free" || parsed.plan === "plus") &&
      typeof parsed.at === "number" &&
      typeof parsed.userId === "string"
    ) {
      return { plan: parsed.plan, at: parsed.at, userId: parsed.userId };
    }
  } catch {
    /* storage blocked or value corrupt — fall through to a fresh fetch */
  }
  return null;
}

/** The cached plan for `userId`, or null if absent / for another account /
 *  older than a day / storage unavailable. */
export function getPlanCache(userId: string | undefined): PlanCacheEntry | null {
  if (!userId) return null;
  // Re-read storage if the in-memory copy is missing or for a different user —
  // another tab may have written it under this account since page load.
  if (!cache || cache.userId !== userId) cache = readStorage();
  if (!cache || cache.userId !== userId) return null;
  if (Date.now() - cache.at > MAX_AGE_MS) return null;
  return { plan: cache.plan, at: cache.at };
}

/** Record an authoritative plan value for `userId` in memory and localStorage. */
export function setPlanCache(userId: string | undefined, plan: Plan): PlanCacheEntry {
  const entry: PlanCacheEntry = { plan, at: Date.now() };
  if (!userId) return entry; // nothing to key it to — don't persist a loose value
  cache = { ...entry, userId };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* non-fatal: we just lose the fast path on the next hard refresh */
  }
  return entry;
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
