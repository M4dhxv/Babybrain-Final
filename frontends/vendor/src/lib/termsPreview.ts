import { useSyncExternalStore } from 'react';

/**
 * Term enrolment — UI PREVIEW ONLY.
 *
 * There is no backend for terms yet. Everything here lives in this browser's
 * localStorage so the admin can click through the vendor flow (Manage schedule →
 * Terms, the schedule calendar's term/single distinction) before the data model
 * is planned. Nothing is written to Supabase and no parent can see a term.
 *
 * Gated: the Terms tab and the calendar overlay only show when the preview flag
 * is on (dev build, or `?terms=preview` once, which is remembered). That keeps a
 * push to main from exposing half a feature to vendors.
 */

const FLAG_KEY = 'bb_terms_preview';
const STORE_KEY = 'bb_terms_preview_v1';

export function termsPreviewEnabled(): boolean {
  try {
    if (import.meta.env.DEV) return true;
    const p = new URLSearchParams(window.location.search).get('terms');
    if (p === 'preview') window.localStorage.setItem(FLAG_KEY, '1');
    if (p === 'off') window.localStorage.removeItem(FLAG_KEY);
    return window.localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export type TermSlot = {
  id: string;
  /** 0 = Sunday … 6 = Saturday. The session repeats on each of these days. */
  days: number[];
  time: string; // HH:MM
  duration: number; // mins
  /** '' = same venue as the activity. */
  locationId: string;
  capacity: number;
  /** yyyy-mm-dd of the first session (or first on/after, per `days`). */
  start: string;
  weeks: number;
  /** Run for exactly this many sessions (skipped dates don't count, so a
   *  holiday pushes the end out). null = run for `weeks` weeks instead. */
  count: number | null;
  /** Dates (yyyy-mm-dd) with no session — a public holiday, a school break. */
  skip: string[];
  /** This slot's own full-term price; null = the term's price. */
  price: number | null;
  /** Most seats single-session bookings may take on one session; null = no limit. */
  singleCap: number | null;
  /** When true each weekday can have its own start time and length
   *  (`dayTimes`, keyed by weekday 0-6); otherwise `time`/`duration` apply to all. */
  perDay: boolean;
  dayTimes: Record<string, { time: string; duration: number }>;
};

export type Term = {
  id: string;
  activityId: string;
  name: string;
  price: number;
  allowMidTerm: boolean;
  /** Stop taking enrolments once this many sessions are left. */
  minLeft: number;
  reduce: boolean;
  /** Fixed SGD taken off for every session that has already run. */
  reduceBy: number;
  allowSingles: boolean;
  singlePrice: number;
  /** Trial session: one session at an intro price, limited per child. Can be on
   *  together with `allowSingles`; once a child has used their trials, only
   *  single sessions are offered to them. */
  allowTrial: boolean;
  trialPrice: number;
  /** Most trial sessions one child may take with this vendor. */
  trialLimit: number;
  /** Parents with a package can book individual sessions of this term with credits. */
  allowPackages: boolean;
  slots: TermSlot[];
  status: 'draft' | 'published';
};

/** Fill fields that terms saved by earlier versions of the preview lack. */
export function normalizeTerm(t: Term): Term {
  return {
    ...t,
    allowTrial: t.allowTrial ?? false,
    trialPrice: t.trialPrice ?? 0,
    trialLimit: t.trialLimit ?? 1,
    allowPackages: t.allowPackages ?? true,
    slots: t.slots.map((s) => ({
      ...s,
      count: s.count ?? null,
      skip: s.skip ?? [],
      price: s.price ?? null,
      singleCap: s.singleCap ?? null,
      perDay: s.perDay ?? false,
      dayTimes: s.dayTimes ?? {},
    })),
  };
}

/** Start time and length for the slot's session on a given weekday (0 = Sunday). */
export function dayTimeFor(
  slot: Pick<TermSlot, 'time' | 'duration' | 'perDay' | 'dayTimes'>,
  dow: number,
): { time: string; duration: number } {
  const own = slot.perDay ? slot.dayTimes?.[String(dow)] : undefined;
  return own ?? { time: slot.time, duration: slot.duration };
}

/* ── tiny external store so the Terms tab and the calendar stay in step ── */

let cache: Term[] | null = null;
const listeners = new Set<() => void>();

function read(): Term[] {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    cache = raw ? (JSON.parse(raw) as Term[]).map(normalizeTerm) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: Term[]) {
  cache = next;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* private mode — the in-memory copy still works for this tab */
  }
  listeners.forEach((l) => l());
}

export function useTerms(): Term[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    read,
  );
}

export function saveTerm(t: Term) {
  const all = read();
  write(all.some((x) => x.id === t.id) ? all.map((x) => (x.id === t.id ? t : x)) : [...all, t]);
}

export function deleteTerm(id: string) {
  write(read().filter((t) => t.id !== id));
}

/* ── pure helpers ── */

export const newId = () => Math.random().toString(36).slice(2, 10);

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => String(n).padStart(2, '0');
const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

type DateRule = Pick<TermSlot, 'days' | 'start' | 'weeks'> & { skip?: string[]; count?: number | null };

/** Sanity ceilings only — a term is as long as the vendor says. */
export const MAX_TERM_SESSIONS = 200;
export const MAX_TERM_WEEKS = 104;

/** Every date the slot's pattern falls on, skipped or not, in order. By weeks,
 *  it runs for that many weeks. By sessions, it runs until that many
 *  non-skipped sessions have been placed (skipped dates are still listed so they
 *  can be switched back on). */
export function slotPatternDates(slot: DateRule): string[] {
  if (!slot.start || slot.days.length === 0) return [];
  const skip = slot.skip ?? [];
  const count = slot.count != null && slot.count > 0 ? Math.min(slot.count, MAX_TERM_SESSIONS) : null;
  const span = count != null ? 7 * (MAX_TERM_SESSIONS + 10) : Math.max(1, Math.min(slot.weeks, MAX_TERM_WEEKS)) * 7;
  const out: string[] = [];
  const first = parseYmd(slot.start);
  let live = 0;
  for (let i = 0; i < span; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    if (!slot.days.includes(d.getDay())) continue;
    const ymd = toYmd(d);
    out.push(ymd);
    if (!skip.includes(ymd)) {
      live++;
      if (count != null && live >= count) break;
    }
  }
  return out;
}

/** Every session date (yyyy-mm-dd) of a slot, in order, minus the skipped ones. */
export function slotDates(slot: DateRule): string[] {
  const skip = slot.skip ?? [];
  return slotPatternDates(slot).filter((d) => !skip.includes(d));
}

/** The price a parent pays for this slot before any mid-term reduction. */
export const slotPrice = (term: Pick<Term, 'price'>, slot: Pick<TermSlot, 'price'>) => slot.price ?? term.price;

export type TermStatusKey = 'draft' | 'upcoming' | 'running' | 'closed' | 'ended';

/** Where a term is in its life: not yet published, not started, taking
 *  joiners, running but closed to joiners, or over. */
export function termStatus(term: Term, now: Date = new Date()): { key: TermStatusKey; label: string } {
  if (term.status === 'draft') return { key: 'draft', label: 'Draft' };
  const all = term.slots.flatMap((s) => slotDates(s));
  if (all.length === 0) return { key: 'draft', label: 'Draft' };
  all.sort();
  const today = toYmd(now);
  if (today < all[0]) return { key: 'upcoming', label: 'Upcoming' };
  if (today > all[all.length - 1]) return { key: 'ended', label: 'Ended' };
  const first = term.slots[0] ? slotDates(term.slots[0]) : [];
  const passed = first.filter((d) => d < today).length;
  const open = term.allowMidTerm && passed <= lastJoinableAfter(term, first.length);
  return open ? { key: 'running', label: 'Running' } : { key: 'closed', label: 'Closed to joiners' };
}

/** Placeholder enrolment numbers for the list (no real data yet). */
export function termStats(term: Term) {
  let enrolled = 0;
  let seatsLeft = 0;
  let revenue = 0;
  for (const s of term.slots) {
    const { termSeats } = mockSeats(s.id, 1, s.capacity, s.singleCap);
    enrolled += termSeats;
    seatsLeft += Math.max(0, s.capacity - termSeats);
    revenue += termSeats * slotPrice(term, s);
  }
  return { enrolled, seatsLeft, revenue };
}

/** What a parent pays if they join after `passed` sessions have run. */
export function priceAfter(term: Pick<Term, 'price' | 'reduce' | 'reduceBy'>, passed: number): number {
  return term.reduce ? Math.max(0, term.price - term.reduceBy * passed) : term.price;
}

/** How many sessions can have run while the term still takes new joiners. */
export function lastJoinableAfter(term: Pick<Term, 'allowMidTerm' | 'minLeft'>, total: number): number {
  return term.allowMidTerm ? Math.max(0, total - Math.max(1, term.minLeft)) : 0;
}

export const fmtShort = (ymd: string) =>
  parseYmd(ymd).toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' });

export const fmtRange = (dates: string[]) =>
  dates.length === 0
    ? ''
    : dates.length === 1
      ? fmtShort(dates[0])
      : `${fmtShort(dates[0])} to ${fmtShort(dates[dates.length - 1])}`;

export function blankTerm(activityId: string, defaults: { price?: number | null; capacity?: number | null; locationId?: string | null }): Term {
  const next = new Date();
  next.setDate(next.getDate() + ((6 - next.getDay() + 7) % 7 || 7)); // coming Saturday
  return {
    id: newId(),
    activityId,
    name: '',
    price: defaults.price != null ? Math.round(defaults.price * 10) : 0,
    allowMidTerm: true,
    minLeft: 3,
    reduce: true,
    reduceBy: defaults.price != null ? Math.round(defaults.price) : 0,
    allowSingles: false,
    singlePrice: defaults.price != null ? Math.round(defaults.price) : 0,
    allowTrial: false,
    trialPrice: defaults.price != null ? Math.round(defaults.price / 2) : 0,
    trialLimit: 1,
    allowPackages: true,
    slots: [
      {
        id: newId(),
        days: [next.getDay()],
        time: '09:00',
        duration: 45,
        locationId: defaults.locationId ?? '',
        capacity: defaults.capacity ?? 10,
        start: toYmd(next),
        weeks: 10,
        count: null,
        skip: [],
        price: null,
        singleCap: null,
        perDay: false,
        dayTimes: {},
      },
    ],
    status: 'draft',
  };
}

/* ── calendar overlay ── */

export type TermSession = {
  id: string;
  activity_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  /** Seats held by children enrolled for the whole term / the rest of it. */
  termSeats: number;
  /** Seats taken by single-session bookings on this one session. */
  singleSeats: number;
  locationId: string | null;
  termName: string;
  sessionNo: number;
  sessionOf: number;
  termId: string;
  slotId: string;
  /** yyyy-mm-dd of this session. */
  ymd: string;
  published: boolean;
};

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** Placeholder seat numbers — deterministic so the demo doesn't flicker.
 *  `singleCap` is the vendor's limit on seats singles may take. */
export function mockSeats(slotId: string, sessionNo: number, capacity: number, singleCap: number | null = null) {
  const termSeats = Math.min(capacity, Math.max(1, Math.round(capacity * (0.55 + (hash(slotId) % 25) / 100))));
  const room = capacity - termSeats;
  let singleSeats = room > 0 ? hash(slotId + sessionNo) % (Math.min(room, 3) + 1) : 0;
  if (singleCap != null) singleSeats = Math.min(singleSeats, Math.max(0, singleCap));
  return { termSeats, singleSeats };
}

export function termSessionsBetween(
  terms: Term[],
  activityTitles: Map<string, string>,
  from: Date,
  to: Date,
): TermSession[] {
  const out: TermSession[] = [];
  for (const t of terms) {
    const title = activityTitles.get(t.activityId);
    if (title === undefined) continue;
    for (const s of t.slots) {
      const dates = slotDates(s);
      dates.forEach((ymd, i) => {
        const { time, duration } = dayTimeFor(s, parseYmd(ymd).getDay());
        const starts = new Date(`${ymd}T${time}:00+08:00`);
        if (starts < from || starts > to) return;
        const ends = new Date(starts.getTime() + duration * 60000);
        const seats = mockSeats(s.id, i + 1, s.capacity, s.singleCap ?? null);
        out.push({
          id: `term:${t.id}:${s.id}:${ymd}`,
          activity_id: t.activityId,
          title,
          starts_at: starts.toISOString(),
          ends_at: ends.toISOString(),
          capacity: s.capacity,
          ...seats,
          locationId: s.locationId || null,
          termName: t.name || 'Untitled term',
          sessionNo: i + 1,
          sessionOf: dates.length,
          termId: t.id,
          slotId: s.id,
          ymd,
          published: t.status === 'published',
        });
      });
    }
  }
  return out;
}

/* ── per-activity switch: does this activity offer terms at all? ──
 *
 * Off by default. While it is off the activity's Terms tab is frozen; while it
 * is on, the activity's own price and capacity are frozen (a term carries its
 * own price and seats per slot). Preview-only, like the rest of this file; in
 * the real feature it is activities.terms_enabled (migration 00243). */

const ENABLED_KEY = 'bb_terms_enabled_v1';
let enabledCache: Record<string, boolean> | null = null;
const enabledListeners = new Set<() => void>();

function readEnabled(): Record<string, boolean> {
  if (enabledCache) return enabledCache;
  try {
    const raw = window.localStorage.getItem(ENABLED_KEY);
    enabledCache = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    enabledCache = {};
  }
  return enabledCache;
}

export function useTermsEnabledMap(): Record<string, boolean> {
  return useSyncExternalStore(
    (cb) => {
      enabledListeners.add(cb);
      return () => enabledListeners.delete(cb);
    },
    readEnabled,
    readEnabled,
  );
}

export function setTermsEnabled(activityId: string, on: boolean) {
  const next = { ...readEnabled(), [activityId]: on };
  enabledCache = next;
  try {
    window.localStorage.setItem(ENABLED_KEY, JSON.stringify(next));
  } catch {
    /* private mode — the in-memory copy still works for this tab */
  }
  enabledListeners.forEach((l) => l());
}

/** True while the activity has a published term that has not ended — the
 *  switch can't be turned off under it. */
export function hasLiveTerm(terms: Term[], activityId: string): boolean {
  return terms.some((t) => t.activityId === activityId && t.status === 'published' && termStatus(t).key !== 'ended');
}

/* ── the price an activity leads with while it offers terms ──
 *
 * Mirrors term_headline_prices (migration 00243) and the parent app's
 * lib/termHeadlines.ts: the trial session price if a term has a trial session, else
 * the single-session price if a term sells single sessions, else the lowest term
 * price. Here every term that has not ended counts, drafts included, so a vendor
 * sees what parents will see once it is published. */

export type Headline = { kind: 'trial' | 'single' | 'term'; price: number };

export function termHeadline(terms: Term[], activityId: string): Headline | null {
  const live = terms.filter((t) => t.activityId === activityId && termStatus(t).key !== 'ended');
  if (live.length === 0) return null;
  const trial = live.filter((t) => t.allowTrial).map((t) => t.trialPrice);
  if (trial.length > 0) return { kind: 'trial', price: Math.min(...trial) };
  const single = live.filter((t) => t.allowSingles).map((t) => t.singlePrice);
  if (single.length > 0) return { kind: 'single', price: Math.min(...single) };
  const prices = live.flatMap((t) => t.slots.map((s) => slotPrice(t, s)));
  return prices.length > 0 ? { kind: 'term', price: Math.min(...prices) } : null;
}

/** Cheapest and dearest full-term price across the activity's live terms. */
export function termPriceRange(terms: Term[], activityId: string): { min: number; max: number } | null {
  const prices = terms
    .filter((t) => t.activityId === activityId && termStatus(t).key !== 'ended')
    .flatMap((t) => t.slots.map((s) => slotPrice(t, s)));
  return prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
}

const headlineMoney = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

/** The card's price line. */
export function headlineLabel(h: Headline): string {
  return h.kind === 'trial'
    ? `Trial session ${headlineMoney(h.price)}`
    : h.kind === 'single'
      ? `Single session ${headlineMoney(h.price)}`
      : `Term from ${headlineMoney(h.price)}`;
}

/** The activity page's big price and the words after it. */
export function headlineParts(h: Headline): { prefix: string; amount: string; unit: string } {
  return {
    prefix: h.kind === 'term' ? 'From ' : '',
    amount: headlineMoney(h.price),
    unit: h.kind === 'trial' ? 'trial session' : h.kind === 'single' ? 'per session' : 'per term',
  };
}

/* ── packages and terms ──
 *
 * An activity is closed to packages when it has terms switched on and none of
 * its terms that are still running accept package credits. Its sessions all
 * come from those terms (the Single sessions tab is locked), so a pack limited to
 * it could be bought but never spent. Mirrors activity_packages_open (00243). */
export function packagesClosedActivityIds(terms: Term[], enabled: Record<string, boolean>): Set<string> {
  const byActivity = new Map<string, Term[]>();
  for (const t of terms) {
    if (!enabled[t.activityId] || termStatus(t).key === 'ended') continue;
    byActivity.set(t.activityId, [...(byActivity.get(t.activityId) ?? []), t]);
  }
  const closed = new Set<string>();
  for (const [id, list] of byActivity) if (!list.some((t) => t.allowPackages)) closed.add(id);
  return closed;
}
