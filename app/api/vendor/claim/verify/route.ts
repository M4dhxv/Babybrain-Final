import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Finish a "Claim Your Business" attempt.
 *
 * Checks the one-time code(s) from /api/vendor/claim/start. When the caller is
 * signed in, a correct code hands them ownership of the provider so they can
 * edit the listing straight away.
 *
 * QA 21/08: "once you enter the verification code it takes you to log in but no
 * password has been set — flow doesn't work." A vendor claiming a business has
 * no account yet, and the portal has no sign-up form at all, so verifying the
 * code dropped them on a login page they could never get past. A signed-out
 * caller can now send a `password` along with the code and gets an account
 * created for the address the code was sent to, then owns the provider.
 *
 * The account is created already-confirmed: the emailed code has just proved
 * the person controls that mailbox, which is the same thing the confirmation
 * link exists to prove. It is only ever created for `claim.contact_email` —
 * never an address supplied in this request — and never for an email that
 * already has an account, so this cannot be used to set someone else's
 * password.
 *
 * Body: { claim_id, email_code, phone_code?, password? }
 */

const MAX_ATTEMPTS = 6;
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

export async function POST(request: Request) {
  const {
    claim_id: claimId,
    email_code: emailCode,
    phone_code: phoneCode,
    password,
  } = (await request.json().catch(() => ({}))) as {
    claim_id?: string;
    email_code?: string;
    phone_code?: string;
    password?: string;
  };

  if (!claimId || !emailCode) {
    return NextResponse.json({ error: 'Enter the code we emailed you' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: claim } = await admin
    .from('provider_claims')
    .select('id, provider_id, contact_email, email_code_hash, phone_code_hash, expires_at, attempts, status')
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
  const { user: signedInUser } = await getAuthedContext(request);
  let user = signedInUser;

  /* Signed out: the code is right, so create the login they need. Without this
     the flow ended on a sign-in page for an account that did not exist. */
  let createdAccount = false;
  if (!user && password) {
    if (password.length < 8) {
      return NextResponse.json({ error: 'Choose a password of at least 8 characters.' }, { status: 400 });
    }
    const email = claim.contact_email;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // the emailed code already proved they hold this address
      user_metadata: { claimed_provider_id: claim.provider_id },
    });
    if (createError || !created?.user) {
      // Overwhelmingly the "already registered" case. Never touch an existing
      // account's password — send them to sign in, and the signed-in branch
      // below finishes the claim on their next post.
      await admin
        .from('provider_claims')
        .update({ email_verified_at: now, phone_verified_at: phoneOk ? now : null, status: 'verified' })
        .eq('id', claim.id);
      return NextResponse.json({
        verified: true,
        claimed: false,
        next: 'sign_in',
        email,
        error: 'You already have a BabyBrain login for this email — sign in and we’ll finish the claim.',
      }, { status: 409 });
    }
    user = created.user;
    createdAccount = true;
  }

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
    // Verified but no password supplied — the page asks for one and re-posts.
    return NextResponse.json({
      verified: true,
      claimed: false,
      next: 'set_password',
      email: claim.contact_email,
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

  return NextResponse.json({
    verified: true,
    claimed: true,
    provider_id: claim.provider_id,
    // The page signs in with the credentials it just set, so it needs to know
    // an account was created rather than reused.
    account_created: createdAccount,
    email: claim.contact_email,
  });
}
