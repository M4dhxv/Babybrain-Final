import { NextResponse } from 'next/server';

/**
 * Public: whether a provider's current plan includes parent messaging.
 *
 * Messaging is available on every tier, including Pay As You Grow (see
 * PLAN_META in the vendor app's lib/plans.ts and the "Messaging is available
 * on every tier" comment in frontends/vendor/src/layouts/PortalLayout.tsx) —
 * it used to be a Growth-and-above perk, and this endpoint still enforced
 * that old rule after messaging was opened up to every plan, which is why a
 * Pay As You Grow vendor's "Chat with provider" button stayed disabled on
 * the parent app even after the vendor had it enabled.
 *
 * Kept as an endpoint (rather than inlined as `true` on the parent side) so
 * a future per-provider messaging toggle has one place to land.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get('providerId');
  if (!providerId) return NextResponse.json({ error: 'providerId required' }, { status: 400 });

  return NextResponse.json(
    { canMessage: true },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } }
  );
}
