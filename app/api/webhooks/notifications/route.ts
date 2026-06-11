import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Called by the on_notification_created pg_net trigger for every new
 * notification row. Sends the email via Resend and records the outcome.
 * Idempotent: only acts while email_status = 'pending'.
 */
export async function POST(request: Request) {
  if (
    request.headers.get('x-webhook-secret') !== process.env.WEBHOOK_SHARED_SECRET
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { notification_id: notificationId } = (await request.json()) as {
    notification_id?: string;
  };
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

  const { data: profile } = await admin
    .from('parent_profiles')
    .select('email, full_name')
    .eq('id', notification.user_id)
    .single();
  if (!profile?.email) {
    await admin
      .from('notifications')
      .update({ email_status: 'skipped' })
      .eq('id', notificationId);
    return NextResponse.json({ ok: true, skipped: true });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const link =
    typeof notification.data === 'object' &&
    notification.data !== null &&
    'url' in notification.data
      ? `${appUrl}${(notification.data as { url: string }).url}`
      : appUrl;

  const resend = new Resend(process.env.RESEND_API_KEY!);
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'BabyBrain <onboarding@resend.dev>',
    to: profile.email,
    subject: notification.title,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#15224b">${notification.title}</h2>
        <p style="color:#5d6b8f;font-size:16px">${notification.body}</p>
        <p><a href="${link}" style="background:#2f7fe8;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Open BabyBrain</a></p>
      </div>`,
  });

  await admin
    .from('notifications')
    .update({ email_status: error ? 'failed' : 'sent' })
    .eq('id', notificationId);

  return NextResponse.json({ ok: !error });
}
