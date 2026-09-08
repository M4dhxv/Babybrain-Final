/**
 * Last-known subscription for the signed-in vendor, held in localStorage across
 * hard refreshes — the vendor-portal analogue of the parent app's
 * `lib/planCache.ts`.
 *
 * On a cold load the portal resolves the provider membership, THEN runs a
 * second query for its subscription tier. In the gap between those two the
 * sidebar plan card and the Pro/paid tab locks render from `subscription =
 * null`, i.e. as if every vendor were on the free tier — a visible wrong state
 * that corrects itself a beat later. Seeding `subscription` synchronously from
 * this cache removes that flash: the card and locks paint correct on the first
 * frame, and the live query still overwrites it.
 *
 * It is display state only — the real subscription query always runs, and row
 * access is enforced by Postgres RLS regardless of what this says. Keyed by
 * user id so a different account on the same browser never inherits it, and
 * aged out after a day so a long-stale value isn't trusted.
 */

import type { SubscriptionPlan } from './database.types';

export interface CachedSubscription {
  plan: SubscriptionPlan;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

interface Stored extends CachedSubscription {
  userId: string;
  at: number;
}

const STORAGE_KEY = 'bb:vendor-subscription';
const MAX_AGE_MS = 24 * 60 * 60_000;

/** The cached subscription for `userId`, or null if absent / for another
 *  account / older than a day / storage unavailable. */
export function getCachedSubscription(userId: string | undefined): CachedSubscription | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Stored>;
    if (s.userId !== userId) return null;
    if (typeof s.at !== 'number' || Date.now() - s.at > MAX_AGE_MS) return null;
    if (typeof s.plan !== 'string' || typeof s.status !== 'string') return null;
    return {
      plan: s.plan as SubscriptionPlan,
      status: s.status,
      current_period_end: s.current_period_end ?? null,
      cancel_at_period_end: !!s.cancel_at_period_end,
    };
  } catch {
    /* storage blocked or value corrupt — fall through to a fresh fetch */
    return null;
  }
}

/** Record an authoritative subscription value for `userId`. */
export function setCachedSubscription(userId: string, sub: CachedSubscription): void {
  try {
    const stored: Stored = { ...sub, userId, at: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* non-fatal: we just lose the fast path on the next hard refresh */
  }
}

/** Forget the cached subscription — called on sign-out. */
export function clearCachedSubscription(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
