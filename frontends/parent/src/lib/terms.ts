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
  /** The group this slot belongs to (00264). */
  groupId: string;
  /** Parallel to `dates`: the session row for each date. */
  sessionIds: string[];
  /** Parallel to `dates`: when each session ends (to tell overlapping slots apart). */
  ends: string[];
  /** This slot's full-term price in dollars (its own, else the term's). */
  price: number;
  singleCap: number | null;
  /** What this group offers (00275): its own setting, else the term's. */
  offers: { term: boolean; single: boolean; trial: boolean; package: boolean };
  /** What one single / trial session of this group costs, in dollars. */
  singlePrice: number;
  trialPrice: number;
};

export type LiveTerm = {
  id: string;
  name: string;
  price: number;
  allowMidTerm: boolean;
  minLeft: number;
  reduce: boolean;
  reduceBy: number;
  /** An early price the vendor set (00278): what the term costs until `until` (a Singapore date, YYYY-MM-DD). */
  early: { price: number; until: string } | null;
  allowSingles: boolean;
  singlePrice: number;
  allowTrial: boolean;
  trialPrice: number;
  trialLimit: number;
  allowPackages: boolean;
  /** Off the 2nd and later child a parent enrols (00244). */
  siblingDiscountPct: number;
  /** 'simple': pick one slot. 'flexible': pick one slot from each group (00264). */
  slotMode: "simple" | "flexible";
  groups: { id: string; name: string }[];
  slots: LiveSlot[];
  /** What the vendor decided about leaving before the term starts (00274). */
  withdraw: WithdrawPolicy;
  /** Some group can be enrolled in for the whole term (a Flexible term needs one in every group). */
  termOffered: boolean;
};

/** `set` false = the vendor has not chosen (an older term): the activity's own cancellation rules apply. */
export type WithdrawPolicy = {
  set: boolean;
  allowed: boolean;
  mode: "money" | "credit" | "none" | null;
  creditDays: number;
};

/**
 * What a parent is told beside the booking button about leaving a term. `tone` 'none' is the
 * no-refund disclaimer, which the page shows more firmly. Null when the vendor has not set a policy.
 * `startLabel` is the first session's date ("Sat, 24 Oct"), the last day a withdrawal is possible.
 */
export function withdrawalNotice(
  p: WithdrawPolicy,
  startLabel: string | null,
  providerName: string | null
): { tone: "info" | "none"; title: string; text: string } | null {
  if (!p.set) return null;
  const who = providerName || "the provider";
  const until = startLabel ? ` until the term starts on ${startLabel}` : " until the term starts";
  if (!p.allowed) {
    return {
      tone: "none",
      title: "No withdrawals, no refund",
      text: `You can't withdraw from this term online, and payment for it is non-refundable. If something changes, contact ${who}.`,
    };
  }
  if (p.mode === "none") {
    return {
      tone: "none",
      title: "No refund",
      text: `You can withdraw${until}, but payment for this term is non-refundable: you won't get money or credit back.`,
    };
  }
  if (p.mode === "credit") {
    return {
      tone: "info",
      title: "Withdrawing",
      text: `You can withdraw${until}. You'll get a credit for what you paid, to use on another term with ${who}, valid for ${p.creditDays} days. It isn't paid back to your card.`,
    };
  }
  return {
    tone: "info",
    title: "Withdrawing",
    text: `You can withdraw${until}. You'll get back what you paid less the payment-processing fee Stripe keeps. Refunds are processed by hand, so allow some time.`,
  };
}

type SlotRow = {
  id: string;
  group_id: string | null;
  position: number;
  capacity: number;
  single_cap: number | null;
  price_cents: number | null;
  pattern: { days?: number[]; time?: string; perDay?: boolean; dayTimes?: Record<string, { time: string }> };
  provider_locations: { name: string } | null;
  offer_term?: boolean | null;
  offer_single?: boolean | null;
  offer_trial?: boolean | null;
  offer_package?: boolean | null;
  single_price_cents?: number | null;
  trial_price_cents?: number | null;
};

type TermRow = {
  id: string;
  name: string;
  price_cents: number;
  allow_mid_term: boolean;
  min_left: number;
  reduce_enabled: boolean;
  reduce_by_cents: number;
  early_price_cents?: number | null;
  early_price_until?: string | null;
  allow_singles: boolean;
  single_price_cents: number;
  allow_trial: boolean;
  trial_price_cents: number;
  trial_limit: number;
  allow_packages: boolean;
  sibling_discount_pct?: number | null;
  slot_mode?: "simple" | "flexible" | null;
  term_slot_groups?: { id: string; name: string; position: number }[] | null;
  withdraw_allowed?: boolean | null;
  withdraw_refund_mode?: "money" | "credit" | "none" | null;
  credit_valid_days?: number | null;
  created_at: string;
  term_slots: SlotRow[];
};

type SessionRow = { id: string; starts_at: string; ends_at: string | null; term_slot_id: string };

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hhmm: string | undefined) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Saturdays, 9:00 am", or "Mondays 4:00 pm & Wednesdays 5:00 pm". */
export function slotLabel(p: SlotRow["pattern"]): string {
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
        .select("*, term_slots(*, provider_locations(name)), term_slot_groups(*)")
        .eq("activity_id", activityId)
        .eq("status", "published");
      if (stale) return;
      if (error || !terms?.length) { setRows({ terms: [], sessions: [] }); setLoading(false); return; }
      const slotIds = (terms as TermRow[]).flatMap((t) => t.term_slots.map((s) => s.id));
      const { data: sessions } = slotIds.length
        ? await db
            .from("activity_sessions")
            .select("id, starts_at, ends_at, term_slot_id")
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
      early:
        t.early_price_cents != null && t.early_price_until
          ? { price: dollars(t.early_price_cents), until: t.early_price_until }
          : null,
      allowSingles: t.allow_singles,
      singlePrice: dollars(t.single_price_cents),
      allowTrial: t.allow_trial,
      trialPrice: dollars(t.trial_price_cents),
      trialLimit: t.trial_limit,
      allowPackages: t.allow_packages,
      siblingDiscountPct: t.sibling_discount_pct ?? 0,
      slotMode: (t.slot_mode === "flexible" && (t.term_slot_groups?.length ?? 0) > 1 ? "flexible" : "simple") as "simple" | "flexible",
      groups: [...(t.term_slot_groups ?? [])].sort((a, b) => a.position - b.position).map((g) => ({ id: g.id, name: g.name })),
      withdraw: {
        set: t.withdraw_allowed != null,
        allowed: t.withdraw_allowed === true,
        mode: t.withdraw_refund_mode ?? null,
        creditDays: t.credit_valid_days ?? 365,
      } as WithdrawPolicy,
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
            groupId: s.group_id ?? "",
            label: slotLabel(s.pattern),
            venue: s.provider_locations?.name ?? null,
            dates: list.map((x) => x.starts_at),
            sessionIds: list.map((x) => x.id),
            ends: list.map((x) => x.ends_at ?? x.starts_at),
            capacity: s.capacity,
            spotsLeft: upcomingSpots.length ? Math.max(0, Math.min(...upcomingSpots)) : null,
            price: dollars(s.price_cents ?? t.price_cents),
            singleCap: s.single_cap,
            // 00275: a group's own offers and prices, else its term's (older rows have none of their own).
            offers: {
              term: s.offer_term ?? true,
              single: s.offer_single ?? t.allow_singles,
              trial: s.offer_trial ?? t.allow_trial,
              package: s.offer_package ?? t.allow_packages,
            },
            singlePrice: dollars(s.single_price_cents ?? t.single_price_cents),
            trialPrice: dollars(s.trial_price_cents ?? t.trial_price_cents),
          };
        })
        .filter((s) => s.dates.some((d) => Date.parse(d) > now)),
    }))
    .filter((t) => t.slots.length > 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(({ created_at: _created, ...t }) => t)
    // 00275: what the term offers is what its groups offer. Prices lead with the cheapest group that offers it.
    .map((t): LiveTerm => {
      const cheapest = (list: number[], fallback: number) => (list.length ? Math.min(...list) : fallback);
      const singles = t.slots.filter((s) => s.offers.single);
      const trials = t.slots.filter((s) => s.offers.trial);
      return {
        ...t,
        allowSingles: singles.length > 0,
        singlePrice: cheapest(singles.map((s) => s.singlePrice), t.singlePrice),
        allowTrial: trials.length > 0,
        trialPrice: cheapest(trials.map((s) => s.trialPrice), t.trialPrice),
        allowPackages: t.slots.some((s) => s.offers.package),
        termOffered:
          t.slotMode === "flexible"
            ? t.groups.length > 0 && t.groups.every((g) => t.slots.some((s) => s.groupId === g.id && s.offers.term))
            : t.slots.some((s) => s.offers.term),
      };
    });

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
  /** The last day of the early price that is lowering `payNow` right now (00278); null when none applies. */
  earlyUntil: string | null;
  joining: string[];
  joinable: boolean;
  reason: string | null;
};

/** What the term's early price takes off right now, in dollars, and its last day; null when it has none
 *  or its last day (the whole of it, Singapore time) has passed. Mirrors term_early_discount() in 00278. */
export function earlyNow(term: Pick<LiveTerm, "price" | "early">): { off: number; until: string } | null {
  if (!term.early) return null;
  const endsAt = Date.parse(`${term.early.until}T00:00:00+08:00`) + 86_400_000;
  const off = Math.max(0, term.price - term.early.price);
  return Date.now() < endsAt && off > 0 ? { off, until: term.early.until } : null;
}

/** "Wed 15 Jan" for a YYYY-MM-DD date. */
export const earlyDateLabel = (ymd: string) =>
  new Date(`${ymd}T12:00:00+08:00`).toLocaleDateString("en-SG", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Singapore" });

/** What a family would pay for this slot right now. Mirrors term_quote() in
 *  00243 (which /api/terms/checkout charges from): a session counts as run once
 *  its booking window has closed. */
export function liveQuote(term: LiveTerm, slot: LiveSlot, cutoffMinutes: number | null): LiveQuote {
  const closeBy = Date.now() + (cutoffMinutes ?? 15) * 60_000;
  const n = slot.dates.length;
  const run = slot.dates.filter((d) => Date.parse(d) <= closeBy).length;
  const left = n - run;
  const fullPrice = slot.price;
  const early = earlyNow(term);
  const basePrice = Math.max(0, fullPrice - (early?.off ?? 0));
  const payNow = term.reduce ? Math.max(0, basePrice - term.reduceBy * run) : basePrice;
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
    earlyUntil: early?.until ?? null,
    joining: slot.dates.slice(run),
    joinable: reason == null,
    reason,
  };
}

/** What a family would pay for a whole combination (Flexible terms: one slot
 *  from each group) right now. Mirrors term_combo_quote() in 00264 (which
 *  /api/terms/checkout charges from): the term's one price, less the reduction for
 *  every session already run in any chosen slot, and joinable only while every
 *  slot is. `slot` stands in for the whole combination so the booking page can
 *  treat it like a single slot: its label joins the picks, its dates are all
 *  their sessions. */
export function liveComboQuote(term: LiveTerm, slots: LiveSlot[], cutoffMinutes: number | null): LiveQuote {
  const per = slots.map((s) => liveQuote(term, s, cutoffMinutes));
  const run = per.reduce((n, q) => n + q.run, 0);
  const n = per.reduce((x, q) => x + q.n, 0);
  const left = per.reduce((x, q) => x + q.left, 0);
  const fullPrice = term.price;
  const early = earlyNow(term);
  const basePrice = Math.max(0, fullPrice - (early?.off ?? 0));
  const payNow = term.reduce ? Math.max(0, basePrice - term.reduceBy * run) : basePrice;
  const blocked = per.find((q) => !q.joinable);
  const dates = slots.flatMap((s) => s.dates).sort();
  const spots = slots.map((s) => s.spotsLeft).filter((v): v is number => v != null);
  const combined: LiveSlot = {
    key: slots.map((s) => s.id).join("+"),
    id: slots[0]?.id ?? "",
    groupId: "",
    label: slots.map((s) => s.label).join(" + "),
    venue: slots[0]?.venue ?? null,
    dates,
    sessionIds: slots.flatMap((s) => s.sessionIds),
    ends: slots.flatMap((s) => s.ends),
    capacity: null,
    spotsLeft: spots.length ? Math.min(...spots) : null,
    price: fullPrice,
    singleCap: null,
    offers: { term: true, single: false, trial: false, package: false },
    singlePrice: 0,
    trialPrice: 0,
  };
  return {
    slot: combined,
    n,
    fullPrice,
    perClass: term.reduce ? term.reduceBy : null,
    singlesTotal: null,
    savings: null,
    lastJoin: Math.min(...per.map((q) => q.lastJoin)),
    run,
    left,
    payNow,
    earlyUntil: early?.until ?? null,
    joining: per.flatMap((q) => q.joining).sort(),
    joinable: !blocked,
    reason: blocked?.reason ?? null,
  };
}

/** Do two slots ever run at the same time? Such slots can't both be in one pair. */
export function liveSlotsClash(a: LiveSlot, b: LiveSlot): boolean {
  return a.dates.some((d, i) => {
    const s1 = Date.parse(d), e1 = Date.parse(a.ends[i]);
    return b.dates.some((d2, j) => s1 < Date.parse(b.ends[j]) && Date.parse(d2) < e1);
  });
}

/** How a Flexible term reads on the activity page and the term chooser: one
 *  pick from each group, the sessions a family gets, and the one price. */
export function flexibleOffering(t: LiveTerm, money: (n: number) => string) {
  const perFamily = t.groups.reduce((n, g) => n + (t.slots.find((s) => s.groupId === g.id)?.dates.length ?? 0), 0);
  return {
    sessions: `${perFamily} sessions`,
    slots: t.groups.map((g) => ({
      label: `Choose 1 of ${t.slots.filter((s) => s.groupId === g.id).length} · ${g.name}`,
      venue: null as string | null,
    })),
    price: `${money(t.price - (earlyNow(t)?.off ?? 0))} for ${t.groups.length} sessions a week${earlyNow(t) ? ` (early price until ${earlyDateLabel(earlyNow(t)!.until)})` : ""}`,
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

/**
 * The parent's credit with this activity's vendor (00274): what is free to spend now (credit set
 * aside for a checkout in progress is left out) and when the soonest of it runs out. Null while
 * loading, or when there is none.
 */
export function useTermCredit(activityId: string | null | undefined, enabled: boolean) {
  const [credit, setCredit] = useState<{ cents: number; expiresAt: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !activityId) { setCredit(null); return; }
    let stale = false;
    db.rpc("term_credit_balance", { p_activity_id: activityId })
      .single()
      .then(({ data }) => {
        if (stale) return;
        const d = data as { balance_cents: number; expires_at: string | null } | null;
        setCredit(d && d.balance_cents > 0 ? { cents: d.balance_cents, expiresAt: d.expires_at } : null);
      });
    return () => { stale = true; };
  }, [activityId, enabled]);
  return credit;
}

export { db as termsDb };
