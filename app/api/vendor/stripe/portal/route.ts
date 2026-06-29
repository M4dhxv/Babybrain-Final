import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';

/**
 * Stripe Billing Portal link (manage/cancel subscription, invoices, card).
 * Owner-only. Body: { provider_id: string }
 */
export async function POST(request: Request) {
  const { provider_id: providerId } = (await request.json()) as { provider_id?: string };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  const auth = await requireProviderRole(providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('provider_id', providerId)
    .maybeSingle();
  if (!sub?.stripe_customer_id) {
    return NextResponse.json({ error: 'No billing account yet' }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const portal = await getStripe().billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${appUrl}/vendor/billing`,
  });
  return NextResponse.json({ url: portal.url });
}
