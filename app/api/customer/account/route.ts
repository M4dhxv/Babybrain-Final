import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Delete the signed-in parent's account (Profile → Settings → Delete account).
 *
 * QA: "I can't see any options to cancel subscription or delete profile."
 *
 * Order matters: cancel any live Stripe subscription first so a deleted
 * account can never be billed again, then remove the auth user. Deleting the
 * auth user cascades to parent_profiles and everything hanging off it
 * (children, preferences, favourites, notifications). Bookings keep their row
 * for the provider's records but lose the user link, per the Terms' data
 * retention clause.
 *
 * Requires the caller to confirm with { confirm: "DELETE" } so a stray POST
 * can't wipe an account.
 */
export async function POST(request: Request) {
  const { confirm } = (await request.json().catch(() => ({}))) as { confirm?: string };
  if (confirm !== 'DELETE') {
    return NextResponse.json({ error: 'Confirmation required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();

  const { data: sub } = await admin
    .from('customer_subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (sub?.stripe_subscription_id) {
    // Best effort: a Stripe outage shouldn't trap someone in their account,
    // but we must not lose the fact that it needs cancelling either.
    try {
      await getStripe().subscriptions.cancel(sub.stripe_subscription_id);
    } catch {
      return NextResponse.json(
        {
          error:
            "We couldn't cancel your subscription just now, so we haven't deleted your account. Please try again shortly or contact hello@babybrain.sg.",
        },
        { status: 502 }
      );
    }
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
