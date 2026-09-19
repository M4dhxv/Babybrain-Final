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
import { Opt } from './select-field';

/**
 * Site multi-select dropdown — the tick-several sibling of {@link SelectField},
 * with the same trigger, rounded white panel and baby-pink accents, so no
 * dropdown on the site falls back to the browser's blue checkboxes.
 *
 * `values` is the list of picked `<Opt value>`s; `onChange` hands the new list
 * back. `max` caps how many can be ticked (the rest grey out). `allLabel` adds
 * a leading "All …" row that is ticked when nothing is picked and clears the
 * selection when chosen. The panel stays open while ticking; Esc, Tab or a
 * click outside closes it. Keyboard: Enter/Space/↓ open, ↑/↓/Home/End move,
 * Enter/Space toggle.
 */

const TRIGGER_BASE =
  'inline-flex items-center justify-between gap-2 rounded-[10px] border border-[#EBE3E5] bg-[#FAF7F7] px-3 py-2 text-left text-sm text-[#211D20] transition-colors hover:border-[#DCD2D5] focus:outline-none focus-visible:border-[#FA4D8D] disabled:cursor-not-allowed disabled:opacity-60';

type OptProps = { value: string; children: ReactNode; disabled?: boolean };
type Row = { key: string; value: string | null; label: ReactNode; text: string; disabled: boolean };

type MultiSelectFieldProps = {
  values: string[];
  onChange: (values: string[]) => void;
  /** `<Opt>` elements. */
  children: ReactNode;
  max?: number;
  /** Leading "All …" row; also the trigger text when nothing is picked. */
  allLabel?: string;
  placeholder?: string;
  /** Show the picked labels as pink chips in the trigger instead of text. */
  chips?: boolean;
  /** Shown in the panel when there are no options. */
  emptyMessage?: string;
  className?: string;
  /** Width of the panel; defaults to the trigger's width. */
  panelWidth?: number;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
};

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

export function MultiSelectField({
  values,
  onChange,
  children,
  max,
  allLabel,
  placeholder = 'Select…',
  chips = false,
  emptyMessage = 'Nothing to pick yet.',
  className,
  panelWidth,
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: MultiSelectFieldProps) {
  const options = useMemo(
    () =>
      Children.toArray(children)
        .filter((c): c is ReactElement<OptProps> => isValidElement(c) && c.type === Opt)
        .map((c) => ({ value: c.props.value, label: c.props.children, disabled: Boolean(c.props.disabled) })),
    [children]
  );

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = options.map((o) => ({
      key: o.value,
      value: o.value,
      label: o.label,
      text: textOf(o.label),
      disabled: o.disabled,
    }));
    if (allLabel) list.unshift({ key: '__all', value: null, label: allLabel, text: allLabel, disabled: false });
    return list;
  }, [options, allLabel]);

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
  const listId = useId();

  const atLimit = max != null && values.length >= max;
  const picked = options.filter((o) => values.includes(o.value));

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const drop: 'down' | 'up' = room < 260 && r.top > room ? 'up' : 'down';
    setPos({ left: r.left, top: drop === 'down' ? r.bottom + 4 : r.top - 4, width: r.width, drop });
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
      if (!listRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const rowBlocked = (r: Row) =>
    r.disabled || (r.value != null && !values.includes(r.value) && atLimit);

  const toggle = (idx: number) => {
    const r = rows[idx];
    if (!r || rowBlocked(r)) return;
    if (r.value == null) {
      onChange([]);
      return;
    }
    onChange(values.includes(r.value) ? values.filter((v) => v !== r.value) : [...values, r.value]);
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
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(rows.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(active);
    }
  };

  const summary =
    picked.length === 0
      ? null
      : picked.length <= 2
        ? picked.map((o) => textOf(o.label)).join(' & ')
        : `${picked.length} selected`;

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
        className={[TRIGGER_BASE, className].filter(Boolean).join(' ')}
      >
        {chips && picked.length > 0 ? (
          <span className="flex min-w-0 flex-wrap gap-1.5">
            {picked.map((o) => (
              <span key={o.value} className="rounded-full bg-[#FEECF2] px-2.5 py-0.5 text-xs font-medium text-[#FA4D8D]">
                {o.label}
              </span>
            ))}
          </span>
        ) : (
          <span className={summary || (allLabel && picked.length === 0) ? 'truncate' : 'truncate text-[#6E646B]'}>
            {summary ?? allLabel ?? placeholder}
          </span>
        )}
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
            aria-multiselectable="true"
            aria-activedescendant={`${listId}-${active}`}
            onKeyDown={onKey}
            tabIndex={-1}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.drop === 'down' ? pos.top : undefined,
              bottom: pos.drop === 'up' ? window.innerHeight - pos.top : undefined,
              minWidth: panelWidth ?? pos.width,
              maxWidth: 'min(92vw, 420px)',
            }}
            className="z-[60] max-h-[320px] overflow-y-auto rounded-[10px] border border-[#EBE3E5] bg-white p-1.5 shadow-[0_4px_14px_rgba(33,29,32,0.08)]"
          >
            {rows.length === 0 && <li className="px-3 py-2 text-sm text-[#6E646B]">{emptyMessage}</li>}
            {rows.map((r, i) => {
              const isOn = r.value == null ? values.length === 0 : values.includes(r.value);
              const blocked = rowBlocked(r);
              return (
                <li
                  key={r.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={isOn}
                  aria-disabled={blocked || undefined}
                  data-idx={i}
                  onMouseEnter={() => !blocked && setActive(i)}
                  onClick={() => toggle(i)}
                  className={[
                    'flex items-center gap-2.5 rounded-[6px] py-2 pl-3 pr-2.5 text-sm',
                    blocked
                      ? 'cursor-not-allowed text-[#6E646B] opacity-50'
                      : isOn
                        ? 'cursor-pointer bg-[#FEECF2] font-medium text-[#211D20]'
                        : i === active
                          ? 'cursor-pointer bg-[#FAF7F7] text-[#211D20]'
                          : 'cursor-pointer text-[#211D20]',
                    r.value == null && rows.length > 1 ? 'mb-1 border-b border-[#F4EFF0] rounded-b-none' : '',
                  ].join(' ')}
                >
                  <span
                    aria-hidden="true"
                    className={[
                      'grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border',
                      isOn ? 'border-[#FA4D8D] bg-[#FA4D8D]' : 'border-[#DCD2D5] bg-white',
                    ].join(' ')}
                  >
                    {isOn && (
                      <svg viewBox="0 0 24 24" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12l5 5 9-10" />
                      </svg>
                    )}
                  </span>
                  <span className="min-w-0 truncate">{r.label}</span>
                </li>
              );
            })}
          </ul>,
          document.body
        )}
    </>
  );
}
