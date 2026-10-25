/* Date ranges as Singapore calendar days (ISO yyyy-mm-dd), for the date-range
   filter (components/DateRangeFilter) and the lists it narrows. */

export type DateRange = { from: string; to: string };

const DAY = 864e5;
/** Today in Singapore as yyyy-mm-dd. */
export const sgToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
/** yyyy-mm-dd shifted by whole days (calendar arithmetic, no timezone drift). */
export const addDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY).toISOString().slice(0, 10);
};
/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;

export const RANGE_PRESETS: { key: string; label: string; range: () => DateRange }[] = [
  { key: 'today', label: 'Today', range: () => ({ from: sgToday(), to: sgToday() }) },
  { key: 'next7', label: 'Next 7 days', range: () => ({ from: sgToday(), to: addDays(sgToday(), 6) }) },
  { key: 'next30', label: 'Next 30 days', range: () => ({ from: sgToday(), to: addDays(sgToday(), 29) }) },
  { key: 'next90', label: 'Next 90 days', range: () => ({ from: sgToday(), to: addDays(sgToday(), 89) }) },
  { key: 'last7', label: 'Last 7 days', range: () => ({ from: addDays(sgToday(), -6), to: sgToday() }) },
  { key: 'last30', label: 'Last 30 days', range: () => ({ from: addDays(sgToday(), -29), to: sgToday() }) },
];

/** The preset a range matches, if any. */
export const presetFor = (r: DateRange) => RANGE_PRESETS.find((p) => {
  const x = p.range();
  return x.from === r.from && x.to === r.to;
});

const short = (iso: string, withYear: boolean) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-SG', {
    timeZone: 'UTC', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  });
};

/** "Next 7 days", or "23 Oct – 6 Nov 2026" for a custom range. */
export function rangeLabel(r: DateRange): string {
  const preset = presetFor(r);
  if (preset) return preset.label;
  if (r.from === r.to) return short(r.from, true);
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${short(r.from, !sameYear)} – ${short(r.to, true)}`;
}
