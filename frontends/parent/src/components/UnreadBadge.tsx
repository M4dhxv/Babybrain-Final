import { useEffect, useRef, useState } from "react";

/**
 * Unread-count bubble for the Messages account-nav item. Shows the running
 * total from Stream (see useUnreadMessages), caps the label at "99+", and
 * gives one outward pulse whenever the count climbs so a parent looking at
 * the screen catches the new message. Renders nothing at zero.
 */
export function UnreadBadge({
  count,
  className = "",
}: {
  count: number;
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
      aria-label={count === 1 ? "1 unread message" : `${count} unread messages`}
      className={`relative grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-baby-cta px-1 text-[11px] font-black leading-none text-white ${className}`}
    >
      {pulse && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-baby-cta opacity-75 animate-ping"
        />
      )}
      <span className="relative">{count > 99 ? "99+" : count}</span>
    </span>
  );
}
