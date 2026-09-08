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

/** A Wix COURSE runs on more than one weekly slot — e.g. Wednesdays
 *  5:30–6:30 pm and Thursdays 5:30–7:00 pm — and one enrolment covers all
 *  of them. Groups a course's occurrences into those distinct strands
 *  (weekday + start–end time), each with its own date range and count, so
 *  the two show up as separate lines instead of a wall of near-identical
 *  "5:30 pm" cards. */
export function courseStrands(sessions: { starts_at: string; ends_at: string | null }[]) {
  const groups: Record<string, { weekday: string; time: string; dates: string[] }> = {};
  for (const s of sessions) {
    const weekday = new Date(s.starts_at).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", weekday: "long" });
    const time = s.ends_at ? `${sgTime(s.starts_at)} – ${sgTime(s.ends_at)}` : sgTime(s.starts_at);
    const key = `${weekday}|${time}`;
    (groups[key] ||= { weekday, time, dates: [] }).dates.push(s.starts_at);
  }
  return Object.values(groups)
    .map((g) => {
      const sorted = g.dates.slice().sort();
      return { weekday: g.weekday, time: g.time, first: sorted[0], last: sorted[sorted.length - 1], count: g.dates.length };
    })
    .sort((a, b) => a.first.localeCompare(b.first))
    .map((g) => ({
      key: `${g.weekday}|${g.time}`,
      label: `${g.weekday}s · ${g.time}`,
      range: g.first === g.last ? sgDay(g.first) : `${sgDay(g.first)} – ${sgDay(g.last)}`,
      count: g.count,
    }));
}
