import { useState } from 'react';
import { NumberInput } from '@/components/ui/number-input';
import { SelectField, Opt } from '@/components/ui/select-field';
import { cn } from '@/lib/utils';

/* A length of time as a number plus a unit (minutes / hours / days), stored
   as whole minutes. The booking cut-off used to be minutes only, so a vendor
   wanting "24 hours" had to type 1440 (QA). The value in and out is still the
   minutes string the forms already keep ('' = blank). */

type Unit = 'minutes' | 'hours' | 'days';
const FACTOR: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

/** The largest unit the minutes divide into evenly, days only from two days up
 *  (as lib/duration words it): 1440 -> 24 hours, 4320 -> 3 days, 90 -> 90 minutes. */
function split(minutes: string): { amount: string; unit: Unit } {
  const n = Number(minutes);
  if (minutes === '' || !Number.isFinite(n) || n <= 0) return { amount: minutes, unit: 'minutes' };
  if (n >= 2880 && n % 1440 === 0) return { amount: String(n / 1440), unit: 'days' };
  if (n % 60 === 0) return { amount: String(n / 60), unit: 'hours' };
  return { amount: String(n), unit: 'minutes' };
}

const toMinutes = (amount: string, unit: Unit) =>
  amount === '' ? '' : String(Math.round(Number(amount) * FACTOR[unit]));

export function DurationInput({ value, onChange, className, 'aria-label': ariaLabel }: {
  /** Whole minutes as a string, '' when blank. */
  value: string;
  onChange: (minutes: string) => void;
  /** Classes for both boxes (border, padding, radius). */
  className?: string;
  'aria-label'?: string;
}) {
  const [state, setState] = useState(() => split(value));
  const [lastValue, setLastValue] = useState(value);
  // Follow a value set from outside (a form reset, opening another activity),
  // but not our own echo — "1.5 hours" must stay as typed, not jump to 90 minutes.
  if (value !== lastValue) {
    setLastValue(value);
    if (value !== toMinutes(state.amount, state.unit)) setState(split(value));
  }

  const set = (amount: string, unit: Unit) => {
    setState({ amount, unit });
    const minutes = toMinutes(amount, unit);
    setLastValue(minutes);
    onChange(minutes);
  };
  const one = Number(state.amount) === 1;

  return (
    <div className="flex gap-2">
      <NumberInput
        step={state.unit === 'minutes' ? undefined : 'any'}
        min="0"
        aria-label={ariaLabel}
        className={cn(className, 'min-w-0 flex-1')}
        value={state.amount}
        onChange={(e) => set(e.target.value, state.unit)}
      />
      {/* Changing the unit keeps the number: "24" then Hours means 24 hours. */}
      <SelectField
        value={state.unit}
        onChange={(v) => set(state.amount, v as Unit)}
        aria-label={ariaLabel ? `${ariaLabel} unit` : 'Unit'}
        className={cn(className, 'w-[7.5rem] shrink-0')}
      >
        <Opt value="minutes">{one ? 'Minute' : 'Minutes'}</Opt>
        <Opt value="hours">{one ? 'Hour' : 'Hours'}</Opt>
        <Opt value="days">{one ? 'Day' : 'Days'}</Opt>
      </SelectField>
    </div>
  );
}
