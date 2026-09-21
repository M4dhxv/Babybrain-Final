import type { InputHTMLAttributes } from 'react';

/**
 * A numeric text field. A native <input type="number"> silently changes value on
 * mouse-wheel / trackpad scroll and on the spinner / arrow keys (33 -> 36),
 * which is dangerous in a form that saves to the backend. This is a plain text
 * input that only accepts digits (and one decimal point when `step="any"`),
 * so nothing but typing can change the value. Callers keep the same
 * `value` / `onChange(e.target.value)` string contract as before.
 */
export function NumberInput({ step, min: _min, max: _max, onChange, onWheel, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const decimal = step === 'any';
  return (
    <input
      {...rest}
      type="text"
      inputMode={decimal ? 'decimal' : 'numeric'}
      autoComplete="off"
      onWheel={(e) => { e.currentTarget.blur(); onWheel?.(e); }}
      onChange={(e) => {
        const raw = e.target.value;
        // A whole-number field drops a pasted fraction ("3.5" -> "3") rather than
        // gluing the digits together ("35").
        let clean = (decimal ? raw : raw.split('.')[0]).replace(decimal ? /[^\d.]/g : /\D/g, '');
        if (!decimal) clean = clean.replace(/^0+(?=\d)/, '');
        if (decimal) {
          const i = clean.indexOf('.');
          if (i >= 0) clean = clean.slice(0, i + 1) + clean.slice(i + 1).replace(/\./g, '');
        }
        if (clean !== raw) e.target.value = clean;
        onChange?.(e);
      }}
    />
  );
}
