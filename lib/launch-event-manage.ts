import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Self-service helpers for launch-event registrants (look up / edit / cancel their own RSVP).
 *
 * Ownership is proved, not assumed: the lookup route only treats a caller as the registrant when
 * at least TWO of {name, email, phone} typed on the form match the same registration. That caller
 * gets a short-lived signed token naming that one registration; every change then needs the token.
 * With only ONE field matching, the caller learns that a registration exists but sees it masked and
 * cannot change anything.
 */

export const MANAGE_TOKEN_TTL_SECONDS = 15 * 60;
/** How many of name / email / phone must match before the registration is treated as theirs. */
export const OWNER_MATCHES_REQUIRED = 2;

function secret(): string {
  // A dedicated secret if one is set; otherwise derive from the service-role key (server-only, never sent to a browser).
  return process.env.LAUNCH_MANAGE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

const b64u = (b: Buffer) => b.toString('base64url');

/** "<registration id>.<expiry unix seconds>.<signature>" - tamper-proof, no database needed. */
export function signManageToken(registrationId: string, now = Date.now(), ttlSeconds = MANAGE_TOKEN_TTL_SECONDS): string {
  const key = secret();
  if (!key) throw new Error('no signing secret configured');
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = `${registrationId}.${exp}`;
  const sig = b64u(createHmac('sha256', key).update(`launch-manage:${body}`).digest());
  return `${body}.${sig}`;
}

/** The registration id the token was issued for, or null if it is forged, malformed or expired. */
export function verifyManageToken(token: unknown, now = Date.now()): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, expStr, sig] = parts;
  const key = secret();
  if (!key || !/^[0-9a-f-]{36}$/i.test(id) || !/^\d{9,12}$/.test(expStr)) return null;
  const want = createHmac('sha256', key).update(`launch-manage:${id}.${expStr}`).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (Number(expStr) * 1000 < now) return null;
  return id;
}

// ---- masking: what someone sees when only one detail matched ----
export function maskName(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).map((w) => `${w[0]}${'*'.repeat(Math.max(2, Math.min(w.length - 1, 5)))}`).join(' ');
}
export function maskEmail(email: string | null): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local[0] ?? ''}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
}
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');            // 65XXXXXXXX
  const n = d.slice(-8);
  return n.length === 8 ? `+65 ${n[0]}*** **${n.slice(6)}` : '+65 **** ****';
}
