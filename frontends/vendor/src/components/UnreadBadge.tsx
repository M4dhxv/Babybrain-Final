import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Unread-count bubble for the Messages nav item. Shows the running total from
 * Stream (see useUnreadMessages), caps the label at "99+", and gives one
 * outward pulse whenever the count climbs so a vendor looking at the screen
 * catches the new message. Renders nothing at zero.
 */
export function UnreadBadge({
  count,
  collapsed = false,
  className,
}: {
  count: number;
  /** Corner-badge treatment for the collapsed rail. */
  collapsed?: boolean;
  className?: string;
}) {
  const [pulse, setPulse] = useState(false);
  const prev = useRef(count);

  useEffect(() => {
    if (count > prev.current) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 1200);
      prev.current = count;
      return () => clearTimeout(t);
    }
    prev.current = count;
  }, [count]);

  if (count <= 0) return null;

  return (
    <span
      role="status"
      aria-label={count === 1 ? '1 unread message' : `${count} unread messages`}
      className={cn(
        'relative grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-[#FA4D8D] px-1 text-[11px] font-black leading-none text-white',
        collapsed && 'absolute right-1 top-1 h-4 min-w-[16px] px-0.5 text-[10px]',
        className,
      )}
    >
      {pulse && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-[#FA4D8D] opacity-75 animate-ping"
        />
      )}
      <span className="relative">{count > 99 ? '99+' : count}</span>
    </span>
  );
}
