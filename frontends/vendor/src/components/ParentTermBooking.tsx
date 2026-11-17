import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  dayTimeFor, isFlexible, lastJoinableAfter, priceAfter, slotDates, slotPrice, slotsClash,
  type Term, type TermSlot,
} from '@/lib/termsPreview';

/**
 * The term section of the parent's booking page, as the vendor's "Parent view"
 * preview shows it.
 *
 * This is a MIRROR of frontends/parent/src/components/TermBookingPreview.tsx:
 * same structure, same copy, same classes (the parent app's palette written out
 * as hex, since this app has no `baby-*` tokens). Change one, change the other.
 * It differs in exactly one way: data. The parent derives a stand-in term from
 * the activity's sessions; this is built from the vendor's own term, so it
 * shows what a family will actually be offered. Nothing else is added or
 * dropped (the parent preview's dashed "preview controls" box is a developer
 * aid, not part of what parents see, so it is not here).
 */

export type BookMode = 'term' | 'single' | 'trial' | 'package';

export type TermViewSlot = {
  key: string;
  /** The group this slot belongs to (00264). */
  groupId: string;
  /** Slots in other groups that run at the same time as this one. */
  clashWith: string[];
  /** "Saturdays, 9:00 am" or "Mon 4:00 pm · Wed 5:30 pm". */
  label: string;
  venue: string | null;
  /** ISO start of every session still to run, past ones included. */
  dates: string[];
  spotsLeft: number | null;
  /** Full-term price for this slot, SGD. */
  price: number;
};

export type TermView = {
  name: string;
  /** A Flexible term: a family picks one slot from each group (00264). */
  flexible: boolean;
  groups: { id: string; name: string }[];
  slots: TermViewSlot[];
  allowMidTerm: boolean;
  minLeft: number;
  reduce: boolean;
  reduceBy: number;
  /** One-off options the vendor has on: either, both or neither. */
  trial: boolean;
  single: boolean;
  singlePrice: number;
  trialPrice: number;
  trialLimit: number;
  packages: boolean;
  /** The activity's own per-session price, for "save vs single sessions". */
  unitPrice: number | null;
};

export type TermQuote = {
  slot: TermViewSlot;
  n: number;
  fullPrice: number;
  savings: number | null;
  lastJoin: number;
  run: number;
  left: number;
  payNow: number;
  /** What a mid-term joiner is not charged for. */
  reducedBy: number;
  joining: string[];
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const pm = h >= 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${pm ? 'pm' : 'am'}`;
};

export const sgDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short' });
export const sgTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' });

/** Orders days Monday-first the way a week is written here. */
const mondayFirst = (days: number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

export function slotLabel(slot: Pick<TermSlot, 'days' | 'time' | 'duration' | 'perDay' | 'dayTimes'>): string {
  const days = mondayFirst(slot.days);
  if (days.length === 0) return 'Group';
  if (slot.perDay) {
    return days.map((d) => `${WEEKDAY[d]} ${clock(dayTimeFor(slot, d).time)}`).join(' · ');
  }
  if (days.length === 1) return `${WEEKDAY_LONG[days[0]]}, ${clock(slot.time)}`;
  return `${days.map((d) => WEEKDAY[d]).join(' & ')}, ${clock(slot.time)}`;
}

/** Build the view of one of the vendor's terms. */
export function buildTermView(
  term: Term,
  _activityPrice: number | null,
  locationName: (id: string) => string | undefined,
  /** Places still free per slot of a published term (term_slot_stats); a draft has every seat free. */
  placesLeft?: Record<string, number | null>,
): TermView {
  return {
    name: term.name.trim() || 'Your term',
    flexible: isFlexible(term),
    groups: term.groups.map((g) => ({ id: g.id, name: g.name })),
    allowMidTerm: term.allowMidTerm,
    minLeft: term.minLeft,
    reduce: term.reduce,
    reduceBy: term.reduceBy,
    trial: term.allowTrial,
    single: term.allowSingles,
    singlePrice: term.singlePrice,
    trialPrice: term.trialPrice,
    trialLimit: term.trialLimit,
    packages: term.allowPackages,
    // A saving is only meaningful against a single-session price the family can
    // actually pay. With a trial (or nothing) there is no such price to compare to.
    unitPrice: term.allowSingles ? term.singlePrice : null,
    slots: term.slots.map((s) => {
      const dates = slotDates(s).map((ymd) => {
        const { time } = dayTimeFor(s, new Date(`${ymd}T00:00:00`).getDay());
        return `${ymd}T${time}:00+08:00`;
      });
      return {
        key: s.id,
        groupId: s.groupId,
        clashWith: term.slots.filter((o) => o.groupId !== s.groupId && slotsClash(s, o)).map((o) => o.id),
        label: slotLabel(s),
        venue: s.locationId ? locationName(s.locationId) ?? null : null,
        dates,
        spotsLeft: term.status === 'published' ? placesLeft?.[s.id] ?? null : s.capacity,
        price: slotPrice(term, s),
      };
    }),
  };
}

export function quoteFor(view: TermView, slotIdx: number, passed: number): TermQuote | null {
  if (view.flexible) {
    // A pair: the first slot of each group stands in for the family's choice.
    const picks = view.groups.map((g) => view.slots.find((s) => s.groupId === g.id)).filter((s): s is TermViewSlot => !!s);
    if (picks.length === 0 || picks.some((s) => s.dates.length === 0)) return null;
    const price = picks[0].price;
    const per = picks[0].dates.length;
    const n = picks.reduce((x, s) => x + s.dates.length, 0);
    const lastJoin = lastJoinableAfter({ allowMidTerm: view.allowMidTerm, minLeft: view.minLeft }, per);
    const run = Math.min(passed, lastJoin);
    const payNow = priceAfter({ price, reduce: view.reduce, reduceBy: view.reduceBy }, run * picks.length);
    const spots = picks.map((s) => s.spotsLeft).filter((v): v is number => v != null);
    const slot: TermViewSlot = {
      key: 'pair', groupId: '', clashWith: [], label: picks.map((s) => s.label).join(' + '), venue: null,
      dates: picks.flatMap((s) => s.dates).sort(), spotsLeft: spots.length ? Math.min(...spots) : null, price,
    };
    return { slot, n, fullPrice: price, savings: null, lastJoin: lastJoin * picks.length, run: run * picks.length, left: n - run * picks.length, payNow, reducedBy: price - payNow, joining: slot.dates.slice(run * picks.length) };
  }
  const slot = view.slots[Math.min(slotIdx, view.slots.length - 1)];
  if (!slot || slot.dates.length === 0) return null;
  const n = slot.dates.length;
  const lastJoin = lastJoinableAfter({ allowMidTerm: view.allowMidTerm, minLeft: view.minLeft }, n);
  const run = Math.min(passed, lastJoin);
  const payNow = priceAfter({ price: slot.price, reduce: view.reduce, reduceBy: view.reduceBy }, run);
  const singlesTotal = view.unitPrice != null ? view.unitPrice * n : null;
  const savings = singlesTotal != null && singlesTotal > slot.price ? Math.round(singlesTotal - slot.price) : null;
  return {
    slot, n, fullPrice: slot.price, savings, lastJoin, run, left: n - run, payNow,
    reducedBy: slot.price - payNow, joining: slot.dates.slice(run),
  };
}

/** "How would you like to book?" — the cards. Mirrors BookModeChoice. */
export function BookModeChoice({
  view, quote, mode, onModeChange, trialUsed = 0,
}: {
  view: TermView;
  quote: TermQuote;
  mode: BookMode;
  onModeChange: (m: BookMode) => void;
  /** Trial sessions this child has already used with this vendor. */
  trialUsed?: number;
}) {
  const card = (m: BookMode) =>
    cn(
      'rounded-[12px] border p-4 text-left transition-colors',
      mode === m ? 'border-[#FFC1D6] bg-[#FEEBF2]' : 'border-[#DCD2D5] bg-white hover:border-[#FFC1D6]',
    );
  const midTerm = quote.run > 0;
  // Trial and single can both be on, but for now one at a time: while this
  // child still has a trial session left, only the trial is offered. Once they
  // have used every trial the vendor allows, the trial card goes and single
  // sessions (if offered) take its place.
  const trialLeft = Math.max(0, view.trialLimit - trialUsed);
  const showTrial = view.trial && trialLeft > 0;
  const trialUsedUp = view.trial && trialLeft === 0;
  const showSingle = view.single && !showTrial;

  return (
    <section>
      <h3 className="mb-4 text-xl font-black">How would you like to book?</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" aria-pressed={mode === 'term'} onClick={() => onModeChange('term')} className={card('term')}>
          <span className="flex items-center justify-between gap-2">
            <span className="font-black text-[#34406f]">{view.name}</span>
            <span className="rounded-full bg-[#DDF3EE] px-2 py-0.5 text-[11px] font-black text-[#0F6E56]">
              {midTerm ? `${quote.left} of ${quote.n} sessions left` : `${quote.n} sessions`}
            </span>
          </span>
          <span className="mt-1 block text-sm font-semibold text-[#59658d]">
            {sgDay(quote.joining[0])} to {sgDay(quote.slot.dates[quote.n - 1])}
          </span>
          <span className="mt-2 block text-lg font-black text-[#FA4D8D]">
            ${quote.payNow}
            {midTerm && quote.reducedBy > 0 && (
              <span className="ml-2 text-sm font-semibold text-[#697390] line-through">${quote.fullPrice}</span>
            )}
            {!midTerm && quote.savings != null && (
              <span className="ml-2 text-xs font-bold text-[#0F6E56]">Save ${quote.savings} vs single sessions</span>
            )}
          </span>
          {midTerm && (
            <span className="mt-1 block text-xs font-bold text-[#0F6E56]">Joining mid-term, price reduced for the sessions already run</span>
          )}
        </button>
        {showTrial && (
          <button type="button" aria-pressed={mode === 'trial'} onClick={() => onModeChange('trial')} className={card('trial')}>
            <span className="flex items-center justify-between gap-2">
              <span className="font-black text-[#34406f]">Trial session</span>
              <span className="rounded-full bg-[#FEEBF2] px-2 py-0.5 text-[11px] font-black text-[#FA4D8D]">
                {trialUsed > 0 ? `${trialLeft} of ${view.trialLimit} left` : `${view.trialLimit} per child`}
              </span>
            </span>
            <span className="mt-1 block text-sm font-semibold text-[#59658d]">Try one session before you commit</span>
            <span className="mt-2 block text-lg font-black text-[#FA4D8D]">${view.trialPrice}<span className="ml-1 text-sm font-semibold text-[#697390]">trial price</span></span>
          </button>
        )}
        {showSingle && (
          <button type="button" aria-pressed={mode === 'single'} onClick={() => onModeChange('single')} className={card('single')}>
            <span className="font-black text-[#34406f]">Single session</span>
            <span className="mt-1 block text-sm font-semibold text-[#59658d]">Pick one session and pay as you go</span>
            <span className="mt-2 block text-lg font-black text-[#FA4D8D]">${view.singlePrice}<span className="ml-1 text-sm font-semibold text-[#697390]">per session</span></span>
          </button>
        )}
        {view.packages && (
          <button type="button" aria-pressed={mode === 'package'} onClick={() => onModeChange('package')} className={card('package')}>
            <span className="font-black text-[#34406f]">Use a package</span>
            <span className="mt-1 block text-sm font-semibold text-[#59658d]">Book sessions when it suits you, using pack credits</span>
            <span className="mt-2 block text-sm font-black text-[#FA4D8D]">Any session of the term</span>
          </button>
        )}
      </div>
      {trialUsedUp && (
        <p className="mt-3 rounded-[10px] bg-[#FAF7F7] px-4 py-2.5 text-sm font-bold text-[#59658d]">
          {view.single
            ? 'This child has used their trial sessions, so single sessions are offered instead.'
            : 'This child has used their trial sessions.'}
        </p>
      )}
      {mode === 'trial' && (
        <p className="mt-3 rounded-[10px] bg-[#FEEBF2] px-4 py-2.5 text-sm font-bold text-[#FA4D8D]">
          Trial sessions are limited to {view.trialLimit} per child, at ${view.trialPrice}. Pick the session below.
        </p>
      )}
      {mode === 'package' && (
        <p className="mt-3 rounded-[10px] bg-[#F4F0FA] px-4 py-2.5 text-sm font-bold text-[#7A5BB5]">
          Choose any session of this term whenever it suits you and pay with a pack credit, or buy a pack at checkout.
        </p>
      )}
    </section>
  );
}

/** The term path: choose a slot, see every running date and the price. Mirrors TermEnrolPreview. */
export function TermEnrolPanel({
  view, slotIdx, onSlotChange, quote,
}: {
  view: TermView;
  slotIdx: number;
  onSlotChange: (i: number) => void;
  quote: TermQuote;
}) {
  const { slot, run, left, n, payNow, fullPrice, reducedBy } = quote;

  return (
    <section className="space-y-5">
      <div>
        <h3 className="mb-1 text-xl font-black">{view.name}</h3>
        <p className="text-sm font-semibold text-[#59658d]">One enrolment puts your child on every session below.</p>
      </div>

      <div>
        <h4 className="mb-2 font-black">Choose your time</h4>
        <div className="space-y-2">
          {view.slots.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={i === Math.min(slotIdx, view.slots.length - 1)}
              onClick={() => onSlotChange(i)}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left',
                s === slot ? 'border-[#FFC1D6] bg-[#FEEBF2]' : 'border-[#DCD2D5] bg-white',
              )}
            >
              <span>
                <span className="block font-black text-[#34406f]">{s.label}</span>
                <span className="block text-xs font-semibold text-[#697390]">
                  {s.dates.length} sessions from {sgDay(s.dates[0])}{s.venue ? ` · ${s.venue}` : ''}
                </span>
              </span>
              {s.spotsLeft === 0 ? (
                <span className="shrink-0 rounded-full bg-[#FEF2D7] px-2 py-0.5 text-[11px] font-black text-[#936700]">Full · waitlist</span>
              ) : s.spotsLeft != null && (
                <span className="shrink-0 text-xs font-bold text-[#697390]">{s.spotsLeft} {s.spotsLeft === 1 ? 'place' : 'places'} left</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-2 font-black">Running dates</h4>
        <div className="flex flex-wrap gap-2">
          {slot.dates.map((d, i) => (
            <span
              key={d}
              className={cn(
                'rounded-[8px] border px-2.5 py-1 text-xs font-bold',
                i < run ? 'border-[#EBE3E5] text-[#A8A1A5] line-through' : 'border-[#DCD2D5] text-[#34406f]',
              )}
            >
              {sgDay(d)}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-[12px] border border-[#DCD2D5] bg-[#FAF7F7] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-black text-[#34406f]">{run === 0 ? 'Full term' : `${left} of ${n} sessions left`}</span>
          <span className="text-2xl font-black text-[#FA4D8D]">
            ${payNow}
            {run > 0 && reducedBy > 0 && <span className="ml-2 text-sm font-semibold text-[#697390] line-through">${fullPrice}</span>}
          </span>
        </div>
        {run > 0 && reducedBy > 0 && (
          <p className="mt-1 text-sm font-semibold text-[#59658d]">
            {run} {run === 1 ? 'session has' : 'sessions have'} already run, so the price drops by ${reducedBy}.
          </p>
        )}
        {view.allowMidTerm && (
          <p className="mt-1 text-xs font-semibold text-[#697390]">Joining closes when {view.minLeft} sessions are left.</p>
        )}
        {!view.allowMidTerm && (
          <p className="mt-1 text-xs font-semibold text-[#697390]">Enrolment closes when the term starts.</p>
        )}
      </div>
    </section>
  );
}

/* ── Flexible terms (00264): one slot from each group ──
 *
 * Mirrors TermComboPicker in the parent app (components/TermBookingPreview.tsx):
 * a family picks one slot from each group and keeps that pair every week. The
 * vendor can click through it; nothing is saved. Keep the two in step. */
export function TermComboPanel({ view }: { view: TermView }) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const chosen = view.groups.map((g) => view.slots.find((s) => s.key === picks[g.id]) ?? null);
  const ready = chosen.every(Boolean);
  const full = chosen.filter((s): s is TermViewSlot => !!s && s.spotsLeft === 0);
  const nextGroup = view.groups.find((g) => !picks[g.id]);
  const n = chosen.reduce((x, s) => x + (s?.dates.length ?? 0), 0);
  const price = view.slots[0]?.price ?? 0;

  return (
    <section className="space-y-5">
      <div>
        <h3 className="mb-1 text-xl font-black">{view.name}</h3>
        <p className="text-sm font-semibold text-[#59658d]">
          Pick one session from each group. Your child will have these {view.groups.length} sessions every week of the term.
        </p>
      </div>

      {view.groups.map((g, gi) => (
        <div key={g.id}>
          <h4 className="mb-2 flex items-baseline justify-between gap-2 font-black">
            <span>{gi + 1} of {view.groups.length} · {g.name || 'Unnamed group'}</span>
            <span className="text-xs font-extrabold text-[#697390]">{picks[g.id] ? 'Picked' : 'Pick one'}</span>
          </h4>
          <div className="space-y-2">
            {view.slots.filter((s) => s.groupId === g.id).map((s) => {
              const on = picks[g.id] === s.key;
              const clash = !on && s.clashWith.some((k) => Object.values(picks).includes(k));
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={on}
                  disabled={clash}
                  onClick={() => setPicks((p) => {
                    // A pick drops any pick in another group that runs at the same time.
                    const next = { ...p, [g.id]: s.key };
                    for (const [g2, k2] of Object.entries(p)) if (g2 !== g.id && s.clashWith.includes(k2)) delete next[g2];
                    return next;
                  })}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left',
                    on ? 'border-[#FFC1D6] bg-[#FEEBF2]' : 'border-[#DCD2D5] bg-white',
                    clash && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <span>
                    <span className="block font-black text-[#34406f]">{s.label}</span>
                    <span className="block text-xs font-semibold text-[#697390]">{s.dates.length} sessions{s.venue ? ` · ${s.venue}` : ''}</span>
                  </span>
                  {clash ? (
                    <span className="shrink-0 text-xs font-bold text-[#697390]">Clashes with your other pick</span>
                  ) : s.spotsLeft === 0 ? (
                    <span className="shrink-0 rounded-full bg-[#FEF2D7] px-2 py-0.5 text-[11px] font-black text-[#936700]">Full · waitlist</span>
                  ) : s.spotsLeft != null && (
                    <span className="shrink-0 text-xs font-bold text-[#697390]">{s.spotsLeft} {s.spotsLeft === 1 ? 'place' : 'places'} left</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="rounded-[12px] border border-[#DCD2D5] bg-[#FAF7F7] p-4" aria-live="polite">
        <div className="font-black text-[#34406f]">Your week</div>
        {!ready ? (
          <p className="mt-1 text-sm font-semibold text-[#59658d]">
            {chosen.some(Boolean) && nextGroup ? `Now pick one from ${nextGroup.name || 'the next group'}.` : 'Pick one session from each group to see your price.'}
          </p>
        ) : (
          <>
            <ul className="mt-2 space-y-1.5">
              {view.groups.map((g, i) => (
                <li key={g.id} className="flex items-baseline justify-between gap-2 font-extrabold text-[#34406f]">
                  <span>{chosen[i]!.label}</span>
                  <span className="text-xs font-bold text-[#697390]">{g.name}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-black text-[#34406f]">Full term · {n} sessions</span>
              <span className="text-2xl font-black text-[#FA4D8D]">${price}</span>
            </div>
            <p className="mt-1 text-xs font-semibold text-[#697390]">
              Same {view.groups.length} sessions every week.{' '}
              {view.allowMidTerm ? `Joining closes when ${view.minLeft} sessions are left in a slot.` : 'Joining closes once the term starts.'}
            </p>
            {full.length > 0 && (
              <p className="mt-2 rounded-[10px] bg-[#FEF2D7] px-3 py-2 text-sm font-bold text-[#936700]">
                {full.map((s) => s.label).join(' and ')} {full.length === 1 ? 'is' : 'are'} full. Join the waitlist for this exact pair for free.
                We'll tell you when {full.length === 1 ? 'it has a place and your other sessions do too' : 'all of them have places'}. The first family to enrol gets them.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* ── One session of a term: trial, single or package ──
 *
 * Shown under "How would you like to book?" when a family books one session
 * rather than the whole term: they pick one of the term's groups, then one of
 * its dates. Identical in the parent app (components/TermBookingPreview.tsx) and
 * the vendor portal's Parent view (components/ParentTermBooking.tsx). */

/** `spots`, when known: places still free on each of `dates` (null = no limit).
 *  A full date can still be picked; booking it joins that session's waitlist. */
export type PickerGroup = { key: string; label: string; venue?: string | null; dates: string[]; spots?: (number | null)[] };

export function TermSessionPicker({
  groups, groupIdx, onGroupChange, from = 0, selected, onSelect,
}: {
  groups: PickerGroup[];
  groupIdx: number;
  onGroupChange: (i: number) => void;
  /** Sessions of each group that have already run. */
  from?: number;
  selected: string | null;
  onSelect: (iso: string) => void;
}) {
  const group = groups[Math.min(groupIdx, groups.length - 1)];
  if (!group) return null;
  const open = group.dates.slice(from);
  const openSpots = group.spots?.slice(from);
  return (
    <section className="space-y-6">
      <div>
        <h3 className="mb-4 text-xl font-black">Choose your time</h3>
        <div className="space-y-2">
          {groups.map((g, i) => {
            const left = Math.max(0, g.dates.length - from);
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={g === group}
                onClick={() => onGroupChange(i)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left',
                  g === group ? 'border-[#FFC1D6] bg-[#FEEBF2]' : 'border-[#DCD2D5] bg-white',
                )}
              >
                <span>
                  <span className="block font-black text-[#34406f]">{g.label}</span>
                  <span className="block text-xs font-semibold text-[#697390]">
                    {left} {left === 1 ? 'session' : 'sessions'} to choose from{g.venue ? ` · ${g.venue}` : ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <h3 className="mb-4 text-xl font-black">Choose a date</h3>
        {open.length === 0 ? (
          <p className="rounded-[12px] bg-[#FFF5F8] p-4 font-semibold text-[#5a6690]">No sessions left in this group.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {open.map((d, i) => {
              const [weekday, dayMonth] = sgDay(d).split(', ');
              const spots = openSpots?.[i];
              const full = spots != null && spots <= 0;
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={d === selected}
                  onClick={() => onSelect(d)}
                  className={cn(
                    'rounded-[10px] border px-3 py-4 text-left text-sm font-bold',
                    d === selected ? 'border-[#FA4D8D] bg-[#FEEBF2] text-[#FA4D8D]' : 'border-[#DCD2D5] bg-white',
                  )}
                >
                  <span className="block whitespace-nowrap">{weekday},</span>
                  <span className="block whitespace-nowrap">{dayMonth}</span>
                  <span className="mt-2 block text-xs font-semibold text-[#697390]">{sgTime(d)}</span>
                  {full && (
                    <span className="mt-1.5 inline-block rounded-full bg-[#FEF2D7] px-2 py-0.5 text-[11px] font-black text-[#936700]">Full · waitlist</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/* ── "Which term?" on the booking page ──
 *
 * Shown above "How would you like to book?" when an activity has more than one
 * term open, so a family can pick the one they want; the choices below then
 * follow that term. Identical in the parent app (components/TermBookingPreview.tsx)
 * and the vendor portal's Parent view (components/ParentTermBooking.tsx). */
export function TermPicker({
  terms, selected, onSelect,
}: { terms: OfferingTerm[]; selected: string; onSelect: (key: string) => void }) {
  if (terms.length < 2) return null;
  return (
    <section>
      <h3 className="mb-4 text-xl font-black">Which term?</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {terms.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={t.key === selected}
            onClick={() => onSelect(t.key)}
            className={cn(
              'rounded-[12px] border p-4 text-left transition-colors',
              t.key === selected ? 'border-[#FFC1D6] bg-[#FEEBF2]' : 'border-[#DCD2D5] bg-white hover:border-[#FFC1D6]',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-black text-[#34406f]">{t.name}</span>
              <span className="rounded-full bg-[#DDF3EE] px-2 py-0.5 text-[11px] font-black text-[#0F6E56]">{t.sessions}</span>
            </span>
            <span className="mt-1 block text-sm font-semibold text-[#59658d]">{t.range}</span>
            <span className="mt-2 block text-lg font-black text-[#FA4D8D]">{t.price}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ── The "Upcoming" block of the activity page for a term-enabled activity ──
 *
 * Shows what a family can actually sign up for: the terms, the one-off session
 * (trial or single), and the packages. Purely presentational: each app builds
 * the lines. This block is identical in the parent app
 * (components/TermBookingPreview.tsx) and the vendor portal's Parent view
 * (components/ParentTermBooking.tsx). Keep the two in step. */

export type OfferingTerm = {
  key: string;
  name: string;
  /** "10 sessions", or "10 to 12 sessions" when slots differ. */
  sessions: string;
  /** "Sat, 17 Oct to Wed, 23 Dec". */
  range: string;
  slots: { label: string; venue?: string | null }[];
  /** "$250", or "From $250" when slots are priced differently. */
  price: string;
};

export type OfferingOneOff = { kind: 'trial' | 'single'; price: string; note: string };

export type OfferingPack = { id: string; name: string; sessions: number; price: string };

export function UpcomingOfferings({
  terms, oneOffs, packs,
}: { terms: OfferingTerm[]; oneOffs: OfferingOneOff[]; packs: OfferingPack[] }) {
  const empty = terms.length === 0 && oneOffs.length === 0 && packs.length === 0;
  if (empty) return <p className="text-sm font-semibold text-[#68718f]">Nothing is open for booking right now.</p>;
  return (
    <div className="space-y-5">
      {terms.length > 0 && (
        <div>
          <h3 className="mb-2 font-black">{terms.length === 1 ? 'Term' : 'Terms'}</h3>
          <div className="space-y-2">
            {terms.map((t) => (
              <div key={t.key} className="rounded-[12px] border border-[#EBE3E5] bg-[#FAF7F7] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-black text-[#34406f]">{t.name}</span>
                  <span className="rounded-full bg-[#DDF3EE] px-2 py-0.5 text-[11px] font-black text-[#0F6E56]">{t.sessions}</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-[#59658d]">{t.range}</p>
                <ul className="mt-2 space-y-0.5">
                  {t.slots.map((s, i) => (
                    <li key={i} className="text-xs font-semibold text-[#697390]">{s.label}{s.venue ? ` · ${s.venue}` : ''}</li>
                  ))}
                </ul>
                <p className="mt-2 text-lg font-black text-[#FA4D8D]">{t.price}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {oneOffs.map((o) => (
        <div key={o.kind}>
          <h3 className="mb-2 font-black">{o.kind === 'trial' ? 'Trial session' : 'Single sessions'}</h3>
          <div className="rounded-[12px] border border-[#EBE3E5] bg-[#FAF7F7] p-4">
            <p className="text-lg font-black text-[#FA4D8D]">
              {o.price}
              <span className="ml-1 text-sm font-semibold text-[#697390]">{o.kind === 'trial' ? 'trial price' : 'per session'}</span>
            </p>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">{o.note}</p>
          </div>
        </div>
      ))}
      {packs.length > 0 && (
        <div>
          <h3 className="mb-2 font-black">Packages</h3>
          <div className="space-y-2">
            {packs.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-[#EBE3E5] bg-[#FAF7F7] p-4">
                <div>
                  <span className="block font-black text-[#34406f]">{p.name}</span>
                  <span className="text-sm font-semibold text-[#59658d]">{p.sessions} {p.sessions === 1 ? 'session' : 'sessions'}</span>
                </div>
                <span className="font-black text-[#FA4D8D]">{p.price}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The vendor's term as a line on the activity page's "Upcoming" block. */
export function offeringFor(view: TermView, key: string): OfferingTerm {
  if (view.flexible) {
    const money2 = (x: number) => `$${x % 1 === 0 ? x.toFixed(0) : x.toFixed(2)}`;
    const everyDate = view.slots.flatMap((s) => s.dates).sort();
    const perFamily = view.groups.reduce((x, g) => x + (view.slots.find((s) => s.groupId === g.id)?.dates.length ?? 0), 0);
    return {
      key,
      name: view.name,
      sessions: `${perFamily} sessions`,
      range: everyDate.length > 0 ? `${sgDay(everyDate[0])} to ${sgDay(everyDate[everyDate.length - 1])}` : '',
      slots: view.groups.map((g) => ({ label: `Choose 1 of ${view.slots.filter((s) => s.groupId === g.id).length} · ${g.name || 'Unnamed group'}`, venue: null })),
      price: `${money2(view.slots[0]?.price ?? 0)} for ${view.groups.length} sessions a week`,
    };
  }
  const counts = view.slots.map((s) => s.dates.length);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  const all = view.slots.flatMap((s) => s.dates).sort();
  const prices = view.slots.map((s) => s.price);
  const cheapest = Math.min(...prices);
  const money = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
  return {
    key,
    name: view.name,
    sessions: lo === hi ? `${lo} sessions` : `${lo} to ${hi} sessions`,
    range: all.length > 0 ? `${sgDay(all[0])} to ${sgDay(all[all.length - 1])}` : '',
    slots: view.slots.map((s) => ({ label: s.label, venue: s.venue })),
    price: Math.max(...prices) === cheapest ? money(cheapest) : `From ${money(cheapest)}`,
  };
}

/** The one-off options parents see across the vendor's terms: a trial session
 *  if any term has one, and single sessions if any term sells them. */
export function oneOffFor(views: TermView[]): OfferingOneOff[] {
  const money = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
  const out: OfferingOneOff[] = [];
  const trial = views.filter((v) => v.trial);
  if (trial.length > 0) {
    const best = trial.reduce((a, b) => (b.trialPrice < a.trialPrice ? b : a));
    out.push({ kind: 'trial', price: money(best.trialPrice), note: `Try one session before you commit. Limited to ${best.trialLimit} per child.` });
  }
  const single = views.filter((v) => v.single);
  if (single.length > 0) {
    const best = single.reduce((a, b) => (b.singlePrice < a.singlePrice ? b : a));
    out.push({
      kind: 'single',
      price: money(best.singlePrice),
      note: trial.length > 0 ? 'Pick one session and pay as you go, once your child has used their trial.' : 'Pick one session and pay as you go.',
    });
  }
  return out;
}
