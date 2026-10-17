import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Pencil, CalendarRange, Info, ArrowLeft, Ticket, Package, Check, Users, Copy, Repeat } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { SelectField, Opt } from '@/components/ui/select-field';
import { DatePicker } from '@/components/ui/date-picker';
import { TimePicker, formatTime } from '@/components/ui/time-picker';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { useProviderQuery } from '@/lib/useProviderQuery';
import { ToggleRow } from '@/components/FormKit';
import {
  blankTerm, dayTimeFor, deleteTerm, fmtRange, fmtShort, lastJoinableAfter, newId, normalizeTerm, priceAfter,
  saveTerm, slotDates, slotPatternDates, slotPrice, termStatus, useTerms, MAX_TERM_SESSIONS, MAX_TERM_WEEKS,
  fetchTermRoster, fetchTermSlotStats, nextTermFrom, openReenrolment, publicHolidaysIn, vendorWithdraw, SG_PUBLIC_HOLIDAYS,
  type RosterRow, type SlotStats, type Term, type TermSlot, type TermStatusKey,
} from '@/lib/termsPreview';

/* Type scale for this panel: bold section titles, semibold labels, and 15px
   medium inputs, so a long form with many options stays scannable. */
const inputCls =
  'w-full h-11 px-4 border border-gray-300 rounded-xl text-[15px] font-medium text-gray-900 placeholder:font-normal placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-pink-300';
const labelCls = 'mb-1.5 block text-sm font-semibold text-gray-800';
const hintCls = 'text-[13px] leading-snug text-gray-500';

const STATUS_STYLE: Record<TermStatusKey, string> = {
  draft: 'bg-gray-100 text-gray-700',
  upcoming: 'bg-blue-100 text-blue-800',
  running: 'bg-green-100 text-green-800',
  closed: 'bg-amber-100 text-amber-900',
  ended: 'bg-gray-100 text-gray-500',
};

const WEEKDAYS = [
  { i: 1, label: 'M', name: 'Monday' },
  { i: 2, label: 'T', name: 'Tuesday' },
  { i: 3, label: 'W', name: 'Wednesday' },
  { i: 4, label: 'T', name: 'Thursday' },
  { i: 5, label: 'F', name: 'Friday' },
  { i: 6, label: 'S', name: 'Saturday' },
  { i: 0, label: 'S', name: 'Sunday' },
];

type Loc = { id: string; name: string };
type Pack = { id: string; name: string; credits: number; price_cents: number; activity_ids: string[] | null };

function Section({
  n, title, subtitle, children,
}: { n: number; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#FA4D8D] text-sm font-bold text-white">{n}</span>
        <div>
          <h4 className="text-lg font-bold leading-7 text-gray-900">{title}</h4>
          {subtitle && <p className={cn('mt-0.5', hintCls)}>{subtitle}</p>}
        </div>
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

/**
 * "Terms" tab of the Manage schedule pop-up — a bundle of weekly sessions a
 * parent enrols in once (a term, a month, a block of weeks), instead of
 * booking session by session.
 *
 * UI PREVIEW: terms are held in the browser only (see lib/termsPreview.ts).
 */
export function TermsPanel({
  activityId, activityTitle, defaultPrice, defaultCapacity, defaultLocationId, locations,
}: {
  activityId: string;
  activityTitle: string;
  defaultPrice: number | null;
  defaultCapacity: number | null;
  defaultLocationId: string | null;
  locations: Loc[];
}) {
  const all = useTerms();
  const terms = useMemo(() => all.filter((t) => t.activityId === activityId), [all, activityId]);
  const [draft, setDraft] = useState<Term | null>(null);

  const banner = (
    <div className="flex items-start gap-2.5 rounded-xl border border-teal-200 bg-teal-50 p-3.5 text-sm text-teal-900">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        A draft is only visible to you. Publishing puts every session on your schedule and opens the term to
        parents; after that its days, times and venue are fixed.
      </span>
    </div>
  );

  if (!draft) {
    return (
      <div className="space-y-5">
        {banner}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-lg font-bold text-gray-900">Terms for {activityTitle}</h4>
            <p className={hintCls}>Parents enrol once and are added to every session of the term.</p>
          </div>
          <Button
            onClick={() => setDraft(blankTerm(activityId, { price: defaultPrice, capacity: defaultCapacity, locationId: defaultLocationId }))}
            className="h-11 rounded-xl px-5 text-[15px] font-bold gradient-primary text-white hover:opacity-90"
          >
            <Plus className="mr-1.5 h-5 w-5" /> New term
          </Button>
        </div>

        {terms.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-gray-300 p-10 text-center">
            <CalendarRange className="mx-auto h-9 w-9 text-gray-300" />
            <p className="mt-3 text-base font-bold text-gray-800">Start your first term</p>
            <p className={cn('mx-auto mt-1 max-w-xs', hintCls)}>
              Bundle a block of weekly sessions, set the groups and price, and choose whether parents can join mid-way.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {terms.map((t) => {
              const n = slotDates(t.slots[0] ?? { days: [], start: '', weeks: 0 }).length;
              const status = termStatus(t);
              return (
                <div key={t.id} className="rounded-2xl border border-gray-200 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-bold text-gray-900">{t.name || 'Untitled term'}</span>
                        <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-bold', STATUS_STYLE[status.key])}>{status.label}</span>
                      </div>
                      <p className="mt-1 text-sm text-gray-600">
                        {n} sessions · SGD {t.price} · {t.slots.length} group{t.slots.length === 1 ? '' : 's'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="rounded-md bg-teal-100 px-2 py-0.5 text-xs font-bold text-teal-900">Whole term</span>
                        {t.allowTrial && <span className="rounded-md bg-pink-100 px-2 py-0.5 text-xs font-bold text-pink-900">Trial · {t.trialLimit} per child</span>}
                        {t.allowSingles && <span className="rounded-md bg-pink-100 px-2 py-0.5 text-xs font-bold text-pink-900">Single sessions</span>}
                        {t.allowPackages && <span className="rounded-md bg-purple-100 px-2 py-0.5 text-xs font-bold text-purple-900">Packages</span>}
                      </div>
                      {t.siblingDiscountPct > 0 && (
                        <p className="mt-1.5 text-xs font-semibold text-gray-600">Sibling discount {t.siblingDiscountPct}%</p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => setDraft(structuredClone(t))} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800" title="Edit term" aria-label="Edit term">
                        <Pencil className="h-5 w-5" />
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            const how = await deleteTerm(t.id);
                            toast(how === 'archived' ? 'Term archived. It stops taking enrolments; its sessions stay on your schedule.' : 'Draft term deleted');
                          } catch (e) {
                            toast.error('Could not remove the term', { description: (e as { message?: string })?.message });
                          }
                        }}
                        className="rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-600"
                        title="Delete term"
                        aria-label="Delete term"
                      >
                        <Trash2 className="h-5 w-5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1 border-t border-gray-100 pt-3">
                    {t.slots.map((s) => {
                      const days = WEEKDAYS.filter((d) => s.days.includes(d.i));
                      return (
                        <p key={s.id} className="text-sm text-gray-700">
                          <span className="font-semibold">
                            {days.map((d) => (s.perDay ? `${d.name.slice(0, 3)} ${formatTime(dayTimeFor(s, d.i).time)}` : d.name.slice(0, 3))).join(', ')}
                            {!s.perDay && ` ${formatTime(s.time)}`}
                          </span>
                          {s.locationId ? ` · ${locations.find((l) => l.id === s.locationId)?.name ?? 'Other venue'}` : ''}
                          {' · '}{fmtRange(slotDates(s))}
                          {s.price != null ? ` · SGD ${s.price}` : ''}
                          {(s.skip ?? []).length > 0 ? ` · ${(s.skip ?? []).length} skipped` : ''}
                        </p>
                      );
                    })}
                  </div>
                  {t.status === 'published' && (
                    <PublishedTermTools term={t} hasNext={terms.some((x) => x.previousTermId === t.id)} onCopy={() => setDraft(nextTermFrom(t))} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <TermForm
      key={draft.id}
      term={draft}
      isNew={!all.some((t) => t.id === draft.id)}
      locations={locations}
      defaultCapacity={defaultCapacity}
      banner={banner}
      onCancel={() => setDraft(null)}
      onSave={async (t) => {
        const publishing = t.status === 'published' && all.find((x) => x.id === t.id)?.status !== 'published';
        try {
          await saveTerm(t);
          setDraft(null);
          toast(publishing ? 'Term published. Its sessions are on your schedule and parents can enrol.' : t.status === 'published' ? 'Term updated' : 'Term saved as draft');
        } catch (e) {
          toast.error(publishing ? 'Could not publish the term' : 'Could not save the term', { description: (e as { message?: string })?.message });
        }
      }}
    />
  );
}

function TermForm({
  term, isNew, locations, defaultCapacity, banner, onCancel, onSave,
}: {
  term: Term;
  isNew: boolean;
  locations: Loc[];
  defaultCapacity: number | null;
  banner: ReactNode;
  onCancel: () => void;
  onSave: (t: Term) => void;
}) {
  const { provider } = useAuth();
  const [t, setT] = useState<Term>(() => normalizeTerm(term));
  const [error, setError] = useState<string | null>(null);
  // Which slot the "what a parent pays" ladder is shown for.
  const [ladderIdx, setLadderIdx] = useState(0);
  // What is being typed in "Number of sessions", so the box can be cleared and
  // retyped without snapping back to 1.
  const [sessionsDraft, setSessionsDraft] = useState<string | null>(null);
  const set = (patch: Partial<Term>) => setT((x) => ({ ...x, ...patch }));
  const setSlot = (id: string, patch: Partial<TermSlot>) =>
    setT((x) => ({ ...x, slots: x.slots.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  // The provider's own active packages — shown so the vendor can see what
  // "open to packages" means in practice. Read-only.
  const { data: packs } = useProviderQuery<Pack[]>(
    provider ? `term-packs:${provider.id}` : null,
    async () => {
      const { data, error: e } = await supabase
        .from('packages')
        .select('id, name, credits, price_cents, activity_ids')
        .eq('provider_id', provider!.id)
        .eq('active', true)
        .order('credits');
      if (e) throw e;
      return (data ?? []) as Pack[];
    },
  );

  const ladderSlot = t.slots[Math.min(ladderIdx, t.slots.length - 1)];
  const n = slotDates(ladderSlot).length;
  const ladderPrice = slotPrice(t, ladderSlot);
  const lastJoin = lastJoinableAfter(t, n);
  const perClass = n > 0 ? Math.round(ladderPrice / n) : 0;
  const firstCount = slotDates(t.slots[0]).length;
  const countsDiffer = new Set(t.slots.map((x) => slotDates(x).length)).size > 1;
  /** Run every slot for exactly this many sessions. */
  const setAllSessions = (n: number) =>
    setT((x) => ({ ...x, slots: x.slots.map((sl) => ({ ...sl, count: n })) }));

  function submit(status: Term['status']) {
    if (!t.name.trim()) return setError('Give the term a name parents will recognise, for example "Term 4 · Saturday swim".');
    if (t.slots.some((s) => slotDates(s).length === 0)) return setError('Every group needs at least one day and a first session date.');
    if (t.price <= 0) return setError('Set the full term price.');
    if (t.allowTrial && t.trialLimit < 1) return setError('Set how many trial sessions one child can take.');
    setError(null);
    onSave({ ...t, name: t.name.trim(), status });
  }

  /** Turn per-day times on or off, seeding each ticked day from the slot's time. */
  function setPerDay(s: TermSlot, on: boolean) {
    if (!on) return setSlot(s.id, { perDay: false });
    const dayTimes = { ...s.dayTimes };
    for (const d of s.days) if (!dayTimes[String(d)]) dayTimes[String(d)] = { time: s.time, duration: s.duration };
    setSlot(s.id, { perDay: true, dayTimes });
  }

  // Functional update, so two quick taps never overwrite each other with a stale slot.
  function toggleDay(slotId: string, d: number) {
    setT((x) => ({
      ...x,
      slots: x.slots.map((s) => {
        if (s.id !== slotId) return s;
        const on = s.days.includes(d);
        const days = on ? s.days.filter((v) => v !== d) : [...s.days, d];
        const dayTimes = { ...s.dayTimes };
        if (!on && !dayTimes[String(d)]) dayTimes[String(d)] = { time: s.time, duration: s.duration };
        return { ...s, days, dayTimes };
      }),
    }));
  }

  const offers: { label: string; detail: string; cls: string }[] = [
    { label: 'Whole term', detail: `SGD ${t.price}`, cls: 'bg-teal-100 text-teal-900' },
    ...(t.allowTrial ? [{ label: 'Trial session', detail: `SGD ${t.trialPrice} · ${t.trialLimit} per child`, cls: 'bg-pink-100 text-pink-900' }] : []),
    ...(t.allowSingles ? [{ label: 'Single session', detail: `SGD ${t.singlePrice}`, cls: 'bg-pink-100 text-pink-900' }] : []),
    ...(t.allowPackages ? [{ label: 'Package credits', detail: 'any session, when it suits', cls: 'bg-purple-100 text-purple-900' }] : []),
  ];

  return (
    <div className="space-y-5">
      {banner}
      <button onClick={onCancel} className="inline-flex items-center gap-1.5 text-sm font-bold text-gray-600 hover:text-gray-900">
        <ArrowLeft className="h-4 w-4" /> Back to terms
      </button>

      <h3 className="text-xl font-bold text-gray-900">{isNew ? 'New term' : 'Edit term'}</h3>

      <Section n={1} title="Term details" subtitle="What parents see when they choose your term.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>Term name</label>
            <input className={inputCls} value={t.name} placeholder="Term 4 · Saturday swim" onChange={(e) => set({ name: e.target.value })} aria-label="Term name" />
          </div>
          <div>
            <label className={labelCls}>Full term price (SGD per child)</label>
            <NumberInput min="0" step="any" className={inputCls} value={String(t.price)} onChange={(e) => set({ price: Number(e.target.value) || 0 })} />
          </div>
          <div>
            <label className={labelCls}>Number of sessions</label>
            <NumberInput
              min="1"
              max={String(MAX_TERM_SESSIONS)}
              className={inputCls}
              value={sessionsDraft ?? (countsDiffer ? '' : String(firstCount))}
              placeholder={countsDiffer ? 'Differs by group' : undefined}
              onChange={(e) => {
                const raw = e.target.value;
                setSessionsDraft(raw);
                const n = Math.floor(Number(raw));
                if (Number.isFinite(n) && n >= 1) setAllSessions(Math.min(MAX_TERM_SESSIONS, n));
              }}
              onBlur={() => setSessionsDraft(null)}
              aria-label="Number of sessions"
            />
            <p className={cn('mt-1.5', hintCls)}>
              {firstCount > 0 && t.price > 0 && !countsDiffer ? `About SGD ${Math.round(t.price / firstCount)} each. ` : ''}
              Applies to every group. Each group can still be set by weeks below.
            </p>
          </div>
        </div>
      </Section>

      <Section n={2} title="Groups" subtitle="Parents pick one group when they enrol and come on all of its days. Add another group for a different set of days or times.">
        <div className="space-y-4">
          {t.slots.map((s, idx) => {
            const dates = slotDates(s);
            const pattern = slotPatternDates(s);
            const pickedDays = WEEKDAYS.filter((d) => s.days.includes(d.i));
            return (
              <div key={s.id} className="rounded-xl border border-gray-300 bg-gray-50/60 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-base font-bold text-gray-900">Group {idx + 1}</span>
                  {t.slots.length > 1 && (
                    <button
                      onClick={() => set({ slots: t.slots.filter((x) => x.id !== s.id) })}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold text-gray-500 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" /> Remove
                    </button>
                  )}
                </div>

                <label className={labelCls}>Repeats every</label>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => {
                    const on = s.days.includes(d.i);
                    return (
                      <button
                        type="button"
                        key={d.i}
                        title={d.name}
                        aria-pressed={on}
                        aria-label={d.name}
                        onClick={() => toggleDay(s.id, d.i)}
                        className={cn(
                          'h-10 w-10 rounded-xl text-sm font-bold transition-colors',
                          on ? 'bg-[#FA4D8D] text-white' : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-100',
                        )}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
                  <ToggleRow
                    title="Different times on different days"
                    hint={pickedDays.length > 1 ? 'For example Monday at 4:00 pm and Wednesday at 5:30 pm.' : 'Tick more than one day to set a time for each.'}
                    checked={s.perDay}
                    disabled={pickedDays.length < 2 && !s.perDay}
                    onChange={(v) => setPerDay(s, v)}
                  />
                  <div className="mt-4">
                    {!s.perDay ? (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className={labelCls}>Start time</label>
                          <TimePicker className={cn(inputCls, 'w-full')} value={s.time} onChange={(v) => setSlot(s.id, { time: v })} aria-label="Start time" />
                        </div>
                        <div>
                          <label className={labelCls}>Length (mins)</label>
                          <NumberInput min="15" step="1" className={inputCls} value={String(s.duration)} onChange={(e) => setSlot(s.id, { duration: Number(e.target.value) || 0 })} />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {pickedDays.map((d) => {
                          const dt = dayTimeFor(s, d.i);
                          const setDay = (patch: Partial<{ time: string; duration: number }>) =>
                            setSlot(s.id, { dayTimes: { ...s.dayTimes, [String(d.i)]: { ...dt, ...patch } } });
                          return (
                            <div key={d.i} className="grid grid-cols-[88px_minmax(0,1fr)_minmax(0,1fr)] items-end gap-3">
                              <div className="pb-2.5 text-[15px] font-bold text-gray-900">{d.name}</div>
                              <div>
                                <label className="mb-1 block text-xs font-semibold text-gray-600">Start time</label>
                                <TimePicker className={cn(inputCls, 'w-full')} value={dt.time} onChange={(v) => setDay({ time: v })} aria-label={`${d.name} start time`} />
                              </div>
                              <div>
                                <label className="mb-1 block text-xs font-semibold text-gray-600">Length (mins)</label>
                                <NumberInput min="15" step="1" className={inputCls} value={String(dt.duration)} onChange={(e) => setDay({ duration: Number(e.target.value) || 0 })} aria-label={`${d.name} length`} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>Venue</label>
                    <SelectField className={inputCls} value={s.locationId} onChange={(v) => setSlot(s.id, { locationId: v })} aria-label="Group venue">
                      <Opt value="">Same as the activity</Opt>
                      {locations.map((l) => <Opt key={l.id} value={l.id}>{l.name}</Opt>)}
                    </SelectField>
                  </div>
                  <div>
                    <label className={labelCls}>Seats</label>
                    <NumberInput min="1" className={inputCls} value={String(s.capacity)} onChange={(e) => setSlot(s.id, { capacity: Number(e.target.value) || 0 })} />
                  </div>
                  <div>
                    <label className={labelCls}>First session</label>
                    <DatePicker className={inputCls} value={s.start} onChange={(v) => setSlot(s.id, { start: v })} aria-label="First session date" />
                  </div>
                  <div>
                    <label className={labelCls}>How long does it run?</label>
                    <div className="flex gap-2">
                      <div className="flex h-11 shrink-0 overflow-hidden rounded-xl border border-gray-300 bg-white text-sm font-bold" role="group" aria-label="Length of the term">
                        {(['weeks', 'sessions'] as const).map((m) => {
                          const on = (s.count != null) === (m === 'sessions');
                          return (
                            <button
                              type="button"
                              key={m}
                              aria-pressed={on}
                              onClick={() => {
                                if (on) return;
                                if (m === 'sessions') {
                                  setSlot(s.id, { count: Math.max(1, slotDates(s).length) });
                                } else {
                                  const last = pattern[pattern.length - 1];
                                  const spanDays = last ? Math.round((new Date(last).getTime() - new Date(s.start).getTime()) / 864e5) : 0;
                                  setSlot(s.id, { count: null, weeks: Math.max(1, Math.min(MAX_TERM_WEEKS, Math.ceil((spanDays + 1) / 7))) });
                                }
                              }}
                              className={cn('px-3 transition-colors', on ? 'bg-[#FA4D8D] text-white' : 'text-gray-600 hover:bg-gray-50')}
                            >
                              {m === 'weeks' ? 'Weeks' : 'Sessions'}
                            </button>
                          );
                        })}
                      </div>
                      {s.count != null ? (
                        <NumberInput min="1" max={String(MAX_TERM_SESSIONS)} className={inputCls} value={String(s.count)} onChange={(e) => setSlot(s.id, { count: Math.max(1, Math.min(MAX_TERM_SESSIONS, Number(e.target.value) || 1)) })} aria-label="Number of sessions" />
                      ) : (
                        <NumberInput min="1" max={String(MAX_TERM_WEEKS)} className={inputCls} value={String(s.weeks)} onChange={(e) => setSlot(s.id, { weeks: Math.max(1, Math.min(MAX_TERM_WEEKS, Number(e.target.value) || 1)) })} aria-label="Number of weeks" />
                      )}
                    </div>
                    <p className={cn('mt-1.5', hintCls)}>
                      {s.count != null
                        ? 'Runs until this many sessions have taken place. A skipped date pushes the end out.'
                        : 'Runs for this many weeks. Pick "Sessions" to set an exact number instead.'}
                    </p>
                  </div>
                  <div>
                    <label className={labelCls}>Price for this group (SGD)</label>
                    <NumberInput
                      min="0"
                      step="any"
                      placeholder={`Same as term: ${t.price}`}
                      className={inputCls}
                      value={s.price == null ? '' : String(s.price)}
                      onChange={(e) => setSlot(s.id, { price: e.target.value === '' ? null : Number(e.target.value) || 0 })}
                      aria-label="Group price"
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Most seats singles can take</label>
                    <NumberInput
                      min="0"
                      placeholder="No limit"
                      className={inputCls}
                      value={s.singleCap == null ? '' : String(s.singleCap)}
                      onChange={(e) => setSlot(s.id, { singleCap: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0) })}
                      aria-label="Single session seat limit"
                    />
                  </div>
                </div>
                {s.singleCap != null && s.capacity > 0 && (
                  <p className={cn('mt-1.5', hintCls)}>Term enrolments can fill the other {Math.max(0, s.capacity - s.singleCap)} of {s.capacity} seats.</p>
                )}

                <div className="mt-4">
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-gray-800">Session dates</span>
                    <span className="text-[13px] text-gray-500">Tap a date to skip it, for example a public holiday</span>
                  </div>
                  {(() => {
                    const holidays = publicHolidaysIn(s);
                    const open = holidays.filter((d) => !(s.skip ?? []).includes(d));
                    if (holidays.length === 0) return null;
                    return (
                      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
                        <span>
                          {holidays.length} public holiday{holidays.length === 1 ? '' : 's'} in this group:{' '}
                          {holidays.map((d) => `${fmtShort(d)} (${SG_PUBLIC_HOLIDAYS[d]})`).join(', ')}
                        </span>
                        {open.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setSlot(s.id, { skip: [...(s.skip ?? []), ...open] })}
                            className="rounded-md border border-amber-300 bg-white px-2 py-0.5 font-semibold hover:bg-amber-100"
                          >
                            Skip public holidays
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  {pattern.length === 0 ? (
                    <p className="rounded-lg bg-white px-3 py-2 text-sm text-gray-600">Pick at least one day and a first session date.</p>
                  ) : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(7.25rem,1fr))] gap-2">
                      {pattern.map((d) => {
                        const off = (s.skip ?? []).includes(d);
                        return (
                          <button
                            type="button"
                            key={d}
                            aria-pressed={off}
                            title={off ? 'Skipped: tap to add the session back' : 'Tap to skip this date'}
                            onClick={() => setSlot(s.id, { skip: off ? s.skip.filter((x) => x !== d) : [...(s.skip ?? []), d] })}
                            className={cn(
                              'rounded-lg border px-2 py-1.5 text-center text-sm font-semibold tabular-nums transition-colors',
                              off ? 'border-gray-200 bg-gray-100 text-gray-400 line-through' : 'border-teal-300 bg-teal-50 text-teal-900 hover:bg-teal-100',
                            )}
                          >
                            {fmtShort(d)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="mt-2 text-sm font-semibold text-gray-700">
                    {dates.length > 0
                      ? `${dates.length} sessions · ${fmtRange(dates)}${pattern.length - dates.length > 0 ? ` · ${pattern.length - dates.length} skipped` : ''}`
                      : 'No sessions left. Un-skip a date or change the days.'}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            const last = t.slots[t.slots.length - 1];
            set({
              slots: [...t.slots, {
                ...last, id: newId(), days: [...last.days], skip: [...last.skip], dayTimes: { ...last.dayTimes },
                capacity: last.capacity || defaultCapacity || 10,
              }],
            });
          }}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 text-[15px] font-bold text-gray-700 hover:border-[#FA4D8D] hover:text-[#FA4D8D]"
        >
          <Plus className="h-5 w-5" /> Add another group
        </button>
      </Section>

      <Section n={3} title="Joining mid-term" subtitle="Let parents enrol after the term has started, and decide what they pay.">
        <ToggleRow
          title="Allow joining mid-term"
          hint="Parents can still enrol after the term has started."
          checked={t.allowMidTerm}
          onChange={(v) => set({ allowMidTerm: v })}
        />
        {t.allowMidTerm && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-[15px] font-semibold text-gray-800">
              Stop taking enrolments when
              <NumberInput min="1" className={cn(inputCls, 'w-24 text-center')} value={String(t.minLeft)} onChange={(e) => set({ minLeft: Math.max(1, Number(e.target.value) || 1) })} aria-label="Sessions left" />
              sessions are left
            </div>
            <div className="border-t border-gray-100 pt-5">
              <ToggleRow
                title="Reduce the price as sessions pass"
                hint="Optional. Off means mid-term joiners pay the full term price."
                checked={t.reduce}
                onChange={(v) => set({ reduce: v })}
              />
              {t.reduce && (
                <div className="mt-4 flex flex-wrap items-center gap-3 text-[15px] font-semibold text-gray-800">
                  Take off SGD
                  <NumberInput min="0" step="any" className={cn(inputCls, 'w-28')} value={String(t.reduceBy)} onChange={(e) => set({ reduceBy: Number(e.target.value) || 0 })} aria-label="Reduction per session" />
                  for every session already run
                  {perClass > 0 && (
                    <button type="button" onClick={() => set({ reduceBy: perClass })} className="h-10 rounded-xl border border-gray-300 px-3.5 text-sm font-bold text-gray-700 hover:bg-gray-50">
                      Match per-session rate
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-bold text-gray-800">
                  What a parent pays, by when they join <span className="font-normal text-gray-500">({n} sessions, SGD {ladderPrice})</span>
                </span>
                {t.slots.length > 1 && (
                  <SelectField className="h-9 w-auto min-w-[9rem] rounded-lg border border-gray-300 px-3 text-sm font-semibold" value={String(ladderIdx)} onChange={(v) => setLadderIdx(Number(v))} aria-label="Show the price ladder for group">
                    {t.slots.map((s, i) => <Opt key={s.id} value={String(i)}>Group {i + 1} · {formatTime(s.time)}</Opt>)}
                  </SelectField>
                )}
              </div>
              {/* Equal columns so every price and "left" count lines up down the list. */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {Array.from({ length: lastJoin + 1 }, (_, k) => (
                  <div key={k} className="grid grid-cols-[1fr_auto_4.5rem] items-baseline gap-3 rounded-lg bg-teal-100 px-3 py-1.5 text-sm tabular-nums text-teal-950">
                    <span>{k === 0 ? 'Before session 1' : `After session ${k}`}</span>
                    <strong className="text-right font-bold">SGD {priceAfter({ ...t, price: ladderPrice }, k)}</strong>
                    <span className="text-right text-teal-800/70">{n - k} left</span>
                  </div>
                ))}
              </div>
              <p className={cn('mt-2', hintCls)}>
                {n > 0 ? `Term enrolment closes after session ${lastJoin}. ` : ''}Trial, single and package bookings are separate and unaffected.
              </p>
            </div>
          </>
        )}
      </Section>

      <Section n={4} title="Trial and single sessions" subtitle="One-off ways in for parents who are not ready for the whole term. Offer either, both or neither.">
        <ToggleRow
          title="Offer a trial session"
          hint="One session at an intro price, limited per child so it stays a trial."
          checked={t.allowTrial}
          onChange={(v) => set({ allowTrial: v })}
        />
        {t.allowTrial && (
          <div className="grid grid-cols-1 gap-4 rounded-xl bg-gray-50 p-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Trial session price (SGD)</label>
              <NumberInput min="0" step="any" className={inputCls} value={String(t.trialPrice)} onChange={(e) => set({ trialPrice: Number(e.target.value) || 0 })} aria-label="Trial price" />
            </div>
            <div>
              <label className={labelCls}>Trial sessions allowed per child</label>
              <NumberInput min="1" max="10" className={inputCls} value={String(t.trialLimit)} onChange={(e) => set({ trialLimit: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} aria-label="Trial sessions per child" />
              <p className={cn('mt-1.5', hintCls)}>Counted per child across all of your terms. Single sessions are only offered once a child has used them.</p>
            </div>
          </div>
        )}

        <div className="border-t border-gray-100 pt-5">
          <ToggleRow
            title="Offer single sessions"
            hint={t.allowTrial ? 'Parents can book one session at a time without enrolling, once their child has used the trial.' : 'Parents can book one session of this term at a time, without enrolling.'}
            checked={t.allowSingles}
            onChange={(v) => set({ allowSingles: v })}
          />
          {t.allowSingles && (
            <div className="mt-4 grid grid-cols-1 gap-4 rounded-xl bg-gray-50 p-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Single session price (SGD)</label>
                <NumberInput min="0" step="any" className={inputCls} value={String(t.singlePrice)} onChange={(e) => set({ singlePrice: Number(e.target.value) || 0 })} aria-label="Single session price" />
              </div>
              <div className="flex items-end">
                <p className={hintCls}>Uses the seats the term leaves free. While a trial is on, shown only to children who have used theirs.</p>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-gray-100 pt-5">
          <ToggleRow
            title="Sibling discount"
            hint="Money off the term for the second and later child a parent enrols."
            checked={t.siblingDiscountPct > 0}
            onChange={(v) => set({ siblingDiscountPct: v ? 10 : 0 })}
          />
          {t.siblingDiscountPct > 0 && (
            <div className="mt-4 grid grid-cols-1 gap-4 rounded-xl bg-gray-50 p-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Discount (%)</label>
                <NumberInput min="1" max="100" className={inputCls} value={String(t.siblingDiscountPct)} onChange={(e) => set({ siblingDiscountPct: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} aria-label="Sibling discount percent" />
              </div>
              <div className="flex items-end">
                <p className={hintCls}>
                  {t.price > 0 ? `A second child pays SGD ${Math.round(t.price * (100 - t.siblingDiscountPct)) / 100} instead of SGD ${t.price}.` : 'Applies to the term price.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section n={5} title="Packages" subtitle="For parents who want to pick sessions when it suits them.">
        <ToggleRow
          title="Open this term to packages"
          hint="Parents with a package can book individual sessions of this term using their credits, or buy a package at checkout."
          checked={t.allowPackages}
          onChange={(v) => set({ allowPackages: v })}
        />
        {!t.allowPackages && (() => {
          const limited = (packs ?? []).filter((p) => (p.activity_ids ?? []).includes(t.activityId));
          return (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-[13px] font-semibold text-amber-900">
              {limited.length > 0
                ? `${limited.length === 1 ? '1 of your packs is' : `${limited.length} of your packs are`} limited to this activity and can't be used here: ${limited.map((p) => p.name).join(', ')}. `
                : ''}
              Package credits can't be spent on this term's sessions. If no running term of this activity accepts packages, it is greyed out on the Packages page and parents aren't offered packs for it.
            </p>
          );
        })()}
        {t.allowPackages && (
          <div className="rounded-xl bg-gray-50 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-gray-800">
              <Package className="h-4 w-4" /> Your active packages
            </div>
            {packs === undefined ? (
              <p className={hintCls}>Loading your packages…</p>
            ) : packs.length === 0 ? (
              <p className={hintCls}>You have no active packages yet. Create one under Packages and it will be usable here.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {packs.map((p) => (
                  <span key={p.id} className="rounded-lg bg-purple-100 px-2.5 py-1.5 text-sm font-semibold text-purple-950">
                    {p.name} · {p.credits} sessions · SGD {Math.round(p.price_cents / 100)}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      <section className="rounded-2xl border-2 border-teal-200 bg-teal-50/50 p-5">
        <h4 className="flex items-center gap-2 text-base font-bold text-gray-900"><Ticket className="h-5 w-5" /> What parents will be offered</h4>
        <div className="mt-3 flex flex-wrap gap-2">
          {offers.map((o) => (
            <span key={o.label} className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm', o.cls)}>
              <Check className="h-4 w-4" /> <strong className="font-bold">{o.label}</strong> · {o.detail}
            </span>
          ))}
        </div>
      </section>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-3">
        {/* A published term can't go back to being a draft, so it only saves
            its changes (seats, prices, the single-session cap). */}
        {term.status === 'published' ? (
          <Button onClick={() => submit('published')} className="h-12 rounded-xl px-6 text-[15px] font-bold gradient-primary text-white hover:opacity-90">
            Save changes
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => submit('draft')} className="h-12 rounded-xl border-2 border-gray-300 px-6 text-[15px] font-bold text-gray-800">
              Save as draft
            </Button>
            <Button onClick={() => submit('published')} className="h-12 rounded-xl px-6 text-[15px] font-bold gradient-primary text-white hover:opacity-90">
              Publish term
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

const money = (cents: number) => `SGD ${(cents / 100).toLocaleString('en-SG', { maximumFractionDigits: 2 })}`;
const ageOf = (dob: string | null) => {
  if (!dob) return null;
  const b = new Date(dob);
  const now = new Date();
  const m = (now.getFullYear() - b.getFullYear()) * 12 + now.getMonth() - b.getMonth();
  return m < 24 ? `${m} mo` : `${Math.floor(m / 12)} yr`;
};
const ROSTER_STATUS: Record<RosterRow['status'], string> = {
  enrolled: 'bg-green-100 text-green-800',
  unpaid: 'bg-amber-100 text-amber-900',
  withdrawn: 'bg-gray-100 text-gray-500',
};

/**
 * Under a published term: its numbers, who is enrolled (with Withdraw), copying
 * it into the next term, and opening re-enrolment for this term's families.
 */
function PublishedTermTools({ term, hasNext, onCopy }: { term: Term; hasNext: boolean; onCopy: () => void }) {
  const [stats, setStats] = useState<SlotStats[] | null>(null);
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [withdrawing, setWithdrawing] = useState<RosterRow | null>(null);
  const [refund, setRefund] = useState<'refund' | 'none'>('refund');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let stale = false;
    fetchTermSlotStats(term.id).then((s) => { if (!stale) setStats(s); }).catch(() => { if (!stale) setStats([]); });
    if (showRoster) fetchTermRoster(term.id).then((r) => { if (!stale) setRoster(r); }).catch(() => { if (!stale) setRoster([]); });
    return () => { stale = true; };
  }, [term.id, showRoster, version]);

  const total = (k: 'enrolled' | 'unpaid' | 'revenue_cents' | 'one_off_bookings') => (stats ?? []).reduce((n, s) => n + (s[k] ?? 0), 0);
  const placesLeft = (stats ?? []).reduce<number | null>((n, s) => (s.places_left == null ? n : (n ?? 0) + s.places_left), null);
  const priorityOpen = term.priorityUntil != null && new Date(term.priorityUntil) > new Date();
  const oneOffs = total('one_off_bookings');

  async function confirmWithdraw() {
    if (!withdrawing) return;
    if (refund === 'none' && !reason.trim()) { toast.error('Add a reason when there is no refund.'); return; }
    setBusy(true);
    try {
      const n = await vendorWithdraw(withdrawing.enrolment_id, refund, reason);
      toast(`${withdrawing.child_name} withdrawn. ${n} upcoming session${n === 1 ? '' : 's'} cancelled.`);
      setWithdrawing(null);
      setReason('');
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error('Could not withdraw', { description: (e as { message?: string })?.message });
    }
    setBusy(false);
  }

  async function reenrol() {
    setBusy(true);
    try {
      const n = await openReenrolment(term.id, 7);
      toast(`Re-enrolment open for 7 days. ${n} ${n === 1 ? 'family was' : 'families were'} told.`);
    } catch (e) {
      toast.error('Could not open re-enrolment', { description: (e as { message?: string })?.message });
    }
    setBusy(false);
  }

  return (
    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Enrolled', value: stats ? String(total('enrolled')) : '…' },
          { label: 'Awaiting payment', value: stats ? String(total('unpaid')) : '…' },
          { label: 'Places left', value: stats ? (placesLeft == null ? '—' : String(placesLeft)) : '…' },
          { label: 'Paid so far', value: stats ? money(total('revenue_cents')) : '…' },
        ].map((c) => (
          <div key={c.label} className="rounded-xl bg-gray-50 px-3 py-2">
            <div className="text-[12px] font-semibold text-gray-500">{c.label}</div>
            <div className="text-base font-bold tabular-nums text-gray-900">{c.value}</div>
          </div>
        ))}
      </div>
      {oneOffs > 0 && (
        <p className={hintCls}>Plus {oneOffs} trial, single, package or make-up booking{oneOffs === 1 ? '' : 's'}.</p>
      )}
      {priorityOpen && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-[13px] font-semibold text-blue-900">
          Re-enrolment is open to current families until{' '}
          {new Date(term.priorityUntil!).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.
          Everyone else can enrol after that.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setShowRoster((v) => !v)} className="h-9 rounded-lg px-3 text-sm font-semibold">
          <Users className="mr-1.5 h-4 w-4" /> {showRoster ? 'Hide roster' : 'Roster'}
        </Button>
        {!hasNext && (
          <Button variant="outline" onClick={onCopy} className="h-9 rounded-lg px-3 text-sm font-semibold">
            <Copy className="mr-1.5 h-4 w-4" /> Copy to next term
          </Button>
        )}
        {term.previousTermId && !term.priorityUntil && (
          <Button variant="outline" disabled={busy} onClick={reenrol} className="h-9 rounded-lg px-3 text-sm font-semibold">
            <Repeat className="mr-1.5 h-4 w-4" /> Open re-enrolment (7 days)
          </Button>
        )}
      </div>

      {showRoster && (
        <div className="rounded-xl border border-gray-200">
          {roster === null ? (
            <p className={cn('p-3', hintCls)}>Loading…</p>
          ) : roster.length === 0 ? (
            <p className={cn('p-3', hintCls)}>No one has enrolled yet.</p>
          ) : (
            term.slots.map((s, i) => {
              const rows = roster.filter((r) => r.slot_id === s.id);
              if (rows.length === 0) return null;
              return (
                <div key={s.id} className={cn(i > 0 && 'border-t border-gray-100')}>
                  {term.slots.length > 1 && (
                    <div className="bg-gray-50 px-3 py-1.5 text-xs font-bold text-gray-600">
                      Group {i + 1} · {WEEKDAYS.filter((d) => s.days.includes(d.i)).map((d) => d.name.slice(0, 3)).join(', ')}
                    </div>
                  )}
                  {rows.map((r) => (
                    <div key={r.enrolment_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-3 py-2 first:border-t-0">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-gray-900">{r.child_name}</span>
                          {ageOf(r.child_dob) && <span className="text-xs text-gray-500">{ageOf(r.child_dob)}</span>}
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', ROSTER_STATUS[r.status])}>
                            {r.status === 'enrolled' ? 'Enrolled' : r.status === 'unpaid' ? 'Awaiting payment' : 'Withdrawn'}
                          </span>
                          {r.joined_session_no != null && r.joined_session_no > 1 && (
                            <span className="text-[11px] font-semibold text-gray-500">joined at session {r.joined_session_no}</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">
                          {[r.parent_name, r.parent_email].filter(Boolean).join(' · ')} · {money(r.price_cents)} · {r.sessions_left} of {r.sessions} sessions left
                        </div>
                      </div>
                      {r.status !== 'withdrawn' && r.sessions_left > 0 && (
                        <button
                          type="button"
                          onClick={() => { setWithdrawing(r); setRefund('refund'); setReason(''); }}
                          className="rounded-lg px-2 py-1 text-sm font-semibold text-red-600 hover:bg-red-50"
                        >
                          Withdraw
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}

      {withdrawing && (
        <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-bold text-red-900">
            Withdraw {withdrawing.child_name} from {term.name}? Their {withdrawing.sessions_left} upcoming
            session{withdrawing.sessions_left === 1 ? '' : 's'} will be cancelled and the family told.
          </p>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={refund === 'refund'} onChange={() => setRefund('refund')} /> Give make-up credit for the cancelled sessions
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={refund === 'none'} onChange={() => setRefund('none')} /> No refund
            </label>
          </div>
          {refund === 'none' && (
            <input className={inputCls} placeholder="Reason (shown to the family)" value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
          <div className="flex gap-2">
            <Button disabled={busy} onClick={confirmWithdraw} className="h-9 rounded-lg bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700">
              Withdraw
            </Button>
            <Button variant="outline" onClick={() => setWithdrawing(null)} className="h-9 rounded-lg px-4 text-sm font-semibold">
              Keep
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
