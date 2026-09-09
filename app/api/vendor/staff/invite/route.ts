import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { appOrigin, vendorPageUrl } from '@/lib/cors';
import type { ProviderRole } from '@/types/database';
import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Find an auth user by email. `listUsers()` is paged (50/page by default), so a
 * single call silently misses anyone past the first page on a busy project —
 * page through until we find them or run out.
 */
async function findUserByEmail(
  admin: SupabaseClient,
  email: string
): Promise<User | undefined> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data.users.length) return undefined;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 1000) return undefined;
  }
  return undefined;
}

/**
 * Owner invites a staff member. Owner-only.
 *
 * - Invitee already has a BabyBrain login  → linked immediately as an active
 *   member. If they've never signed in, they also get a set-password link.
 * - Invitee has no account                → we create the auth user up front
 *   (email pre-confirmed, no password) and link the membership, then email a
 *   one-time link that lands them on the portal's set-password screen. No
 *   password is ever generated or sent; the invitee picks their own.
 *
 * The old flow left a pending `provider_invites` row and told the person to
 * "sign up" — but the portal has no sign-up form, so a brand-new invitee had
 * no working path in. Creating the user here removes that dead end.
 *
 * Body: { provider_id: string, email: string, role: 'manager' | 'staff' }
 */
export async function POST(request: Request) {
  const {
    provider_id: providerId,
    email,
    role = 'staff',
  } = (await request.json()) as { provider_id?: string; email?: string; role?: ProviderRole };

  if (!providerId || !email) {
    return NextResponse.json({ error: 'provider_id and email required' }, { status: 400 });
  }
  if (role !== 'manager' && role !== 'staff') {
    return NextResponse.json({ error: 'role must be manager or staff' }, { status: 400 });
  }

  const auth = await requireProviderRole(request, providerId, 'owner');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const normalized = email.toLowerCase();

  let member = await findUserByEmail(admin, normalized);
  const alreadyHadAccount = Boolean(member);

  if (!member) {
    // No login yet — create one now so the membership can be linked and the
    // invitee has a real account to set a password on. Email is pre-confirmed
    // because the owner vouched for the address; no password is set.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: normalized,
      email_confirm: true,
    });
    // Lost a race with a concurrent signup/invite — fall back to linking the
    // now-existing user rather than failing the invite.
    const alreadyRegistered =
      createError?.code === 'email_exists' ||
      createError?.code === 'user_already_exists' ||
      /already.*(registered|exists)/i.test(createError?.message ?? '');
    if (createError && alreadyRegistered) {
      member = await findUserByEmail(admin, normalized);
    } else if (createError || !created?.user) {
      return NextResponse.json(
        { error: 'Could not create the invitee’s login — please try again.' },
        { status: 502 }
      );
    } else {
      member = created.user;
    }
  }

  if (!member) {
    return NextResponse.json({ error: 'Could not resolve the invitee account' }, { status: 502 });
  }

  // Never let an invite DOWNGRADE an existing owner. The upsert below replaces
  // `role` on conflict, so inviting an address that already owns this business
  // (the owner's own address, or a co-owner) as manager/staff would strip
  // ownership — and there's no re-promote path, so the business could be left
  // with no owner. Leave an existing owner's row untouched and say so.
  const { data: existing } = await admin
    .from('provider_members')
    .select('role, status')
    .eq('provider_id', providerId)
    .eq('user_id', member.id)
    .maybeSingle();
  if (existing?.role === 'owner') {
    return NextResponse.json(
      { error: 'That person already owns this business — they can’t be re-added as staff.' },
      { status: 409 }
    );
  }

  const { error: upsertError } = await admin.from('provider_members').upsert(
    { provider_id: providerId, user_id: member.id, role, status: 'active', invited_email: normalized },
    { onConflict: 'provider_id,user_id' }
  );
  if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 400 });

  // Anyone who has never signed in needs a way to set a password: a freshly
  // created invitee, or a pre-existing account that was only ever a shell.
  const needsPassword = !member.last_sign_in_at;
  let setPasswordUrl: string | null = null;
  if (needsPassword) {
    // Mirror the portal's own forgot-password redirect: land on the SPA root
    // so supabase-js picks up the recovery hash and RecoveryRedirect forwards
    // to /reset-password. A pre-hashed URL would collide with that token hash.
    const { data: linkData } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: normalized,
      options: { redirectTo: `${appOrigin(request)}/vendor/` },
    });
    setPasswordUrl = linkData?.properties?.action_link ?? null;
  }

  const { data: provider } = await admin
    .from('providers')
    .select('business_name')
    .eq('id', providerId)
    .single();
  const businessName = provider?.business_name ?? 'a business';
  // The portal is a HashRouter SPA under /vendor/, so its login route is
  // /vendor/#/login — a bare /vendor/login has no rewrite and lands on
  // Vercel's own 404, not the sign-in page.
  const signInUrl = vendorPageUrl(request, '/login');

  const cta = setPasswordUrl
    ? `<p><a href="${setPasswordUrl}">Set your password</a> to activate your account, then sign in at
         <a href="${signInUrl}">the vendor portal</a>.</p>
       <p style="color:#6b7280;font-size:12px">This link expires in 24 hours. If it lapses, use
         &ldquo;Forgot password?&rdquo; on the sign-in page with this email address.</p>`
    : `<p><a href="${signInUrl}">Sign in</a> with this email to access the dashboard.</p>`;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY!);
    await resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'BabyBrain <hello@updates.babybrain.sg>',
      to: email,
      subject: `You've been invited to ${businessName} on BabyBrain`,
      html: `<div style="font-family:sans-serif">
        <h2>You're invited as ${role}</h2>
        <p>${businessName} added you to their BabyBrain vendor account.</p>
        ${cta}
      </div>`,
    });
  } catch {
    /* email best-effort */
  }

  return NextResponse.json({
    ok: true,
    linked: true,
    account_created: !alreadyHadAccount,
    set_password_email_sent: Boolean(setPasswordUrl),
  });
}
