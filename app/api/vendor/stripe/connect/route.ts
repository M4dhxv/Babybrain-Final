import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';

/**
 * Create/refresh a Stripe Connect (Express) onboarding link so a provider
 * can receive booking payouts. Owner-only. Returns an onboarding URL.
 * Body: { provider_id: string }
 */
export async function POST(request: Request) {
  const { provider_id: providerId } = (await request.json()) as { provider_id?: string };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  const auth = await requireProviderRole(providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const stripe = getStripe();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  const { data: provider } = await admin
    .from('providers')
    .select('stripe_account_id, contact_email, business_name')
    .eq('id', providerId)
    .single();

  let accountId = provider?.stripe_account_id ?? undefined;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'SG',
      email: provider?.contact_email ?? undefined,
      business_type: 'company',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { provider_id: providerId },
    });
    accountId = account.id;
    await admin
      .from('providers')
      .update({ stripe_account_id: accountId })
      .eq('id', providerId);
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appUrl}/vendor/billing?connect=refresh`,
    return_url: `${appUrl}/vendor/billing?connect=done`,
    type: 'account_onboarding',
  });

  return NextResponse.json({ url: link.url });
}
