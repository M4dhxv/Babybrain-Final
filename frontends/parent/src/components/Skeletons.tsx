/**
 * Loading placeholders that hold a section's real footprint while its data is
 * in flight — so a hard refresh doesn't leave a blank band where cards will
 * land. Same visual language as `BookingsSkeleton` in App.tsx: `animate-pulse`
 * over the `#F3EDF0` / `#F6F1F3` greys, `#EBE3E5` hairline, brand card radius.
 */

/** Placeholder matching `ActivityCard`'s footprint: image, title, three meta
 *  lines, a footer rule. */
export function ActivityCardSkeleton() {
  return (
    <article
      aria-hidden="true"
      className="flex h-full flex-col overflow-hidden rounded-[14px] border border-[#EBE3E5] bg-white shadow-card"
    >
      <div className="h-[108px] animate-pulse bg-[#F3EDF0]" />
      <div className="flex flex-1 flex-col p-3.5">
        <div className="h-3 w-4/5 animate-pulse rounded bg-[#F3EDF0]" />
        <div className="mt-2.5 h-2.5 w-3/5 animate-pulse rounded bg-[#F6F1F3]" />
        <div className="mt-3 h-2.5 w-2/3 animate-pulse rounded bg-[#F6F1F3]" />
        <div className="mt-2 h-2.5 w-2/5 animate-pulse rounded bg-[#F6F1F3]" />
        <div className="mt-auto border-t border-[#F4EFF0] pt-3">
          <div className="h-2.5 w-2/5 animate-pulse rounded bg-[#F6F1F3]" />
        </div>
      </div>
    </article>
  );
}

/** A grid of `ActivityCardSkeleton`s, laid out like the real matching /
 *  suggestion grids so the section keeps its height while loading. */
export function ActivityCardGridSkeleton({
  count = 4,
  className = "grid gap-4 md:grid-cols-2 lg:grid-cols-4",
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <ActivityCardSkeleton key={i} />
      ))}
    </div>
  );
}
