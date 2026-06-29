import { createClient } from '@/lib/supabase/server';
import type { ProviderRole } from '@/types/database';

const RANK: Record<ProviderRole, number> = { staff: 1, manager: 2, owner: 3 };

export interface VendorContext {
  userId: string;
  providerId: string;
  role: ProviderRole;
}

/**
 * Resolve the logged-in user's membership of a provider and assert a
 * minimum role. Returns the context, or an { error, status } to return.
 * RLS already lets a member read their own provider_members row.
 */
export async function requireProviderRole(
  providerId: string,
  minRole: ProviderRole = 'staff'
): Promise<
  | { ok: true; ctx: VendorContext }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
  return { ok: true, ctx: { userId: user.id, providerId, role: member.role } };
}
