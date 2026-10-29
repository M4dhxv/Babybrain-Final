import type { PreviewSlot } from "../lib/termsPreview";
import { sgDay, sgTime } from "../lib/schedule";

/** term = enrol for the whole term; single / trial = one session; package = pick
 *  sessions when convenient and pay with pack credits. */
export type BookMode = "term" | "single" | "trial" | "package";

/** What the vendor has switched on for this term: a trial session, single
 *  sessions, either, both or neither; packages are independent. Once a child
 *  has used their trial sessions only single sessions are offered. In the real
 *  feature this comes from the term itself; here a preview control sets it. */
export type TermOffer = { trial: boolean; single: boolean; packages: boolean; trialLimit: number; trialUsed: number };

export const DEFAULT_OFFER: TermOffer = { trial: false, single: false, packages: true, trialLimit: 1, trialUsed: 0 };

/** Placeholder trial price: half the single-session price. */
export const trialPriceFor = (price: number | null) => (price != null ? Math.max(1, Math.round(price * 0.5)) : null);

/** A term stops taking new joiners when this many sessions are left (vendor setting, once built). */
export const TERM_MIN_LEFT = 3;

export type TermQuote = {
  slot: PreviewSlot;
  n: number;
  /** Full-term price. Placeholder: the vendor will set this; here it is derived from the single-session price. */
  fullPrice: number | null;
  perClass: number | null;
  singlesTotal: number | null;
  /** What the term saves against booking every session singly — null when it saves nothing. */
  savings: number | null;
  lastJoin: number;
  run: number;
  left: number;
  payNow: number | null;
  /** The sessions the child ends up on (past ones dropped). */
  joining: string[];
};

export function termQuote(slots: PreviewSlot[], slotIdx: number, passed: number, price: number | null): TermQuote | null {
  const slot = slots[Math.min(slotIdx, slots.length - 1)];
  if (!slot) return null;
  const n = slot.dates.length;
  const singlesTotal = price != null ? Math.round(price * n) : null;
  const fullPrice = price != null ? Math.round(price * n * 0.9) : null;
  const perClass = fullPrice != null ? Math.round(fullPrice / n) : null;
  const lastJoin = Math.max(0, n - TERM_MIN_LEFT);
  const run = Math.min(passed, lastJoin);
  const payNow = fullPrice != null && perClass != null ? Math.max(0, fullPrice - perClass * run) : null;
  const savings = singlesTotal != null && fullPrice != null && singlesTotal > fullPrice ? singlesTotal - fullPrice : null;
  return { slot, n, fullPrice, perClass, singlesTotal, savings, lastJoin, run, left: n - run, payNow, joining: slot.dates.slice(run) };
}

/**
 * "How would you like to book?" — a term (one enrolment, every session) or a
 * single session. Rendered at the top of the booking form.
 *
 * UI PREVIEW: the term here is derived from the activity's real sessions and
 * priced from the single-session price. Nothing is saved or charged.
 *
 * The vendor portal's "Parent view" preview mirrors this markup
 * (frontends/vendor/src/components/ParentTermBooking.tsx) so a vendor sees what
 * a family sees. Keep the two in step: copy, structure and classes.
 */
export function BookModeChoice({
  quote, price, trialPrice, mode, onModeChange, offer, termName,
}: {
  /** The vendor's name for the term. */
  termName?: string;
  quote: TermQuote;
  /** The term's single-session price; null when it sells none. */
  price: number | null;
  /** The term's trial price; null when it has no trial. */
  trialPrice: number | null;
  mode: BookMode;
  onModeChange: (m: BookMode) => void;
  offer: TermOffer;
}) {
  const card = (m: BookMode) =>
    `rounded-[12px] border p-4 text-left transition-colors ${mode === m ? "border-baby-pink bg-[#FEEBF2]" : "border-[#DCD2D5] bg-white hover:border-baby-pink"}`;
  const midTerm = quote.run > 0;
  // Trial and single can both be on, but for now one at a time: while this
  // child still has a trial session left, only the trial is offered. Once they
  // have used every trial the vendor allows, the trial card goes and single
  // sessions (if offered) take its place.
  const trialLeft = Math.max(0, offer.trialLimit - offer.trialUsed);
  const showTrial = offer.trial && trialLeft > 0;
  const trialUsedUp = offer.trial && trialLeft === 0;
  const showSingle = offer.single && !showTrial;

  return (
    <section>
      <h3 className="mb-4 text-xl font-black">How would you like to book?</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" aria-pressed={mode === "term"} onClick={() => onModeChange("term")} className={card("term")}>
          <span className="flex items-center justify-between gap-2">
            <span className="font-black text-[#34406f]">{termName ?? "Whole term"}</span>
            <span className="rounded-full bg-[#DDF3EE] px-2 py-0.5 text-[11px] font-black text-[#0F6E56]">
              {midTerm ? `${quote.left} of ${quote.n} sessions left` : `${quote.n} sessions`}
            </span>
          </span>
          <span className="mt-1 block text-sm font-semibold text-[#59658d]">
            {sgDay(quote.joining[0])} to {sgDay(quote.slot.dates[quote.n - 1])}
          </span>
          {quote.payNow != null && (
            <span className="mt-2 block text-lg font-black text-baby-cta">
              ${quote.payNow}
              {midTerm && quote.fullPrice != null && quote.payNow < quote.fullPrice && (
                <span className="ml-2 text-sm font-semibold text-[#697390] line-through">${quote.fullPrice}</span>
              )}
              {!midTerm && offer.single && quote.savings != null && (
                <span className="ml-2 text-xs font-bold text-[#0F6E56]">Save ${quote.savings} vs single sessions</span>
              )}
            </span>
          )}
          {midTerm && (
            <span className="mt-1 block text-xs font-bold text-[#0F6E56]">
              Join from {sgDay(quote.joining[0])} · {quote.left} sessions
              {quote.perClass != null && quote.perClass > 0 ? ` · $${quote.perClass * quote.run} off for the ${quote.run} already run` : ""}
            </span>
          )}
        </button>
        {showTrial && (
          <button type="button" aria-pressed={mode === "trial"} onClick={() => onModeChange("trial")} className={card("trial")}>
            <span className="flex items-center justify-between gap-2">
              <span className="font-black text-[#34406f]">Trial session</span>
              <span className="rounded-full bg-[#FEEBF2] px-2 py-0.5 text-[11px] font-black text-baby-cta">
                {offer.trialUsed > 0 ? `${trialLeft} of ${offer.trialLimit} left` : `${offer.trialLimit} per child`}
              </span>
            </span>
            <span className="mt-1 block text-sm font-semibold text-[#59658d]">Try one session before you commit</span>
            {trialPrice != null && <span className="mt-2 block text-lg font-black text-baby-cta">${trialPrice}<span className="ml-1 text-sm font-semibold text-[#697390]">trial price</span></span>}
          </button>
        )}
        {showSingle && (
          <button type="button" aria-pressed={mode === "single"} onClick={() => onModeChange("single")} className={card("single")}>
            <span className="font-black text-[#34406f]">Single session</span>
            <span className="mt-1 block text-sm font-semibold text-[#59658d]">Pick one session and pay as you go</span>
            {price != null && <span className="mt-2 block text-lg font-black text-baby-cta">${price}<span className="ml-1 text-sm font-semibold text-[#697390]">per session</span></span>}
          </button>
        )}
        {offer.packages && (
          <button type="button" aria-pressed={mode === "package"} onClick={() => onModeChange("package")} className={card("package")}>
            <span className="font-black text-[#34406f]">Use a package</span>
            <span className="mt-1 block text-sm font-semibold text-[#59658d]">Book sessions when it suits you, using pack credits</span>
            <span className="mt-2 block text-sm font-black text-baby-cta">Any session of the term</span>
          </button>
        )}
      </div>
      {trialUsedUp && (
        <p className="mt-3 rounded-[10px] bg-[#FAF7F7] px-4 py-2.5 text-sm font-bold text-[#59658d]">
          {offer.single
            ? "This child has used their trial sessions, so single sessions are offered instead."
            : "This child has used their trial sessions."}
        </p>
      )}
      {mode === "trial" && (
        <p className="mt-3 rounded-[10px] bg-[#FEEBF2] px-4 py-2.5 text-sm font-bold text-baby-cta">
          Trial sessions are limited to {offer.trialLimit} per child{trialPrice != null ? `, at $${trialPrice}` : ""}. Pick the session below.
        </p>
      )}
      {mode === "package" && (
        <p className="mt-3 rounded-[10px] bg-[#F4F0FA] px-4 py-2.5 text-sm font-bold text-[#7A5BB5]">
          Choose any session of this term whenever it suits you and pay with a pack credit, or buy a pack at checkout.
        </p>
      )}
    </section>
  );
}

/** The term path: choose a slot and see every running date and the price. The
 *  consent steps and the Enrol button are the booking page's own. */
export function TermEnrolPreview({
  slots, onSlotChange, quote, childName, activityTitle, termName, minLeft, allowMidTerm, reason,
}: {
  /** The vendor's name for the term; falls back to "<activity> · Term". */
  termName?: string;
  slots: PreviewSlot[];
  onSlotChange: (i: number) => void;
  quote: TermQuote;
  childName: string;
  activityTitle: string;
  /** Joining closes once this many sessions are left. */
  minLeft: number;
  allowMidTerm: boolean;
  /** Why this slot can't be joined right now, if it can't. */
  reason?: string | null;
}) {
  const { slot, run, left, n, payNow, fullPrice, perClass } = quote;

  return (
    <section className="space-y-5">
      {reason && (
        <div className="rounded-[10px] bg-[#FEF2D7] px-4 py-2.5 text-sm font-bold text-yellow-700">{reason}</div>
      )}

      <div>
        <h3 className="mb-1 text-xl font-black">{termName ?? `${activityTitle} · Term`}</h3>
        <p className="text-sm font-semibold text-[#59658d]">One enrolment puts {childName} on every session below.</p>
      </div>

      <div>
        <h4 className="mb-2 font-black">Choose your group</h4>
        <div className="space-y-2">
          {slots.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={s === slot}
              onClick={() => onSlotChange(i)}
              className={`flex w-full items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left ${s === slot ? "border-baby-pink bg-[#FEEBF2]" : "border-[#DCD2D5] bg-white"}`}
            >
              <span>
                <span className="block font-black text-[#34406f]">{s.label}</span>
                <span className="block text-xs font-semibold text-[#697390]">{s.dates.length} sessions from {sgDay(s.dates[0])}{s.venue ? ` · ${s.venue}` : ""}</span>
              </span>
              {s.spotsLeft != null && <span className="shrink-0 text-xs font-bold text-[#697390]">{s.spotsLeft} {s.spotsLeft === 1 ? "place" : "places"} left</span>}
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
              className={`rounded-[8px] border px-2.5 py-1 text-xs font-bold ${i < run ? "border-[#EBE3E5] text-[#A8A1A5] line-through" : "border-[#DCD2D5] text-[#34406f]"}`}
            >
              {sgDay(d)}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-[12px] border border-[#DCD2D5] bg-[#FAF7F7] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-black text-[#34406f]">
            {run === 0 ? `Full term · ${n} sessions` : `Join from ${sgDay(quote.joining[0])} · ${left} of ${n} sessions`}
          </span>
          {payNow != null && (
            <span className="text-2xl font-black text-baby-cta">
              ${payNow}
              {run > 0 && fullPrice != null && payNow < fullPrice && <span className="ml-2 text-sm font-semibold text-[#697390] line-through">${fullPrice}</span>}
            </span>
          )}
        </div>
        {run > 0 && (
          <p className="mt-1 text-sm font-semibold text-[#59658d]">
            {run} {run === 1 ? "session has" : "sessions have"} already run.{" "}
            {perClass != null && perClass > 0
              ? `You pay $${fullPrice} less $${perClass} for each, so $${payNow}.`
              : `This term is the same price whenever you join.`}
          </p>
        )}
        <p className="mt-1 text-xs font-semibold text-[#697390]">
          {allowMidTerm ? `Joining closes when ${minLeft} sessions are left.` : "Joining closes once the term starts."}
        </p>
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
        <h3 className="mb-4 text-xl font-black">Choose your group</h3>
        <div className="space-y-2">
          {groups.map((g, i) => {
            const left = Math.max(0, g.dates.length - from);
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={g === group}
                onClick={() => onGroupChange(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left ${g === group ? "border-baby-pink bg-[#FEEBF2]" : "border-[#DCD2D5] bg-white"}`}
              >
                <span>
                  <span className="block font-black text-[#34406f]">{g.label}</span>
                  <span className="block text-xs font-semibold text-[#697390]">
                    {left} {left === 1 ? "session" : "sessions"} to choose from{g.venue ? ` · ${g.venue}` : ""}
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
              const [weekday, dayMonth] = sgDay(d).split(", ");
              const spots = openSpots?.[i];
              const full = spots != null && spots <= 0;
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={d === selected}
                  onClick={() => onSelect(d)}
                  className={`rounded-[10px] border px-3 py-4 text-left text-sm font-bold ${d === selected ? "border-baby-pink bg-[#FEEBF2] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}
                >
                  <span className="block whitespace-nowrap">{weekday},</span>
                  <span className="block whitespace-nowrap">{dayMonth}</span>
                  <span className="mt-2 block text-xs font-semibold text-[#697390]">{sgTime(d)}</span>
                  {full && (
                    <span className="mt-1.5 inline-block rounded-full bg-palette-yellowSoft px-2 py-0.5 text-[11px] font-black text-palette-yellowInk">Full · waitlist</span>
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
            className={`rounded-[12px] border p-4 text-left transition-colors ${t.key === selected ? "border-baby-pink bg-[#FEEBF2]" : "border-[#DCD2D5] bg-white hover:border-baby-pink"}`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-black text-[#34406f]">{t.name}</span>
              <span className="rounded-full bg-[#DDF3EE] px-2 py-0.5 text-[11px] font-black text-[#0F6E56]">{t.sessions}</span>
            </span>
            <span className="mt-1 block text-sm font-semibold text-[#59658d]">{t.range}</span>
            <span className="mt-2 block text-lg font-black text-baby-cta">{t.price}</span>
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
