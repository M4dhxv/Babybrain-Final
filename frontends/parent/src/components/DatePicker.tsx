import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Site date field — a typeable DD-MM-YYYY input paired with our own calendar
 * popover, in place of the browser's native <input type="date"> control.
 *
 * `value` / `onChange` speak ISO yyyy-mm-dd (or "" when empty), matching what
 * the native input used, so call sites only swap the tag. The calendar is
 * portalled to <body> and fixed-positioned so a drawer's overflow never clips
 * it. Keyboard in the grid: ←→↑↓ move a day/week, PageUp/PageDown move a
 * month (Shift = a year), Home/End jump to the week's ends, Enter picks, Esc
 * closes. This file is intentionally identical between the vendor and parent
 * apps.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const toISO = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parseISO(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2] - 1;
  const d = +m[3];
  const dt = new Date(y, mo, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return { y, m: mo, d };
}
const isoToUk = (iso: string) => {
  const p = parseISO(iso);
  return p ? `${pad(p.d)}-${pad(p.m + 1)}-${p.y}` : '';
};
const todayISO = () => {
  const n = new Date();
  return toISO(n.getFullYear(), n.getMonth(), n.getDate());
};
/** ISO date shifted by whole days / months / years, still a valid ISO date. */
function shift(iso: string, opts: { d?: number; m?: number; y?: number }): string {
  const p = parseISO(iso) ?? parseISO(todayISO())!;
  const dt = new Date(p.y + (opts.y ?? 0), p.m + (opts.m ?? 0), p.d + (opts.d ?? 0));
  return toISO(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

type DatePickerProps = {
  /** ISO yyyy-mm-dd, or "" when empty. */
  value: string;
  onChange: (iso: string) => void;
  /** Classes for the text input (width, font-weight, …). */
  className?: string;
  /** Strip the input's border/background/padding for use inside an existing
   *  bordered pill (the Bookings date filter). */
  bare?: boolean;
  id?: string;
  placeholder?: string;
  /** Inclusive ISO bounds; days outside are shown disabled. */
  min?: string;
  max?: string;
  disabled?: boolean;
  'aria-label'?: string;
};

const INPUT_BASE =
  'w-full rounded-[10px] border border-[#EBE3E5] bg-[#FAF7F7] px-3 py-2 text-sm text-[#211D20] transition-colors focus:outline-none focus-visible:border-[#FA4D8D] disabled:cursor-not-allowed disabled:opacity-60';

export function DatePicker({
  value,
  onChange,
  className,
  bare = false,
  id,
  placeholder = 'dd-mm-yyyy',
  min,
  max,
  disabled = false,
  'aria-label': ariaLabel,
}: DatePickerProps) {
  const [text, setText] = useState(() => isoToUk(value));
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(isoToUk(value));
  }

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const p = parseISO(value) ?? parseISO(todayISO())!;
    return { y: p.y, m: p.m };
  });
  const [active, setActive] = useState<string>(value || todayISO());
  const [pos, setPos] = useState<{ left: number; top: number; drop: 'down' | 'up' }>({
    left: 0,
    top: 0,
    drop: 'down',
  });

  const wrapRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const disabledISO = (iso: string) => (!!min && iso < min) || (!!max && iso > max);

  const emit = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 8);
    const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
    setText(parts.join('-'));
    if (digits.length < 8) {
      if (value) onChange('');
      return;
    }
    const iso = `${digits.slice(4, 8)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
    if (parseISO(iso) && !disabledISO(iso)) onChange(iso);
    else if (value) onChange('');
  };

  const pick = (iso: string) => {
    if (disabledISO(iso)) return;
    onChange(iso);
    setText(isoToUk(iso));
    setLastValue(iso);
    setActive(iso);
    setOpen(false);
    inputRef.current?.focus();
  };

  const clear = () => {
    onChange('');
    setText('');
    setLastValue('');
    setOpen(false);
    inputRef.current?.focus();
  };

  const openCal = () => {
    if (disabled) return;
    const start = value || todayISO();
    const p = parseISO(start)!;
    setView({ y: p.y, m: p.m });
    setActive(start);
    setOpen(true);
  };

  const place = () => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const drop: 'down' | 'up' = room < 330 && r.top > room ? 'up' : 'down';
    setPos({ left: r.left, top: drop === 'down' ? r.bottom + 4 : r.top - 4, drop });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const on = () => place();
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on, true);
      window.removeEventListener('resize', on);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !popRef.current?.contains(e.target as Node) &&
        !wrapRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) gridRef.current?.focus();
  }, [open]);

  // Keep the active day's month in view.
  useEffect(() => {
    const p = parseISO(active);
    if (p && (p.y !== view.y || p.m !== view.m)) setView({ y: p.y, m: p.m });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const start = new Date(view.y, view.m, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return {
        iso: toISO(dt.getFullYear(), dt.getMonth(), dt.getDate()),
        day: dt.getDate(),
        outside: dt.getMonth() !== view.m,
      };
    });
  }, [view]);

  const onGridKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      setOpen(false);
      inputRef.current?.focus();
      return;
    }
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      pick(active);
      return;
    }
    let next: string | null = null;
    if (k === 'ArrowLeft') next = shift(active, { d: -1 });
    else if (k === 'ArrowRight') next = shift(active, { d: 1 });
    else if (k === 'ArrowUp') next = shift(active, { d: -7 });
    else if (k === 'ArrowDown') next = shift(active, { d: 7 });
    else if (k === 'Home') next = shift(active, { d: -new Date(active).getDay() });
    else if (k === 'End') next = shift(active, { d: 6 - new Date(active).getDay() });
    else if (k === 'PageUp') next = shift(active, e.shiftKey ? { y: -1 } : { m: -1 });
    else if (k === 'PageDown') next = shift(active, e.shiftKey ? { y: 1 } : { m: 1 });
    if (next) {
      e.preventDefault();
      setActive(next);
    }
  };

  const inputCls = [bare ? 'w-full bg-transparent text-sm focus:outline-none' : INPUT_BASE, bare ? '' : 'pr-10', className]
    .filter(Boolean)
    .join(' ');

  return (
    <span ref={wrapRef} className="relative block">
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => emit(e.target.value)}
        className={inputCls}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openCal())}
        aria-label="Open calendar"
        className={
          bare
            ? 'ml-1 inline-grid h-6 w-6 place-items-center rounded text-[#FA4D8D] disabled:opacity-60'
            : 'absolute right-0 top-0 grid h-full w-10 place-items-center text-[#FA4D8D] hover:text-[#C90044] disabled:opacity-60'
        }
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.drop === 'down' ? pos.top : undefined,
              bottom: pos.drop === 'up' ? window.innerHeight - pos.top : undefined,
            }}
            className="z-[60] w-[264px] overflow-hidden rounded-[12px] border border-[#EBE3E5] bg-white shadow-[0_4px_14px_rgba(33,29,32,0.08)]"
          >
            <div className="flex items-center justify-between bg-[#FA4D8D] px-3 py-2.5 text-white">
              <button
                type="button"
                onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))}
                aria-label="Previous month"
                className="grid h-7 w-7 place-items-center rounded-[7px] border border-white/50 text-white hover:bg-white/15"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <span className="text-[13px] font-semibold">
                {MONTHS[view.m]} {view.y}
              </span>
              <button
                type="button"
                onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))}
                aria-label="Next month"
                className="grid h-7 w-7 place-items-center rounded-[7px] border border-white/50 text-white hover:bg-white/15"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>

            <div className="px-3 pt-3">
              <div className="grid grid-cols-7">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="py-1 text-center text-[11px] font-medium text-[#6E646B]">{w}</span>
                ))}
              </div>

              <div
                ref={gridRef}
                role="grid"
                tabIndex={0}
                onKeyDown={onGridKey}
                className="grid grid-cols-7 gap-0.5 outline-none"
              >
                {cells.map((c) => {
                  const isSel = c.iso === value;
                  const isToday = c.iso === todayISO();
                  const isActive = c.iso === active;
                  const off = disabledISO(c.iso);
                  return (
                    <button
                      key={c.iso}
                      type="button"
                      role="gridcell"
                      aria-selected={isSel}
                      aria-current={isToday ? 'date' : undefined}
                      disabled={off}
                      tabIndex={-1}
                      onMouseEnter={() => !off && setActive(c.iso)}
                      onClick={() => pick(c.iso)}
                      className={[
                        'relative flex h-8 items-center justify-center rounded-full text-[12.5px]',
                        off
                          ? 'cursor-not-allowed text-[#C9C2C4] opacity-50'
                          : isSel
                            ? 'bg-[#FA4D8D] font-medium text-white'
                            : c.outside
                              ? 'text-[#C9C2C4] hover:bg-[#FEF5F8]'
                              : isToday
                                ? 'font-medium text-[#211D20] shadow-[inset_0_0_0_1.5px_#FFC1D6] hover:bg-[#FEF5F8]'
                                : 'text-[#211D20] hover:bg-[#FEF5F8]',
                        isActive && !isSel && !off ? 'ring-1 ring-inset ring-[#FFC1D6]' : '',
                      ].join(' ')}
                    >
                      {c.day}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between px-3 pb-3 pt-2 text-xs font-medium">
              <button type="button" onClick={clear} className="text-[#6E646B] hover:text-[#211D20]">
                Clear
              </button>
              <button
                type="button"
                onClick={() => {
                  const t = todayISO();
                  const p = parseISO(t)!;
                  setView({ y: p.y, m: p.m });
                  if (!disabledISO(t)) pick(t);
                  else setActive(t);
                }}
                className="text-[#FA4D8D] hover:text-[#C90044]"
              >
                Today
              </button>
            </div>
          </div>,
          document.body
        )}
    </span>
  );
}
