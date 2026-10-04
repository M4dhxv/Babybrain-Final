#!/usr/bin/env node
/**
 * Smoke test for the parent site: the few things that, when broken, mean a
 * parent can't find or open a class. Run it by hand, after a deploy, and on a
 * schedule (see .github/workflows/uptime.yml).
 *
 *   node scripts/smoke.mjs                     # production
 *   SITE_URL=https://staging.example node scripts/smoke.mjs
 *
 * It needs no secrets: the Supabase URL and anon key are the public values the
 * parent app already ships (frontends/parent/.env.production).
 *
 * Checks, in the order a parent hits them:
 *   1. Explore HTML loads and every script/style it references exists
 *      (catches a half-published deploy).
 *   2. search_activities returns rows and a consistent count, quickly.
 *   3. A Type filter returns the same count the unfiltered list implies, and
 *      no row is listed that the count doesn't cover (the 21-found-but-nothing
 *      and everything-then-nothing failures).
 *   4. A live activity opens by slug (the "Activity not found" failure).
 *   5. The map pin query answers.
 * Each check retries once before it counts as a failure.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, "../frontends/parent/.env.production"), "utf8");
const fromEnv = (k) => envText.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();

const SITE = (process.env.SITE_URL || "https://babybrain-final.vercel.app").replace(/\/$/, "");
const SB_URL = process.env.SUPABASE_URL || fromEnv("VITE_SUPABASE_URL");
const SB_KEY = process.env.SUPABASE_ANON_KEY || fromEnv("VITE_SUPABASE_ANON_KEY");
/** A search slower than this is a warning sign: anonymous users are cut off at 3s. */
const SLOW_MS = Number(process.env.SMOKE_SLOW_MS || 2000);

if (!SB_URL || !SB_KEY) {
  console.error("smoke: no Supabase URL/key (set SUPABASE_URL and SUPABASE_ANON_KEY)");
  process.exit(2);
}

const failures = [];
const notes = [];

async function timed(fn) {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

async function rpc(name, body) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${name} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function check(name, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const detail = await fn();
      console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error(`FAIL ${name}: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  failures.push(name);
}

let rows = [];

await check("explore page and its assets load", async () => {
  const res = await fetch(`${SITE}/explore`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  if (assets.length === 0) throw new Error("no script or style tags in the page");
  for (const a of assets) {
    const r = await fetch(new URL(a, `${SITE}/`), { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${a} -> HTTP ${r.status}`);
  }
  return `${assets.length} assets`;
});

await check("search_activities lists activities with a consistent count", async () => {
  const { value, ms } = await timed(() => rpc("search_activities", { p_limit: 100 }));
  rows = value;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("returned no activities");
  const total = Number(rows[0].total_count);
  if (!(total >= rows.length)) throw new Error(`count ${total} is below the ${rows.length} rows returned`);
  if (ms > SLOW_MS) notes.push(`search_activities took ${ms}ms (limit for anonymous users is 3000ms)`);
  return `${rows.length} rows, ${ms}ms`;
});

await check("a Type filter agrees with the list", async () => {
  if (rows.length === 0) throw new Error("no rows to derive a category from");
  const slug = rows[0].category_slug;
  const { value: filtered, ms } = await timed(() => rpc("search_activities", { p_categories: [slug], p_limit: 100 }));
  const expected = rows.filter((r) => r.category_slug === slug || r.category_2_slug === slug).length;
  const total = Number(filtered[0]?.total_count ?? 0);
  if (filtered.length === 0) throw new Error(`filter "${slug}" returned nothing but the list has ${expected}`);
  if (total !== filtered.length && total > 100) throw new Error("count and rows disagree");
  if (rows.length < Number(rows[0].total_count)) return `skipped exact compare (list is paged), ${ms}ms`;
  if (total !== expected) throw new Error(`filter "${slug}" counts ${total}, list implies ${expected}`);
  if (ms > SLOW_MS) notes.push(`filtered search took ${ms}ms`);
  return `${slug}: ${total}, ${ms}ms`;
});

await check("a live activity opens by slug", async () => {
  if (rows.length === 0) throw new Error("no rows to pick an activity from");
  const slug = rows[0].slug;
  const res = await fetch(
    `${SB_URL}/rest/v1/activities?select=id,slug,is_published&slug=eq.${encodeURIComponent(slug)}&is_published=eq.true`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const got = await res.json();
  if (got.length !== 1) throw new Error(`"${slug}" is listed in search but its page would say not found (${got.length} rows)`);
  return slug;
});

await check("cached Explore endpoint matches the database", async () => {
  const args = { p_limit: 50, p_offset: 0, p_sort: "popular" };
  const url = `${SITE}/api/explore/search_activities?a=${encodeURIComponent(JSON.stringify(args))}`;
  const first = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (first.status === 404) {
    // Not deployed to this site yet (older build): Explore falls back to
    // querying the database directly, so this is a note, not an outage.
    notes.push("/api/explore is not deployed on this site yet (Explore is using direct database calls)");
    return "not deployed yet";
  }
  if (!first.ok) throw new Error(`HTTP ${first.status}`);
  const cc = first.headers.get("cache-control") || "";
  if (!/s-maxage=\d+/.test(cc)) throw new Error(`not edge-cacheable (cache-control: "${cc}")`);
  const viaEdge = await first.json();
  const direct = await rpc("search_activities", args);
  if (JSON.stringify(viaEdge) !== JSON.stringify(direct)) {
    // A listing may legitimately change within the cache window, so compare
    // the part that must never differ: the same activities are on offer.
    const ids = (r) => r.map((x) => x.id).sort().join();
    if (ids(viaEdge) !== ids(direct) || (viaEdge[0]?.total_count ?? 0) !== (direct[0]?.total_count ?? 0))
      throw new Error("endpoint and database disagree on which activities exist");
  }
  const second = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const hit = second.headers.get("x-vercel-cache");
  if (hit && !["HIT", "STALE", "REVALIDATED"].includes(hit)) notes.push(`second identical request was ${hit}, not served from the edge cache`);
  return `${viaEdge.length} rows, second request ${hit ?? "no cache header"}`;
});

await check("map pins answer", async () => {
  const { value, ms } = await timed(() => rpc("matching_activities", {}));
  if (!Array.isArray(value) || value.length === 0) throw new Error("returned no pins");
  return `${value.length} pins, ${ms}ms`;
});

for (const n of notes) console.warn(`warn ${n}`);
if (failures.length) {
  console.error(`\nsmoke FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nsmoke passed");
