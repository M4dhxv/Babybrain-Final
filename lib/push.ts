/**
 * Web Push sending, from the notifications webhook (app/api/webhooks/
 * notifications), to any device a parent has subscribed on (push_subscriptions,
 * migration 00168). Subscribing only ever happens from an installed app —
 * see frontends/parent/src/lib/push.ts — so there's nothing to gate here;
 * a user with zero rows just gets no push, silently.
 *
 * Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT to switch this on.
 * Without them every call is a no-op, same convention as klaviyo.ts.
 */

import webpush from 'web-push';
import { createAdminClient } from '@/lib/supabase/admin';

export function pushEnabled(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configured = false;
function ensureConfigured() {
  if (configured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:hello@babybrain.sg',
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
  configured = true;
}

/**
 * Pushes {title, body, url} to every device the user has subscribed on.
 * A subscription the push service reports gone (404/410 — the browser
 * unsubscribed, uninstalled the app, or cleared data) is deleted so it stops
 * being retried. Never throws — a push failure shouldn't affect the email
 * send it runs alongside.
 */
export async function sendPushToUser(userId: string, payload: { title: string; body: string; url?: string }) {
  if (!pushEnabled()) return;
  ensureConfigured();

  const admin = createAdminClient();
  const { data: subs } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId);
  if (!subs || subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await admin.from('push_subscriptions').delete().eq('id', sub.id);
        } else {
          console.error(`[push] send failed for subscription ${sub.id}:`, err);
        }
      }
    })
  );
}
