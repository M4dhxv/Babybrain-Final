import { useSyncExternalStore } from "react";
import { supabase } from "./supabase";
import { termsPreviewEnabled } from "./termsPreview";

/**
 * The one price a card or an activity page leads with when the vendor offers
 * terms (migration 00243, term_headline_prices):
 *
 *   1. the trial session price, if a term has a trial session;
 *   2. else the single-session price, if a term sells single sessions;
 *   3. else the lowest term price the vendor is showing.
 *
 * Fetched in small batches, once per activity, and only while the terms preview
 * flag is on. Cards ask for their own id; ids asked for in the same moment go
 * out as one request, so a page of results costs one extra small query and the
 * Explore data path itself is untouched.
 */

export type TermHeadline = { kind: "trial" | "single" | "term"; price: number };

const TTL_MS = 5 * 60_000;
const BATCH_MS = 60;
const MAX_BATCH = 100;

type Entry = { at: number; value: TermHeadline | null };
const entries = new Map<string, Entry>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;

const bump = () => {
  version++;
  listeners.forEach((l) => l());
};

async function flush() {
  timer = null;
  const ids = [...asked].slice(0, MAX_BATCH);
  ids.forEach((i) => asked.delete(i));
  if (ids.length === 0) return;
  try {
    const rpc = (supabase as unknown as {
      rpc: (fn: string, args: object) => Promise<{ data: unknown; error: { message: string } | null }>;
    }).rpc;
    const { data, error } = await rpc.call(supabase, "term_headline_prices", { p_activity_ids: ids });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { activity_id: string; kind: TermHeadline["kind"]; price_cents: number }[];
    const byId = new Map(rows.map((r) => [r.activity_id, { kind: r.kind, price: Number(r.price_cents) / 100 }]));
    const now = Date.now();
    for (const id of ids) entries.set(id, { at: now, value: byId.get(id) ?? null });
  } catch {
    // Best effort: show the ordinary price rather than nothing. Try again later.
    const now = Date.now() - TTL_MS + 30_000;
    for (const id of ids) entries.set(id, { at: now, value: null });
  }
  bump();
  if (asked.size > 0) timer = setTimeout(flush, BATCH_MS);
}

function request(id: string) {
  const e = entries.get(id);
  if (e && Date.now() - e.at < TTL_MS) return;
  asked.add(id);
  if (!timer) timer = setTimeout(flush, BATCH_MS);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => version;

const ENABLED = termsPreviewEnabled();

/** The activity's headline term price, or null when it has none (or while it is
 *  still being looked up). Always null when the terms flag is off. */
export function useTermHeadline(activityId: string | undefined | null): TermHeadline | null {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!ENABLED || !activityId) return null;
  request(activityId);
  return entries.get(activityId)?.value ?? null;
}

const money = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

/** The card's price line. */
export function termHeadlineLabel(h: TermHeadline): string {
  return h.kind === "trial" ? `Trial session ${money(h.price)}` : h.kind === "single" ? `Single session ${money(h.price)}` : `Term from ${money(h.price)}`;
}

/** The activity page's big price and the words after it. */
export function termHeadlineParts(h: TermHeadline): { prefix: string; amount: string; unit: string } {
  return {
    prefix: h.kind === "term" ? "From " : "",
    amount: money(h.price),
    unit: h.kind === "trial" ? "trial session" : h.kind === "single" ? "per session" : "per term",
  };
}

/* ── packages at an activity that offers terms ──
 *
 * activity_packages_closed (00243): when none of an activity's running terms
 * accept package credits, the parent pages stop offering packs there, so nobody
 * buys credits they can't spend. Only asked while the terms flag is on; answers
 * "open" until it knows otherwise. */
const closedCache = new Map<string, { at: number; closed: boolean }>();
const closedListeners = new Set<() => void>();
let closedVersion = 0;
const closedPending = new Set<string>();

async function askClosed(id: string) {
  closedPending.add(id);
  let closed = false;
  try {
    const rpc = (supabase as unknown as {
      rpc: (fn: string, args: object) => Promise<{ data: unknown; error: { message: string } | null }>;
    }).rpc;
    const { data, error } = await rpc.call(supabase, "activity_packages_closed", { p_activity_ids: [id] });
    if (!error) closed = ((data ?? []) as { activity_id: string }[]).some((r) => r.activity_id === id);
  } catch {
    /* treat as open */
  }
  closedPending.delete(id);
  closedCache.set(id, { at: Date.now(), closed });
  closedVersion++;
  closedListeners.forEach((l) => l());
}

/** False when packs must not be offered at this activity. True otherwise. */
export function usePackagesOpen(activityId: string | undefined | null): boolean {
  useSyncExternalStore(
    (cb) => { closedListeners.add(cb); return () => closedListeners.delete(cb); },
    () => closedVersion,
    () => closedVersion,
  );
  if (!ENABLED || !activityId) return true;
  const e = closedCache.get(activityId);
  if ((!e || Date.now() - e.at > TTL_MS) && !closedPending.has(activityId)) void askClosed(activityId);
  return !(e?.closed ?? false);
}
