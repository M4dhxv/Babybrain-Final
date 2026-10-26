import { useState } from 'react';
import { NumberInput } from '@/components/ui/number-input';

/* Weekday prices for an activity (activities.day_prices, migration 00258): a different price on
   certain days, for example a weekend price is just Saturday + Sunday. Beats a price set on a single
   session, which beats the activity's own price. */

/** Weekday prices as typed: '0'..'6' (Sunday..Saturday, Singapore time) to the input's text. */
export type DayPrices = Record<string, string>;

const DAYS: { key: string; label: string }[] = [
  { key: '1', label: 'Mon' }, { key: '2', label: 'Tue' }, { key: '3', label: 'Wed' },
  { key: '4', label: 'Thu' }, { key: '5', label: 'Fri' }, { key: '6', label: 'Sat' }, { key: '0', label: 'Sun' },
];
const WEEKDAYS = ['1', '2', '3', '4', '5'];
const WEEKEND = ['6', '0'];

/** Typed day prices -> the jsonb stored on activities.day_prices (empty boxes dropped). */
export function dayPricesToJson(d: DayPrices): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) out[k] = Number(v);
  }
  return out;
}
export function dayPricesFromJson(j: Record<string, number> | null | undefined): DayPrices {
  const out: DayPrices = {};
  for (const [k, v] of Object.entries(j ?? {})) out[k] = String(v);
  return out;
}

const money = (v: string) => `$${Number(v) % 1 === 0 ? Number(v).toFixed(0) : Number(v).toFixed(2)}`;

/** "Sat & Sun $50 · Mon $30" — what the folded day-price line says once set. */
function daySummary(d: DayPrices): string {
  const set = DAYS.filter((x) => (d[x.key] ?? '').trim() !== '');
  if (!set.length) return '';
  const byPrice = new Map<string, string[]>();
  for (const x of set) byPrice.set(d[x.key], [...(byPrice.get(d[x.key]) ?? []), x.key]);
  return [...byPrice]
    .map(([price, keys]) => {
      const same = (a: string[]) => a.length === keys.length && a.every((k) => keys.includes(k));
      const label = same(WEEKEND) ? 'Weekends' : same(WEEKDAYS) ? 'Weekdays' : keys.map((k) => DAYS.find((x) => x.key === k)!.label).join(', ');
      return `${label} ${money(price)}`;
    })
    .join(' · ');
}

export function DayPricesEditor({ value, onChange, basePrice }: { value: DayPrices; onChange: (v: DayPrices) => void; basePrice: string }) {
  const summary = daySummary(value);
  const [open, setOpen] = useState(false);
  const [eachDay, setEachDay] = useState(false);
  const group = (keys: string[]) => {
    const vals = keys.map((k) => value[k] ?? '');
    return vals.every((v) => v === vals[0]) ? vals[0] : '';
  };
  const setGroup = (keys: string[], v: string) => onChange({ ...value, ...Object.fromEntries(keys.map((k) => [k, v])) });
  const smallCls = 'w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';
  const placeholder = basePrice ? money(basePrice) : '—';

  if (!open) {
    return (
      <p className="mt-1.5 text-xs text-gray-500">
        {summary ? <span className="font-medium text-gray-700">{summary}. </span> : null}
        <button type="button" onClick={() => setOpen(true)} className="font-medium text-[#FA4D8D] hover:underline">
          {summary ? 'Change day prices' : 'Different price on certain days'}
        </button>
      </p>
    );
  }
  return (
    <div className="mt-2 rounded-lg bg-gray-50 p-3">
      {eachDay ? (
        <div className="grid grid-cols-7 gap-1.5">
          {DAYS.map((d) => (
            <label key={d.key} className="block text-center text-[11px] font-medium text-gray-600">
              {d.label}
              <NumberInput min="0" step="any" placeholder={placeholder} className={smallCls} value={value[d.key] ?? ''} onChange={(e) => onChange({ ...value, [d.key]: e.target.value })} aria-label={`${d.label} price`} />
            </label>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-medium text-gray-600">
            Weekdays (Mon–Fri)
            <NumberInput min="0" step="any" placeholder={placeholder} className={smallCls} value={group(WEEKDAYS)} onChange={(e) => setGroup(WEEKDAYS, e.target.value)} />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Weekends (Sat–Sun)
            <NumberInput min="0" step="any" placeholder={placeholder} className={smallCls} value={group(WEEKEND)} onChange={(e) => setGroup(WEEKEND, e.target.value)} />
          </label>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-500">
        Applies to every session on that day, including ones already scheduled, and beats a price set on a single session. Leave blank to use {basePrice ? money(basePrice) : 'the usual price'}.{' '}
        <button type="button" onClick={() => setEachDay((v) => !v)} className="font-medium text-[#FA4D8D] hover:underline">
          {eachDay ? 'Weekdays and weekends' : 'Set each day'}
        </button>
        {' · '}
        <button type="button" onClick={() => { onChange({}); setOpen(false); }} className="font-medium text-gray-600 hover:underline">
          Clear
        </button>
        {' · '}
        <button type="button" onClick={() => setOpen(false)} className="font-medium text-gray-600 hover:underline">
          Done
        </button>
      </p>
    </div>
  );
}
