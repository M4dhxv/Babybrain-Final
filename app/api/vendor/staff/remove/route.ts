import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';

/**
 * Remove a team member from a provider.
 *
 * Who can remove whom:
 *   - Owner   → any manager or staff member
 *   - Manager → staff members only
 *   - Staff   → nobody
 * The owner can never be removed (a provider must keep exactly one active
 * owner — migration 00113), and nobody can remove themselves here.
 *
 * `provider_members` is owner-write-only under RLS ("owners manage staff",
 * 00007), so a manager removing staff has to go through the service role —
 * hence this route rather than a client-side delete. All the authorisation
 * lives here.
 *
 * Body: { provider_id: string, user_id: string }
 */
export async function POST(request: Request) {
  const { provider_id: providerId, user_id: targetUserId } = (await request.json()) as {
    provider_id?: string;
    user_id?: string;
  };

  if (!providerId || !targetUserId) {
    return NextResponse.json({ error: 'provider_id and user_id required' }, { status: 400 });
  }

  // Caller must be at least a manager of this business.
  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (targetUserId === auth.ctx.userId) {
    return NextResponse.json({ error: 'You can’t remove yourself from the team.' }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: target } = await admin
    .from('provider_members')
    .select('role, invited_email')
    .eq('provider_id', providerId)
    .eq('user_id', targetUserId)
    .maybeSingle();

  if (!target) {
    return NextResponse.json({ error: 'That person isn’t on this team.' }, { status: 404 });
  }
  if (target.role === 'owner') {
    return NextResponse.json({ error: 'The business owner can’t be removed.' }, { status: 403 });
  }
  if (auth.ctx.role === 'manager' && target.role !== 'staff') {
    return NextResponse.json(
      { error: 'Managers can only remove staff. Ask the owner to remove another manager.' },
      { status: 403 }
    );
  }

  const { error } = await admin
    .from('provider_members')
    .delete()
    .eq('provider_id', providerId)
    .eq('user_id', targetUserId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Best-effort cleanup so the person leaves no trace on this business:
  //  - their per-member details row (no FK cascade from provider_members —
  //    its PK references providers/auth.users, not the membership);
  //  - any still-pending invite for the same address, which the signup
  //    trigger (00010) would otherwise re-consume into a fresh membership.
  await admin
    .from('provider_member_profiles')
    .delete()
    .eq('provider_id', providerId)
    .eq('user_id', targetUserId);
  if (target.invited_email) {
    await admin
      .from('provider_invites')
      .delete()
      .eq('provider_id', providerId)
      .ilike('email', target.invited_email)
      .is('accepted_at', null);
  }

  return NextResponse.json({ ok: true });
}
