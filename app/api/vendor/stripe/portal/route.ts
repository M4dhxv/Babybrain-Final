import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { vendorPageUrl } from '@/lib/cors';

/**
 * Stripe Billing Portal link (manage/cancel subscription, invoices, card).
 * Owner-only. Body: { provider_id: string }
 */
export async function POST(request: Request) {
  const { provider_id: providerId } = (await request.json()) as { provider_id?: string };
  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, providerId, 'owner');
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

  // Pin our own portal configuration when one has been set up. Stripe's
  // default configuration has `subscription_update` disabled, which is why
  // the portal offered cancel and invoices but no way to change tier
  // ("Can't downgrade anywhere", QA 23/08). Created by `npm run stripe:portal`;
  // if that hasn't been run the session still opens on Stripe's default.
  const { data: cfg } = await admin
    .from('app_config')
    .select('value')
    .eq('key', 'stripe_portal_configuration_id')
    .maybeSingle();

  const portal = await getStripe().billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    ...(cfg?.value ? { configuration: cfg.value } : {}),
    return_url: vendorPageUrl(request, '/billing'),
  });
  return NextResponse.json({ url: portal.url });
}
