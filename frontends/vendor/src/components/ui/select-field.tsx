import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Site dropdown — a custom control that replaces the native <select> so the
 * menu carries the brand look (warm off-white trigger, rounded white panel,
 * baby-pink on the selected row) instead of the OS's square blue list.
 *
 * Drop-in for `<select value onChange>`: `onChange` hands back the value
 * string directly (not an event), children are `<Opt>` not `<option>`.
 * Keyboard: Enter/Space/↓ open, ↑/↓/Home/End move, Enter/Space pick, Esc
 * close, plus type-ahead. The menu is portalled to <body> and fixed-
 * positioned so a filter row's or drawer's `overflow` never clips it.
 *
 * This file is intentionally identical between the vendor and parent apps.
 */

const TRIGGER_BASE =
  'inline-flex items-center justify-between gap-2 rounded-[10px] border border-[#EBE3E5] bg-[#FAF7F7] px-3 py-2 text-left text-sm text-[#211D20] transition-colors hover:border-[#DCD2D5] focus:outline-none focus-visible:border-[#FA4D8D] disabled:cursor-not-allowed disabled:opacity-60';
const TRIGGER_BARE =
  'inline-flex items-center justify-between gap-2 bg-transparent text-left text-sm text-[#211D20] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60';

type OptProps = { value: string; children: ReactNode; disabled?: boolean };

/** Data carrier for {@link SelectField}. Never rendered directly. */
export function Opt(_props: OptProps): null {
  return null;
}

type ResolvedOption = { value: string; label: ReactNode; disabled: boolean };

type SelectFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** `<Opt>` elements. */
  children: ReactNode;
  /** Extra classes for the trigger button (width, font-weight, …). */
  className?: string;
  /** Strip the trigger's border/background/padding — for use inside an
   *  existing bordered pill (Schedule / Bookings session pickers). */
  bare?: boolean;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
};

export function SelectField({
  value,
  onChange,
  children,
  className,
  bare = false,
  placeholder = 'Select…',
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: SelectFieldProps) {
  const options = useMemo<ResolvedOption[]>(
    () =>
      Children.toArray(children)
        .filter((c): c is ReactElement<OptProps> => isValidElement(c))
        .map((c) => ({
          value: c.props.value,
          label: c.props.children,
          disabled: Boolean(c.props.disabled),
        })),
    [children]
  );

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; drop: 'down' | 'up' }>({
    left: 0,
    top: 0,
    width: 0,
    drop: 'down',
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef<{ buf: string; at: number }>({ buf: '', at: 0 });
  const listId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex] : null;

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const drop: 'down' | 'up' = room < 260 && r.top > room ? 'up' : 'down';
    setPos({
      left: r.left,
      top: drop === 'down' ? r.bottom + 4 : r.top - 4,
      width: r.width,
      drop,
    });
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
      if (
        !listRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setActive(selectedIndex >= 0 ? selectedIndex : firstEnabled(options, 0, 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const commit = (idx: number) => {
    const o = options[idx];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      if (e.key === 'Escape') triggerRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => firstEnabled(options, i + 1, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => firstEnabled(options, i - 1, -1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(firstEnabled(options, 0, 1));
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(firstEnabled(options, options.length - 1, -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(active);
    } else if (e.key.length === 1) {
      const now = Date.now();
      const t = typeahead.current;
      t.buf = now - t.at > 600 ? e.key : t.buf + e.key;
      t.at = now;
      const q = t.buf.toLowerCase();
      const hit = options.findIndex(
        (o) => !o.disabled && typeof o.label === 'string' && o.label.toLowerCase().startsWith(q)
      );
      if (hit >= 0) setActive(hit);
    }
  };

  const triggerCls = [bare ? TRIGGER_BARE : TRIGGER_BASE, className].filter(Boolean).join(' ');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKey}
        className={triggerCls}
      >
        <span className={current ? 'truncate' : 'truncate text-[#6E646B]'}>
          {current ? current.label : placeholder}
        </span>
        <svg
          className="pointer-events-none h-4 w-4 shrink-0 text-[#FA4D8D] transition-transform duration-150"
          style={open ? { transform: 'rotate(180deg)' } : undefined}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-activedescendant={`${listId}-${active}`}
            onKeyDown={onKey}
            tabIndex={-1}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.drop === 'down' ? pos.top : undefined,
              bottom: pos.drop === 'up' ? window.innerHeight - pos.top : undefined,
              minWidth: pos.width,
              maxWidth: 'min(92vw, 420px)',
            }}
            className="z-[60] max-h-[320px] overflow-y-auto rounded-[10px] border border-[#EBE3E5] bg-white p-1.5 shadow-[0_4px_14px_rgba(33,29,32,0.08)]"
          >
            {options.map((o, i) => {
              const isSel = o.value === value;
              const isActive = i === active;
              return (
                <li
                  key={o.value || `__i${i}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  data-idx={i}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onClick={() => commit(i)}
                  className={[
                    'flex cursor-pointer items-center gap-2 rounded-[6px] px-2.5 py-2 text-sm',
                    o.disabled
                      ? 'cursor-not-allowed text-[#6E646B] opacity-50'
                      : isSel
                        ? 'bg-[#FFC1D6] font-medium text-[#87002E]'
                        : isActive
                          ? 'bg-[#FAF7F7] text-[#211D20]'
                          : 'text-[#211D20]',
                  ].join(' ')}
                >
                  {o.label}
                </li>
              );
            })}
          </ul>,
          document.body
        )}
    </>
  );
}

function firstEnabled(options: ResolvedOption[], from: number, dir: 1 | -1): number {
  const n = options.length;
  if (n === 0) return 0;
  let i = Math.max(0, Math.min(n - 1, from));
  for (let step = 0; step < n; step++) {
    if (!options[i]?.disabled) return i;
    i += dir;
    if (i < 0) i = 0;
    if (i > n - 1) i = n - 1;
  }
  return Math.max(0, Math.min(n - 1, from));
}
