/**
 * Credential-connect validation for Settings -> Integrate your Business.
 *
 * Runs the exact sequence POST /api/vendor/wix-integration does — normalize,
 * Site-ID shape check, verify against Wix, retry once on a transient failure,
 * describeWixApiError — against a real connected account, for every messy
 * paste and every genuine mistake a vendor can make.
 *
 * The point is the "pass" half: a correct key and Site ID must NEVER be
 * reported as wrong just because the paste carried a newline, a "Bearer "
 * prefix, a whole dashboard URL, or an invisible character. Read-only; it
 * writes nothing.
 *
 * Run: npx tsx scripts/validate-wix-credentials.mts
 */
process.loadEnvFile('.env.local');
import { createClient } from '@supabase/supabase-js';
import {
  fetchWixServices, describeWixApiError, normalizeWixApiKey, normalizeWixSiteId,
  isWixSiteId, WixApiError,
} from '../lib/wix/client';

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// Any connected provider will do — the matrix only needs one working pair.
const { data: row } = await admin
  .from('provider_wix_credentials')
  .select('provider_id, wix_api_key, wix_site_id')
  .limit(1)
  .maybeSingle();
if (!row) throw new Error('no provider has Wix credentials connected — link one first');
const KEY = row.wix_api_key as string;
const SITE = row.wix_site_id as string;

// A real Wix site UUID that this key has no rights on. Any well-formed UUID
// Wix doesn't know answers 404; one it *does* know but the key can't touch
// answers 403 — both are covered below.
const FOREIGN_SITE = 'b341aa0a-cb80-41b0-813b-2e5362e2a80b';
const ZWSP = '\u200b', NBSP = '\u00a0', SHY = '\u00ad', BOM = '\ufeff', ENDASH = '\u2013';

/** Mirrors the route, minus the DB write. */
async function connect(rawKey: string, rawSite: string) {
  if (!rawSite?.trim() || !rawKey?.trim()) return { ok: false, via: 'field-check', msg: 'required fields' };
  const creds = { accessToken: normalizeWixApiKey(rawKey), siteId: normalizeWixSiteId(rawSite) };
  if (!creds.accessToken || !creds.siteId) return { ok: false, via: 'field-check', msg: 'required fields' };
  if (!isWixSiteId(creds.siteId)) return { ok: false, via: 'site-id-shape', msg: 'not a Wix Site ID (rejected without a Wix call)' };
  try {
    const s = await fetchWixServices(creds);
    return { ok: true, via: 'verified', msg: `${s.length} services` };
  } catch (e) {
    const transient = e instanceof WixApiError && (e.status === 0 || e.status === 429 || e.status >= 500);
    if (transient) {
      await new Promise((r) => setTimeout(r, 1500));
      try { const s = await fetchWixServices(creds); return { ok: true, via: 'verified-on-retry', msg: `${s.length} services` }; }
      catch (e2) { return { ok: false, via: `wix ${(e2 as WixApiError).status}`, msg: describeWixApiError(e2) }; }
    }
    return { ok: false, via: `wix ${(e as WixApiError).status}`, msg: describeWixApiError(e) };
  }
}

const cases: [string, string, string, 'pass' | 'fail'][] = [
  // Correct credentials — every one of these MUST connect.
  ['correct key + correct site',            KEY, SITE, 'pass'],
  ['key: surrounding whitespace',           `  ${KEY}\n`, SITE, 'pass'],
  ['key: "Bearer " prefix',                 `Bearer ${KEY}`, SITE, 'pass'],
  ['key: newline mid-token (wrapped)',      KEY.slice(0, 40) + '\n' + KEY.slice(40), SITE, 'pass'],
  ['key: internal spaces',                  KEY.slice(0, 60) + '  ' + KEY.slice(60), SITE, 'pass'],
  ['key: zero-width space inside',          KEY.slice(0, 30) + ZWSP + KEY.slice(30), SITE, 'pass'],
  ['key: BOM prefix',                       BOM + KEY, SITE, 'pass'],
  ['site: full dashboard URL',              KEY, `https://manage.wix.com/dashboard/${SITE}/home`, 'pass'],
  ['site: trailing slash + spaces',         KEY, ` ${SITE}/ `, 'pass'],
  ['site: UPPERCASE',                       KEY, SITE.toUpperCase(), 'pass'],
  ['site: URL with query string',           KEY, `wix.com/dashboard/${SITE}/home?referralInfo=x`, 'pass'],
  ['site: zero-width space inside',         KEY, SITE.slice(0, 8) + ZWSP + SITE.slice(8), 'pass'],
  ['site: non-breaking spaces around',      KEY, NBSP + SITE + NBSP, 'pass'],
  ['site: en-dashes instead of hyphens',    KEY, SITE.replace(/-/g, ENDASH), 'pass'],
  ['site: soft hyphen inside',              KEY, SITE.slice(0, 12) + SHY + SITE.slice(12), 'pass'],
  // Genuine mistakes — must fail, with a message that names the real cause.
  ['valid key + foreign real site',         KEY, FOREIGN_SITE, 'fail'],
  ['valid key + unknown UUID site',         KEY, '11111111-2222-3333-4444-555555555555', 'fail'],
  ['garbage key',                           'IST.notarealkey', SITE, 'fail'],
  ['truncated key',                         KEY.slice(0, -20), SITE, 'fail'],
  ['site is not a UUID at all',             KEY, 'my-wix-site', 'fail'],
  ['empty key',                             '   ', SITE, 'fail'],
  ['empty site',                            KEY, '  ', 'fail'],
];

console.log(`--- Wix connect-credentials validation (site ${SITE}) ---\n`);
let bad = 0;
for (const [name, k, s, expect] of cases) {
  const r = await connect(k, s);
  const got = r.ok ? 'pass' : 'fail';
  if (got !== expect) bad++;
  console.log(`${got === expect ? '  ' : '⚠️'} ${r.ok ? '✅' : '❌'} ${name}  [${r.via}]`);
  if (!r.ok) console.log(`        ${r.msg}`);
}
console.log(`\n${bad === 0 ? '🎉' : '⚠️'} ${cases.length - bad}/${cases.length} as expected`);
process.exit(bad === 0 ? 0 : 1);
