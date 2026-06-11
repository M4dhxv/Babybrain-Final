/** Display formatting helpers (SGT) used across pages. */

const SGT = 'Asia/Singapore';

export const sgTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-SG', {
    timeZone: SGT,
    hour: 'numeric',
    minute: '2-digit',
  });

export const sgDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', {
    timeZone: SGT,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

const sgWeekday = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: SGT, weekday: 'short' });

/** "Mon, Wed · 11:00 AM" from a list of upcoming session start times. */
export function scheduleSummary(startTimes: string[]): string | null {
  if (startTimes.length === 0) return null;
  const days = [...new Set(startTimes.map(sgWeekday))].slice(0, 3);
  return `${days.join(', ')} · ${sgTime(startTimes[0])}`;
}

/** "Novena" from "United Square, Novena" — area is the last address part. */
export function areaFromAddress(address?: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map((s) => s.trim());
  return parts[parts.length - 1] || null;
}

export const initials = (name?: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
