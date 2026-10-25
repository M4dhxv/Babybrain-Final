import { useState } from 'react';
import { NumberInput } from '@/components/ui/number-input';
import { SelectField, Opt } from '@/components/ui/select-field';
import { cn } from '@/lib/utils';

/* An activity's age range, typed in months or picked as birth years (QA: some
   vendors group classes by birth year, "born 2021–2022"). Either way it saves
   as the months range activities already store, so Explore's age filter and
   matching are unchanged. Birth years are worked out against today's date, so
   the months shown for them are as of today. */

/** BabyBrain lists activities for children up to 11 (132 months). */
const MAX_MONTHS = 132;

/** Whole months from `dob` to `now`. */
function monthsBetween(dob: Date, now: Date): number {
  return (now.getFullYear() - dob.getFullYear()) * 12 + (now.getMonth() - dob.getMonth()) - (now.getDate() < dob.getDate() ? 1 : 0);
}

/** Born in `fromYear`…`toYear` (either order) -> the months range children of those years are in today. */
function monthsForBirthYears(fromYear: number, toYear: number, now = new Date()): { min: number; max: number } {
  const older = Math.min(fromYear, toYear);
  const younger = Math.max(fromYear, toYear);
  // The youngest is born on 31 Dec of the later year, the oldest on 1 Jan of the earlier one.
  const min = Math.max(0, monthsBetween(new Date(younger, 11, 31), now));
  const max = Math.min(MAX_MONTHS, Math.max(0, monthsBetween(new Date(older, 0, 1), now)));
  return { min, max: Math.max(min, max) };
}

const ageText = (m: number) => {
  if (m < 24) return `${m} month${m === 1 ? '' : 's'}`;
  const y = Math.floor(m / 12);
  const r = m % 12;
  return r ? `${y}y ${r}m` : `${y} years`;
};

export function AgeRangeField({ min, max, onChange, inputCls }: {
  /** Months as strings, '' when blank — the drawer form's own values. */
  min: string;
  max: string;
  onChange: (min: string, max: string) => void;
  inputCls: string;
}) {
  const thisYear = new Date().getFullYear();
  // This year back to the oldest year still inside the 11-year cap.
  const years = Array.from({ length: 12 }, (_, i) => String(thisYear - i));
  const [mode, setMode] = useState<'months' | 'years'>('months');
  const [fromYear, setFromYear] = useState('');
  const [toYear, setToYear] = useState('');
  const [echo, setEcho] = useState(`${min}|${max}`);
  // Months set from outside (another activity opened, a reset) show as months:
  // birth years picked for the previous activity no longer describe them.
  if (`${min}|${max}` !== echo) {
    setEcho(`${min}|${max}`);
    if (mode === 'years') { setMode('months'); setFromYear(''); setToYear(''); }
  }

  const pickYears = (from: string, to: string) => {
    setFromYear(from);
    setToYear(to);
    if (!from || !to) return;
    const r = monthsForBirthYears(Number(from), Number(to));
    setEcho(`${r.min}|${r.max}`);
    onChange(String(r.min), String(r.max));
  };

  const tab = (m: 'months' | 'years', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
      )}
    >
      {label}
    </button>
  );

  const hasMonths = min !== '' && max !== '';
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label className="block text-sm font-medium text-gray-900">Age range</label>
        <div role="tablist" aria-label="Enter ages as" className="inline-flex rounded-lg bg-gray-100 p-0.5">
          {tab('months', 'Months')}
          {tab('years', 'Birth year')}
        </div>
      </div>
      {mode === 'months' ? (
        <div className="flex items-center gap-3">
          <NumberInput min="0" placeholder="Min (months)" aria-label="Minimum age in months" className={inputCls} value={min} onChange={(e) => onChange(e.target.value, max)} />
          <span className="text-gray-400">—</span>
          <NumberInput min="0" placeholder="Max (months)" aria-label="Maximum age in months" className={inputCls} value={max} onChange={(e) => onChange(min, e.target.value)} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <SelectField value={fromYear} onChange={(v) => pickYears(v, toYear)} placeholder="Born from" aria-label="Born from year" className={inputCls}>
              {years.map((y) => <Opt key={y} value={y}>{y}</Opt>)}
            </SelectField>
            <span className="text-gray-400">—</span>
            <SelectField value={toYear} onChange={(v) => pickYears(fromYear, v)} placeholder="Born to" aria-label="Born to year" className={inputCls}>
              {years.map((y) => <Opt key={y} value={y}>{y}</Opt>)}
            </SelectField>
          </div>
          <p className="mt-1.5 text-xs text-gray-500">
            {fromYear && toYear && hasMonths
              ? `Children born ${Math.min(+fromYear, +toYear)}${fromYear !== toYear ? `–${Math.max(+fromYear, +toYear)}` : ''} are ${ageText(Number(min))} to ${ageText(Number(max))} today, so that's the range saved. It stays fixed in months, so pick the years again when your groups move up.`
              : 'Pick the earliest and latest birth year. It saves as an age range in months, worked out from today.'}
          </p>
        </>
      )}
    </div>
  );
}
