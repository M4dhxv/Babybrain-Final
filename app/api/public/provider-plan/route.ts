import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Public: whether a provider's current plan includes parent messaging.
 * Messaging is a Growth-and-above perk (see PLAN_META in the vendor app's
 * lib/plans.ts) — a Pay As You Grow vendor shouldn't be reachable via chat
 * on either side, so the parent app's "Chat with provider" / class group
 * chat buttons check this before opening.
 *
 * `subscriptions` RLS scopes reads to the provider's own members, so a
 * parent's browser can't read the row directly — this goes through the
 * service role and exposes only the derived boolean, never the row itself.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get('providerId');
  if (!providerId) return NextResponse.json({ error: 'providerId required' }, { status: 400 });

  const admin = createAdminClient();
  const { data } = await admin
    .from('subscriptions')
    .select('plan')
    .eq('provider_id', providerId)
    .maybeSingle();
  // Legacy rows can still carry 'premium' from before the Plans page's
  // pro/premium rename — treat it the same as 'pro' (see vendor lib/plans.ts).
  const plan = data?.plan ?? 'free';
  const canMessage = plan === 'growth' || plan === 'pro' || plan === 'premium';
  return NextResponse.json({ canMessage });
}
