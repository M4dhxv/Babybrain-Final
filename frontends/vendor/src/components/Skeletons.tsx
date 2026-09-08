/**
 * Loading placeholders that hold a section's real footprint while its data is
 * in flight — so a cold load (or a hard refresh) shows the shape of the page
 * filling in, not a centred spinner over an empty band that then jumps.
 *
 * House style: `animate-pulse` over Tailwind greys (`bg-gray-100` fills,
 * `bg-gray-200` for the stronger bars), inside the portal's own
 * `border-gray-200 bg-white rounded-xl` cards, so the skeleton and the real
 * content occupy the same box.
 *
 * These are shown ONLY when there is nothing to display yet. Once a page has
 * data — including a cached value from a previous visit — the data stays on
 * screen and <RefreshBar> is the only "revalidating" hint. Skeletons never
 * replace real information.
 */

/** Thin indeterminate bar for the "we have content, just refreshing it" state.
 *  Sits at the top of the page's scroll area; `aria-hidden` because the content
 *  underneath is already the real, readable page. */
export function RefreshBar() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden bg-pink-100/60"
    >
      <span className="bb-indeterminate-bar" />
    </div>
  );
}

function Bar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-100 ${className}`} />;
}

/** Generic stacked-card placeholder — a title bar and a few body lines per
 *  card. Fits Reviews, Notifications and any similar list surface. */
export function ListRowsSkeleton({ count = 4, lines = 2 }: { count?: number; lines?: number }) {
  return (
    <div className="space-y-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 flex-shrink-0 animate-pulse rounded-full bg-gray-100" />
            <div className="flex-1">
              <Bar className="h-3.5 w-2/5" />
              <div className="mt-3 space-y-2">
                {Array.from({ length: lines }).map((_, j) => (
                  <Bar key={j} className="h-3" />
                ))}
                <Bar className="h-3 w-1/2" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Placeholder for the wide data tables (Packages purchases, Make-up tokens) —
 *  a header strip and evenly spaced body rows inside the same framed card. */
export function TableRowsSkeleton({ cols = 5, count = 6 }: { cols?: number; count?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-hidden="true">
      <div
        className="grid gap-x-4 bg-gray-50 px-5 py-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: cols }).map((_, i) => (
          <Bar key={i} className="h-3 w-16 bg-gray-200" />
        ))}
      </div>
      {Array.from({ length: count }).map((_, r) => (
        <div
          key={r}
          className="grid gap-x-4 border-t border-gray-100 px-5 py-4"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <Bar key={c} className={`h-3 ${c === 0 ? 'w-4/5' : 'w-2/3'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Dashboard: the five stat cards and the three-column bottom grid, at their
 *  real sizes so nothing shifts when the live numbers land. The static quick
 *  actions above stay on screen — they need no data. */
export function DashboardSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-2">
              <div className="h-8 w-8 animate-pulse rounded-lg bg-gray-100" />
              <Bar className="h-3 w-16" />
            </div>
            <Bar className="h-6 w-2/5 bg-gray-200" />
            <Bar className="mt-2 h-3 w-3/5" />
            <Bar className="mt-3 h-3 w-1/2" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-white p-5">
            <Bar className="h-4 w-2/5 bg-gray-200" />
            <div className="mt-4 space-y-4">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="flex items-center gap-3">
                  <div className="h-10 w-10 flex-shrink-0 animate-pulse rounded-lg bg-gray-100" />
                  <div className="flex-1">
                    <Bar className="h-3 w-4/5" />
                    <Bar className="mt-2 h-3 w-2/5" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Schedule week view: seven day columns, a few with session blocks. Matches
 *  the `sm:grid-cols-7` / `min-h-[240px]` layout of the real grid. */
export function ScheduleWeekSkeleton() {
  return (
    <div className="overflow-x-auto" aria-hidden="true">
      <div className="flex gap-3 sm:grid sm:min-w-[900px] sm:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="min-h-[240px] w-[calc(50%-0.375rem)] flex-shrink-0 rounded-xl border border-gray-200 bg-white p-3 sm:w-auto sm:flex-shrink"
          >
            <div className="mb-2 flex items-baseline justify-between">
              <Bar className="h-3 w-8" />
              <Bar className="h-4 w-4 rounded-full bg-gray-200" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: (i % 3) + 1 }).map((_, j) => (
                <div key={j} className="rounded-lg border border-gray-100 bg-gray-50 px-2.5 py-2">
                  <Bar className="h-3 w-3/4" />
                  <Bar className="mt-1.5 h-2.5 w-1/2" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
