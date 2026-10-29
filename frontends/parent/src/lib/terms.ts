import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { PreviewSlot } from "./termsPreview";

/**
 * Published terms for one activity (migration 00243), as the parent booking
 * page and activity page need them.
 *
 * A published term's sessions are ordinary activity_sessions rows tagged with
 * term_slot_id (publish_term). They can only be booked through
 * enrol_in_term() / book_term_class() or a package credit, so the ordinary
 * single-session flow must leave them out (`termSessionIds`).
 */

// The term tables are newer than the generated Database types.
const db = supabase as unknown as SupabaseClient;

export type LiveSlot = PreviewSlot & {
  id: string;
  /** Parallel to `dates`: the session row for each date. */
  sessionIds: string[];
  /** This slot's full-term price in dollars (its own, else the term's). */
  price: number;
  singleCap: number | null;
};

export type LiveTerm = {
  id: string;
  name: string;
  price: number;
  allowMidTerm: boolean;
  minLeft: number;
  reduce: boolean;
  reduceBy: number;
  allowSingles: boolean;
  singlePrice: number;
  allowTrial: boolean;
  trialPrice: number;
  trialLimit: number;
  allowPackages: boolean;
  /** Off the 2nd and later child a parent enrols (00244). */
  siblingDiscountPct: number;
  slots: LiveSlot[];
};

type SlotRow = {
  id: string;
  position: number;
  capacity: number;
  single_cap: number | null;
  price_cents: number | null;
  pattern: { days?: number[]; time?: string; perDay?: boolean; dayTimes?: Record<string, { time: string }> };
  provider_locations: { name: string } | null;
};

type TermRow = {
  id: string;
  name: string;
  price_cents: number;
  allow_mid_term: boolean;
  min_left: number;
  reduce_enabled: boolean;
  reduce_by_cents: number;
  allow_singles: boolean;
  single_price_cents: number;
  allow_trial: boolean;
  trial_price_cents: number;
  trial_limit: number;
  allow_packages: boolean;
  sibling_discount_pct?: number | null;
  created_at: string;
  term_slots: SlotRow[];
};

type SessionRow = { id: string; starts_at: string; term_slot_id: string };

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hhmm: string | undefined) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Saturdays, 9:00 am", or "Mondays 4:00 pm & Wednesdays 5:00 pm". */
function slotLabel(p: SlotRow["pattern"]): string {
  const days = [...(p.days ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (p.perDay) {
    return days.map((d) => `${DAY[d]}s ${clock(p.dayTimes?.[String(d)]?.time ?? p.time)}`).join(" & ");
  }
  return `${days.map((d) => `${DAY[d]}s`).join(" & ")}, ${clock(p.time)}`;
}

const dollars = (cents: number) => cents / 100;

/** Published terms with at least one session still to come, newest first.
 *  `spotsLeft` comes from the page's own upcoming-sessions read (which already
 *  subtracts bookings), keyed by session id. */
export function useActivityTerms(
  activityId: string | null,
  enabled: boolean,
  spotsBySession: Map<string, number | null>,
): { terms: LiveTerm[]; termSessionIds: Set<string>; loading: boolean } {
  const [rows, setRows] = useState<{ terms: TermRow[]; sessions: SessionRow[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !activityId) { setRows(null); return; }
    let stale = false;
    setLoading(true);
    (async () => {
      const { data: terms, error } = await db
        .from("terms")
        .select("*, term_slots(*, provider_locations(name))")
        .eq("activity_id", activityId)
        .eq("status", "published");
      if (stale) return;
      if (error || !terms?.length) { setRows({ terms: [], sessions: [] }); setLoading(false); return; }
      const slotIds = (terms as TermRow[]).flatMap((t) => t.term_slots.map((s) => s.id));
      const { data: sessions } = slotIds.length
        ? await db
            .from("activity_sessions")
            .select("id, starts_at, term_slot_id")
            .in("term_slot_id", slotIds)
            .neq("status", "cancelled")
            .order("starts_at")
        : { data: [] };
      if (stale) return;
      setRows({ terms: terms as TermRow[], sessions: (sessions ?? []) as SessionRow[] });
      setLoading(false);
    })();
    return () => { stale = true; };
  }, [activityId, enabled]);

  const derived = useMemo(() => (rows ? derive(rows, spotsBySession) : EMPTY), [rows, spotsBySession]);
  return { ...derived, loading };
}

const EMPTY = { terms: [] as LiveTerm[], termSessionIds: new Set<string>() };

function derive(rows: { terms: TermRow[]; sessions: SessionRow[] }, spotsBySession: Map<string, number | null>) {
  const bySlot = new Map<string, SessionRow[]>();
  for (const s of rows.sessions) bySlot.set(s.term_slot_id, [...(bySlot.get(s.term_slot_id) ?? []), s]);
  const now = Date.now();
  const terms: LiveTerm[] = rows.terms
    .map((t) => ({
      id: t.id,
      name: t.name,
      price: dollars(t.price_cents),
      allowMidTerm: t.allow_mid_term,
      minLeft: t.min_left,
      reduce: t.reduce_enabled,
      reduceBy: dollars(t.reduce_by_cents),
      allowSingles: t.allow_singles,
      singlePrice: dollars(t.single_price_cents),
      allowTrial: t.allow_trial,
      trialPrice: dollars(t.trial_price_cents),
      trialLimit: t.trial_limit,
      allowPackages: t.allow_packages,
      siblingDiscountPct: t.sibling_discount_pct ?? 0,
      created_at: t.created_at,
      slots: [...t.term_slots]
        .sort((a, b) => a.position - b.position)
        .map((s): LiveSlot => {
          const list = bySlot.get(s.id) ?? [];
          // A term place is a seat on every session still to come, so the
          // fullest of them decides (term_slot_free_places, 00260). 0 = full:
          // the booking page offers the slot's waitlist instead.
          const upcomingSpots = list
            .filter((x) => Date.parse(x.starts_at) > now)
            .map((x) => spotsBySession.get(x.id))
            .filter((v): v is number => v != null);
          return {
            key: s.id,
            id: s.id,
            label: slotLabel(s.pattern),
            venue: s.provider_locations?.name ?? null,
            dates: list.map((x) => x.starts_at),
            sessionIds: list.map((x) => x.id),
            capacity: s.capacity,
            spotsLeft: upcomingSpots.length ? Math.max(0, Math.min(...upcomingSpots)) : null,
            price: dollars(s.price_cents ?? t.price_cents),
            singleCap: s.single_cap,
          };
        })
        .filter((s) => s.dates.some((d) => Date.parse(d) > now)),
    }))
    .filter((t) => t.slots.length > 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(({ created_at: _created, ...t }) => t);

  return { terms, termSessionIds: new Set(rows.sessions.map((s) => s.id)) };
}

export type LiveQuote = {
  slot: LiveSlot;
  n: number;
  fullPrice: number;
  /** Taken off for each session already run; null when the term has no reduction. */
  perClass: number | null;
  singlesTotal: number | null;
  savings: number | null;
  /** Most sessions that may have run for a family to still join. */
  lastJoin: number;
  run: number;
  left: number;
  payNow: number;
  joining: string[];
  joinable: boolean;
  reason: string | null;
};

/** What a family would pay for this slot right now. Mirrors term_quote() in
 *  00243 (which /api/terms/checkout charges from): a session counts as run once
 *  its booking window has closed. */
export function liveQuote(term: LiveTerm, slot: LiveSlot, cutoffMinutes: number | null): LiveQuote {
  const closeBy = Date.now() + (cutoffMinutes ?? 15) * 60_000;
  const n = slot.dates.length;
  const run = slot.dates.filter((d) => Date.parse(d) <= closeBy).length;
  const left = n - run;
  const fullPrice = slot.price;
  const payNow = term.reduce ? Math.max(0, fullPrice - term.reduceBy * run) : fullPrice;
  const singlesTotal = term.allowSingles ? term.singlePrice * n : null;
  let reason: string | null = null;
  if (left === 0) reason = "This term has finished.";
  else if (run > 0 && !term.allowMidTerm) reason = "This term has started and is closed to new joiners.";
  else if (run > 0 && left < term.minLeft) reason = `This term is closed to new joiners with only ${left} sessions left.`;
  return {
    slot,
    n,
    fullPrice,
    perClass: term.reduce ? term.reduceBy : null,
    singlesTotal,
    savings: singlesTotal != null && singlesTotal > fullPrice ? singlesTotal - fullPrice : null,
    lastJoin: term.allowMidTerm ? Math.max(0, n - term.minLeft) : 0,
    run,
    left,
    payNow,
    joining: slot.dates.slice(run),
    joinable: reason == null,
    reason,
  };
}

/** How many trial sessions this child still has with the vendor (00243). */
export function useTrialRemaining(activityId: string | null, childId: string | null, enabled: boolean, signedIn: boolean) {
  const [state, setState] = useState<{ used: number; limit: number } | null>(null);
  useEffect(() => {
    if (!enabled || !activityId || !signedIn) { setState(null); return; }
    let stale = false;
    db.rpc("term_trial_remaining", { p_activity_id: activityId, p_child_id: childId })
      .single()
      .then(({ data }) => {
        if (stale || !data) return;
        const d = data as { used: number; trial_limit: number };
        setState({ used: d.used, limit: d.trial_limit });
      });
    return () => { stale = true; };
  }, [activityId, childId, enabled, signedIn]);
  return state;
}

export { db as termsDb };
