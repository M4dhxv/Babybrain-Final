/**
 * Age rules for add-on people (migration 00273). A vendor can say who an add-on price is for, e.g.
 * "Child" is up to 12 and "Adult" is 15 and over. The parent types each person's age; an age outside
 * the range shows a warning and blocks payment, so a child price can't be bought for an adult.
 */
export type AgedOffer = { id: string; name: string; min_age: number | null; max_age: number | null };

/** Whole-year age from what the parent typed, or null when blank or not a sensible number. */
export function parseAge(text: string | undefined): number | null {
  const t = (text ?? "").trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= 120 ? n : null;
}

export function hasAgeRange(o: Pick<AgedOffer, "min_age" | "max_age">): boolean {
  return o.min_age !== null || o.max_age !== null;
}

/** "ages 12 and under", "ages 15 and over", "ages 5 to 12", or null when there is no limit. */
export function rangeText(o: Pick<AgedOffer, "min_age" | "max_age">): string | null {
  if (o.min_age !== null && o.max_age !== null) return `ages ${o.min_age} to ${o.max_age}`;
  if (o.max_age !== null) return `ages ${o.max_age} and under`;
  if (o.min_age !== null) return `ages ${o.min_age} and over`;
  return null;
}

export function ageFits(o: Pick<AgedOffer, "min_age" | "max_age">, age: number): boolean {
  return (o.min_age === null || age >= o.min_age) && (o.max_age === null || age <= o.max_age);
}

/** True when any typed age is outside its add-on's range (payment is blocked until it's fixed). */
export function anyAgeMismatch(offers: AgedOffer[], qty: Record<string, number>, ages: Record<string, string[]>): boolean {
  return offers.some((o) => {
    if (!hasAgeRange(o)) return false;
    for (let i = 0; i < (qty[o.id] ?? 0); i++) {
      const a = parseAge(ages[o.id]?.[i]);
      if (a !== null && !ageFits(o, a)) return true;
    }
    return false;
  });
}

/**
 * A warning when `age` is outside the add-on's range, naming a better-fitting add-on if there is one.
 * Returns null when the age fits, is not given, or the add-on has no age limit.
 */
export function ageWarning(offer: AgedOffer, age: number | null, all: AgedOffer[]): string | null {
  if (age === null || !hasAgeRange(offer) || ageFits(offer, age)) return null;
  const better = all.find((o) => o.id !== offer.id && hasAgeRange(o) && ageFits(o, age));
  const base = `${offer.name} is for ${rangeText(offer)}, but you entered ${age}.`;
  return better
    ? `${base} Please choose “${better.name}” (${rangeText(better)}) instead.`
    : `${base} No add-on here fits age ${age}, so this person can't be added online. Please check with the provider.`;
}

/** The first person (if any) with a missing age on an add-on that has an age range. */
export function missingAge(offer: AgedOffer, qty: number, ages: string[] | undefined): boolean {
  if (!hasAgeRange(offer)) return false;
  for (let i = 0; i < qty; i++) if (parseAge(ages?.[i]) === null) return true;
  return false;
}
