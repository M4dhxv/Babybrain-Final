import { useEffect, useSyncExternalStore } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Term enrolment (migration 00243).
 *
 * Terms and their slots live in Supabase (terms, term_slots); publishing runs
 * publish_term(), which writes the term's sessions as ordinary
 * activity_sessions rows, so a published term's classes show on the schedule
 * and to parents like any other session. The "Offer this activity as a term"
 * switch is activities.terms_enabled.
 *
 * Gated: the Terms tab, the switch and the calendar overlay only show when the
 * preview flag is on (dev build, a build pointed at the test database, or
 * `?terms=preview` once, which is remembered). That keeps a push to main from
 * exposing half a feature to vendors.
 */

const FLAG_KEY = 'bb_terms_preview';

// The term tables are newer than the generated Database types.
const db = supabase as unknown as SupabaseClient;

// The babybrain-test Supabase project. A build pointed at it (the test site and
// its previews) has the preview on by default, so admins testing there need no
// special link. Production builds point at the live project and stay opt-in.
const TEST_SUPABASE_REF = 'imlfhepnucytyajxpoum';

export function termsPreviewEnabled(): boolean {
  try {
    if (import.meta.env.DEV) return true;
    // `?terms=` may sit before the hash (/vendor?terms=preview#/activities) or
    // inside the hash route (/vendor#/activities?terms=preview); read both.
    const inHash = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('terms');
    const p = new URLSearchParams(window.location.search).get('terms') ?? inHash;
    if (p === 'preview') window.localStorage.setItem(FLAG_KEY, '1');
    if (p === 'off') window.localStorage.setItem(FLAG_KEY, '0');
    const stored = window.localStorage.getItem(FLAG_KEY);
    const testBuild = String(import.meta.env.VITE_SUPABASE_URL ?? '').includes(TEST_SUPABASE_REF);
    return stored === '1' || (testBuild && stored !== '0');
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
  /** Taken off the 2nd and later child a parent enrols in this term (00244). */
  siblingDiscountPct: number;
  /** The term this one was copied from, for re-enrolment priority (00244). */
  previousTermId: string | null;
  /** While in the future, only families from the previous term can enrol. */
  priorityUntil: string | null;
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
    siblingDiscountPct: t.siblingDiscountPct ?? 0,
    previousTermId: t.previousTermId ?? null,
    priorityUntil: t.priorityUntil ?? null,
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

/* ── the provider's terms, loaded from Supabase and shared by every screen ── */

type SlotRow = {
  id: string;
  position: number;
  location_id: string | null;
  capacity: number;
  single_cap: number | null;
  price_cents: number | null;
  pattern: Partial<Pick<TermSlot, 'days' | 'time' | 'duration' | 'start' | 'weeks' | 'count' | 'skip' | 'perDay' | 'dayTimes'>>;
};

type TermRow = {
  id: string;
  activity_id: string;
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
  sibling_discount_pct: number | null;
  previous_term_id: string | null;
  priority_until: string | null;
  status: 'draft' | 'published' | 'archived';
  term_slots: SlotRow[];
};

const toDollars = (cents: number) => cents / 100;
const toCents = (dollars: number) => Math.round(dollars * 100);

function fromRow(r: TermRow): Term {
  return normalizeTerm({
    id: r.id,
    activityId: r.activity_id,
    name: r.name,
    price: toDollars(r.price_cents),
    allowMidTerm: r.allow_mid_term,
    minLeft: r.min_left,
    reduce: r.reduce_enabled,
    reduceBy: toDollars(r.reduce_by_cents),
    allowSingles: r.allow_singles,
    singlePrice: toDollars(r.single_price_cents),
    allowTrial: r.allow_trial,
    trialPrice: toDollars(r.trial_price_cents),
    trialLimit: r.trial_limit,
    allowPackages: r.allow_packages,
    siblingDiscountPct: r.sibling_discount_pct ?? 0,
    previousTermId: r.previous_term_id,
    priorityUntil: r.priority_until,
    status: r.status === 'published' ? 'published' : 'draft',
    slots: [...(r.term_slots ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        id: s.id,
        days: s.pattern.days ?? [],
        time: s.pattern.time ?? '09:00',
        duration: s.pattern.duration ?? 45,
        locationId: s.location_id ?? '',
        capacity: s.capacity,
        start: s.pattern.start ?? '',
        weeks: s.pattern.weeks ?? 1,
        count: s.pattern.count ?? null,
        skip: s.pattern.skip ?? [],
        price: s.price_cents != null ? toDollars(s.price_cents) : null,
        singleCap: s.single_cap,
        perDay: s.pattern.perDay ?? false,
        dayTimes: s.pattern.dayTimes ?? {},
      })),
  });
}

const termFields = (t: Term) => ({
  activity_id: t.activityId,
  name: t.name.trim() || 'Untitled term',
  price_cents: toCents(t.price),
  allow_mid_term: t.allowMidTerm,
  min_left: Math.max(1, t.minLeft),
  reduce_enabled: t.reduce,
  reduce_by_cents: toCents(t.reduceBy),
  allow_singles: t.allowSingles,
  single_price_cents: toCents(t.singlePrice),
  allow_trial: t.allowTrial,
  trial_price_cents: toCents(t.trialPrice),
  trial_limit: Math.min(10, Math.max(1, t.trialLimit)),
  allow_packages: t.allowPackages,
  sibling_discount_pct: Math.min(100, Math.max(0, Math.round(t.siblingDiscountPct || 0))),
  previous_term_id: t.previousTermId,
});

const slotRow = (termId: string, s: TermSlot, position: number) => ({
  id: s.id,
  term_id: termId,
  position,
  location_id: s.locationId || null,
  capacity: Math.max(1, s.capacity),
  single_cap: s.singleCap,
  price_cents: s.price != null ? toCents(s.price) : null,
  pattern: {
    days: s.days, time: s.time, duration: s.duration, start: s.start, weeks: s.weeks,
    count: s.count, skip: s.skip ?? [], perDay: s.perDay, dayTimes: s.dayTimes ?? {},
  },
});

const NO_TERMS: Term[] = [];
let cache: Term[] = NO_TERMS;
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Reload this provider's terms (drafts and published; archived ones are gone). */
export async function refreshTerms(providerId: string = loadedFor ?? ''): Promise<void> {
  if (!providerId) return;
  const { data, error } = await db
    .from('terms')
    .select('*, term_slots(*)')
    .eq('provider_id', providerId)
    .neq('status', 'archived')
    .order('created_at');
  if (error) throw error;
  if (loadedFor !== providerId) loadedFor = providerId;
  cache = ((data ?? []) as TermRow[]).map(fromRow);
  notify();
}

export function useTerms(): Term[] {
  const { provider } = useAuth();
  const providerId = provider?.id ?? null;
  useEffect(() => {
    if (!providerId || loadedFor === providerId || loading) return;
    loadedFor = providerId;
    cache = NO_TERMS;
    loading = refreshTerms(providerId)
      .catch((e) => { console.error('Could not load terms', e); loadedFor = null; })
      .finally(() => { loading = null; });
  }, [providerId]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cache,
    () => cache,
  );
}

/** Save a term and its slots. A draft's slots are replaced wholesale; a
 *  published term's days, times and venues are fixed (the database refuses
 *  changes), so only seats, prices and the single-session cap are updated.
 *  Saving with status 'published' over a draft publishes it, which writes its
 *  sessions. Throws with the database's message on failure. */
export async function saveTerm(t: Term): Promise<void> {
  if (!loadedFor) throw new Error('Your business is still loading. Try again in a moment.');
  const before = cache.find((x) => x.id === t.id);
  if (!before) {
    const { error } = await db.from('terms').insert({ id: t.id, provider_id: loadedFor, status: 'draft', ...termFields(t) });
    if (error) throw error;
  } else {
    const { error } = await db.from('terms').update(termFields(t)).eq('id', t.id);
    if (error) throw error;
  }

  if (before?.status === 'published') {
    const known = new Set(before.slots.map((s) => s.id));
    if (t.slots.some((s) => !known.has(s.id))) {
      throw new Error('Groups can’t be added to a published term. Start a new term for a new group.');
    }
    const fixed = (s: TermSlot) => JSON.stringify([slotRow(t.id, s, 0).pattern, s.locationId || null]);
    const was = new Map(before.slots.map((s) => [s.id, fixed(s)]));
    if (t.slots.some((s) => was.get(s.id) !== fixed(s))) {
      throw new Error('A published term’s days, times and venue are fixed. Cancel a session from the schedule instead, or start a new term.');
    }
    for (const s of t.slots) {
      const { error } = await db
        .from('term_slots')
        .update({ capacity: Math.max(1, s.capacity), single_cap: s.singleCap, price_cents: s.price != null ? toCents(s.price) : null })
        .eq('id', s.id);
      if (error) throw error;
    }
  } else {
    const keep = t.slots.map((s) => s.id);
    let del = db.from('term_slots').delete().eq('term_id', t.id);
    if (keep.length) del = del.not('id', 'in', `(${keep.join(',')})`);
    const { error: delErr } = await del;
    if (delErr) throw delErr;
    if (t.slots.length) {
      const { error } = await db.from('term_slots').upsert(t.slots.map((s, i) => slotRow(t.id, s, i)));
      if (error) throw error;
    }
    if (t.status === 'published') {
      const { error } = await db.rpc('publish_term', { p_term_id: t.id });
      if (error) {
        await refreshTerms();
        throw error;
      }
    }
  }
  await refreshTerms();
}

/** A draft is deleted; a published term is archived (its sessions and any
 *  bookings stay, and it stops taking enrolments). */
export async function deleteTerm(id: string): Promise<'deleted' | 'archived'> {
  const t = cache.find((x) => x.id === id);
  const archived = t?.status === 'published';
  const { error } = archived
    ? await db.from('terms').update({ status: 'archived' }).eq('id', id)
    : await db.from('terms').delete().eq('id', id);
  if (error) throw error;
  await refreshTerms();
  return archived ? 'archived' : 'deleted';
}

/* ── pure helpers ── */

export const newId = () => crypto.randomUUID();

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
    siblingDiscountPct: 0,
    previousTermId: null,
    priorityUntil: null,
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
    // A published term's classes are real activity_sessions rows (publish_term)
    // and show on the schedule with their real bookings; only drafts, which have
    // no sessions yet, are drawn from their pattern.
    if (t.status === 'published') continue;
    const title = activityTitles.get(t.activityId);
    if (title === undefined) continue;
    for (const s of t.slots) {
      const dates = slotDates(s);
      dates.forEach((ymd, i) => {
        const { time, duration } = dayTimeFor(s, parseYmd(ymd).getDay());
        const starts = new Date(`${ymd}T${time}:00+08:00`);
        if (starts < from || starts > to) return;
        const ends = new Date(starts.getTime() + duration * 60000);
        const seats = { termSeats: 0, singleSeats: 0 };
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
 * own price and seats per slot). Stored as activities.terms_enabled (00243). */

const NO_ENABLED: Record<string, boolean> = {};
let enabledCache: Record<string, boolean> = NO_ENABLED;
let enabledFor: string | null = null;
const enabledListeners = new Set<() => void>();

async function loadEnabled(providerId: string) {
  const { data, error } = await db.from('activities').select('id, terms_enabled').eq('provider_id', providerId);
  if (error) throw error;
  enabledCache = Object.fromEntries(((data ?? []) as { id: string; terms_enabled: boolean }[]).map((a) => [a.id, !!a.terms_enabled]));
  enabledListeners.forEach((l) => l());
}

export function useTermsEnabledMap(): Record<string, boolean> {
  const { provider } = useAuth();
  const providerId = provider?.id ?? null;
  useEffect(() => {
    if (!providerId || enabledFor === providerId) return;
    enabledFor = providerId;
    enabledCache = NO_ENABLED;
    loadEnabled(providerId).catch((e) => { console.error('Could not load term switches', e); enabledFor = null; });
  }, [providerId]);
  return useSyncExternalStore(
    (cb) => {
      enabledListeners.add(cb);
      return () => enabledListeners.delete(cb);
    },
    () => enabledCache,
    () => enabledCache,
  );
}

/** Turn "Offer this activity as a term" on or off. The database refuses to
 *  turn it off under a published term that still has sessions to run. */
export async function setTermsEnabled(activityId: string, on: boolean): Promise<void> {
  if ((enabledCache[activityId] ?? false) === on) return;
  const { error } = await db.from('activities').update({ terms_enabled: on }).eq('id', activityId);
  if (error) throw error;
  enabledCache = { ...enabledCache, [activityId]: on };
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

/* ── running a published term (00244) ── */

export type RosterRow = {
  enrolment_id: string;
  slot_id: string;
  child_name: string;
  child_dob: string | null;
  parent_name: string | null;
  parent_email: string | null;
  price_cents: number;
  sessions: number;
  sessions_left: number;
  joined_session_no: number | null;
  paid: boolean;
  status: 'enrolled' | 'unpaid' | 'withdrawn';
  enrolled_at: string;
};

export type SlotStats = {
  slot_id: string;
  enrolled: number;
  unpaid: number;
  places_left: number | null;
  one_off_bookings: number;
  revenue_cents: number;
};

export async function fetchTermRoster(termId: string): Promise<RosterRow[]> {
  const { data, error } = await db.rpc('term_roster', { p_term_id: termId });
  if (error) throw error;
  return (data ?? []) as RosterRow[];
}

export async function fetchTermSlotStats(termId: string): Promise<SlotStats[]> {
  const { data, error } = await db.rpc('term_slot_stats', { p_term_id: termId });
  if (error) throw error;
  return (data ?? []) as SlotStats[];
}

/** Take a child off a term: their sessions still to come are cancelled. */
export async function vendorWithdraw(enrolmentId: string, refund: 'refund' | 'none', reason: string): Promise<number> {
  const { data, error } = await db.rpc('vendor_withdraw_from_term', {
    p_enrolment_id: enrolmentId, p_refund_mode: refund, p_reason: reason.trim() || null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Hold the new term for the previous term's families for `days`, and tell them. */
export async function openReenrolment(termId: string, days = 7): Promise<number> {
  const { data, error } = await db.rpc('open_reenrolment', { p_term_id: termId, p_days: days });
  if (error) throw error;
  await refreshTerms();
  return Number(data ?? 0);
}

/* ── the term waitlist (00259-00261) ── */

/** Someone waiting on a term: for a place in a group ('term'), or for one
 *  trial, single or pack session of it (`session_id` set). */
export type TermWaitRow = {
  kind: 'term' | 'single' | 'trial' | 'package' | 'makeup';
  id: string;
  slot_id: string;
  session_id: string | null;
  session_starts_at: string | null;
  child_name: string;
  child_dob: string | null;
  parent_name: string | null;
  parent_email: string | null;
  status: 'waiting' | 'holding' | 'offered';
  queue_position: number | null;
  joined_at: string;
};

export type TermWaitCount = { slot_id: string; waiting: number; session_waiting: number; free_places: number };

export async function fetchTermWaitlist(termId: string): Promise<TermWaitRow[]> {
  const { data, error } = await db.rpc('term_waitlist_roster', { p_term_id: termId });
  if (error) throw error;
  return (data ?? []) as TermWaitRow[];
}

export async function fetchTermWaitlistCounts(termId: string): Promise<TermWaitCount[]> {
  const { data, error } = await db.rpc('term_waitlist_counts', { p_term_id: termId });
  if (error) throw error;
  return (data ?? []) as TermWaitCount[];
}

/** A personal offer of a term place to one waiting family; it may go over capacity. */
export async function offerTermPlace(entryId: string): Promise<void> {
  const { error } = await db.rpc('vendor_offer_term_place', { p_entry_id: entryId });
  if (error) throw error;
}

/** Offer a freed trial or single session seat to one family, as "Promote" does. */
export async function offerSessionPlace(bookingId: string): Promise<void> {
  const { error } = await db.rpc('promote_waitlist_entry', { p_booking_id: bookingId });
  if (error) throw error;
}

/** Tell everyone waiting on a group about a free place nobody announced. */
export async function tellTermWaitlist(slotId: string): Promise<number> {
  const { data, error } = await db.rpc('vendor_tell_term_waitlist', { p_slot_id: slotId });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function removeFromTermWaitlist(entryId: string, reason: string): Promise<void> {
  const { error } = await db.rpc('vendor_remove_from_term_waitlist', { p_entry_id: entryId, p_reason: reason.trim() || null });
  if (error) throw error;
}

/** A draft of the next term: same groups, prices and rules, each group starting
 *  on its first day after this term's last session. */
export function nextTermFrom(t: Term): Term {
  const last = t.slots.flatMap((s) => slotDates(s)).sort().pop();
  const after = last ? parseYmd(last) : new Date();
  return {
    ...structuredClone(t),
    id: newId(),
    name: `${t.name} (next)`,
    status: 'draft',
    previousTermId: t.id,
    priorityUntil: null,
    slots: t.slots.map((s) => {
      const d = new Date(after);
      for (let i = 1; i <= 7; i++) {
        d.setDate(after.getDate() + i);
        if (s.days.includes(d.getDay())) break;
      }
      return { ...structuredClone(s), id: newId(), start: toYmd(d), skip: [] };
    }),
  };
}

/* ── Singapore public holidays, for "Skip public holidays" ──
 * The observed day off (a Sunday holiday moves to Monday). Source: MOM's
 * published list; add the next year's dates when MOM announces them. */
export const SG_PUBLIC_HOLIDAYS: Record<string, string> = {
  '2026-01-01': "New Year's Day",
  '2026-02-17': 'Chinese New Year',
  '2026-02-18': 'Chinese New Year',
  '2026-03-21': 'Hari Raya Puasa',
  '2026-04-03': 'Good Friday',
  '2026-05-01': 'Labour Day',
  '2026-05-27': 'Hari Raya Haji',
  '2026-05-31': 'Vesak Day',
  '2026-06-01': 'Vesak Day (observed)',
  '2026-08-09': 'National Day',
  '2026-08-10': 'National Day (observed)',
  '2026-11-08': 'Deepavali',
  '2026-11-09': 'Deepavali (observed)',
  '2026-12-25': 'Christmas Day',
  '2027-01-01': "New Year's Day",
};

/** The slot's dates that fall on a public holiday. */
export function publicHolidaysIn(slot: DateRule): string[] {
  return slotPatternDates(slot).filter((d) => d in SG_PUBLIC_HOLIDAYS);
}
