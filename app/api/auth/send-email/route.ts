import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { renderEmail } from '@/lib/emails/render';

/**
 * Supabase "Send Email" auth hook — sends confirmation, password-reset and
 * other auth emails through Resend using BabyBrain's own branded templates.
 *
 * QA: "Confirmation e-mail comes from Supabase and is not branded" and
 * "Reset password e-mail needs to be BabyBrain branded".
 *
 * Enable it once in the Supabase dashboard:
 *   Authentication → Hooks → Send Email Hook
 *     URI:    https://<your-domain>/api/auth/send-email
 *     Secret: generate one, then set it as AUTH_EMAIL_HOOK_SECRET here
 * With the hook on, Supabase stops sending its own default templates.
 *
 * Requests are signed with the Standard Webhooks scheme, verified below.
 */

const ACTION_TEMPLATES: Record<string, string> = {
  signup: 'auth_confirm_signup',
  recovery: 'auth_recovery',
  magiclink: 'auth_magic_link',
  invite: 'auth_invite',
  email_change: 'auth_email_change',
  email_change_current: 'auth_email_change',
  email_change_new: 'auth_email_change',
};

interface HookPayload {
  user: { email?: string; user_metadata?: { full_name?: string }; new_email?: string };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: string;
  };
}

/** Standard Webhooks signature check (the scheme Supabase auth hooks use). */
function verify(secretRaw: string, headers: Headers, body: string): boolean {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatureHeader = headers.get('webhook-signature');
  if (!id || !timestamp || !signatureHeader) return false;

  // Reject anything more than five minutes old, to blunt replays.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const secret = Buffer.from(secretRaw.replace(/^v1,?whsec_/, '').replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');

  // The header carries one or more space-separated `v1,<sig>` pairs.
  return signatureHeader.split(' ').some((part) => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export async function POST(request: Request) {
  const secret = process.env.AUTH_EMAIL_HOOK_SECRET;
  if (!secret) {
    // Not configured: tell Supabase to fall back to its own delivery rather
    // than silently dropping somebody's confirmation email.
    return NextResponse.json({ error: 'Auth email hook not configured' }, { status: 501 });
  }

  const body = await request.text();
  if (!verify(secret, request.headers, body)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(body) as HookPayload;
  } catch {
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }

  const { user, email_data: data } = payload;
  const to = data.email_action_type === 'email_change_new' ? user.new_email : user.email;
  if (!to) return NextResponse.json({ error: 'No recipient' }, { status: 400 });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://babybrain.sg';
  const templateKey = ACTION_TEMPLATES[data.email_action_type];
  if (!templateKey) {
    // Unknown action: let Supabase handle it rather than sending nothing.
    return NextResponse.json({ error: `Unhandled action ${data.email_action_type}` }, { status: 501 });
  }

  // Supabase gives us the raw token; the verify endpoint turns it into a
  // session and forwards to redirect_to.
  const actionUrl =
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/verify` +
    `?token=${encodeURIComponent(data.token_hash)}` +
    `&type=${encodeURIComponent(data.email_action_type)}` +
    `&redirect_to=${encodeURIComponent(data.redirect_to || `${appUrl}/auth/callback?next=/profile`)}`;

  const email = renderEmail(
    templateKey,
    { action_url: actionUrl, token: data.token, new_email: user.new_email },
    { appUrl, recipientName: user.user_metadata?.full_name ?? null }
  );
  if (!email) {
    return NextResponse.json({ error: 'No template' }, { status: 500 });
  }

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: 'Resend not configured' }, { status: 501 });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'Katie from BabyBrain <hello@babybrain.sg>',
    replyTo: 'hello@babybrain.sg',
    to,
    subject: email.subject,
    html: email.html,
  });

  if (error) {
    // A non-2xx makes Supabase surface the failure instead of reporting the
    // signup as "email sent" when nothing went out.
    return NextResponse.json({ error: error.message }, { status: 502 });
  }

  return NextResponse.json({});
}
