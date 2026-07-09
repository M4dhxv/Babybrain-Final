import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { createAdminClient } from '@/lib/supabase/admin';
import { renderEmail, type EmailData } from '@/lib/emails/render';

/**
 * Called by the on_notification_created pg_net trigger for every new
 * notification row. Renders the branded BabyBrain email for the notification's
 * `type` (see lib/emails/render) and sends it via Resend, recording the outcome.
 * Idempotent: only acts while email_status = 'pending'.
 */
export async function POST(request: Request) {
  if (request.headers.get('x-webhook-secret') !== process.env.WEBHOOK_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { notification_id: notificationId } = (await request.json()) as { notification_id?: string };
  if (!notificationId) {
    return NextResponse.json({ error: 'notification_id required' }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: notification } = await admin
    .from('notifications')
    .select('id, user_id, type, title, body, data, email_status')
    .eq('id', notificationId)
    .single();
  if (!notification || notification.email_status !== 'pending') {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Resolve the recipient. Parents live in parent_profiles; providers (and any
  // other auth user) are looked up via the auth admin API.
  const { data: profile } = await admin
    .from('parent_profiles')
    .select('email, full_name')
    .eq('id', notification.user_id)
    .maybeSingle();

  let email = profile?.email ?? null;
  let name: string | null = profile?.full_name ?? null;
  if (!email) {
    const { data: authUser } = await admin.auth.admin.getUserById(notification.user_id);
    email = authUser.user?.email ?? null;
    name = name ?? (authUser.user?.user_metadata?.full_name as string | undefined) ?? null;
  }
  if (!email) {
    await admin.from('notifications').update({ email_status: 'skipped' }).eq('id', notificationId);
    return NextResponse.json({ ok: true, skipped: true });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const data = (typeof notification.data === 'object' && notification.data !== null ? notification.data : {}) as EmailData;

  // Branded template for this type, or a safe generic fallback.
  const rendered = renderEmail(notification.type, data, { appUrl, recipientName: name });
  const subject = rendered?.subject ?? notification.title;
  const html =
    rendered?.html ??
    `<div style="font-family:'Fredoka','Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;color:#767676;font-size:18px">
      <h2 style="color:#4a4a4a">${notification.title}</h2>
      <p>${notification.body}</p>
      <p><a href="${appUrl}${typeof data.url === 'string' ? data.url : ''}" style="color:#FA5D93">Open BabyBrain</a></p>
    </div>`;

  const resend = new Resend(process.env.RESEND_API_KEY!);
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'Katie from BabyBrain <hello@babybrain.sg>',
    replyTo: 'hello@babybrain.sg',
    to: email,
    subject,
    html,
  });

  await admin
    .from('notifications')
    .update({ email_status: error ? 'failed' : 'sent' })
    .eq('id', notificationId);

  return NextResponse.json({ ok: !error });
}
