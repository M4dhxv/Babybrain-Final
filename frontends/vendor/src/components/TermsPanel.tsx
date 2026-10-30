import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Pencil, CalendarRange, Info, ArrowLeft, Ticket, Package, Check, Users, Copy, Repeat, Hourglass } from 'lucide-react';
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
  blankTerm, comboSessions, dayTimeFor, deleteTerm, DEFAULT_GROUP_NAME, fmtRange, fmtShort, isFlexible, lastJoinableAfter, newId, normalizeTerm, priceAfter,
  saveTerm, slotDates, slotLabel, slotPatternDates, slotPrice, slotsClash, swapTermSlot, termStatus, useTerms, MAX_TERM_SESSIONS, MAX_TERM_WEEKS,
  fetchTermRoster, fetchTermSlotStats, nextTermFrom, openReenrolment, publicHolidaysIn, vendorWithdraw, SG_PUBLIC_HOLIDAYS,
  fetchTermWaitlist, fetchTermWaitlistCounts, offerSessionPlace, offerTermPlace, removeFromTermWaitlist, tellTermWaitlist,
  type RosterRow, type SlotMode, type SlotStats, type Term, type TermSlot, type TermStatusKey, type TermWaitCount, type TermWaitRow,
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

/** Monday first, as the week reads. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const dayRank = (d: number) => DAY_ORDER.indexOf(d);

/** Slots in reading order: by group, then first day of the week, then time. */
function sortSlots(slots: TermSlot[], groupIds: string[]): TermSlot[] {
  return [...slots].sort(
    (a, b) =>
      groupIds.indexOf(a.groupId) - groupIds.indexOf(b.groupId) ||
      dayRank(Math.min(...a.days.map(dayRank), 9)) - dayRank(Math.min(...b.days.map(dayRank), 9)) ||
      a.time.localeCompare(b.time),
  );
}

/** Simple or Flexible: how parents choose. Chosen while the term is a draft. */
function ModeSwitch({ mode, locked, onChange }: { mode: SlotMode; locked: boolean; onChange: (m: SlotMode) => void }) {
  const options: { id: SlotMode; title: string; body: string }[] = [
    { id: 'simple', title: 'Simple', body: 'Parents pick one slot. One list, the way terms have always worked. A slot can run on more than one day.' },
    { id: 'flexible', title: 'Flexible', body: 'Parents pick one slot from each group you make, for example one on Mon or Tue and one on Thu or Fri, and keep that pair every week.' },
  ];
  return (
    <div>
      <label className={labelCls}>How do parents choose?</label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How parents choose">
        {options.map((o) => {
          const on = mode === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={locked && !on}
              onClick={() => !locked && onChange(o.id)}
              className={cn(
                'rounded-xl border-2 p-4 text-left transition-colors',
                on ? 'border-[#FA4D8D] bg-pink-50' : 'border-gray-200 bg-white hover:border-gray-300',
                locked && !on && 'opacity-40',
                locked && 'cursor-default',
              )}
            >
              <span className="flex items-center gap-2 text-base font-bold text-gray-900">
                <span className={cn('grid h-5 w-5 place-items-center rounded-full border-2', on ? 'border-[#FA4D8D] bg-[#FA4D8D]' : 'border-gray-300')}>
                  {on && <Check className="h-3 w-3 text-white" />}
                </span>
                {o.title}
              </span>
              <span className="mt-1 block text-[13px] leading-snug text-gray-600">{o.body}</span>
            </button>
          );
        })}
      </div>
      {locked && <p className={cn('mt-1.5', hintCls)}>The mode is fixed once a term is published.</p>}
    </div>
  );
}

/** "Add several slots at once": every chosen day at every chosen time. This is
 *  how a vendor offers more than one slot on a day without making each by hand. */
function QuickAdd({ onCreate }: { onCreate: (days: number[], times: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number[]>([]);
  const [times, setTimes] = useState<string[]>([]);
  const [pick, setPick] = useState('09:30');
  const n = days.length * times.length;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3.5 py-2 text-sm font-bold text-gray-800 hover:border-[#FA4D8D] hover:text-[#FA4D8D]">
        <Plus className="h-4 w-4" /> Add several slots at once
      </button>
    );
  }
  return (
    <div className="space-y-4 rounded-xl border border-dashed border-gray-300 bg-white p-4">
      <div>
        <label className={labelCls}>Days</label>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((d) => {
            const on = days.includes(d.i);
            return (
              <button
                key={d.i}
                type="button"
                title={d.name}
                aria-label={d.name}
                aria-pressed={on}
                onClick={() => setDays((x) => (on ? x.filter((v) => v !== d.i) : [...x, d.i]))}
                className={cn('h-10 w-10 rounded-xl text-sm font-bold transition-colors', on ? 'bg-[#FA4D8D] text-white' : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-100')}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <label className={labelCls}>Times (one slot for each day and time)</label>
        <div className="flex flex-wrap items-center gap-2">
          {[...times].sort().map((tm) => (
            <button key={tm} type="button" onClick={() => setTimes((x) => x.filter((v) => v !== tm))} title="Remove this time" className="rounded-lg bg-[#FA4D8D] px-3 py-1.5 text-sm font-bold text-white">
              {formatTime(tm)} ×
            </button>
          ))}
          <TimePicker className={cn(inputCls, 'h-10 w-36')} value={pick} onChange={setPick} aria-label="Time to add" />
          <button
            type="button"
            onClick={() => setTimes((x) => (x.includes(pick) ? x : [...x, pick]))}
            className="h-10 rounded-xl border border-gray-300 px-3 text-sm font-bold text-gray-700 hover:bg-gray-50"
          >
            Add this time
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={n === 0}
          onClick={() => { onCreate(days, times); setDays([]); setTimes([]); setOpen(false); }}
          className="h-10 rounded-xl px-4 text-sm font-bold gradient-primary text-white hover:opacity-90"
        >
          {n === 0 ? 'Pick days and times' : `Create ${n} slot${n === 1 ? '' : 's'}`}
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm font-semibold text-gray-600 hover:text-gray-900">Cancel</button>
        {n > 0 && <span className={hintCls}>{days.length} day{days.length === 1 ? '' : 's'} × {times.length} time{times.length === 1 ? '' : 's'}. Length, seats and venue are copied from the last slot.</span>}
      </div>
    </div>
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
              Bundle a block of weekly sessions, set the slots and price, and choose whether parents can join mid-way.
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
                        {isFlexible(t)
                          ? `Flexible · ${comboSessions(t)} sessions for one slot from each of ${t.groups.length} groups · SGD ${t.price} · ${t.slots.length} slots`
                          : `${n} sessions · SGD ${t.price} · ${t.slots.length} slot${t.slots.length === 1 ? '' : 's'}`}
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
                    {(isFlexible(t) ? t.groups : [null]).map((g) => (
                      <div key={g?.id ?? 'all'} className="space-y-1">
                        {g && <p className="pt-1 text-xs font-bold uppercase tracking-wide text-gray-500">Choose 1 · {g.name || 'Unnamed group'}</p>}
                        {t.slots.filter((sl) => !g || sl.groupId === g.id).map((s) => (
                          <p key={s.id} className="text-sm text-gray-700">
                            <span className="font-semibold">{slotLabel(s)}</span>
                            {s.locationId ? ` · ${locations.find((l) => l.id === s.locationId)?.name ?? 'Other venue'}` : ''}
                            {' · '}{fmtRange(slotDates(s))}
                            {!isFlexible(t) && s.price != null ? ` · SGD ${s.price}` : ''}
                            {(s.skip ?? []).length > 0 ? ` · ${(s.skip ?? []).length} skipped` : ''}
                          </p>
                        ))}
                      </div>
                    ))}
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
  const [openSlots, setOpenSlots] = useState<Set<string>>(() => new Set());
  const [mergeAsk, setMergeAsk] = useState(false);
  const flexible = t.slotMode === 'flexible';
  const toggleOpen = (id: string) => setOpenSlots((x) => { const n2 = new Set(x); if (n2.has(id)) n2.delete(id); else n2.add(id); return n2; });
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
  // A Flexible family has one slot from each group, so a session passing in
  // each slot takes `lanes` sessions off at once and the price covers all of them.
  const lanes = flexible ? Math.max(1, t.groups.length) : 1;
  const perClass = flexible ? (comboSessions(t) > 0 ? Math.round(ladderPrice / comboSessions(t)) : 0) : n > 0 ? Math.round(ladderPrice / n) : 0;
  const firstCount = slotDates(t.slots[0]).length;
  const countsDiffer = new Set(t.slots.map((x) => slotDates(x).length)).size > 1;
  /** Run every slot for exactly this many sessions. */
  const setAllSessions = (n: number) =>
    setT((x) => ({ ...x, slots: x.slots.map((sl) => ({ ...sl, count: n })) }));

  /** Simple <-> Flexible. Going back to Simple with several groups needs them combined first. */
  function chooseMode(m: SlotMode) {
    if (m === t.slotMode) return;
    if (m === 'flexible') {
      setT((x) => ({
        ...x,
        slotMode: 'flexible',
        groups: x.groups.map((g, i) => (i === 0 && g.name === DEFAULT_GROUP_NAME ? { ...g, name: '' } : g)),
      }));
      return;
    }
    if (t.groups.length > 1) { setMergeAsk(true); return; }
    setT((x) => ({ ...x, slotMode: 'simple' }));
  }
  function mergeToSimple() {
    setT((x) => {
      const g = x.groups[0];
      return { ...x, slotMode: 'simple', groups: [g], slots: sortSlots(x.slots.map((sl) => ({ ...sl, groupId: g.id })), [g.id]) };
    });
    setMergeAsk(false);
  }
  function addGroup() {
    setT((x) => {
      const tpl = x.slots[x.slots.length - 1];
      const gid = newId();
      const slot: TermSlot = { ...structuredClone(tpl), id: newId(), groupId: gid };
      setOpenSlots((o) => new Set(o).add(slot.id));
      return { ...x, groups: [...x.groups, { id: gid, name: '' }], slots: [...x.slots, slot] };
    });
  }
  function removeGroup(id: string) {
    setT((x) => ({ ...x, groups: x.groups.filter((g) => g.id !== id), slots: x.slots.filter((sl) => sl.groupId !== id) }));
  }
  function addSlotIn(groupId: string) {
    setT((x) => {
      const inGroup = x.slots.filter((sl) => sl.groupId === groupId);
      const tpl = inGroup[inGroup.length - 1] ?? x.slots[x.slots.length - 1];
      const slot: TermSlot = { ...structuredClone(tpl), id: newId(), groupId, capacity: tpl.capacity || defaultCapacity || 10 };
      setOpenSlots((o) => new Set(o).add(slot.id));
      return { ...x, slots: sortSlots([...x.slots, slot], x.groups.map((g) => g.id)) };
    });
  }
  /** One slot for every chosen day at every chosen time, skipping any already there. */
  function createSlots(groupId: string, days: number[], times: string[]) {
    setT((x) => {
      const inGroup = x.slots.filter((sl) => sl.groupId === groupId);
      const tpl = inGroup[inGroup.length - 1] ?? x.slots[x.slots.length - 1];
      if (!tpl) return x;
      const have = new Set(inGroup.filter((sl) => sl.days.length === 1).map((sl) => `${sl.days[0]}@${sl.time}`));
      const made: TermSlot[] = [];
      for (const d of DAY_ORDER.filter((v) => days.includes(v))) {
        for (const tm of [...times].sort()) {
          if (have.has(`${d}@${tm}`)) continue;
          made.push({ ...structuredClone(tpl), id: newId(), groupId, days: [d], time: tm, perDay: false, dayTimes: {}, skip: [] });
        }
      }
      return { ...x, slots: sortSlots([...x.slots, ...made], x.groups.map((g) => g.id)) };
    });
  }
  function removeSlot(id: string) {
    setT((x) => ({ ...x, slots: x.slots.filter((sl) => sl.id !== id) }));
  }
  /** What is wrong with this slot, in words (Flexible terms). */
  function problemsOf(sl: TermSlot): string[] {
    const out: string[] = [];
    if (sl.days.length === 0) out.push('Pick at least one day.');
    for (const o of t.slots) {
      if (o.id === sl.id) continue;
      if (o.groupId === sl.groupId && o.id < sl.id && o.days.join() === sl.days.join() && o.time === sl.time) out.push('Same days and time as another slot in this group.');
      if (o.groupId !== sl.groupId && slotsClash(sl, o)) {
        out.push(`Runs at the same time as ${slotLabel(o)} in ${t.groups.find((g) => g.id === o.groupId)?.name || 'another group'}, so a parent could not pick both.`);
      }
    }
    return out;
  }

  function submit(status: Term['status']) {
    if (!t.name.trim()) return setError('Give the term a name parents will recognise, for example "Term 4 · Saturday swim".');
    if (t.slots.length === 0) return setError('Add at least one slot.');
    if (t.slots.some((s) => slotDates(s).length === 0)) return setError('Every slot needs at least one day and a first session date.');
    if (flexible) {
      const empty = t.groups.find((g) => !t.slots.some((sl) => sl.groupId === g.id));
      if (empty) return setError(`${empty.name.trim() ? `"${empty.name.trim()}"` : 'A group'} has no slots yet. Add at least one, or remove the group.`);
      if (t.groups.some((g) => !g.name.trim())) return setError('Name every group, for example "Mon & Tue", so parents know what they are choosing.');
      const names = t.groups.map((g) => g.name.trim().toLowerCase());
      if (new Set(names).size !== names.length) return setError('Two groups have the same name. Give each its own.');
      for (let i = 0; i < t.slots.length; i++) {
        for (let j = i + 1; j < t.slots.length; j++) {
          const a = t.slots[i];
          const b = t.slots[j];
          if (a.groupId !== b.groupId && slotsClash(a, b)) return setError(`${slotLabel(a)} and ${slotLabel(b)} are in different groups but run at the same time, so a parent could not take both. Change one of them.`);
        }
      }
    }
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

  /** Everything about one slot: days, times, venue, seats, length, dates. */
  const slotBody = (s: TermSlot) => {
    const dates = slotDates(s);
    const pattern = slotPatternDates(s);
    const pickedDays = WEEKDAYS.filter((d) => s.days.includes(d.i));
    return (
      <>
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
                    <SelectField className={inputCls} value={s.locationId} onChange={(v) => setSlot(s.id, { locationId: v })} aria-label="Slot venue">
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
                  {!flexible && (
                  <div>
                    <label className={labelCls}>Price for this slot (SGD)</label>
                    <NumberInput
                      min="0"
                      step="any"
                      placeholder={`Same as term: ${t.price}`}
                      className={inputCls}
                      value={s.price == null ? '' : String(s.price)}
                      onChange={(e) => setSlot(s.id, { price: e.target.value === '' ? null : Number(e.target.value) || 0 })}
                      aria-label="Slot price"
                    />
                  </div>
                  )}
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
                          {holidays.length} public holiday{holidays.length === 1 ? '' : 's'} in this slot:{' '}
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
      </>
    );
  };

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
            <label className={labelCls}>{flexible ? 'Price for the whole term (SGD per child, one slot from each group)' : 'Full term price (SGD per child)'}</label>
            <NumberInput min="0" step="any" className={inputCls} value={String(t.price)} onChange={(e) => set({ price: Number(e.target.value) || 0 })} />
          </div>
          <div>
            <label className={labelCls}>Number of sessions</label>
            <NumberInput
              min="1"
              max={String(MAX_TERM_SESSIONS)}
              className={inputCls}
              value={sessionsDraft ?? (countsDiffer ? '' : String(firstCount))}
              placeholder={countsDiffer ? 'Differs by slot' : undefined}
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
              {flexible && comboSessions(t) > 0 && t.price > 0 ? `Per slot. A family's ${t.groups.length} slots give ${comboSessions(t)} sessions in all. ` : ''}
              Applies to every slot. Each slot can still be set by weeks below.
            </p>
          </div>
        </div>
      </Section>

      <Section
        n={2}
        title={flexible ? 'Groups and slots' : 'Slots'}
        subtitle={flexible
          ? 'Parents pick one slot from each group and keep that pair every week. Name each group so parents know what they are choosing.'
          : 'Parents pick one slot when they enrol and come on all of its days. Add a slot for each day and time you offer.'}
      >
        <ModeSwitch mode={t.slotMode} locked={term.status === 'published'} onChange={chooseMode} />
        {mergeAsk && (
          <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-bold text-amber-950">
              Simple has one list of slots. Your {t.groups.length} groups will be combined into one list of {t.slots.length} slots, and parents will pick just one.
            </p>
            <div className="flex gap-2">
              <Button type="button" onClick={mergeToSimple} className="h-9 rounded-lg px-4 text-sm font-bold gradient-primary text-white hover:opacity-90">Combine into one list</Button>
              <Button type="button" variant="outline" onClick={() => setMergeAsk(false)} className="h-9 rounded-lg px-4 text-sm font-semibold">Stay Flexible</Button>
            </div>
          </div>
        )}

        {!flexible ? (
          <>
            <div className="space-y-4">
              {t.slots.map((s, idx) => (
                <div key={s.id} className="rounded-xl border border-gray-300 bg-gray-50/60 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-base font-bold text-gray-900">Slot {idx + 1}</span>
                    {t.slots.length > 1 && (
                      <button
                        onClick={() => removeSlot(s.id)}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold text-gray-500 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" /> Remove
                      </button>
                    )}
                  </div>
                  {slotBody(s)}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <QuickAdd onCreate={(d, tm) => createSlots(t.groups[0].id, d, tm)} />
            </div>
            <button
              type="button"
              onClick={() => addSlotIn(t.groups[0].id)}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 text-[15px] font-bold text-gray-700 hover:border-[#FA4D8D] hover:text-[#FA4D8D]"
            >
              <Plus className="h-5 w-5" /> Add another slot
            </button>
          </>
        ) : (
          <>
            <div className="space-y-4">
              {t.groups.map((g, gi) => {
                const inGroup = t.slots.filter((sl) => sl.groupId === g.id);
                return (
                  <div key={g.id} className="space-y-3 rounded-2xl border border-gray-300 bg-gray-50/60 p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="text-sm font-semibold text-gray-700" htmlFor={`group-name-${g.id}`}>Group {gi + 1}</label>
                      <input
                        id={`group-name-${g.id}`}
                        className={cn(inputCls, 'max-w-xs font-bold')}
                        value={g.name}
                        placeholder="Name it, e.g. Mon & Tue"
                        onChange={(e) => setT((x) => ({ ...x, groups: x.groups.map((y) => (y.id === g.id ? { ...y, name: e.target.value } : y)) }))}
                      />
                      <span className="rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-bold text-teal-900">{inGroup.length} slot{inGroup.length === 1 ? '' : 's'}</span>
                      <span className="flex-1" />
                      {t.groups.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeGroup(g.id)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold text-gray-500 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" /> Remove group
                        </button>
                      )}
                    </div>

                    {inGroup.length === 0 && (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900">This group has no slots yet. Add at least one, or remove the group.</p>
                    )}
                    <div className="space-y-2">
                      {inGroup.map((s) => {
                        const open = openSlots.has(s.id);
                        const problems = problemsOf(s);
                        return (
                          <div key={s.id} className={cn('rounded-xl border bg-white', problems.length ? 'border-amber-300' : 'border-gray-200')}>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                              <span className="font-bold text-gray-900">{slotLabel(s)}</span>
                              <span className="text-sm text-gray-500">{s.duration} min · {s.capacity} seats</span>
                              <span className="flex-1" />
                              <button type="button" aria-expanded={open} onClick={() => toggleOpen(s.id)} className="rounded-lg px-2 py-1 text-sm font-semibold text-gray-700 hover:bg-gray-100">
                                {open ? 'Done' : 'Edit'}
                              </button>
                              <button type="button" onClick={() => removeSlot(s.id)} aria-label={`Remove ${slotLabel(s)}`} className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                            {problems.map((m) => (
                              <p key={m} className="mx-3.5 mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-[13px] font-semibold text-amber-900">{m}</p>
                            ))}
                            {open && <div className="border-t border-gray-100 p-4">{slotBody(s)}</div>}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <QuickAdd onCreate={(d, tm) => createSlots(g.id, d, tm)} />
                      <button type="button" onClick={() => addSlotIn(g.id)} className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold text-gray-700 hover:bg-gray-100">
                        <Plus className="h-4 w-4" /> Add one slot
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={addGroup}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 text-[15px] font-bold text-gray-700 hover:border-[#FA4D8D] hover:text-[#FA4D8D]"
            >
              <Plus className="h-5 w-5" /> Add another group
            </button>
            {(() => {
              const combos = t.groups.reduce((m, g) => m * t.slots.filter((sl) => sl.groupId === g.id).length, 1);
              return (
                <div className="rounded-xl bg-pink-50 p-4 text-sm text-gray-900">
                  <p className="font-bold">What parents will see</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {t.groups.map((g) => (
                      <span key={g.id} className="rounded-full border border-gray-300 bg-white px-3 py-1 text-[13px] font-bold">
                        Choose 1 · {g.name.trim() || 'Unnamed group'} ({t.slots.filter((sl) => sl.groupId === g.id).length})
                      </span>
                    ))}
                  </div>
                  <p className="mt-2">
                    {combos === 0
                      ? 'A group has no slots yet.'
                      : `That is ${combos} possible combination${combos === 1 ? '' : 's'}: ${t.groups.length} sessions a week, ${comboSessions(t)} sessions in all, for SGD ${t.price}.`}
                  </p>
                </div>
              );
            })()}
          </>
        )}
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
                  What a parent pays, by when they join <span className="font-normal text-gray-500">({flexible ? `${comboSessions(t)} sessions across their ${t.groups.length} slots` : `${n} sessions`}, SGD {ladderPrice})</span>
                </span>
                {t.slots.length > 1 && !flexible && (
                  <SelectField className="h-9 w-auto min-w-[9rem] rounded-lg border border-gray-300 px-3 text-sm font-semibold" value={String(ladderIdx)} onChange={(v) => setLadderIdx(Number(v))} aria-label="Show the price ladder for slot">
                    {t.slots.map((s, i) => <Opt key={s.id} value={String(i)}>Slot {i + 1} · {slotLabel(s)}</Opt>)}
                  </SelectField>
                )}
              </div>
              {/* Equal columns so every price and "left" count lines up down the list. */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {Array.from({ length: lastJoin + 1 }, (_, k) => (
                  <div key={k} className="grid grid-cols-[1fr_auto_4.5rem] items-baseline gap-3 rounded-lg bg-teal-100 px-3 py-1.5 text-sm tabular-nums text-teal-950">
                    <span>{k === 0 ? 'Before session 1' : `After session ${k}`}</span>
                    <strong className="text-right font-bold">SGD {priceAfter({ ...t, price: ladderPrice }, k * lanes)}</strong>
                    <span className="text-right text-teal-800/70">{n - k} left{flexible ? ' in each' : ''}</span>
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
const WAIT_STATUS: Record<TermWaitRow['status'], { label: string; cls: string }> = {
  waiting: { label: 'Waiting', cls: 'bg-amber-100 text-amber-900' },
  holding: { label: 'Holding a place', cls: 'bg-blue-100 text-blue-800' },
  offered: { label: 'Offered by you', cls: 'bg-pink-100 text-pink-800' },
};
const WAIT_KIND: Record<TermWaitRow['kind'], string> = {
  term: 'Term place',
  trial: 'Trial',
  single: 'Single session',
  package: 'Pack credit',
  makeup: 'Make-up',
};
const whenShort = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Who is waiting on a published term (00259-00261): families waiting for a
 * place in a full group, and for one trial or single session of it. The vendor
 * can offer one family a place (it may go over capacity), tell everyone about a
 * place that opened without a family leaving (that isn't announced on its own),
 * or take a family off the list. Shows nothing while nobody is waiting.
 */
function TermWaitlistTools({ term }: { term: Term }) {
  const [counts, setCounts] = useState<TermWaitCount[] | null>(null);
  const [rows, setRows] = useState<TermWaitRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<TermWaitRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let stale = false;
    fetchTermWaitlistCounts(term.id).then((c) => { if (!stale) setCounts(c); }).catch(() => { if (!stale) setCounts([]); });
    if (open) fetchTermWaitlist(term.id).then((r) => { if (!stale) setRows(r); }).catch(() => { if (!stale) setRows([]); });
    return () => { stale = true; };
  }, [term.id, open, version]);

  const total = (counts ?? []).reduce((n, c) => n + c.waiting + c.session_waiting, 0);
  if (!counts || total === 0) return null;

  const groupName = (slotId: string) => {
    const sl = term.slots.find((s) => s.id === slotId);
    if (!sl || term.slots.length < 2) return 'This term';
    return slotLabel(sl);
  };
  const freeFor = (slotId: string) => counts.find((c) => c.slot_id === slotId)?.free_places ?? 0;

  async function act(fn: () => Promise<string>, failed: string) {
    setBusy(true);
    try {
      toast(await fn());
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(failed, { description: (e as { message?: string })?.message });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      {counts.filter((c) => c.waiting > 0).map((c) => (
        <div key={c.slot_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900">
          <span className="min-w-0 flex-1">
            {c.free_places > 0
              ? `${groupName(c.slot_id)} has ${c.free_places === 1 ? 'a term place' : `${c.free_places} term places`} free and ${c.waiting} waiting. They haven't been told, because the place opened without a family leaving.`
              : `${groupName(c.slot_id)} is full, with ${c.waiting} waiting for a place. To take them, raise its places under Edit; everyone waiting is told straight away.`}
          </span>
          {c.free_places > 0 && (
            <Button
              disabled={busy}
              onClick={() => act(async () => {
                const n = await tellTermWaitlist(c.slot_id);
                return `${n} ${n === 1 ? 'family' : 'families'} told. The first to enrol gets the place.`;
              }, 'Could not tell them')}
              className="h-8 rounded-lg bg-[#FA4D8D] px-3 text-[13px] font-bold text-white hover:bg-[#e8437f]"
            >
              Tell everyone waiting
            </Button>
          )}
        </div>
      ))}

      <Button variant="outline" onClick={() => setOpen((v) => !v)} className="h-9 rounded-lg px-3 text-sm font-semibold">
        <Hourglass className="mr-1.5 h-4 w-4" /> {open ? 'Hide waitlist' : `Waitlist (${total})`}
      </Button>

      {open && (
        <div className="rounded-xl border border-gray-200">
          {rows === null ? (
            <p className={cn('p-3', hintCls)}>Loading…</p>
          ) : (
            <>
            {(() => {
              const seen = new Set<string>();
              const combos = rows.filter((r) => r.kind === 'term' && r.combo_id && !seen.has(r.combo_id) && seen.add(r.combo_id));
              if (combos.length === 0) return null;
              return (
                <div>
                  <div className="bg-gray-50 px-3 py-1.5 text-xs font-bold text-gray-600">Waiting for a combination</div>
                  {combos.map((r) => (
                    <div key={r.combo_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-3 py-2 first:border-t-0">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-gray-900">{r.child_name}</span>
                          {ageOf(r.child_dob) && <span className="text-xs text-gray-500">{ageOf(r.child_dob)}</span>}
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', WAIT_STATUS[r.status].cls)}>{WAIT_STATUS[r.status].label}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {(r.combo_slot_ids ?? []).map((id) => {
                            const sl = term.slots.find((x) => x.id === id);
                            const full = freeFor(id) <= 0;
                            return (
                              <span key={id} className={cn('rounded-full px-2.5 py-0.5 text-xs font-bold', full ? 'bg-amber-100 text-amber-900' : 'bg-teal-100 text-teal-900')}>
                                {sl ? slotLabel(sl) : 'Slot'} · {full ? 'full' : `${freeFor(id)} free`}
                              </span>
                            );
                          })}
                        </div>
                        <div className="mt-1 text-xs text-gray-500">
                          {[r.parent_name, r.parent_email].filter(Boolean).join(' · ')} · joined {new Date(r.joined_at).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' })}. Told when every slot has a place.
                        </div>
                      </div>
                      <div className="flex gap-1">
                        {r.status === 'waiting' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(async () => {
                              await offerTermPlace(r.id);
                              return `Places offered to ${r.child_name}'s family. They have been sent a link to pay.`;
                            }, 'Could not offer the places')}
                            className="rounded-lg px-2 py-1 text-sm font-semibold text-pink-700 hover:bg-pink-50"
                          >
                            Offer a place
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => { setRemoving(r); setReason(''); }}
                          className="rounded-lg px-2 py-1 text-sm font-semibold text-red-600 hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
            {term.slots.map((s, i) => {
              const list = rows.filter((r) => r.slot_id === s.id && !(r.kind === 'term' && r.combo_id));
              if (list.length === 0) return null;
              return (
                <div key={s.id} className={cn(i > 0 && 'border-t border-gray-100')}>
                  {term.slots.length > 1 && (
                    <div className="bg-gray-50 px-3 py-1.5 text-xs font-bold text-gray-600">{groupName(s.id)}</div>
                  )}
                  {list.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-3 py-2 first:border-t-0">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-gray-900">{r.child_name}</span>
                          {ageOf(r.child_dob) && <span className="text-xs text-gray-500">{ageOf(r.child_dob)}</span>}
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', WAIT_STATUS[r.status].cls)}>{WAIT_STATUS[r.status].label}</span>
                          <span className="text-[11px] font-semibold text-gray-500">
                            {WAIT_KIND[r.kind]}{r.session_starts_at ? ` · ${whenShort(r.session_starts_at)}` : ''}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500">
                          {[r.parent_name, r.parent_email].filter(Boolean).join(' · ')} · joined {new Date(r.joined_at).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' })}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        {r.status === 'waiting' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(async () => {
                              if (r.kind === 'term') await offerTermPlace(r.id);
                              else await offerSessionPlace(r.id);
                              return `Place offered to ${r.child_name}'s family. They have been sent a link to pay.`;
                            }, 'Could not offer the place')}
                            className="rounded-lg px-2 py-1 text-sm font-semibold text-pink-700 hover:bg-pink-50"
                          >
                            Offer a place
                          </button>
                        )}
                        {r.kind === 'term' && (
                          <button
                            type="button"
                            onClick={() => { setRemoving(r); setReason(''); }}
                            className="rounded-lg px-2 py-1 text-sm font-semibold text-red-600 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
            </>
          )}
          {rows !== null && (
            <p className={cn('border-t border-gray-100 px-3 py-2', hintCls)}>
              Offering a place sends that family a link to pay, even when the slot is full: their sessions grow by one place.
            </p>
          )}
        </div>
      )}

      {removing && (
        <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-bold text-red-900">
            Take {removing.child_name} off the waitlist for {term.name}? The family is told.
          </p>
          <input className={inputCls} placeholder="Reason, shown to the family (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() => act(async () => {
                await removeFromTermWaitlist(removing.id, reason);
                const name = removing.child_name;
                setRemoving(null);
                return `${name} is off the waitlist.`;
              }, 'Could not remove them')}
              className="h-9 rounded-lg bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-700"
            >
              Remove
            </Button>
            <Button variant="outline" onClick={() => setRemoving(null)} className="h-9 rounded-lg px-4 text-sm font-semibold">
              Keep
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Under a published term: its numbers, who is enrolled (with Withdraw), copying
 * it into the next term, and opening re-enrolment for this term's families.
 */
function PublishedTermTools({ term, hasNext, onCopy }: { term: Term; hasNext: boolean; onCopy: () => void }) {
  const [stats, setStats] = useState<SlotStats[] | null>(null);
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [withdrawing, setWithdrawing] = useState<RosterRow | null>(null);
  const [moving, setMoving] = useState<{ row: RosterRow; to: string } | null>(null);
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

  async function confirmMove() {
    if (!moving) return;
    setBusy(true);
    try {
      const n = await swapTermSlot(moving.row.enrolment_id, moving.to);
      toast(`${moving.row.child_name} moved. ${n} upcoming session${n === 1 ? '' : 's'} moved with them, and the family has been told.`);
      setMoving(null);
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error('Could not move them', { description: (e as { message?: string })?.message });
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
      {isFlexible(term) && stats && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {term.groups.map((g) => (
            <div key={g.id} className="space-y-1.5 rounded-xl bg-gray-50 p-3">
              <div className="text-xs font-bold uppercase tracking-wide text-gray-500">{g.name || 'Group'}</div>
              {term.slots.filter((sl) => sl.groupId === g.id).map((sl) => {
                const st = stats.find((x) => x.slot_id === sl.id);
                const taken = st?.enrolled ?? 0;
                const pct = sl.capacity > 0 ? Math.min(100, Math.round((100 * taken) / sl.capacity)) : 0;
                const full = st?.places_left != null && st.places_left <= 0;
                return (
                  <div key={sl.id} className="rounded-lg bg-white p-2">
                    <div className="flex items-center justify-between gap-2 text-sm font-bold text-gray-900">
                      <span>{slotLabel(sl)}</span>
                      {full ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900">Full</span> : <span className="text-xs font-semibold text-gray-500">{st?.places_left ?? '—'} left</span>}
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200">
                      <div className={cn('h-full', full ? 'bg-[#FA4D8D]' : 'bg-teal-600')} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-500">{taken} of {sl.capacity} seats</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
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
          ) : isFlexible(term) ? (
            (() => {
              const families = new Map<string, RosterRow[]>();
              for (const r of roster) families.set(r.combo_id ?? r.enrolment_id, [...(families.get(r.combo_id ?? r.enrolment_id) ?? []), r]);
              return [...families.values()].map((rows) => {
                const first = rows[0];
                const live = rows.filter((r) => r.status !== 'withdrawn');
                const status = rows.some((r) => r.status === 'unpaid') ? 'unpaid' : live.length === 0 ? 'withdrawn' : 'enrolled';
                const left = rows.reduce((n2, r) => n2 + r.sessions_left, 0);
                return (
                  <div key={first.combo_id ?? first.enrolment_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-3 py-2 first:border-t-0">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-gray-900">{first.child_name}</span>
                        {ageOf(first.child_dob) && <span className="text-xs text-gray-500">{ageOf(first.child_dob)}</span>}
                        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', ROSTER_STATUS[status])}>
                          {status === 'enrolled' ? 'Enrolled' : status === 'unpaid' ? 'Awaiting payment' : 'Withdrawn'}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {rows.map((r) => {
                          const sl = term.slots.find((x) => x.id === r.slot_id);
                          return (
                            <button
                              key={r.enrolment_id}
                              type="button"
                              disabled={r.status === 'withdrawn' || r.sessions_left === 0}
                              onClick={() => {
                                const options = term.slots.filter((o) => sl && o.groupId === sl.groupId && o.id !== sl.id);
                                setMoving({ row: r, to: options[0]?.id ?? '' });
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-bold text-gray-900 hover:border-[#FA4D8D] disabled:opacity-50"
                              title="Move to another slot in this group"
                            >
                              {sl ? slotLabel(sl) : 'Slot'} <span className="font-semibold text-gray-500">Move ▾</span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {[first.parent_name, first.parent_email].filter(Boolean).join(' · ')} · {money(rows.reduce((n2, r) => n2 + r.price_cents, 0))} · {left} of {rows.reduce((n2, r) => n2 + r.sessions, 0)} sessions left
                      </div>
                    </div>
                    {status !== 'withdrawn' && left > 0 && (
                      <button
                        type="button"
                        onClick={() => { setWithdrawing({ ...first, sessions_left: left }); setRefund('refund'); setReason(''); }}
                        className="rounded-lg px-2 py-1 text-sm font-semibold text-red-600 hover:bg-red-50"
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                );
              });
            })()
          ) : (
            term.slots.map((s, i) => {
              const rows = roster.filter((r) => r.slot_id === s.id);
              if (rows.length === 0) return null;
              return (
                <div key={s.id} className={cn(i > 0 && 'border-t border-gray-100')}>
                  {term.slots.length > 1 && (
                    <div className="bg-gray-50 px-3 py-1.5 text-xs font-bold text-gray-600">
                      Slot {i + 1} · {slotLabel(s)}
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

      <TermWaitlistTools term={term} />

      {moving && (() => {
        const cur = term.slots.find((x) => x.id === moving.row.slot_id);
        const options = term.slots.filter((o) => cur && o.groupId === cur.groupId && o.id !== cur.id);
        const group = term.groups.find((g) => g.id === cur?.groupId);
        const other = roster?.filter((r) => r.combo_id && r.combo_id === moving.row.combo_id && r.enrolment_id !== moving.row.enrolment_id)
          .map((r) => term.slots.find((x) => x.id === r.slot_id)).filter(Boolean).map((x) => slotLabel(x!)).join(', ');
        return (
          <div className="space-y-3 rounded-xl border-2 border-[#FA4D8D] bg-white p-4" role="dialog" aria-label={`Move ${moving.row.child_name}`}>
            <p className="text-base font-bold text-gray-900">Move {moving.row.child_name} from {cur ? slotLabel(cur) : 'this slot'}</p>
            <p className={hintCls}>
              Pick another slot in {group?.name || 'this group'}. Their remaining sessions move with them{other ? `, and ${other} stays as it is` : ''}. Nothing more to pay, and the family is told.
            </p>
            {options.length === 0 ? (
              <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">There is no other slot in this group.</p>
            ) : (
              <div className="space-y-2">
                {options.map((o) => {
                  const st = stats?.find((x) => x.slot_id === o.id);
                  const full = st?.places_left != null && st.places_left <= 0;
                  return (
                    <label key={o.id} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 font-semibold', full ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400' : 'border-gray-300 text-gray-900')}>
                      <input type="radio" name="move-to" disabled={full} checked={moving.to === o.id} onChange={() => setMoving({ ...moving, to: o.id })} className="h-4 w-4 accent-[#FA4D8D]" />
                      <span className="flex-1">{slotLabel(o)}</span>
                      <span className="text-xs font-semibold text-gray-500">{full ? 'Full' : st?.places_left != null ? `${st.places_left} seats free` : 'Open'}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2">
              <Button disabled={busy || !moving.to} onClick={confirmMove} className="h-9 rounded-lg px-4 text-sm font-bold gradient-primary text-white hover:opacity-90">
                Move {moving.row.child_name}
              </Button>
              <Button variant="outline" onClick={() => setMoving(null)} className="h-9 rounded-lg px-4 text-sm font-semibold">Cancel</Button>
            </div>
          </div>
        );
      })()}

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
