#!/usr/bin/env node
/**
 * Fails when a later migration redefines one of the functions below WITHOUT something an earlier
 * migration put into it.
 *
 * Why: `create or replace function` replaces the whole body. A migration written from an older copy
 * silently deletes whatever was added since. It has happened: the term-enrolment migration (written
 * as 00244) was based on a copy of search_activities from before 00250 and a copy of
 * redeem_make_up_token from before 00197, so applying it would have taken away 00250's price range
 * and venue count and 00197's "a waitlisted booking does not use up the token" rule.
 *
 * It reads supabase/migrations in file order, takes the LAST definition of each function, and
 * checks that every marker below is still in it. Needs no database and no secrets.
 *
 *   node scripts/check-migration-regressions.mjs       # exit 1 on a regression
 *   npm run check:migrations
 *
 * Run it before `supabase db push`. When a function legitimately changes shape, update its markers
 * here in the same change, with the migration that introduced the new piece named in `why`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../supabase/migrations");

/** function -> pieces its latest definition must still contain. */
const GUARDED = {
  search_activities: [
    { has: "price_from", why: "00250: the price range on Explore cards (From $X)" },
    { has: "location_count", why: "00250: how many venues an activity runs at (Venue +N)" },
    { has: "p_terms_only", why: "00257: the Explore terms filter" },
  ],
  redeem_make_up_token: [
    // 00276 turned a token into a money balance: the 00197 rule is now "credit is only spent on a seat that got a
    // place" (a waitlisted booking is never confirmed here, so nothing is reserved for it).
    { has: /v_status\s*=\s*'pending'/, why: "00197/00276: a booking that only reached the waitlist must not spend any make-up credit" },
    { has: "reserve_make_up_credit", why: "00276: the class is paid from the vendor-scoped make-up credit balance" },
    { has: "v_term_slot", why: "00257: redeeming a token on a term class" },
  ],
  notify_booking_confirmed: [
    { has: "group_sibling_notified", why: "00228: one confirmation for a multi-ticket booking" },
    { has: "term_enrolment_id", why: "00257: one 'enrolled' notice per term enrolment" },
  ],
};

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const last = {};

for (const file of files) {
  const text = readFileSync(join(dir, file), "utf8").replace(/\r/g, "");
  for (const name of Object.keys(GUARDED)) {
    const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "gi");
    let m;
    let at = -1;
    while ((m = re.exec(text))) at = m.index;
    if (at < 0) continue;
    // The body sits between the first pair of $tag$ delimiters after the signature.
    const open = /\$[a-z_]*\$/i.exec(text.slice(at));
    if (!open) continue;
    const tag = open[0];
    const from = at + open.index + tag.length;
    last[name] = { file, body: text.slice(from, text.indexOf(tag, from)) };
  }
}

let failed = 0;
for (const [name, markers] of Object.entries(GUARDED)) {
  const def = last[name];
  if (!def) {
    console.error(`FAIL ${name}: no definition found in supabase/migrations`);
    failed++;
    continue;
  }
  const missing = markers.filter((mk) => !(mk.has instanceof RegExp ? mk.has.test(def.body) : def.body.includes(mk.has)));
  if (missing.length === 0) {
    console.log(`ok   ${name}  (latest definition: ${def.file})`);
    continue;
  }
  failed++;
  console.error(`FAIL ${name}  (latest definition: ${def.file}) has lost:`);
  for (const mk of missing) console.error(`       - ${typeof mk.has === "string" ? mk.has : mk.has.source}   ${mk.why}`);
  console.error(`     Rebuild ${def.file} from the previous definition of ${name}, not from an older copy.`);
}

if (failed) {
  console.error(`\n${failed} guarded function(s) regressed. Do not push these migrations.`);
  process.exit(1);
}
console.log(`\nall ${Object.keys(GUARDED).length} guarded functions still carry everything earlier migrations gave them`);
