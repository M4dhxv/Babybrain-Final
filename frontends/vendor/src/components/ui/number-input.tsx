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
        const caret = e.target.selectionStart ?? raw.length;
        const clean = (v: string) => {
          // A whole-number field drops a pasted fraction ("3.5" -> "3") rather than
          // gluing the digits together ("35").
          let c = (decimal ? v : v.split('.')[0]).replace(decimal ? /[^\d.]/g : /\D/g, '');
          if (!decimal) c = c.replace(/^0+(?=\d)/, '');
          if (decimal) {
            const i = c.indexOf('.');
            if (i >= 0) c = c.slice(0, i + 1) + c.slice(i + 1).replace(/\./g, '');
          }
          return c;
        };
        const cleaned = clean(raw);
        if (cleaned !== raw) {
          // Assigning .value directly (needed to strip what was just typed)
          // snaps the native caret to the end of the field, so typing a digit
          // in the middle of a number ends up appended at the end instead —
          // this reproduces the filter on just the prefix up to where the
          // vendor was typing, to put the caret back where it belongs.
          const prefixLen = clean(raw.slice(0, caret)).length;
          e.target.value = cleaned;
          e.target.setSelectionRange(prefixLen, prefixLen);
        }
        onChange?.(e);
      }}
    />
  );
}
