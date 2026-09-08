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

/** Placeholder matching `ActivityRow` — the wide image-left layout the Explore
 *  results list uses. */
export function ActivityRowSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-1 overflow-hidden rounded-[12px] border border-[#EBE3E5] bg-white shadow-card sm:grid-cols-[170px_1fr] xl:grid-cols-[220px_1fr]"
    >
      <div className="h-44 animate-pulse bg-[#F3EDF0] sm:h-full sm:min-h-[116px]" />
      <div className="p-4">
        <div className="h-3 w-2/5 animate-pulse rounded bg-[#F3EDF0]" />
        <div className="mt-2.5 h-2.5 w-1/3 animate-pulse rounded bg-[#F6F1F3]" />
        <div className="mt-3.5 h-2.5 w-3/5 animate-pulse rounded bg-[#F6F1F3]" />
        <div className="mt-2 h-2.5 w-2/5 animate-pulse rounded bg-[#F6F1F3]" />
      </div>
    </div>
  );
}

/** A list of `ActivityRowSkeleton`s for the Explore results column. */
export function ActivityRowListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-2.5 xl:grid-cols-2" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <ActivityRowSkeleton key={i} />
      ))}
    </div>
  );
}

/** Placeholder for the Home page's child card (avatar + name + age + interest
 *  pills), so the right column doesn't sit empty until auth resolves. */
export function ChildCardSkeleton() {
  return (
    <article
      aria-hidden="true"
      className="flex gap-4 rounded-[18px] border border-[#EBE3E5] bg-white p-4 shadow-card"
    >
      <div className="h-32 w-32 flex-none animate-pulse rounded-full bg-[#FEEBF2] ring-8 ring-[#FEF4F8]" />
      <div className="flex-1 pt-1">
        <div className="h-4 w-2/5 animate-pulse rounded bg-[#F3EDF0]" />
        <div className="mt-3 h-3 w-1/4 animate-pulse rounded bg-[#F6F1F3]" />
        <div className="mt-4 h-6 w-4/5 animate-pulse rounded-full bg-[#FEF4EB]" />
        <div className="mt-2 h-6 w-3/5 animate-pulse rounded-full bg-[#FEF4EB]" />
      </div>
    </article>
  );
}

/** Full-page placeholder for the activity detail route: title column + hero,
 *  an About card, the sessions card, and the booking rail — same grid as the
 *  real page so nothing shifts when it swaps in. Render inside `PageShell`. */
export function ActivityDetailSkeleton() {
  return (
    <main
      aria-hidden="true"
      className="mx-auto flex max-w-[1180px] flex-col gap-5 px-6 py-5 lg:grid lg:grid-cols-[1fr_295px] lg:items-start"
    >
      <section className="order-1 grid gap-5 lg:order-none lg:col-start-1 lg:row-start-1 lg:grid-cols-[285px_1fr]">
        <div className="flex flex-col gap-3">
          <div className="h-3 w-28 animate-pulse rounded bg-[#F6F1F3]" />
          <div className="mt-2 h-7 w-4/5 animate-pulse rounded bg-[#F3EDF0]" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-[#F6F1F3]" />
          <div className="mt-2 h-8 w-32 animate-pulse rounded-[9px] bg-[#FEEBF2]" />
        </div>
        <div>
          <div className="h-[305px] w-full animate-pulse rounded-[18px] bg-[#F3EDF0]" />
          <div className="mt-3 flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-11 w-[76px] animate-pulse rounded-[8px] bg-[#F6F1F3]" />
            ))}
          </div>
        </div>
      </section>

      <section className="order-2 rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card lg:order-none lg:col-start-1 lg:row-start-2">
        <div className="h-4 w-24 animate-pulse rounded bg-[#F3EDF0]" />
        <div className="mt-3 space-y-2">
          <div className="h-3 w-full animate-pulse rounded bg-[#F6F1F3]" />
          <div className="h-3 w-11/12 animate-pulse rounded bg-[#F6F1F3]" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-[#F6F1F3]" />
        </div>
      </section>

      <div className="order-4 grid gap-5 lg:order-none lg:col-start-1 lg:row-start-3">
        <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
          <div className="h-5 w-40 animate-pulse rounded bg-[#F3EDF0]" />
          <div className="mt-4 flex flex-wrap gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 w-32 animate-pulse rounded-[10px] bg-[#F6F1F3]" />
            ))}
          </div>
        </section>
        <section className="rounded-[16px] border border-[#EBE3E5] bg-white p-5 shadow-card">
          <div className="h-5 w-28 animate-pulse rounded bg-[#F3EDF0]" />
          <div className="mt-4 space-y-3">
            <div className="h-3 w-full animate-pulse rounded bg-[#F6F1F3]" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-[#F6F1F3]" />
          </div>
        </section>
      </div>

      <aside className="order-3 h-fit rounded-[18px] border border-[#EBE3E5] bg-white p-5 shadow-card lg:order-none lg:col-start-2 lg:row-span-3 lg:row-start-1">
        <div className="h-8 w-24 animate-pulse rounded bg-[#F3EDF0]" />
        <div className="mt-4 h-11 w-full animate-pulse rounded-[11px] bg-[#F3EDF0]" />
        <div className="mt-3 h-11 w-full animate-pulse rounded-[11px] bg-[#F6F1F3]" />
        <div className="mt-4 space-y-2">
          <div className="h-3 w-full animate-pulse rounded bg-[#F6F1F3]" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-[#F6F1F3]" />
        </div>
      </aside>
    </main>
  );
}

/** Full-page placeholder for the booking route: breadcrumb, the framed card
 *  with its header, the class summary, the date / session steps, and the
 *  checkout rail. Render inside `PageShell`. */
export function BookingPageSkeleton() {
  return (
    <main aria-hidden="true" className="mx-auto max-w-[1024px] px-6 py-7">
      <div className="mb-6 h-3 w-72 animate-pulse rounded bg-[#F6F1F3]" />
      <section className="rounded-[18px] border border-[#EBE3E5] bg-white shadow-card">
        <header className="grid items-center gap-5 border-b border-[#F4EFF0] p-6 md:grid-cols-[90px_1fr_240px]">
          <div className="h-20 w-20 animate-pulse rounded-full bg-[#F3EDF0]" />
          <div className="space-y-2">
            <div className="h-7 w-2/3 animate-pulse rounded bg-[#F3EDF0]" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-[#F6F1F3]" />
          </div>
          <div className="hidden h-16 w-16 animate-pulse rounded bg-[#F6F1F3] md:block md:justify-self-end" />
        </header>
        <div className="grid gap-5 p-6 lg:grid-cols-[1fr_340px]">
          <section>
            <div className="grid gap-5 md:grid-cols-[245px_1fr]">
              <div className="h-52 w-full animate-pulse rounded-[12px] bg-[#F3EDF0]" />
              <div className="space-y-3">
                <div className="h-5 w-3/5 animate-pulse rounded bg-[#F3EDF0]" />
                <div className="h-3 w-2/5 animate-pulse rounded bg-[#F6F1F3]" />
                <div className="mt-4 h-3 w-1/2 animate-pulse rounded bg-[#F6F1F3]" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-[#F6F1F3]" />
                <div className="h-3 w-2/5 animate-pulse rounded bg-[#F6F1F3]" />
              </div>
            </div>
            <div className="mt-6 border-t border-[#F4EFF0] pt-5">
              <div className="h-5 w-40 animate-pulse rounded bg-[#F3EDF0]" />
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-[12px] bg-[#F6F1F3]" />
                ))}
              </div>
              <div className="mt-6 h-5 w-36 animate-pulse rounded bg-[#F3EDF0]" />
              <div className="mt-4 flex flex-wrap gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-10 w-24 animate-pulse rounded-[10px] bg-[#F6F1F3]" />
                ))}
              </div>
            </div>
          </section>
          <aside className="h-fit rounded-[16px] border border-[#EBE3E5] bg-[#FAF7F7] p-5">
            <div className="h-5 w-32 animate-pulse rounded bg-[#F3EDF0]" />
            <div className="mt-4 space-y-3">
              <div className="h-3 w-full animate-pulse rounded bg-[#F6F1F3]" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-[#F6F1F3]" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-[#F6F1F3]" />
            </div>
            <div className="mt-6 h-12 w-full animate-pulse rounded-[11px] bg-[#F3EDF0]" />
          </aside>
        </div>
      </section>
    </main>
  );
}
