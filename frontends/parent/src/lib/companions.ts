/**
 * Companion mode (migration 00273), parent side. A vendor can make every ticket include N free
 * companions of one type, "adult" (15 and over) or "child" (12 and under). The parent enters each
 * companion's name and age; a name needs an age, and the age must match the type. The API repeats
 * these checks, this is the same rule shown on the page so the parent can't continue with a mismatch.
 */
import { parseAge } from "./addonAges";

export const CHILD_MAX_AGE = 12;
export const ADULT_MIN_AGE = 15;
export type CompanionType = "adult" | "child";

export const typeWord = (t: CompanionType) => (t === "adult" ? `an adult (${ADULT_MIN_AGE} and over)` : `a child (${CHILD_MAX_AGE} and under)`);

/** Null when the age suits the type, otherwise what to tell the parent. */
export function ageProblem(type: CompanionType, age: number): string | null {
  const fits = type === "adult" ? age >= ADULT_MIN_AGE : age <= CHILD_MAX_AGE;
  if (fits) return null;
  return `This class's companion must be ${typeWord(type)}, but you entered ${age}.`;
}

/** The companions the parent filled in, one entry per person, in ticket order. Blank rows are dropped. */
export function buildCompanions(
  tickets: number,
  slots: number,
  names: string[],
  ages: string[]
): Array<{ seat: number; name: string; age: number | null }> {
  const out: Array<{ seat: number; name: string; age: number | null }> = [];
  for (let seat = 0; seat < tickets; seat++) {
    for (let k = 0; k < slots; k++) {
      const i = seat * slots + k;
      const name = (names[i] ?? "").trim();
      const age = parseAge(ages[i]);
      if (!name && age === null) continue;
      out.push({ seat, name, age });
    }
  }
  return out;
}

/** The first thing stopping the parent from continuing, or null when the companions are fine. */
export function companionProblem(type: CompanionType, tickets: number, slots: number, names: string[], ages: string[]): string | null {
  for (const c of buildCompanions(tickets, slots, names, ages)) {
    if (!c.name) return "Enter the companion's name as well as their age.";
    if (c.age === null) return `Enter ${c.name}'s age so we can check the companion is ${type === "adult" ? "an adult" : "a child"}.`;
    if (c.age !== null) {
      const p = ageProblem(type, c.age);
      if (p) return p;
    }
  }
  return null;
}
