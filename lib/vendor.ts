import { getAuthedContext } from '@/lib/api-auth';
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

  if (!member) return { ok: false, status: 403, error: 'Not a member of this business' };
  if (RANK[member.role] < RANK[minRole]) {
    return { ok: false, status: 403, error: `Requires ${minRole} role` };
  }
  return { ok: true, ctx: { userId: user.id, providerId, role: member.role, supabase } };
}
