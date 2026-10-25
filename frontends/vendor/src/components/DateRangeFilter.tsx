import { useState } from 'react';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';
import { cn } from '@/lib/utils';
import { RANGE_PRESETS, daysBetween, presetFor, rangeLabel, type DateRange } from '@/lib/dateRange';

/* A date range for a list: quick presets on the left, any From / To on the
   right. Dates are Singapore calendar days as ISO yyyy-mm-dd, the same values
   DatePicker speaks. The dashboard used to offer only "Next 7 / 30 / 90 days"
   (QA: "a bit rigid"). The range helpers live in lib/dateRange. */

/** Longest custom range, so one pick can't ask for years of sessions. */
const MAX_SPAN_DAYS = 366;

export function DateRangeFilter({ value, onChange, className }: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  const active = presetFor(value)?.key ?? 'custom';

  const span = draft.from && draft.to ? daysBetween(draft.from, draft.to) : -1;
  const draftError = !draft.from || !draft.to
    ? null
    : span < 0 ? 'The end date is before the start date.'
    : span >= MAX_SPAN_DAYS ? 'Pick a range of up to a year.'
    : null;
  const canApply = !!draft.from && !!draft.to && !draftError;

  const show = () => { setDraft(value); setOpen(true); };
  const pick = (r: DateRange) => { onChange(r); setOpen(false); };

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : show())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-9 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50"
      >
        <CalendarDays className="h-4 w-4 text-gray-500" />
        <span className="whitespace-nowrap font-medium">{rangeLabel(value)}</span>
        <ChevronDown className={cn('h-4 w-4 text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          {/* Click-away layer. The calendars are portalled above it (z-60),
              so picking a day doesn't count as clicking away. */}
          <div className="fixed inset-0 z-30" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Choose a date range"
            className="absolute left-0 top-full z-40 mt-2 w-[min(92vw,30rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg sm:flex"
          >
            <ul className="border-b border-gray-100 py-1.5 sm:w-44 sm:shrink-0 sm:border-b-0 sm:border-r">
              {RANGE_PRESETS.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    onClick={() => pick(p.range())}
                    className={cn(
                      'flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-gray-50',
                      active === p.key ? 'font-medium text-[#FA4D8D]' : 'text-gray-700',
                    )}
                  >
                    {p.label}
                    {active === p.key && <Check className="h-4 w-4" />}
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex-1 p-4">
              <div className="text-sm font-semibold text-gray-900">Custom range</div>
              <p className="mt-0.5 text-xs text-gray-500">Any dates, past or upcoming.</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-600">From</span>
                  <DatePicker value={draft.from} onChange={(v) => setDraft((d) => ({ ...d, from: v }))} aria-label="From date" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-600">To</span>
                  <DatePicker
                    value={draft.to}
                    min={draft.from || undefined}
                    onChange={(v) => setDraft((d) => ({ ...d, to: v }))}
                    aria-label="To date"
                  />
                </label>
              </div>
              {draftError && <p className="mt-2 text-xs font-medium text-red-600">{draftError}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="h-9 rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canApply}
                  onClick={() => pick(draft)}
                  className="h-9 rounded-lg bg-[#FA4D8D] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
