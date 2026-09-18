/** Singapore-time date/time formatting shared by the listing, booking and
 *  dashboard surfaces. Kept out of App.tsx so the lazy-loaded pages can use
 *  them without pulling the whole module into their chunk. */

export const sgDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

export const sgDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
  });

export const sgTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
  });

/** "Wed, 9 Sept – Thu, 29 Oct", collapsing to a single date when both ends
 *  land on the same day (a one-session course, or a course down to its last
 *  session). */
export const sgDayRange = (start: string, end: string) =>
  sgDay(start) === sgDay(end) ? sgDay(start) : `${sgDay(start)} – ${sgDay(end)}`;

const sgDayNum = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", day: "numeric" });
const sgDayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", day: "numeric", month: "short" });
const sgMonthKey = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" }).slice(0, 7);

/** Compact "17 – 20 Sept" / "30 Sept – 2 Oct" for a card, where the full
 *  "Thu, 17 Sept – Sun, 20 Sept" would widen the whole column. A single day
 *  collapses to "17 Sept". */
export const sgShortRange = (start: string, end: string) => {
  if (sgDayMonth(start) === sgDayMonth(end)) return sgDayMonth(start);
  return sgMonthKey(start) === sgMonthKey(end)
    ? `${sgDayNum(start)} – ${sgDayMonth(end)}`
    : `${sgDayMonth(start)} – ${sgDayMonth(end)}`;
};

/** One occurrence longer than a day is a whole camp/run that Wix returned as a
 *  single continuous session (midnight to midnight across several days), not a
 *  class with a length — so it has no meaningful "duration" and no time of day. */
export const isMultiDay = (start: string, end: string | null | undefined) =>
  !!end && new Date(end).getTime() - new Date(start).getTime() > 24 * 60 * 60 * 1000;

/** A Wix COURSE runs on more than one weekly slot — e.g. Wednesdays
 *  5:30–6:30 pm and Thursdays 5:30–7:00 pm — and one enrolment covers all
 *  of them. Groups a course's occurrences into those distinct strands
 *  (weekday + start–end time), each with its own date range and count, so
 *  the two show up as separate lines instead of a wall of near-identical
 *  "5:30 pm" cards. */
export function courseStrands(
  sessions: { starts_at: string; ends_at: string | null }[],
  /** When the course actually began (Wix's own bound). `sessions` is
   *  future-only, so without it a course mid-run can't be told from one that
   *  hasn't started, and "N sessions" can't say whether that is what's left. */
  runStart?: string | null
) {
  const started = !!runStart && new Date(runStart).getTime() <= Date.now();
  const groups: Record<string, { weekday: string; time: string; multiDay: boolean; start: string; end: string | null; dates: string[] }> = {};
  for (const s of sessions) {
    // A camp-style course occasionally comes back from Wix as one
    // continuous occurrence spanning several calendar days rather than a
    // daily recurrence (e.g. Thu 17 Sept 12am to Sun 20 Sept 12am as a
    // single "session") — there's no real weekday+time-of-day pattern to
    // group that by, and treating its literal midnight bounds as a time
    // range reads as "Thursdays · 12:00am – 12:00am", which looks broken.
    // Grouped separately and labelled by its date span instead.
    const multiDay = !!s.ends_at && sgDay(s.starts_at) !== sgDay(s.ends_at);
    const weekday = new Date(s.starts_at).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", weekday: "long" });
    const time = s.ends_at ? `${sgTime(s.starts_at)} – ${sgTime(s.ends_at)}` : sgTime(s.starts_at);
    const key = multiDay ? `multiday|${s.starts_at}|${s.ends_at}` : `${weekday}|${time}`;
    (groups[key] ||= { weekday, time, multiDay, start: s.starts_at, end: s.ends_at, dates: [] }).dates.push(s.starts_at);
  }
  return Object.values(groups)
    .map((g) => {
      const sorted = g.dates.slice().sort();
      return { ...g, first: sorted[0], last: sorted[sorted.length - 1], count: g.dates.length };
    })
    .sort((a, b) => a.first.localeCompare(b.first))
    .map((g) => {
      if (g.multiDay) {
        // One continuous occurrence, so "1 session" says nothing (and sat
        // beside "one booking covers every session" it read as a contradiction).
        // Say where it is in its run instead.
        const running = new Date(g.start).getTime() <= Date.now();
        return {
          key: `multiday|${g.start}`,
          label: `Runs ${sgDayRange(g.start, g.end!)}`,
          range: "",
          count: g.count,
          note: running ? `In progress · ends ${sgDay(g.end!)}` : `Starts ${sgDay(g.start)}`,
        };
      }
      // The list is future-only, so once the course has begun this is what is
      // left to attend, not the size of the course.
      const noun = g.count === 1 ? "session" : "sessions";
      return {
        key: `${g.weekday}|${g.time}`,
        label: `${g.weekday}s · ${g.time}`,
        range: g.first === g.last ? sgDay(g.first) : `${sgDay(g.first)} – ${sgDay(g.last)}`,
        count: g.count,
        note: `${g.count} ${noun}${started ? " left" : ""}`,
      };
    });
}
