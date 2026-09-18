import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { createAdminClient } from '@/lib/supabase/admin';
import { renderEmail, esc, type EmailData } from '@/lib/emails/render';
import { getStreamServerClient } from '@/lib/stream';
import { klaviyoEnabled, metricFor, trackEvent, upsertProfile } from '@/lib/klaviyo';

/** Chat reply emails wait this long and are dropped if the message was read. */
const CHAT_TYPES = new Set(['provider_message', 'provider_message_response']);
const CHAT_EMAIL_DELAY_MS = 8 * 60 * 60 * 1000;

async function chatMessageRead(channelId: unknown, userId: string, sentAt: Date): Promise<boolean> {
  if (typeof channelId !== 'string') return false;
  try {
    const state = await getStreamServerClient().channel('messaging', channelId).query({ state: true, messages: { limit: 0 } });
    const read = state.read?.find((r) => r.user.id === userId);
    return !!read && new Date(read.last_read) >= sentAt;
  } catch {
    return false;
  }
}

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
    .select('id, user_id, type, title, body, data, email_status, created_at')
    .eq('id', notificationId)
    .single();
  if (!notification || notification.email_status !== 'pending') {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Chat replies: hold the email until the message has sat unread for 8h.
  // Left 'pending' while waiting; the hourly send_pending_chat_emails() cron
  // re-posts them here once they're old enough.
  if (CHAT_TYPES.has(notification.type)) {
    const sentAt = new Date(notification.created_at);
    if (Date.now() - sentAt.getTime() < CHAT_EMAIL_DELAY_MS) {
      return NextResponse.json({ ok: true, deferred: true });
    }
    const chatData = (notification.data ?? {}) as EmailData;
    if (await chatMessageRead(chatData.channel_id, notification.user_id, sentAt)) {
      await admin.from('notifications').update({ email_status: 'skipped' }).eq('id', notificationId);
      return NextResponse.json({ ok: true, skipped: true });
    }
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

  // Everything from here on can throw (a bad template, Resend rejecting the
  // request) — without the try/catch that used to leave the row uncaught,
  // email_status stayed 'pending' forever with no record of why, since the
  // update below never ran. Always land on 'sent' or 'failed'.
  let sendError: unknown = null;
  let subject = notification.title;
  let html = '';
  try {
    // Branded template for this type, or a safe generic fallback.
    const rendered = renderEmail(notification.type, data, { appUrl, recipientName: name });
    subject = rendered?.subject ?? notification.title;
    // The generic fallback (used for any notification type without a branded
    // template, e.g. provider_message) interpolates title/body/url that can be
    // user-controlled — chat text most notably — so every field is HTML-escaped
    // to prevent HTML/script injection into the delivered email.
    html =
      rendered?.html ??
      `<div style="font-family:'Fredoka','Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;color:#767676;font-size:18px">
        <h2 style="color:#4a4a4a">${esc(notification.title)}</h2>
        <p>${esc(notification.body)}</p>
        <p><a href="${esc(appUrl)}${typeof data.url === 'string' ? esc(data.url) : ''}" style="color:#FA5D93">Open BabyBrain</a></p>
      </div>`;

    const resend = new Resend(process.env.RESEND_API_KEY!);
    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'Katie from BabyBrain <hello@updates.babybrain.sg>',
      replyTo: 'hello@babybrain.sg',
      to: email,
      subject,
      html,
    });
    sendError = error;
  } catch (err) {
    sendError = err;
  }

  if (sendError) {
    console.error(`[notifications webhook] send failed for ${notification.type} (${notificationId}):`, sendError);
  }

  await admin
    .from('notifications')
    .update({ email_status: sendError ? 'failed' : 'sent' })
    .eq('id', notificationId);

  // Mirror the event into Klaviyo so the marketing flows have something to
  // trigger on. No-ops unless KLAVIYO_API_KEY is set, and never blocks the
  // transactional send above.
  const metric = metricFor(notification.type);
  if (metric && klaviyoEnabled()) {
    await upsertProfile({ email, firstName: name, properties: { babybrain_user_id: notification.user_id } });
    await trackEvent({
      metric,
      email,
      name,
      properties: { notification_type: notification.type, title: notification.title, ...data },
    });
  }

  return NextResponse.json({ ok: !sendError });
}
