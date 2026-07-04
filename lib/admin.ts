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
  const { user } = await getAuthedContext(request);
  if (!user) return { ok: false, status: 401, error: 'Not authenticated' };
  if (!user.email || !adminEmails().includes(user.email.toLowerCase())) {
    return { ok: false, status: 403, error: 'Not an admin' };
  }
  return { ok: true, user };
}
