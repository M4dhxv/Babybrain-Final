import type { SupabaseClient } from '@supabase/supabase-js';
import type { createAdminClient } from '@/lib/supabase/admin';

/**
 * Companion mode (migration 00273): a vendor can make each pass include N free companions of one type,
 * "adult" or "child". The parent gives each companion's name and age, and the age must match the type
 * the vendor chose, so a child can't come on an adult place or the reverse.
 *
 * Companions are free headcount stored as `booking_addons` rows with kind 'companion', one row per
 * person, attached to the seat (booking row) of the child they come with. They never use class places.
 * Additional (paid) people are a separate feature in lib/booking-addons.ts.
 */
type Admin = ReturnType<typeof createAdminClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = SupabaseClient<any, 'public', any>;
const loose = (admin: Admin) => admin as unknown as Loose;

/** A child is 12 or under, an adult is 15 or over. 13 and 14 fit neither, on purpose. */
export const CHILD_MAX_AGE = 12;
export const ADULT_MIN_AGE = 15;

export type CompanionType = 'adult' | 'child';

export interface CompanionSettings {
  companion_enabled: boolean;
  companion_count: number;
  companion_type: CompanionType;
}

/** One companion: `seat` is the 0-based position of the child's ticket within the booking. */
export interface CompanionInput {
  seat: number;
  name: string;
  age: number | null;
}

const typeWord = (t: CompanionType) => (t === 'adult' ? `an adult (${ADULT_MIN_AGE} and over)` : `a child (${CHILD_MAX_AGE} and under)`);

/** Null when `age` suits the companion type, otherwise a sentence for the parent. */
export function companionAgeProblem(type: CompanionType, age: number): string | null {
  const fits = type === 'adult' ? age >= ADULT_MIN_AGE : age <= CHILD_MAX_AGE;
  return fits ? null : `This class's companion must be ${typeWord(type)}, but the age entered is ${age}.`;
}

function cleanAge(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 120 ? n : null;
}

/** Tidy a client-supplied list: names trimmed, ages whole years, blanks dropped. */
export function cleanCompanions(raw: unknown): CompanionInput[] {
  if (!Array.isArray(raw)) return [];
  const out: CompanionInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { seat, name, age } = item as Record<string, unknown>;
    const s = Math.floor(Number(seat));
    if (!Number.isFinite(s) || s < 0 || s > 19) continue;
    const n = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    const a = cleanAge(age);
    if (!n && a === null) continue;
    out.push({ seat: s, name: n, age: a });
  }
  return out;
}

export type CompanionCheck = { ok: true; list: CompanionInput[] } | { ok: false; error: string };

/**
 * The rules, applied the same way on the booking page and here: companion mode must be on, no more
 * than the vendor allows per ticket, a name needs an age, and the age must match the vendor's type.
 */
export function validateCompanions(settings: CompanionSettings, seatCount: number, raw: unknown): CompanionCheck {
  const list = cleanCompanions(raw);
  if (list.length === 0) return { ok: true, list };
  if (!settings.companion_enabled) return { ok: false, error: "This class doesn't include a companion." };
  const perSeat = new Map<number, number>();
  for (const c of list) {
    if (c.seat >= seatCount) return { ok: false, error: 'That companion does not match a ticket on this booking.' };
    const n = (perSeat.get(c.seat) ?? 0) + 1;
    perSeat.set(c.seat, n);
    if (n > settings.companion_count) {
      return { ok: false, error: `Each ticket includes ${settings.companion_count} companion${settings.companion_count === 1 ? '' : 's'}.` };
    }
    if (!c.name) return { ok: false, error: "Enter the companion's name as well as their age." };
    if (c.age === null) {
      return { ok: false, error: `Enter ${c.name}'s age so we can check the companion is ${settings.companion_type === 'adult' ? 'an adult' : 'a child'}.` };
    }
    if (c.age !== null) {
      const problem = companionAgeProblem(settings.companion_type, c.age);
      if (problem) return { ok: false, error: problem };
    }
  }
  return { ok: true, list };
}

/** The activity's companion settings, read with the service role. */
export async function companionSettingsFor(admin: Admin, activityId: string): Promise<CompanionSettings | null> {
  const { data } = await loose(admin)
    .from('activities')
    .select('companion_enabled, companion_count, companion_type')
    .eq('id', activityId)
    .maybeSingle();
  if (!data) return null;
  const d = data as { companion_enabled: boolean | null; companion_count: number | null; companion_type: string | null };
  return {
    companion_enabled: d.companion_enabled === true,
    companion_count: d.companion_count ?? 1,
    companion_type: d.companion_type === 'child' ? 'child' : 'adult',
  };
}

/**
 * Write the companions for a booking's seats. Replaces what was saved for those seats before, so a
 * retry (or the webhook and the return page both running) never doubles anyone up. `seatIds` is in
 * ticket order. Free, so the rows are born paid.
 */
export async function saveCompanions(
  admin: Admin,
  opts: { userId: string; providerId: string; seatIds: string[]; type: CompanionType; list: CompanionInput[] }
): Promise<{ ok: boolean }> {
  const db = loose(admin);
  if (opts.seatIds.length === 0) return { ok: false };
  const { error: delError } = await db.from('booking_addons').delete().in('booking_id', opts.seatIds).eq('kind', 'companion');
  if (delError) return { ok: false };
  const rows = opts.list
    .filter((c) => c.seat < opts.seatIds.length)
    .map((c) => ({
      booking_id: opts.seatIds[c.seat],
      user_id: opts.userId,
      provider_id: opts.providerId,
      addon_id: null,
      kind: 'companion',
      name: opts.type === 'adult' ? 'Adult companion' : 'Child companion',
      unit_price_cents: 0,
      quantity: 1,
      person_names: [c.name],
      person_ages: [c.age],
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    }));
  if (rows.length === 0) return { ok: true };
  const { error } = await db.from('booking_addons').insert(rows);
  return { ok: !error };
}

/** Companions travel through Stripe metadata (values cap at 500 chars), so they are packed and split. */
export function packCompanionMetadata(list: CompanionInput[]): Record<string, string> {
  const json = JSON.stringify(list.map((c) => ({ s: c.seat, n: c.name.slice(0, 40), a: c.age })));
  const out: Record<string, string> = {};
  for (let i = 0; i * 480 < json.length && i < 4; i++) out[`companions_${i}`] = json.slice(i * 480, (i + 1) * 480);
  return out;
}

export function readCompanionMetadata(metadata: Record<string, string> | null | undefined): CompanionInput[] {
  const json = [0, 1, 2, 3].map((i) => metadata?.[`companions_${i}`] ?? '').join('');
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Array<{ s: number; n: string; a: number | null }>;
    return cleanCompanions(parsed.map((p) => ({ seat: p.s, name: p.n, age: p.a })));
  } catch {
    return [];
  }
}
