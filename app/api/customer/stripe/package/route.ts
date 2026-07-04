import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { appOrigin } from '@/lib/cors';

/**
 * Parent buys a class package (multi-session pack). One-off Stripe Checkout;
 * the webhook (kind='package') creates the package_purchases row with credits.
 * Body: { package_id: string }
 */
export async function POST(request: Request) {
  const { package_id: packageId } = (await request.json().catch(() => ({}))) as { package_id?: string };
  if (!packageId) {
    return NextResponse.json({ error: 'package_id required' }, { status: 400 });
  }

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  const { data: pkg } = await admin
    .from('packages')
    .select('id, name, credits, price_cents, active')
    .eq('id', packageId)
    .maybeSingle();
  if (!pkg || !pkg.active) {
    return NextResponse.json({ error: 'Package not available' }, { status: 404 });
  }

  const origin = appOrigin(request);
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'sgd',
          unit_amount: pkg.price_cents,
          product_data: { name: `${pkg.name} (${pkg.credits} classes)` },
        },
        quantity: 1,
      },
    ],
    metadata: { kind: 'package', user_id: user.id, package_id: pkg.id },
    success_url: `${origin}/profile?tab=packages&purchase=success`,
    cancel_url: `${origin}/profile?tab=packages&purchase=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
