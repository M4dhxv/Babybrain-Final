/**
 * Web Push sending, from the notifications webhook (app/api/webhooks/
 * notifications), to any device a parent has subscribed on (push_subscriptions,
 * migration 00168). Parents subscribe from the browser or the installed app —
 * see frontends/parent/src/lib/push.ts; a user with zero rows just gets no
 * push, and the caller is told so (outcome 'no_devices').
 *
 * Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT to switch this on.
 * Without them every call is a no-op, same convention as klaviyo.ts, and the
 * outcome is 'disabled' so notifications.push_status never claims 'sent'.
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

export interface PushResult {
  /** 'sent' = at least one device accepted it; 'failed' = devices existed but none accepted. */
  outcome: 'sent' | 'failed' | 'no_devices' | 'disabled';
  devices: number;
  delivered: number;
}

/**
 * Pushes {title, body, url} to every device the user has subscribed on.
 * A subscription the push service reports gone (404/410 — the browser
 * unsubscribed, uninstalled the app, or cleared data) is deleted so it stops
 * being retried. Never throws — a push failure shouldn't affect the email
 * send it runs alongside.
 */
export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string }
): Promise<PushResult> {
  if (!pushEnabled()) return { outcome: 'disabled', devices: 0, delivered: 0 };

  try {
    ensureConfigured();

    const admin = createAdminClient();
    const { data: subs } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId);
    if (!subs || subs.length === 0) return { outcome: 'no_devices', devices: 0, delivered: 0 };

    const body = JSON.stringify(payload);
    const results = await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body
          );
          return true;
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await admin.from('push_subscriptions').delete().eq('id', sub.id);
          } else {
            console.error(`[push] send failed for subscription ${sub.id}:`, err);
          }
          return false;
        }
      })
    );

    const delivered = results.filter(Boolean).length;
    return { outcome: delivered > 0 ? 'sent' : 'failed', devices: subs.length, delivered };
  } catch (err) {
    console.error('[push] send crashed:', err);
    return { outcome: 'failed', devices: 0, delivered: 0 };
  }
}
