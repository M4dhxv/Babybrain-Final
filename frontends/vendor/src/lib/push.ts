import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';

/**
 * Web Push for the vendor portal: booking received, activity fully booked,
 * payouts and the like, delivered to the browser even when the portal is closed.
 *
 * Same worker and endpoints as the parent app (public/app/push-sw.js, scope
 * "/", and the save_push_subscription function). Two differences:
 *  - the VAPID public key comes from GET /api/push/config, not a build variable,
 *    so this also tells us whether the server can send at all;
 *  - nothing here requires the portal to be installed. On iPhone / iPad push
 *    only exists for a Home Screen app, so there the card explains that.
 *
 * One browser holds one subscription: if the same browser is also used as a
 * parent, whichever account turned notifications on last receives them.
 */

const PUSH_SW_URL = '/app/push-sw.js';

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'subscribed' | 'unsubscribed';

let publicKey: string | null = null;
let serverEnabled: boolean | null = null;
let configPromise: Promise<boolean> | null = null;
const configListeners = new Set<() => void>();

/** Asks the server whether push is switched on. Fails closed. */
export function loadPushConfig(): Promise<boolean> {
  if (!configPromise) {
    const base = (import.meta.env.VITE_API_BASE as string) || '';
    configPromise = fetch(`${base}/api/push/config`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((j: { enabled?: boolean; publicKey?: string | null }) => {
        publicKey = j.publicKey ?? null;
        return j.enabled === true && !!publicKey;
      })
      .catch(() => false)
      .then((v) => {
        serverEnabled = v;
        configListeners.forEach((l) => l());
        return v;
      });
  }
  return configPromise;
}

export function usePushServerEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => { configListeners.add(cb); return () => { configListeners.delete(cb); }; },
    () => serverEnabled === true,
    () => false
  );
}

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function pushAvailable(): boolean {
  return serverEnabled === true && supported();
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

function keyToBuffer(base64url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
}

async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(PUSH_SW_URL, { scope: '/' });
  if (reg.active) return reg;
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return reg;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The notification service didn't start — try again.")), 15000);
    const done = () => { window.clearTimeout(timer); resolve(); };
    if (worker.state === 'activated') return done();
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') done();
      else if (worker.state === 'redundant') { window.clearTimeout(timer); reject(new Error("The notification service couldn't start.")); }
    });
  });
  return reg;
}

async function saveSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
  const { error } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, string>
  ) => PromiseLike<{ error: { message: string } | null }>)('save_push_subscription', {
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
  });
  if (error) throw new Error(error.message);
}

async function ensureSubscribed(): Promise<PushSubscription> {
  const reg = await pushRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBuffer(publicKey!),
    });
  }
  await saveSubscription(sub);
  return sub;
}

export async function getPushState(): Promise<PushState> {
  if (!(await loadPushConfig())) return 'unsupported';
  if (!supported()) return isIos() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg || reg.scope !== `${location.origin}/`) return 'unsubscribed';
  return (await reg.pushManager.getSubscription()) ? 'subscribed' : 'unsubscribed';
}

/** Must be called straight from a tap: the permission request is the first await. */
export async function subscribeToPush(): Promise<PushState> {
  if (!serverEnabled || !supported()) return isIos() ? 'needs-install' : 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'unsubscribed';
  await ensureSubscribed();
  return 'subscribed';
}

export async function unsubscribeFromPush(): Promise<PushState> {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return 'unsubscribed';
  await (supabase.rpc as unknown as (fn: string, args: Record<string, string>) => PromiseLike<unknown>)(
    'delete_push_subscription',
    { p_endpoint: sub.endpoint }
  );
  await sub.unsubscribe();
  return 'unsubscribed';
}

let syncedFor: string | null = null;

/** Permission already granted: quietly attach this browser to whoever is signed in. No prompt. */
export async function syncPushSubscription(userId: string): Promise<void> {
  if (!supported() || Notification.permission !== 'granted' || syncedFor === userId) return;
  if (!(await loadPushConfig())) return;
  syncedFor = userId;
  try {
    await ensureSubscribed();
  } catch (err) {
    syncedFor = null;
    console.error('[push] subscription sync failed', err);
  }
}

export const PUSH_SNOOZE_KEY = 'bb_vendor_push_snooze_until';
export const PUSH_NOT_NOW_MS = 3 * 24 * 60 * 60 * 1000;
export const PUSH_CLOSE_MS = 24 * 60 * 60 * 1000;

export function isPushSnoozed(): boolean {
  try { return Number(localStorage.getItem(PUSH_SNOOZE_KEY) ?? 0) > Date.now(); } catch { return false; }
}
export function snoozePush(ms: number) {
  try { localStorage.setItem(PUSH_SNOOZE_KEY, String(Date.now() + ms)); } catch { /* may come back sooner */ }
}
