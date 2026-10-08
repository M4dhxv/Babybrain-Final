import type { User } from '@supabase/supabase-js';
import { getAuthedContext } from '@/lib/api-auth';

/**
 * Founder/admin gate for `/api/admin/**`. An admin is any authenticated user
 * whose email is in the ADMIN_EMAILS allowlist (comma-separated, set in the
 * deployment env). Mirrors {@link requireProviderRole} for the vendor side.
 */

export type AdminRole = 'admin' | 'support';

function emailList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `admin` = anyone in ADMIN_EMAILS (everything). `support` = anyone in ADMIN_SUPPORT_EMAILS: they can
 * work the inbox (Messages, Contact form, Email flows) and look up parents, but not money, vendors
 * or settings. Leave ADMIN_SUPPORT_EMAILS unset and nothing changes: only admins get in.
 */
export function adminRoleOf(email: string | null | undefined): AdminRole | null {
  const e = (email ?? '').toLowerCase();
  if (!e) return null;
  if (emailList('ADMIN_EMAILS').includes(e)) return 'admin';
  if (emailList('ADMIN_SUPPORT_EMAILS').includes(e)) return 'support';
  return null;
}

export async function requireAdmin(
  request: Request,
  allow: AdminRole[] = ['admin']
): Promise<{ ok: true; user: User; role: AdminRole } | { ok: false; status: number; error: string }> {
  // Production and Preview share one Supabase database (see lib/stripe-config.ts's
  // doc comment) — there is no sandboxed copy for a test/preview deployment to
  // mutate. So rather than "admin changes don't show up on test", the real
  // requirement is admin actions can only be taken from the live deployment at
  // all, so nobody mistakes a preview URL for a safe place to click admin buttons.
  if (process.env.VERCEL_ENV === 'preview') {
    return { ok: false, status: 403, error: 'Admin actions are disabled on preview deployments — use the live site.' };
  }
  const { user } = await getAuthedContext(request);
  if (!user) return { ok: false, status: 401, error: 'Not authenticated' };
  // Admin is granted by email address alone, so the address has to be one the
  // account has proved it owns. Supabase's "Confirm email" setting is what
  // enforces that today; this holds even if that setting is ever switched off
  // (or an allowlisted address has no account yet and someone signs up as it).
  if (!user.email_confirmed_at) return { ok: false, status: 403, error: 'Not an admin' };
  const role = adminRoleOf(user.email);
  if (!role) return { ok: false, status: 403, error: 'Not an admin' };
  if (!allow.includes(role)) return { ok: false, status: 403, error: 'Admin only' };
  return { ok: true, user, role };
}
