/* Lengths of time kept as whole minutes (booking cut-offs), in words. */

/** "15 minutes", "24 hours", "1 hour 30 minutes", "3 days" — for the sentence
 *  under the field. Whole days only from two days up, so 1440 reads "24 hours",
 *  which is how vendors think of a one-day cut-off. */
export function formatMinutes(minutes: number): string {
  const part = (v: number, w: string) => (v ? `${v} ${w}${v === 1 ? '' : 's'}` : '');
  if (minutes >= 2880 && minutes % 1440 === 0) return part(minutes / 1440, 'day');
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [part(h, 'hour'), part(m, 'minute')].filter(Boolean).join(' ') || '0 minutes';
}
