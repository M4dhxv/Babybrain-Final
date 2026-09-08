/** The preference chips + budget-band maths shared by the sign-up and
 *  edit-profile forms. Its own module so both lazy page chunks can use it
 *  without pulling App.tsx along. */

export const TIME_CHIPS: [string, string][] = [
  ["morning", "Morning"],
  ["afternoon", "Afternoon"],
  ["evening", "Evening"],
];

/** Singapore areas used by every preference / area filter (Explore, sign-up,
 *  edit-profile). Keep in step with `sg_region()` / migration 00032. */
export const REGION_FILTERS: [string, string][] = [
  ["central", "Central"],
  ["east", "East"],
  ["north-east", "North-East"],
  ["north", "North"],
  ["west", "West"],
  ["sentosa", "Sentosa"],
];

export const BUDGET_CHIPS: [string, string, number | null, number | null][] = [
  ["u40", "Under $40", 0, 40],
  ["40-80", "$40 - $80", 40, 80],
  ["80-120", "$80 - $120", 80, 120],
  ["120+", "$120+", 120, null],
];

/** Ticked budget bands → the single {budget_min, budget_max} span we store.
 *  Shared by sign-up and edit-profile so both accept several bands. */
export function budgetRange(keys: string[]): { budget_min: number | null; budget_max: number | null } {
  const chosen = BUDGET_CHIPS.filter(([k]) => keys.includes(k));
  if (!chosen.length) return { budget_min: null, budget_max: null };
  return {
    budget_min: Math.min(...chosen.map(([, , lo]) => lo ?? 0)),
    // An open-ended band ("$120+") means no upper limit at all.
    budget_max: chosen.every(([, , , hi]) => hi != null)
      ? Math.max(...chosen.map(([, , , hi]) => hi as number))
      : null,
  };
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-[8px] border px-3 py-2 text-xs font-bold ${on ? "border-baby-pink bg-[#FED7E4] text-baby-cta" : "border-[#DCD2D5] bg-white"}`}>
      {children}
    </button>
  );
}
