import { getAuthedContext } from '@/lib/api-auth';
import { adminRoleOf } from '@/lib/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, ProviderRole } from '@/types/database';

const RANK: Record<ProviderRole, number> = { staff: 1, manager: 2, owner: 3 };

export interface VendorContext {
  userId: string;
  providerId: string;
  role: ProviderRole;
  supabase: SupabaseClient<Database>;
}

/**
 * Resolve the caller's membership of a provider and assert a minimum role.
 * Auth comes from a Bearer token (cross-origin SPA) or the cookie session
 * (SSR) via {@link getAuthedContext}. Returns the context, or an
 * { error, status } to return. RLS already lets a member read their own
 * provider_members row.
 */
export async function requireProviderRole(
  request: Request,
  providerId: string,
  minRole: ProviderRole = 'staff'
): Promise<
  | { ok: true; ctx: VendorContext }
  | { ok: false; status: number; error: string }
> {
  const { supabase, user } = await getAuthedContext(request);
  if (!user) return { ok: false, status: 401, error: 'Not authenticated' };

  const { data: member } = await supabase
    .from('provider_members')
    .select('role, status')
    .eq('provider_id', providerId)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (!member) {
    // An admin who opened this vendor from the admin portal works here as a
    // manager (00251). Re-checked against ADMIN_EMAILS on every call, so a
    // grant left behind by someone who is no longer an admin does nothing here.
    if (RANK.manager >= RANK[minRole] && user.email_confirmed_at && adminRoleOf(user.email) === 'admin') {
      const { data: grant } = await supabase
        .from('admin_vendor_access')
        .select('provider_id')
        .eq('provider_id', providerId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (grant) return { ok: true, ctx: { userId: user.id, providerId, role: 'manager', supabase } };
    }
    return { ok: false, status: 403, error: 'Not a member of this business' };
  }
  if (RANK[member.role] < RANK[minRole]) {
    return { ok: false, status: 403, error: `Requires ${minRole} role` };
  }
  return { ok: true, ctx: { userId: user.id, providerId, role: member.role, supabase } };
}
