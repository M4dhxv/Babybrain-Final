#!/usr/bin/env node
/**
 * Parity check for Explore's local filtering (frontends/parent/src/lib/exploreCatalogue.ts).
 *
 * Explore fetches one snapshot of the catalogue and applies Type / Age / Area /
 * Price on the phone. This proves that gives EXACTLY what the database gives:
 * for many filter combinations it asks Postgres the old way (the filter sent to
 * search_activities / search_activity_facets) and compares, id for id and in
 * order, with the snapshot filtered locally. Read-only; uses the public anon key.
 *
 *   node scripts/explore-parity.mjs            # live production catalogue
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/explore-parity.mjs
 *
 * Keep `passes` / `facets` below in step with exploreCatalogue.ts.
 * Exits 1 on any mismatch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, "../frontends/parent/.env.production"), "utf8");
const fromEnv = (k) => envText.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
const SB_URL = process.env.SUPABASE_URL || fromEnv("VITE_SUPABASE_URL");
const SB_KEY = process.env.SUPABASE_ANON_KEY || fromEnv("VITE_SUPABASE_ANON_KEY");

const AGE_BANDS = [
  { key: "0-5", min: 0, max: 5 }, { key: "6-11", min: 6, max: 11 }, { key: "12-17", min: 12, max: 17 },
  { key: "18-35", min: 18, max: 35 }, { key: "36+", min: 36, max: 132 },
];

async function rpc(name, body) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${name} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function passes(r, f, skip) {
  if (skip !== "type" && f.categories.length) {
    if (!((r.category_slug != null && f.categories.includes(r.category_slug)) ||
          (r.category_2_slug != null && f.categories.includes(r.category_2_slug)))) return false;
  }
  if (skip !== "age" && f.ageMin != null && f.ageMax != null) {
    if (!(r.age_min_months <= f.ageMax && r.age_max_months >= f.ageMin)) return false;
  }
  if (skip !== "area" && f.regions.length) {
    if (!(r.is_custom_location || (r.areas ?? []).some((a) => f.regions.includes(a)))) return false;
  }
  if (f.maxPrice != null) {
    const lo = r.price_from ?? r.price;
    if (lo != null && Number(lo) > f.maxPrice) return false;
  }
  return true;
}

function facets(rows, f) {
  const out = { type: {}, age: {}, area: { custom: 0 } };
  for (const r of rows) {
    if (passes(r, f, "type")) for (const k of new Set([r.category_slug, r.category_2_slug])) if (k) out.type[k] = (out.type[k] ?? 0) + 1;
    if (passes(r, f, "age")) for (const b of AGE_BANDS) if (r.age_min_months <= b.max && r.age_max_months >= b.min) out.age[b.key] = (out.age[b.key] ?? 0) + 1;
    if (passes(r, f, "area")) {
      for (const a of r.areas ?? []) out.area[a] = (out.area[a] ?? 0) + 1;
      if (r.is_custom_location) out.area.custom += 1;
    }
  }
  return out;
}

const sameObj = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

let checks = 0;
const bad = [];

for (const sort of ["soonest", "popular", "price_asc", "price_desc"]) {
  const base = { p_sort: sort, p_limit: 500, p_offset: 0 };
  const snapshot = await rpc("search_activities", base);
  const cats = [...new Set(snapshot.flatMap((r) => [r.category_slug, r.category_2_slug]).filter(Boolean))];
  const areas = [...new Set(snapshot.flatMap((r) => r.areas ?? []))];
  const prices = [20, 50, 80, 120, 200, 400];

  const combos = [{ categories: [], ageMin: null, ageMax: null, regions: [], maxPrice: null }];
  for (const c of cats) combos.push({ categories: [c], ageMin: null, ageMax: null, regions: [], maxPrice: null });
  if (cats.length > 1) combos.push({ categories: cats.slice(0, 2), ageMin: null, ageMax: null, regions: [], maxPrice: null });
  for (let i = 0; i < AGE_BANDS.length; i++) {
    combos.push({ categories: [], ageMin: AGE_BANDS[i].min, ageMax: AGE_BANDS[i].max, regions: [], maxPrice: null });
    if (i + 1 < AGE_BANDS.length) combos.push({ categories: [], ageMin: AGE_BANDS[i].min, ageMax: AGE_BANDS[i + 1].max, regions: [], maxPrice: null });
  }
  for (const a of areas) combos.push({ categories: [], ageMin: null, ageMax: null, regions: [a], maxPrice: null });
  combos.push({ categories: [], ageMin: null, ageMax: null, regions: ["custom"], maxPrice: null });
  if (areas.length > 1) combos.push({ categories: [], ageMin: null, ageMax: null, regions: areas.slice(0, 2), maxPrice: null });
  for (const p of prices) combos.push({ categories: [], ageMin: null, ageMax: null, regions: [], maxPrice: p });
  // Mixed: every filter at once.
  if (cats[0] && areas[0]) combos.push({ categories: [cats[0]], ageMin: 6, ageMax: 35, regions: [areas[0]], maxPrice: 120 });

  for (const f of combos) {
    const args = {
      ...base,
      p_categories: f.categories.length ? f.categories : null,
      p_age_min_months: f.ageMin, p_age_max_months: f.ageMax,
      p_regions: f.regions.length ? f.regions : null,
      p_max_price: f.maxPrice,
    };
    const fromDb = (await rpc("search_activities", args)).map((r) => r.id);
    const local = snapshot.filter((r) => passes(r, f)).map((r) => r.id);
    checks++;
    if (JSON.stringify(fromDb) !== JSON.stringify(local)) {
      bad.push(`${sort} ${JSON.stringify(f)}: database ${fromDb.length} rows, local ${local.length} rows`);
    }

    if (sort === "soonest") {
      const dbFacetRows = await rpc("search_activity_facets", {
        p_categories: args.p_categories, p_age_min_months: f.ageMin, p_age_max_months: f.ageMax,
        p_regions: args.p_regions, p_max_price: f.maxPrice,
      });
      const dbF = { type: {}, age: {}, area: {} };
      for (const x of dbFacetRows) dbF[x.facet][x.key] = Number(x.cnt);
      // The database reports 'custom' only when non-zero; so does the local count.
      const localF = facets(snapshot, f);
      checks++;
      for (const k of ["type", "age", "area"]) {
        if (!sameObj(dbF[k], localF[k])) bad.push(`facets.${k} ${JSON.stringify(f)}: database ${JSON.stringify(dbF[k])} local ${JSON.stringify(localF[k])}`);
      }
    }
  }
  console.log(`sort ${sort}: ${snapshot.length} activities, ${combos.length} filter combinations compared`);
}

if (bad.length) {
  console.error(`\nMISMATCH (${bad.length}):`);
  for (const b of bad.slice(0, 25)) console.error(" - " + b);
  process.exit(1);
}
console.log(`\nOK: ${checks} comparisons, local filtering matches the database exactly.`);
