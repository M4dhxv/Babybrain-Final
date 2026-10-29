import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { createAdminClient } from '@/lib/supabase/admin';
import { sessionWordingTitle, sessionWordingBody } from '@/lib/notification-wording';
import { renderEmail, esc, type EmailData } from '@/lib/emails/render';
import { getStreamServerClient } from '@/lib/stream';
import { sendPushToUser } from '@/lib/push';
import { pushExtras } from '@/lib/push-images';
import { isSitePath, pushLink } from '@/lib/notification-links';

/** Chat reply emails wait this long and are dropped if the message was read. */
const CHAT_TYPES = new Set(['provider_message', 'provider_message_response', 'class_group_message', 'provider_class_group_message']);
const CHAT_EMAIL_DELAY_MS = 4 * 60 * 60 * 1000; // keep in step with send_pending_chat_emails() (00190)

/** Promotional flows (digests/nudges the parent didn't trigger by doing
 *  something). These go only to parents with marketing consent
 *  (parent_profiles.marketing_consent_at, cleared on unsubscribe) — consent is
 *  optional at sign-up, so everything else here is transactional and unaffected.
 *  Mirrors the PDPA rule noted in OnboardingPage. */
const MARKETING_TYPES = new Set(['suggested_activities', 'upgrade_nudge', 'providers_added', 'package_rebook']);

/** Never pushed to a device (email only): the promotional flows above, plus the
 *  re-engagement nudges ("you were missed", a vendor's "your schedule is light"
 *  and "trial ending"), which are prompts rather than news about a booking.
 *  Exception: suggested_activities is pushed too (Aman, 2026-10-21), with its own
 *  switch (push_suggestions, 00245) and still only to consented parents (above). */
const NO_PUSH_TYPES = new Set(
  [...MARKETING_TYPES, 'missed_activity', 'provider_add_activities', 'trial_ending'].filter((t) => t !== 'suggested_activities')
);

/** Quiet hours (Singapore): reminders and review requests are not pushed between 22:00 and 07:00. */
const QUIET_PUSH_TYPES = new Set(['booking_reminder', 'class_followup']);
const isQuietHourSgt = (): boolean => {
  const h = (new Date().getUTCHours() + 8) % 24;
  return h < 7 || h >= 22;
};

/** Which push preference (notification_preferences, 00236) a notification type falls under. */
const MESSAGE_TYPES = new Set([...CHAT_TYPES, 'support_message']);
const REMINDER_TYPES = new Set(['booking_reminder', 'booking_starting_soon', 'class_followup']);
const pushPrefColumn = (type: string): 'push_messages' | 'push_reminders' | 'push_bookings' | 'push_suggestions' =>
  MESSAGE_TYPES.has(type) ? 'push_messages'
    : REMINDER_TYPES.has(type) ? 'push_reminders'
    : type === 'suggested_activities' ? 'push_suggestions'
    : 'push_bookings';

/** The one button under a push where the device supports them. Tapping it opens the same page. */
function pushActions(type: string): { action: string; title: string }[] | undefined {
  if (MESSAGE_TYPES.has(type)) return [{ action: 'open', title: 'Open chat' }];
  if (type === 'suggested_activities') return [{ action: 'open', title: 'See suggestions' }];
  if (type === 'waitlist_available') return [{ action: 'open', title: 'Claim your spot' }];
  if (type === 'term_waitlist_place_open' || type === 'term_waitlist_offer' || type === 'term_next_open') return [{ action: 'open', title: 'Enrol now' }];
  if (type === 'provider_term_waitlist_joined') return [{ action: 'open', title: 'View waitlist' }];
  if (type === 'provider_waitlist_joined') return [{ action: 'open', title: 'View waitlist' }];
  if (type.startsWith('booking_') || type === 'session_rescheduled' || type === 'class_cancelled' || type === 'provider_booking_received') {
    return [{ action: 'open', title: 'View booking' }];
  }
  return undefined;
}

/** Why a push should not be sent right now (preference off, quiet hours), or null to send it.
 *  A failed preference lookup (table not migrated yet, a hiccup) never blocks a push. */
async function pushSkipReason(db: SupabaseClient, userId: string, type: string): Promise<string | null> {
  if (QUIET_PUSH_TYPES.has(type) && isQuietHourSgt()) return 'quiet hours';
  const column = pushPrefColumn(type);
  const { data } = await db.from('notification_preferences').select(column).eq('user_id', userId).maybeSingle();
  if (data && (data as unknown as Record<string, unknown>)[column] === false) return 'turned off by the user';
  return null;
}

/** A notification's `url` as a path on this site, or nothing. It is appended
 *  straight to the app's origin, so anything not starting with a single "/"
 *  ("@evil.example", "//evil.example", ".evil.example") would turn the link
 *  into another host. */
const sitePath = (url: unknown): string => (isSitePath(url) ? esc(url) : '');

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
    .select('id, user_id, type, title, body, data, email_status, push_status, created_at')
    .eq('id', notificationId)
    .single();
  // Email and push have their own status. A push-only notification (email 'skipped', e.g. the
  // "starting soon" reminder) still has to be pushed.
  if (!notification || (notification.email_status !== 'pending' && notification.push_status !== 'pending')) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Marketing flows: consented parents only, for email and push alike. Checked
  // here, before anything is sent, so a withdrawal always wins even for a
  // notification that was queued earlier.
  if (MARKETING_TYPES.has(notification.type)) {
    const { data: consent } = await admin
      .from('parent_profiles')
      .select('marketing_consent_at')
      .eq('id', notification.user_id)
      .maybeSingle();
    if (!consent?.marketing_consent_at) {
      await admin.from('notifications').update({ email_status: 'skipped', push_status: 'skipped' }).eq('id', notificationId);
      return NextResponse.json({ ok: true, skipped: true, reason: 'no marketing consent' });
    }
  }

  // Push goes out on this first call, ahead of the chat-email-delay logic
  // below — unlike email, push shouldn't wait 4h. push_status guards against
  // the delayed chat re-post (below) sending it a second time.
  if (notification.push_status === 'pending' && NO_PUSH_TYPES.has(notification.type)) {
    // Promotional types are email-only: a buzz on the phone is a bigger ask
    // than marketing-email consent covers.
    await admin.from('notifications').update({ push_status: 'skipped' }).eq('id', notificationId);
  } else if (notification.push_status === 'pending') {
    const pushData = (typeof notification.data === 'object' && notification.data !== null ? notification.data : {}) as EmailData;
    const skipReason = await pushSkipReason(admin as unknown as SupabaseClient, notification.user_id, notification.type);
    if (skipReason) {
      await admin.from('notifications').update({ push_status: 'skipped' }).eq('id', notificationId);
    } else {
      const channelId = typeof pushData.channel_id === 'string' ? pushData.channel_id : null;
      // A vendor's "booking received" opens that session's roster, which needs the session id.
      let sessionId: string | null = null;
      if (notification.type === 'provider_booking_received' && typeof pushData.booking_id === 'string') {
        const { data: bk } = await admin.from('bookings').select('session_id').eq('id', pushData.booking_id).maybeSingle();
        sessionId = bk?.session_id ?? null;
      }
      const pushResult = await sendPushToUser(notification.user_id, {
        title: sessionWordingTitle(notification.title),
        body: sessionWordingBody(notification.body),
        url: pushLink(notification.type, pushData, { sessionId }),
        // One entry per conversation, so a burst of replies doesn't stack up.
        tag: CHAT_TYPES.has(notification.type) && channelId ? `chat-${channelId}` : undefined,
        actions: pushActions(notification.type),
        // Photo, and for suggestions a title naming the top pick (never blocks the push).
        ...(await pushExtras(admin as unknown as SupabaseClient, notification.type, pushData).catch(() => ({}))),
      });
      // 'sent' only when a device actually accepted it, so push_status can be
      // trusted: no devices / VAPID unset → 'skipped', every device rejected → 'failed'.
      const pushStatus = pushResult.outcome === 'sent' ? 'sent' : pushResult.outcome === 'failed' ? 'failed' : 'skipped';
      await admin.from('notifications').update({ push_status: pushStatus }).eq('id', notificationId);
    }
  }

  // Push-only notification (no email to send): done.
  if (notification.email_status !== 'pending') {
    return NextResponse.json({ ok: true, pushOnly: true });
  }

  // Chat replies: hold the email until the message has sat unread for 4h.
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

  // babybrain.sg is a "coming soon" placeholder, not the deployed app — see
  // scripts/setup-stripe-portal.mjs. Falls back to the known-working host.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://babybrain-final.vercel.app';
  const data = (typeof notification.data === 'object' && notification.data !== null ? notification.data : {}) as EmailData;

  // The booking-confirmed email carries an "Add to calendar" button. The
  // notification payload has the display strings but not the session's real
  // start/end, so look them up; if that fails the email simply omits the button.
  if (notification.type === 'booking_confirmed' && typeof data.booking_id === 'string') {
    const { data: b } = await admin
      .from('bookings')
      .select('activity_sessions(starts_at, ends_at)')
      .eq('id', data.booking_id)
      .maybeSingle();
    const sess = (b as { activity_sessions?: { starts_at?: string; ends_at?: string } | null } | null)?.activity_sessions;
    if (sess?.starts_at) {
      data.starts_at = sess.starts_at;
      data.ends_at = sess.ends_at;
    }
  }

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
    subject = rendered?.subject ?? sessionWordingTitle(notification.title);
    // The generic fallback (used for any notification type without a branded
    // template, e.g. provider_message) interpolates title/body/url that can be
    // user-controlled — chat text most notably — so every field is HTML-escaped
    // to prevent HTML/script injection into the delivered email.
    html =
      rendered?.html ??
      `<div style="font-family:'Fredoka','Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;color:#767676;font-size:18px">
        <h2 style="color:#4a4a4a">${esc(sessionWordingTitle(notification.title))}</h2>
        <p>${esc(sessionWordingBody(notification.body))}</p>
        <p><a href="${esc(appUrl)}${sitePath(data.url)}" style="color:#FA5D93">Open BabyBrain</a></p>
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

  // Klaviyo is managed by hand (decided 29 Sep): nothing is mirrored to it
  // from here. Katie exports consenting parents from /admin → Marketing.

  return NextResponse.json({ ok: !sendError });
}
