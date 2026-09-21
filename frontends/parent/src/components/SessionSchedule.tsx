import { useEffect, useMemo, useState } from "react";
import { Icon } from "./ui";
import { isMultiDay, sgDateTime, sgTime } from "../lib/schedule";

type Session = { id: string; starts_at: string; ends_at?: string | null; teacher_name?: string | null; studio?: string | null };

// Enough for a typical short run to show at once; a long-running class folds
// the rest behind one line so the page doesn't turn into a wall of dates.
const VISIBLE_DAYS = 6;
// A busy day folds its times behind one button so the grid stays short.
const VISIBLE_TIMES = 8;

const SG = "Asia/Singapore";
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: SG });
const weekdayIdx = (iso: string) =>
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
    new Date(iso).toLocaleDateString("en-US", { timeZone: SG, weekday: "short" })
  );
const weekdayShort = (iso: string) => new Date(iso).toLocaleDateString("en-SG", { timeZone: SG, weekday: "short" });
const weekdayLong = (iso: string) => new Date(iso).toLocaleDateString("en-SG", { timeZone: SG, weekday: "long" });
const dayNum = (iso: string) => new Date(iso).toLocaleDateString("en-SG", { timeZone: SG, day: "numeric" });
const monthShort = (iso: string) => new Date(iso).toLocaleDateString("en-SG", { timeZone: SG, month: "short" });
const dayMonth = (iso: string) => `${dayNum(iso)} ${monthShort(iso)}`;
const monthLong = (iso: string) => new Date(iso).toLocaleDateString("en-SG", { timeZone: SG, month: "long" });
const monthKey = (iso: string) => dayKey(iso).slice(0, 7);

// Below this width (the card can be half a row beside Packages) the compact
// date chips are used; at or above it the dates sit in a list beside the times.
const WIDE_MIN_PX = 600;

const minutesOfDay = (iso: string) => {
  const [h, m] = new Date(iso).toLocaleTimeString("en-GB", { timeZone: SG, hour: "2-digit", minute: "2-digit", hour12: false }).split(":");
  return Number(h) * 60 + Number(m);
};

type Slot = { id: string; time: string; who: string };
type Day = { key: string; iso: string; slots: Slot[] };

function groupByDay(sessions: Session[]): Day[] {
  const sorted = [...sessions].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const days: Day[] = [];
  const byKey = new Map<string, Day>();
  for (const s of sorted) {
    const key = dayKey(s.starts_at);
    let d = byKey.get(key);
    if (!d) {
      d = { key, iso: s.starts_at, slots: [] };
      byKey.set(key, d);
      days.push(d);
    }
    // One slot per session — two sessions at the same time (two teachers or
    // venues) stay two options instead of collapsing into one button.
    d.slots.push({ id: s.id, time: sgTime(s.starts_at), who: [s.teacher_name, s.studio].filter(Boolean).join(" · ") });
  }
  return days;
}

/** The "Upcoming sessions" body for a class, appointment or event. It keeps
 * the date choices compact, then gives the selected date's times enough room
 * to stay easy to scan and tap — even for a day with many available slots. */
export function SessionSchedule({
  sessions,
  durationMins,
  selectedId,
  onSelect,
}: {
  sessions: Session[];
  durationMins?: number | null;
  /** The session the parent tapped, held by the page so the Book button can carry it to checkout. */
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [showAllTimes, setShowAllTimes] = useState(false);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  // Wide layout: whether the "more options" panel is open, and which month tab is showing.
  const [moreOpen, setMoreOpen] = useState(false);
  const [monthTab, setMonthTab] = useState(0);
  // The chip row scrolls sideways; these drive the edge arrows.
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= WIDE_MIN_PX));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  useEffect(() => {
    if (!strip) return;
    const update = () =>
      setEdge({ left: strip.scrollLeft > 4, right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 4 });
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(strip);
    if (strip.firstElementChild) ro.observe(strip.firstElementChild);
    return () => {
      strip.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [strip, showAll, sessions.length]);
  const { days, summary } = useMemo(() => {
    const days = groupByDay(sessions);
    const weekdays = [...new Set(days.map((d) => weekdayIdx(d.iso)))].sort((a, b) => a - b);
    const firstOfWeekday = (w: number) => days.find((d) => weekdayIdx(d.iso) === w)!.iso;
    // Distinct times of day, in clock order rather than the order they first
    // appear across the dates.
    const clock = [...new Map(sessions.map((s) => [sgTime(s.starts_at), minutesOfDay(s.starts_at)])).entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([t]) => t);
    let pattern: string;
    if (days.length === 1) pattern = `${weekdayShort(days[0].iso)}, ${dayMonth(days[0].iso)}`;
    else if (weekdays.length === 1) pattern = `${weekdayLong(firstOfWeekday(weekdays[0]))}s`;
    else pattern = weekdays.map((w) => weekdayShort(firstOfWeekday(w))).join(", ");
    const timeText = clock.length > 4 ? "Various times" : clock.join(", ");
    const range = days.length > 1 ? `${dayMonth(days[0].iso)} to ${dayMonth(days[days.length - 1].iso)} · ` : "";
    return {
      days,
      summary: {
        headline: `${pattern} · ${timeText}`,
        detail: `${range}${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`,
      },
    };
  }, [sessions]);

  // A whole-day camp has no time of day, so the date-and-time tile doesn't fit
  // it — keep the plain date chips for those.
  if (sessions.some((s) => isMultiDay(s.starts_at, s.ends_at))) {
    return (
      <div className="flex flex-wrap gap-2">
        {sessions.map((s) => (
          <span key={s.id} className="rounded-[10px] border border-[#EBE3E5] px-3 py-2 text-sm font-bold">{sgDateTime(s.starts_at)}</span>
        ))}
      </div>
    );
  }

  const shown = showAll ? days : days.slice(0, VISIBLE_DAYS);
  // Every upcoming session in order, for the wide "next available" layout.
  const flat = days.flatMap((day) =>
    day.slots.map((slot) => ({ ...slot, day, shared: day.slots.filter((x) => x.time === slot.time).length > 1 }))
  );
  const first = flat[0];
  const flatLabel = (f: (typeof flat)[number]) =>
    `${weekdayShort(f.day.iso)} ${dayMonth(f.day.iso)} · ${f.time}${f.shared && f.who ? ` · ${f.who}` : ""}`;
  const monthGroups: { key: string; name: string; days: Day[] }[] = [];
  for (const d of days) {
    const key = monthKey(d.iso);
    const g = monthGroups.find((x) => x.key === key);
    if (g) g.days.push(d);
    else monthGroups.push({ key, name: monthLong(d.iso), days: [d] });
  }
  const monthIdx = Math.min(monthTab, monthGroups.length - 1);
  const monthGroup = monthGroups[monthIdx];
  const expandDay = monthGroup.days.find((d) => d.key === selectedDayKey) ?? monthGroup.days[0];
  const selectedDay = days.find((d) => d.key === selectedDayKey) ?? days[0];
  const shownSlots = showAllTimes ? selectedDay.slots : selectedDay.slots.slice(0, VISIBLE_TIMES);
  // Only label a slot with who/where when its time isn't unique that day.
  const timeCount = new Map<string, number>();
  selectedDay.slots.forEach((s) => timeCount.set(s.time, (timeCount.get(s.time) ?? 0) + 1));
  const picked = selectedDay.slots.some((s) => s.id === selectedId);

  const timesPanel = (
    <section
      className="rounded-[14px] border border-[#EBE3E5] bg-white p-3.5 shadow-card sm:p-4"
      aria-label={`Sessions on ${weekdayLong(selectedDay.iso)} ${dayMonth(selectedDay.iso)}`}
    >
      <div>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h3 className="text-[18px] font-black text-baby-ink">{weekdayShort(selectedDay.iso)} {dayMonth(selectedDay.iso)}</h3>
            <p className="text-xs font-semibold text-[#68718f]">{selectedDay.slots.length} {selectedDay.slots.length === 1 ? "session" : "sessions"} available</p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <span className="rounded-full bg-palette-pinkSoft px-2.5 py-1 text-[11px] font-black text-baby-cta">Choose a time</span>
            {picked && (
              <button type="button" onClick={() => onSelect?.(null)} className="text-[11px] font-black text-[#68718f] underline underline-offset-2 hover:text-baby-cta">
                Clear
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {shownSlots.map((slot) => {
            const active = selectedId === slot.id;
            const shared = (timeCount.get(slot.time) ?? 0) > 1;
            return (
              <button
                key={slot.id}
                type="button"
                aria-pressed={active}
                onClick={() => onSelect?.(slot.id)}
                className={`min-h-12 rounded-[11px] border px-2 py-2 text-[15px] font-black tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta focus-visible:ring-offset-2 ${
                  active
                    ? "border-baby-cta bg-baby-cta text-white shadow-pink"
                    : "border-[#DCD2D5] bg-white text-baby-ink hover:border-baby-pink hover:bg-palette-pinkTint"
                }`}
              >
                {slot.time}
                {shared && <span className={`mt-0.5 block truncate text-[11px] font-bold ${active ? "text-white/90" : "text-[#68718f]"}`}>{slot.who || "Another session"}</span>}
              </button>
            );
          })}
        </div>
        {selectedDay.slots.length > VISIBLE_TIMES && (
          <button
            type="button"
            onClick={() => setShowAllTimes((v) => !v)}
            className="mt-3 w-full py-1.5 text-sm font-black text-baby-cta"
          >
            {showAllTimes ? "Show fewer times" : `Show ${selectedDay.slots.length - VISIBLE_TIMES} more times`}
          </button>
        )}
        {picked && (
          <p role="status" className="mt-3 rounded-[10px] bg-palette-pinkTint px-3 py-2 text-sm font-bold text-[#34406f]">
            Click on Book a class to proceed with this time.
          </p>
        )}
      </div>
    </section>
  );

  const pickDay = (key: string) => {
    setSelectedDayKey(key);
    setShowAllTimes(false);
  };

  return (
    <div ref={setBox}>
      <div className="mb-3 rounded-[12px] bg-palette-pinkTint px-3 py-2.5 leading-snug">
        <p className="text-sm font-black text-[#34406f]">{summary.headline}</p>
        <p className="text-xs font-semibold text-[#68718f]">{summary.detail}</p>
      </div>

      {wide ? (
        <div>
          {/* Row 1: the soonest session, one tap. */}
          <button
            type="button"
            aria-pressed={selectedId === first.id}
            onClick={() => onSelect?.(first.id)}
            className={`flex w-full items-center justify-between gap-3 rounded-[14px] border-2 border-baby-cta px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta focus-visible:ring-offset-2 ${
              selectedId === first.id ? "bg-baby-cta text-white" : "bg-palette-pinkTint text-baby-ink hover:brightness-95"
            }`}
          >
            <span>
              <span className={`block text-xs font-bold ${selectedId === first.id ? "text-white/90" : "text-[#68718f]"}`}>Next available</span>
              <span className="block text-[18px] font-black">{flatLabel(first)}</span>
            </span>
            <span className="text-[13px] font-black">{selectedId === first.id ? "Selected" : "Select this time"}</span>
          </button>

          {/* Row 2: the next few, plus a way into everything else. */}
          {flat.length > 1 && (
            <div className="mt-2.5 flex flex-wrap items-stretch gap-2">
              {flat.slice(1, 4).map((f) => {
                const active = selectedId === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelect?.(f.id)}
                    className={`rounded-[11px] border px-3 py-2 text-left leading-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta focus-visible:ring-offset-2 ${
                      active ? "border-baby-cta bg-baby-cta text-white" : "border-[#DCD2D5] bg-white text-baby-ink hover:border-baby-pink hover:bg-palette-pinkTint"
                    }`}
                  >
                    <span className="block text-[13px] font-black">{weekdayShort(f.day.iso)} {dayMonth(f.day.iso)}</span>
                    <span className={`block text-xs font-semibold ${active ? "text-white/90" : "text-[#68718f]"}`}>{f.time}{f.shared && f.who ? ` · ${f.who}` : ""}</span>
                  </button>
                );
              })}
              {flat.length > 4 && (
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((v) => !v)}
                  className="flex items-center rounded-[11px] border border-dashed border-baby-cta px-3 py-2 text-[13px] font-black text-baby-cta transition hover:bg-palette-pinkTint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta"
                >
                  {moreOpen ? "Fewer options ▴" : `+${flat.length - 4} more ▾`}
                </button>
              )}
            </div>
          )}

          {/* Everything else: month tabs, date chips, then that date's times. */}
          {moreOpen && flat.length > 4 && (
            <div className="mt-3 border-t border-[#EBE3E5] pt-3">
              {monthGroups.length > 1 && (
                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  {monthGroups.map((g, i) => (
                    <button
                      key={g.key}
                      type="button"
                      aria-pressed={i === monthIdx}
                      onClick={() => setMonthTab(i)}
                      className={`rounded-full border px-3 py-1 text-xs font-black transition ${
                        i === monthIdx ? "border-baby-cta bg-baby-cta text-white" : "border-[#DCD2D5] bg-white text-[#34406f] hover:border-baby-pink"
                      }`}
                    >
                      {g.name} · {g.days.length}
                    </button>
                  ))}
                </div>
              )}
              {days.length > 1 && (
                <div className={`flex flex-wrap gap-2 ${monthGroup.days.length > 18 ? "max-h-[210px] overflow-y-auto pr-1" : ""}`}>
                  {monthGroup.days.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      aria-pressed={expandDay.key === d.key}
                      onClick={() => pickDay(d.key)}
                      className={`grid h-[68px] w-[64px] place-items-center rounded-[12px] text-center leading-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta ${
                        expandDay.key === d.key ? "bg-baby-cta text-white" : "bg-palette-pinkTint text-[#34406f] hover:brightness-95"
                      }`}
                    >
                      <span className="text-[10px] font-bold">{weekdayShort(d.iso)}</span>
                      <span className="text-[19px] font-black tabular-nums">{dayNum(d.iso)}</span>
                      <span className="text-[10px] font-bold">{monthShort(d.iso)}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap gap-2">
                {expandDay.slots.map((slot) => {
                  const active = selectedId === slot.id;
                  const shared = expandDay.slots.filter((x) => x.time === slot.time).length > 1;
                  return (
                    <button
                      key={slot.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onSelect?.(slot.id)}
                      className={`rounded-[10px] border px-3.5 py-2 text-[14px] font-black tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta focus-visible:ring-offset-2 ${
                        active ? "border-baby-cta bg-baby-cta text-white" : "border-[#DCD2D5] bg-white text-baby-ink hover:border-baby-pink hover:bg-palette-pinkTint"
                      }`}
                    >
                      {slot.time}
                      {shared && <span className={`block text-[11px] font-bold ${active ? "text-white/90" : "text-[#68718f]"}`}>{slot.who || "Another session"}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {flat.some((f) => f.id === selectedId) && (
            <p role="status" className="mt-3 flex items-center justify-between gap-3 rounded-[10px] bg-palette-pinkTint px-3 py-2 text-sm font-bold text-[#34406f]">
              <span>Click on Book a class to proceed with this time.</span>
              <button type="button" onClick={() => onSelect?.(null)} className="text-xs font-black text-[#68718f] underline underline-offset-2 hover:text-baby-cta">
                Clear
              </button>
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="mb-3">
          <div ref={setStrip} className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <ul className="flex min-w-max gap-2">
              {shown.map((d) => (
                <li key={d.key}>
                  <button
                    type="button"
                    aria-pressed={selectedDay.key === d.key}
                    onClick={() => pickDay(d.key)}
                    className={`grid h-[84px] w-[74px] place-items-center rounded-[14px] border text-center leading-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta focus-visible:ring-offset-2 ${
                      selectedDay.key === d.key
                        ? "border-baby-pink bg-baby-pink text-baby-ink shadow-card"
                        : "border-[#EBE3E5] bg-[#F4F0FA] text-[#34406f] hover:border-baby-pink"
                    }`}
                  >
                    <span className="text-[11px] font-black">{weekdayShort(d.iso)}</span>
                    <span className="text-[25px] font-black tabular-nums">{dayNum(d.iso)}</span>
                    <span className="text-[11px] font-bold">{monthShort(d.iso)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {(edge.left || edge.right) && (
            <div className="mt-1 flex justify-end gap-4 pr-1">
              {(["left", "right"] as const).filter((side) => edge[side]).map((side) => (
                <button
                  key={side}
                  type="button"
                  aria-label={side === "left" ? "Earlier dates" : "More dates"}
                  onClick={() => strip?.scrollBy({ left: (side === "left" ? -1 : 1) * strip.clientWidth * 0.7, behavior: "smooth" })}
                  className={`p-0.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-baby-cta text-baby-cta hover:scale-110`}
                >
                  <svg viewBox="0 0 24 24" className={`h-5 w-5 ${side === "left" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 12h16M14 6l6 6-6 6" />
                  </svg>
                </button>
              ))}
            </div>
          )}
          </div>
          {timesPanel}
        </>
      )}

      {durationMins && (
        <p className="mt-3 flex items-center gap-2 rounded-[12px] bg-palette-pinkTint px-3 py-2.5 text-sm font-bold text-[#68718f]">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-palette-pinkSoft text-baby-cta"><Icon name="clock" className="h-4 w-4" /></span>
          {durationMins} min per session
        </p>
      )}
      {!wide && days.length > VISIBLE_DAYS && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 py-1.5 text-sm font-black text-baby-cta"
        >
          {showAll ? "Show fewer" : `Show all ${days.length} days (${days.length - VISIBLE_DAYS} more)`}
        </button>
      )}
    </div>
  );
}
