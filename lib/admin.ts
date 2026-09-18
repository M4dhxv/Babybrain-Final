import type { User } from '@supabase/supabase-js';
import { getAuthedContext } from '@/lib/api-auth';

/**
 * Founder/admin gate for `/api/admin/**`. An admin is any authenticated user
 * whose email is in the ADMIN_EMAILS allowlist (comma-separated, set in the
 * deployment env). Mirrors {@link requireProviderRole} for the vendor side.
 */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function requireAdmin(
  request: Request
): Promise<{ ok: true; user: User } | { ok: false; status: number; error: string }> {
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
  if (!user.email || !adminEmails().includes(user.email.toLowerCase())) {
    return { ok: false, status: 403, error: 'Not an admin' };
  }
  return { ok: true, user };
}
