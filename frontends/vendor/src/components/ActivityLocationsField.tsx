import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { NumberInput } from '@/components/ui/number-input';
import { SelectField, Opt } from '@/components/ui/select-field';

/* An activity's venues and their prices (migration 00250), as one block on the
   activity form rather than separate location and price sections: each venue
   carries its own price and, folded away until asked for, its weekday prices.
   The first venue is the primary one (activities.location_id) and its price is
   the activity's own price; another venue left blank costs the same. */

/** Weekday prices as typed: '0'..'6' (Sunday..Saturday, Singapore time) to the input's text. */
export type DayPrices = Record<string, string>;
export type ExtraLocation = { location_id: string; price: string; day_prices: DayPrices };

const DAYS: { key: string; label: string }[] = [
  { key: '1', label: 'Mon' }, { key: '2', label: 'Tue' }, { key: '3', label: 'Wed' },
  { key: '4', label: 'Thu' }, { key: '5', label: 'Fri' }, { key: '6', label: 'Sat' }, { key: '0', label: 'Sun' },
];
const WEEKDAYS = ['1', '2', '3', '4', '5'];
const WEEKEND = ['6', '0'];

/** Typed day prices -> the jsonb stored on activity_locations (empty boxes dropped). */
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

function DayPricesEditor({ value, onChange, basePrice }: { value: DayPrices; onChange: (v: DayPrices) => void; basePrice: string }) {
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
        Applies to every session on that day here, including ones already scheduled, and beats a price set on a single session. Leave blank to use {basePrice ? money(basePrice) : 'the usual price'}.{' '}
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

export function ActivityLocationsField({
  locations,
  inputCls,
  primaryId,
  onPrimaryId,
  price,
  onPrice,
  primaryDays,
  onPrimaryDays,
  extras,
  onExtras,
}: {
  locations: { id: string; name: string }[];
  inputCls: string;
  primaryId: string;
  onPrimaryId: (v: string) => void;
  /** The primary venue's price = the activity's own price. */
  price: string;
  onPrice: (v: string) => void;
  primaryDays: DayPrices;
  onPrimaryDays: (v: DayPrices) => void;
  extras: ExtraLocation[];
  onExtras: (v: ExtraLocation[]) => void;
}) {
  const chosen = new Set([primaryId, ...extras.map((x) => x.location_id)].filter(Boolean));
  const free = (own: string) => locations.filter((l) => l.id === own || !chosen.has(l.id));
  const canAdd = !!primaryId && locations.some((l) => !chosen.has(l.id)) && extras.every((x) => x.location_id);
  const setExtra = (i: number, patch: Partial<ExtraLocation>) => onExtras(extras.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const boxCls = 'rounded-xl border border-gray-200 p-3';

  return (
    <div className="space-y-2">
      <div className={boxCls}>
        <p className="mb-1.5 text-xs font-medium text-gray-500">{extras.length ? 'Primary location' : 'Location'}</p>
        <SelectField className={inputCls} value={primaryId} onChange={onPrimaryId} placeholder="Select a location" aria-label="Primary location">
          <Opt value="">Select a location</Opt>
          {free(primaryId).map((l) => <Opt key={l.id} value={l.id}>{l.name}</Opt>)}
        </SelectField>
        <label className="mt-2 mb-1 block text-xs font-medium text-gray-500">Price (SGD per session)</label>
        <NumberInput min="0" step="any" placeholder="e.g. 45" className={inputCls} value={price} onChange={(e) => onPrice(e.target.value)} />
        <DayPricesEditor value={primaryDays} onChange={onPrimaryDays} basePrice={price} />
      </div>

      {extras.map((x, i) => (
        <div key={i} className={boxCls}>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium text-gray-500">Location {i + 2}</p>
            <button type="button" onClick={() => onExtras(extras.filter((_, j) => j !== i))} className="rounded p-0.5 text-gray-400 hover:text-gray-700" aria-label="Remove this location">
              <X className="h-4 w-4" />
            </button>
          </div>
          <SelectField className={inputCls} value={x.location_id} onChange={(v) => setExtra(i, { location_id: v })} placeholder="Select a location" aria-label={`Location ${i + 2}`}>
            <Opt value="">Select a location</Opt>
            {free(x.location_id).map((l) => <Opt key={l.id} value={l.id}>{l.name}</Opt>)}
          </SelectField>
          <label className="mt-2 mb-1 block text-xs font-medium text-gray-500">Price (SGD per session)</label>
          <NumberInput
            min="0"
            step="any"
            placeholder={price ? `Same as primary (${money(price)})` : 'Same as primary'}
            className={inputCls}
            value={x.price}
            onChange={(e) => setExtra(i, { price: e.target.value })}
          />
          <DayPricesEditor value={x.day_prices} onChange={(v) => setExtra(i, { day_prices: v })} basePrice={x.price || price} />
        </div>
      ))}

      {canAdd && (
        <button
          type="button"
          onClick={() => onExtras([...extras, { location_id: '', price: '', day_prices: {} }])}
          className="inline-flex items-center gap-1 text-sm font-medium text-[#FA4D8D] hover:underline"
        >
          <Plus className="h-4 w-4" /> Add another location
        </button>
      )}
    </div>
  );
}
