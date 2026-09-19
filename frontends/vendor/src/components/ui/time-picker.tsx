import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

/**
 * Site time field — our own panel in place of the browser's native
 * <input type="time"> control, so it looks the same everywhere and carries the
 * brand look (warm off-white trigger, rounded white panel, baby-pink picks),
 * like {@link SelectField} and {@link DatePicker}.
 *
 * `value` / `onChange` speak 24-hour "HH:MM" (or "" when empty), matching what
 * the native input used, so call sites only swap the tag. The panel has hour
 * (1–12), minute (5-minute steps) and AM/PM columns plus quick picks, and
 * commits as you pick; Done, Esc or a click outside closes it. `clearable`
 * adds a Clear button for optional fields.
 */

const TRIGGER =
  'inline-flex items-center justify-between gap-2 rounded-[10px] border border-[#EBE3E5] bg-[#FAF7F7] px-3 py-2 text-left text-sm text-[#211D20] transition-colors hover:border-[#DCD2D5] focus:outline-none focus-visible:border-[#FA4D8D] disabled:cursor-not-allowed disabled:opacity-60';

const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTE_STEPS = Array.from({ length: 12 }, (_, i) => i * 5);
const QUICK = ['09:00', '10:00', '16:00'];

function parse(v: string): { h12: number; m: number; pm: boolean } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v || '');
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  if (h > 23 || min > 59) return null;
  return { h12: h % 12 === 0 ? 12 : h % 12, m: min, pm: h >= 12 };
}
function build(h12: number, m: number, pm: boolean): string {
  return `${pad((h12 % 12) + (pm ? 12 : 0))}:${pad(m)}`;
}
export function formatTime(v: string): string {
  const p = parse(v);
  return p ? `${p.h12}:${pad(p.m)} ${p.pm ? 'pm' : 'am'}` : '';
}

type TimePickerProps = {
  /** 24-hour "HH:MM", or "" when empty. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  /** Adds a Clear button, for optional fields. */
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  title?: string;
  'aria-label'?: string;
};

export function TimePicker({
  value,
  onChange,
  className,
  placeholder = 'Set time',
  clearable = false,
  disabled = false,
  id,
  title,
  'aria-label': ariaLabel,
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; drop: 'down' | 'up' }>({ left: 0, top: 0, drop: 'down' });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const cur = parse(value);
  // Untouched, the columns sit on 9:00 am — a sensible class start — but the
  // field stays empty until the vendor actually picks something.
  const view = cur ?? { h12: 9, m: 0, pm: false };
  const minutes = cur && !MINUTE_STEPS.includes(cur.m) ? [...MINUTE_STEPS, cur.m].sort((a, b) => a - b) : MINUTE_STEPS;

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const PANEL_W = 288;
    const room = window.innerHeight - r.bottom;
    const drop: 'down' | 'up' = room < 330 && r.top > room ? 'up' : 'down';
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8));
    setPos({ left, top: drop === 'down' ? r.bottom + 4 : r.top - 4, drop });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Bring the picked hour / minute into view when the panel opens.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelectorAll<HTMLElement>('[data-on="true"]').forEach((el) => el.scrollIntoView({ block: 'center' }));
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
    } else if (open && e.key === 'Escape') {
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const pick = (h12: number, m: number, pm: boolean) => onChange(build(h12, m, pm));

  const item = (on: boolean, label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      data-on={on}
      onClick={onClick}
      className={[
        'rounded-[6px] py-1.5 text-center text-sm',
        on ? 'bg-[#FEECF2] font-medium text-[#FA4D8D]' : 'text-[#211D20] hover:bg-[#FAF7F7]',
      ].join(' ')}
    >
      {label}
    </button>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        title={title}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKey}
        className={[TRIGGER, className].filter(Boolean).join(' ')}
      >
        <span className={cur ? 'truncate' : 'truncate text-[#6E646B]'}>{cur ? formatTime(value) : placeholder}</span>
        <svg
          className="pointer-events-none h-4 w-4 shrink-0 text-[#FA4D8D]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label="Choose a time"
            onKeyDown={onKey}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.drop === 'down' ? pos.top : undefined,
              bottom: pos.drop === 'up' ? window.innerHeight - pos.top : undefined,
              width: 288,
              maxWidth: 'calc(100vw - 16px)',
            }}
            className="z-[60] rounded-[10px] border border-[#EBE3E5] bg-white p-2.5 shadow-[0_4px_14px_rgba(33,29,32,0.08)]"
          >
            <div className="flex gap-2">
              <div className="flex-1">
                <div className="mb-1 text-center text-[11px] text-[#6E646B]">Hour</div>
                <div className="flex max-h-[168px] flex-col gap-0.5 overflow-y-auto">
                  {HOURS.map((h) => item(cur != null && cur.h12 === h, String(h), () => pick(h, view.m, view.pm)))}
                </div>
              </div>
              <div className="flex-1">
                <div className="mb-1 text-center text-[11px] text-[#6E646B]">Minute</div>
                <div className="flex max-h-[168px] flex-col gap-0.5 overflow-y-auto">
                  {minutes.map((m) => item(cur != null && cur.m === m, pad(m), () => pick(view.h12, m, view.pm)))}
                </div>
              </div>
              <div className="w-[60px]">
                <div className="mb-1 text-center text-[11px] text-[#6E646B]">&nbsp;</div>
                <div className="flex flex-col gap-1.5">
                  {[false, true].map((pm) => {
                    const on = cur != null && cur.pm === pm;
                    return (
                      <button
                        key={pm ? 'pm' : 'am'}
                        type="button"
                        onClick={() => pick(view.h12, view.m, pm)}
                        className={[
                          'rounded-[6px] border py-2 text-center text-sm',
                          on ? 'border-[#FA4D8D] bg-[#FA4D8D] font-medium text-white' : 'border-[#EBE3E5] text-[#211D20] hover:bg-[#FAF7F7]',
                        ].join(' ')}
                      >
                        {pm ? 'PM' : 'AM'}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => onChange(q)}
                  className={[
                    'rounded-full border px-2.5 py-1 text-xs',
                    value === q ? 'border-[#FA4D8D] bg-[#FEECF2] text-[#FA4D8D]' : 'border-[#EBE3E5] text-[#211D20] hover:bg-[#FAF7F7]',
                  ].join(' ')}
                >
                  {formatTime(q)}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              {clearable && (
                <button
                  type="button"
                  onClick={() => {
                    onChange('');
                    setOpen(false);
                  }}
                  className="flex-1 rounded-[8px] border border-[#EBE3E5] py-1.5 text-sm text-[#6E646B] hover:bg-[#FAF7F7]"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="flex-1 rounded-[8px] bg-[#FA4D8D] py-1.5 text-sm font-medium text-white hover:bg-[#e23f7c]"
              >
                Done
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
