/**
 * Term enrolment — UI PREVIEW ONLY (parent side).
 *
 * No backend exists for terms yet, so the term shown on the booking page is
 * derived from the activity's real upcoming sessions and nothing is saved or
 * charged. The whole thing is hidden unless the preview flag is on (dev build,
 * or `?terms=preview` once — remembered in this browser; `?terms=off` clears it),
 * so shipping this file cannot show parents a half-built feature.
 */

const FLAG_KEY = "bb_terms_preview";

export function termsPreviewEnabled(): boolean {
  try {
    if (import.meta.env.DEV) return true;
    const p = new URLSearchParams(window.location.search).get("terms");
    if (p === "preview") window.localStorage.setItem(FLAG_KEY, "1");
    if (p === "off") window.localStorage.removeItem(FLAG_KEY);
    return window.localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export type PreviewSession = { id: string; starts_at: string; ends_at: string; capacity: number | null };

export type PreviewSlot = {
  key: string;
  label: string; // "Saturdays, 9:00 am"
  dates: string[]; // ISO start of each session
  capacity: number | null;
  spotsLeft: number | null;
  /** Venue name when it differs from the activity's own. */
  venue?: string | null;
};

const sgWeekday = (iso: string) =>
  new Date(iso).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", weekday: "long" });
const sgClock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "numeric", minute: "2-digit" });

/** Group the activity's upcoming sessions into weekly strands (one per weekday
 *  and time) — each becomes a slot a parent could enrol in. A lone session
 *  becomes a weekly series so the preview always has something to show. */
export function deriveSlots(sessions: PreviewSession[]): PreviewSlot[] {
  const groups = new Map<string, PreviewSession[]>();
  for (const s of [...sessions].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
    const k = `${sgWeekday(s.starts_at)}|${sgClock(s.starts_at)}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const slots: PreviewSlot[] = [];
  for (const [k, list] of groups) {
    let dates = list.map((s) => s.starts_at);
    if (dates.length < 2) {
      const first = new Date(dates[0]).getTime();
      dates = Array.from({ length: 8 }, (_, i) => new Date(first + i * 7 * 86_400_000).toISOString());
    }
    const [day, clock] = k.split("|");
    const cap = list[0].capacity;
    slots.push({
      key: k,
      label: `${day}s, ${clock}`,
      dates,
      capacity: cap,
      spotsLeft: cap != null ? Math.max(1, Math.round(cap * 0.3)) : null,
    });
  }
  return slots.slice(0, 3);
}
