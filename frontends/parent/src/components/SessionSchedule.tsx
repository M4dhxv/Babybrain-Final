import { useMemo, useState } from "react";
import { isMultiDay, sgDateTime, sgTime } from "../lib/schedule";

type Session = { id: string; starts_at: string; ends_at?: string | null };

// Enough for a typical short run to show at once; a long-running class folds
// the rest behind one line so the page doesn't turn into a wall of dates.
const VISIBLE_DAYS = 6;

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

const minutesOfDay = (iso: string) => {
  const [h, m] = new Date(iso).toLocaleTimeString("en-GB", { timeZone: SG, hour: "2-digit", minute: "2-digit", hour12: false }).split(":");
  return Number(h) * 60 + Number(m);
};

type Day = { key: string; iso: string; times: string[] };

function groupByDay(sessions: Session[]): Day[] {
  const sorted = [...sessions].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const days: Day[] = [];
  const byKey = new Map<string, Day>();
  for (const s of sorted) {
    const key = dayKey(s.starts_at);
    let d = byKey.get(key);
    if (!d) {
      d = { key, iso: s.starts_at, times: [] };
      byKey.set(key, d);
      days.push(d);
    }
    const t = sgTime(s.starts_at);
    if (!d.times.includes(t)) d.times.push(t);
  }
  return days;
}

/** The "Upcoming sessions" body for a class, appointment or event: a one-line
 *  summary of the pattern, then one date tile per day with that day's times.
 *  Display only — nothing here is a control except the fold-out. */
export function SessionSchedule({ sessions }: { sessions: Session[] }) {
  const [showAll, setShowAll] = useState(false);
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
  return (
    <div>
      <div className="mb-3 rounded-[12px] bg-[#FFF5F8] px-3 py-2.5 leading-snug">
        <p className="text-sm font-black text-[#34406f]">{summary.headline}</p>
        <p className="text-xs font-semibold text-[#68718f]">{summary.detail}</p>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1.5">
        {shown.map((d) => (
          <li key={d.key} className="overflow-hidden rounded-[12px] border border-[#F0E3E8] text-center">
            <div className="bg-[#FED7E4] py-1.5 leading-tight text-baby-cta">
              <p className="text-[11px] font-black">{weekdayShort(d.iso)}</p>
              <p className="text-[19px] font-black">{dayNum(d.iso)}</p>
              <p className="text-[11px] font-bold">{monthShort(d.iso)}</p>
            </div>
            <div className="py-1.5 text-xs font-bold leading-relaxed tabular-nums text-[#34406f]">
              {d.times.map((t) => (
                <p key={t}>{t}</p>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {days.length > VISIBLE_DAYS && (
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
