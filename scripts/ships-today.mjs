#!/usr/bin/env node
/**
 * How many times has production been deployed today (India time)? Every push
 * to main ships to Production, so this is the "ships today" count that
 * CLAUDE.md's shipping rules refer to. Needs the GitHub CLI (`gh auth login`).
 *
 *   node scripts/ships-today.mjs
 */
import { execFileSync } from "node:child_process";

const LIMIT = 3;
const istDay = (d) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

const raw = execFileSync(
  "gh",
  ["api", "repos/:owner/:repo/deployments?per_page=60", "--jq", '[.[] | select(.environment == "Production – babybrain-final") | {sha: .sha[0:7], at: .created_at}]'],
  { encoding: "utf8" },
);
const today = istDay(new Date());
const deploys = JSON.parse(raw).filter((d) => istDay(new Date(d.at)) === today);
const shas = [...new Set(deploys.map((d) => d.sha))];
const hourIst = (new Date().getUTCHours() + 5.5 + 24) % 24;

console.log(`Production ships today (IST ${today}): ${shas.length} of ${LIMIT} recommended`);
for (const d of deploys.reverse()) {
  const t = new Date(new Date(d.at).getTime() + 5.5 * 3600_000).toISOString().slice(11, 16);
  console.log(`  ${t} IST  ${d.sha}`);
}
if (shas.length >= LIMIT) console.log(`WARNING: at or past the daily limit - a push now is ship #${shas.length + 1}.`);
if (hourIst >= 21 || hourIst < 7) console.log("WARNING: it is late night in India - avoid shipping unless it is an urgent fix.");
