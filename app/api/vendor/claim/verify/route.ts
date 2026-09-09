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
 * When that email DOES already have a login, we don't touch it: the response
 * says `next: 'sign_in'`, the page signs the owner in, and re-posts this route
 * with the session (no password) — the signed-in branch then finishes the
 * claim. That second post is the same path a manually-signed-in vendor takes.
 *
 * Body: { claim_id, email_code, phone_code?, password?, terms_accepted?, marketing_consent? }
 *
 * `terms_accepted` / `marketing_consent` ride along only on the set-password
 * pass (a brand-new claimer). They are recorded on the provider as ownership is
 * handed over, so /save-listing can show the same two checkboxes already
 * ticked. Terms is enforced in the UI; the server still only writes the
 * acceptance timestamp when it actually arrives true.
 */

const MAX_ATTEMPTS = 6;
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

export async function POST(request: Request) {
  const {
    claim_id: claimId,
    email_code: emailCode,
    phone_code: phoneCode,
    password,
    terms_accepted: termsAccepted,
    marketing_consent: marketingConsent,
  } = (await request.json().catch(() => ({}))) as {
    claim_id?: string;
    email_code?: string;
    phone_code?: string;
    password?: string;
    terms_accepted?: boolean;
    marketing_consent?: boolean;
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
  const contactEmail = claim.contact_email.trim().toLowerCase();
  const { user: signedInUser } = await getAuthedContext(request);

  /* SECURITY (layer 1 — identity binding).
     A claim is proven only by control of `claim.contact_email` — the emailed
     code. Ownership must therefore go to the account that owns THAT address,
     never to whatever session happens to ride along on the request.

     The bug this closes: a vendor already signed in as account A hits "Claim
     your listing", picks a different business, and enters a different email B.
     The code lands in inbox B, they type it — and because this route trusted
     the ambient session, business B was silently bolted onto account A as
     `owner`, with `providers.owner_id` overwritten too. Signing out didn't
     help: the membership row outlives the session, and the portal's
     single-provider lookup then surfaced the wrong business.

     A session whose email is NOT the claim's contact email is treated exactly
     like signed-out here: the claimer must set (new account) or enter
     (existing account) the password for `contact_email`, so the granted
     account is always the one that received the code. */
  const sessionMatchesClaim =
    !!signedInUser?.email && signedInUser.email.trim().toLowerCase() === contactEmail;
  let user = sessionMatchesClaim ? signedInUser : null;

  /* Signed out (or signed in as someone other than the claim's contact email):
     the code is right, so create / adopt the login for `contact_email`. Without
     this the flow ended on a sign-in page for an account that did not exist. */
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

    // The email already has a login. Never touch its password — mark the code
    // verified and tell the page to sign the owner in; their next post (with a
    // session, no password) lands in the signed-in branch and finishes the
    // claim. Returned as a normal 200 `next` step, like `set_password`.
    const alreadyRegistered =
      createError?.code === 'email_exists' ||
      createError?.code === 'user_already_exists' ||
      /already.*(registered|exists)/i.test(createError?.message ?? '');

    if (createError && alreadyRegistered) {
      await admin
        .from('provider_claims')
        .update({ email_verified_at: now, phone_verified_at: phoneOk ? now : null, status: 'verified' })
        .eq('id', claim.id);
      return NextResponse.json({ verified: true, claimed: false, next: 'sign_in', email });
    }

    if (createError || !created?.user) {
      // A real failure (not "already registered") — don't strand them on a
      // half-done claim with a misleading "sign in" nudge.
      return NextResponse.json(
        { error: 'Could not create your log-in — please try again, or email hello@babybrain.sg.' },
        { status: 502 }
      );
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
    // Verified but no usable account yet — the page collects a password (new
    // account) or the contact email's existing password, then re-posts. Note
    // this branch is also where a caller signed in as a *different* account
    // lands: `user` was deliberately cleared above so ownership can't attach
    // to the wrong identity.
    return NextResponse.json({
      verified: true,
      claimed: false,
      next: 'set_password',
      email: claim.contact_email,
      provider_id: claim.provider_id,
    });
  }

  /* SECURITY (layer 2 — no silent takeover / race).
     `start` already refuses an is_claimed provider, but a second claim can be
     finished in the window between two starts, or this route retried. Re-read
     the provider immediately before the write and refuse to move ownership
     away from an account that already holds it. The DB also enforces a single
     active owner per provider (migration 00113); this returns a readable 409
     instead of a raw constraint error. */
  const { data: current } = await admin
    .from('providers')
    .select('is_claimed, owner_id')
    .eq('id', claim.provider_id)
    .maybeSingle();
  if (current?.is_claimed && current.owner_id && current.owner_id !== user.id) {
    return NextResponse.json(
      {
        error:
          'This business has just been claimed by someone else. Email hello@babybrain.sg if that wasn’t expected.',
      },
      { status: 409 }
    );
  }

  // Hand over ownership. `on conflict do nothing` keeps a retry harmless.
  await admin
    .from('provider_members')
    .upsert(
      { provider_id: claim.provider_id, user_id: user.id, role: 'owner', status: 'active' },
      { onConflict: 'provider_id,user_id' }
    );

  /* Consent captured on the claim's set-password step. Only written when it
     actually rode along (the new-account pass) — an existing owner re-running
     verification with a session never sends these, so their prior consent is
     left untouched. Marketing follows the same NULL-means-no-consent shape the
     listing page uses. */
  const consentPatch: Record<string, string | null> = {};
  if (createdAccount && termsAccepted === true) {
    consentPatch.vendor_terms_accepted_at = now;
  }
  if (createdAccount && typeof marketingConsent === 'boolean') {
    consentPatch.marketing_consent_at = marketingConsent ? now : null;
  }

  await admin
    .from('providers')
    .update({
      is_claimed: true,
      owner_id: user.id,
      verification_status: 'verified',
      status: 'active',
      ...consentPatch,
    })
    .eq('id', claim.provider_id)
    // Belt-and-braces with the layer-2 check above: only claim a row that is
    // still unclaimed or already ours, so a lost race can't overwrite an owner.
    .or(`is_claimed.is.false,owner_id.eq.${user.id}`);

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
