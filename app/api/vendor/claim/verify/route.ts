import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Finish a "Claim Your Business" attempt.
 *
 * Checks the one-time code(s) from /api/vendor/claim/start. When the caller is
 * signed in, a correct code hands them ownership of the provider so they can
 * edit the listing straight away; when they're not, the claim is marked
 * verified and completes as soon as they sign in and re-post with their token.
 *
 * Body: { claim_id, email_code, phone_code? }
 */

const MAX_ATTEMPTS = 6;
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

export async function POST(request: Request) {
  const {
    claim_id: claimId,
    email_code: emailCode,
    phone_code: phoneCode,
  } = (await request.json().catch(() => ({}))) as {
    claim_id?: string;
    email_code?: string;
    phone_code?: string;
  };

  if (!claimId || !emailCode) {
    return NextResponse.json({ error: 'Enter the code we emailed you' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: claim } = await admin
    .from('provider_claims')
    .select('id, provider_id, email_code_hash, phone_code_hash, expires_at, attempts, status')
    .eq('id', claimId)
    .maybeSingle();

  if (!claim) return NextResponse.json({ error: 'Verification not found' }, { status: 404 });
  if (claim.status === 'approved') {
    return NextResponse.json({ error: 'This business has already been claimed' }, { status: 409 });
  }
  if (new Date(claim.expires_at) < new Date()) {
    return NextResponse.json({ error: 'That code has expired — please request a new one.' }, { status: 410 });
  }
  if (claim.attempts >= MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: 'Too many attempts. Request a new code, or email hello@babybrain.sg.' },
      { status: 429 }
    );
  }

  const emailOk = claim.email_code_hash === hash(emailCode.trim());
  // The phone code is only checked when one was actually issued and supplied.
  const phoneOk = !claim.phone_code_hash || !phoneCode
    ? null
    : claim.phone_code_hash === hash(phoneCode.trim());

  if (!emailOk || phoneOk === false) {
    await admin
      .from('provider_claims')
      .update({ attempts: claim.attempts + 1 })
      .eq('id', claim.id);
    return NextResponse.json({ error: "That code doesn't match. Please check and try again." }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { user } = await getAuthedContext(request);

  await admin
    .from('provider_claims')
    .update({
      email_verified_at: now,
      phone_verified_at: phoneOk ? now : null,
      status: user ? 'approved' : 'verified',
      claimed_by: user?.id ?? null,
    })
    .eq('id', claim.id);

  if (!user) {
    // Verified, but we can't attach an owner yet. The vendor signs up / logs in
    // and the page re-posts with their token to finish.
    return NextResponse.json({
      verified: true,
      claimed: false,
      next: 'sign_in',
      provider_id: claim.provider_id,
    });
  }

  // Hand over ownership. `on conflict do nothing` keeps a retry harmless.
  await admin
    .from('provider_members')
    .upsert(
      { provider_id: claim.provider_id, user_id: user.id, role: 'owner', status: 'active' },
      { onConflict: 'provider_id,user_id' }
    );

  await admin
    .from('providers')
    .update({
      is_claimed: true,
      owner_id: user.id,
      verification_status: 'verified',
      status: 'active',
    })
    .eq('id', claim.provider_id);

  return NextResponse.json({ verified: true, claimed: true, provider_id: claim.provider_id });
}
