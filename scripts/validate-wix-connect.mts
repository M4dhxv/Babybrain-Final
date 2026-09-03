/**
 * Edge-case validation for the Wix credential connect / verify path
 * (app/api/vendor/wix-integration POST). The bug class this guards against:
 * CORRECT credentials producing a "your key/site is wrong" failure —
 * transient Wix outages, and messy copy-paste (a dashboard URL in the Site
 * ID field, a line-wrapped key, a stray "Bearer ").
 *
 * Read-only against Wix. Uses the live indsg.kidscenter key.
 *
 *   npx tsx scripts/validate-wix-connect.mts
 */
process.loadEnvFile('.env.local');
import { createClient } from '@supabase/supabase-js';
import {
  WixApiError,
  describeWixApiError,
  fetchWixServices,
  normalizeWixSiteId,
  normalizeWixApiKey,
} from '../lib/wix/client';

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
  ok ? pass++ : fail++;
};

const { data: cred } = await admin
  .from('provider_wix_credentials')
  .select('wix_api_key, wix_site_id')
  .eq('provider_id', 'a64b081d-476c-4530-b342-1276ca5c2002')
  .maybeSingle();
if (!cred?.wix_api_key) throw new Error('indsg.kidscenter has no Wix credentials — relink first');
const KEY = cred.wix_api_key as string;
const SITE = cred.wix_site_id as string;

console.log('--- Wix connect / verify edge cases ---\n');

// ── 1. A transient failure never reads as "wrong credentials" ──────────────
const mk = (s: number, b = '') => new WixApiError(s, '/bookings/v2/services/query', b);
const blamesCreds = (m: string) => /check (the |it )?(key|api key)|revoked|permissions|Site ID/i.test(m);
const traysAgain = (m: string) => /try (again|connecting)|Wix’s side|reach Wix|Bookings app is installed/i.test(m);

for (const [label, e] of [
  ['429 rate limit', mk(429)],
  ['500', mk(500)],
  ['502', mk(502)],
  ['503', mk(503)],
  ['504 (our 20s timeout)', mk(504, 'Wix did not respond within 20s')],
  ['0 network error', mk(0, 'network error')],
  ['non-WixApiError', new Error('socket hang up')],
] as const) {
  check(`${label} → "try again", not "wrong key"`, traysAgain(describeWixApiError(e)) && !blamesCreds(describeWixApiError(e)), describeWixApiError(e).slice(0, 64));
}
// setup problem, still not a credential problem
check('404 / 428 → "install Bookings app", not "wrong key"', !blamesCreds(describeWixApiError(mk(428))) && !blamesCreds(describeWixApiError(mk(404, 'nope'))));
// the genuine credential problems keep their specific guidance
check('403 still points at the key AND the Site ID', /api key/i.test(describeWixApiError(mk(403))) && /Site ID/i.test(describeWixApiError(mk(403))));
check('404 meta-site still flags a site/key account mismatch', /Site ID.*match/i.test(describeWixApiError(mk(404, 'requested meta-site x not found'))));

// ── 2. normalizeWixSiteId pulls the UUID out of a messy paste ─────────────
for (const [label, raw] of [
  ['plain id', SITE],
  ['dashboard URL', `wix.com/dashboard/${SITE}/home`],
  ['full https URL w/ query', `https://manage.wix.com/dashboard/${SITE}/home?tab=x`],
  ['trailing slash', `${SITE}/`],
  ['surrounding spaces', `  ${SITE}  `],
  ['uppercased', SITE.toUpperCase()],
] as const) {
  check(`site: ${label} → clean UUID`, normalizeWixSiteId(raw) === SITE);
}
check('site: unrecognisable input passes through (Wix answers, message names the site)', normalizeWixSiteId('not-an-id') === 'not-an-id');

// ── 3. normalizeWixApiKey recovers a line-wrapped / prefixed key ──────────
for (const [label, raw] of [
  ['trailing newline', KEY + '\n'],
  ['inner newline (wrapped)', KEY.slice(0, 40) + '\n' + KEY.slice(40)],
  ['inner space', KEY.slice(0, 40) + ' ' + KEY.slice(40)],
  ['leading "Bearer "', 'Bearer ' + KEY],
  ['tabs + newline wrap', KEY.slice(0, 30) + '\n\t' + KEY.slice(30)],
] as const) {
  check(`key: ${label} → exact key recovered`, normalizeWixApiKey(raw) === KEY);
}

// ── 4. end-to-end: the normalised messy inputs actually verify on Wix ─────
async function verifies(label: string, k: string, s: string, want: boolean) {
  let ok = false;
  let detail = '';
  try {
    await fetchWixServices({ accessToken: normalizeWixApiKey(k), siteId: normalizeWixSiteId(s) });
    ok = true;
  } catch (e) {
    detail = describeWixApiError(e).slice(0, 60);
  }
  check(`verify: ${label}`, ok === want, want ? detail : ok ? 'unexpectedly succeeded' : '');
}
await verifies('correct key + dashboard-URL site', KEY, `wix.com/dashboard/${SITE}/home`, true);
await verifies('line-wrapped key + correct site', KEY.slice(0, 40) + '\n' + KEY.slice(40), SITE, true);
await verifies('"Bearer "-prefixed key + correct site', 'Bearer ' + KEY, SITE, true);
await verifies('both fields messy', 'Bearer ' + KEY.slice(0, 40) + '\n' + KEY.slice(40), `  wix.com/dashboard/${SITE}/home `, true);
await verifies('genuinely wrong key (control)', KEY.slice(0, -4) + 'zzzz', SITE, false);
await verifies('genuinely wrong site (control)', KEY, '00000000-0000-4000-8000-000000000000', false);

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
