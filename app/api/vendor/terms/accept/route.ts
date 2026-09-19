import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';

/**
 * Owner accepts the vendor Terms & Conditions / Privacy Policy on behalf of
 * the business, gating the onboarding screen the portal shows a freshly
 * invited owner (see frontends/vendor/src/components/OnboardingGate.tsx).
 *
 * Mirrors the consent write in /api/vendor/claim/verify — same two columns,
 * same "only write true, never unset" shape — but reachable for an owner
 * account that was created directly (staff-invite-style sign-in link) rather
 * than through Claim Your Business, which never ran this step.
 *
 * Body: { provider_id: string, marketing_consent?: boolean }
 */
export async function POST(request: Request) {
  const { provider_id: providerId, marketing_consent: marketingConsent } = (await request.json().catch(() => ({}))) as {
    provider_id?: string;
    marketing_consent?: boolean;
  };

  if (!providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }

  // Only the owner can accept on behalf of the business — same bar as
  // inviting/removing staff.
  const auth = await requireProviderRole(request, providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { error } = await admin
    .from('providers')
    .update({
      vendor_terms_accepted_at: now,
      ...(typeof marketingConsent === 'boolean' ? { marketing_consent_at: marketingConsent ? now : null } : {}),
    })
    .eq('id', providerId);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
