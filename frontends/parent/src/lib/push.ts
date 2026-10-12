import { useSyncExternalStore } from "react";
import { supabase } from "./supabase";
import { isStandalone } from "./install";

/**
 * Web Push subscribe/unsubscribe for the parent site.
 *
 * Works in a normal browser tab as well as the installed app — Chrome, Edge,
 * Firefox and Safari 16+ on Android and desktop. The one exception is iPhone /
 * iPad: iOS only exposes push to a site that has been added to the Home Screen,
 * so there the permission can be asked only once the app is installed
 * ("needs-install" below); the install banner and Settings point the parent at
 * installing, and the prompt appears on the app's first launch.
 *
 * Push runs on its own worker (public/push-sw.js, scope "/") so a parent can
 * subscribe from any page, including the bare paths production serves the SPA
 * from, which the /app/-scoped shell worker (sw.js) does not cover.
 */

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const PUSH_SW_URL = "/app/push-sw.js";

export type PushState = "unsupported" | "needs-install" | "denied" | "subscribed" | "unsubscribed";

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !!VAPID_PUBLIC_KEY
  );
}

/** iPhone / iPad in any browser (iPadOS reports itself as a Mac; the touch screen gives it away). */
function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/** True when push can't be asked for yet only because the app isn't installed (iOS). */
export function pushNeedsInstall(): boolean {
  return !!VAPID_PUBLIC_KEY && isIos() && !isStandalone() && !supported();
}

/** Can this browser be asked for notification permission right now? */
export function pushAvailable(): boolean {
  return supported();
}

/** The browser's permission, or "unsupported". */
export function pushPermission(): NotificationPermission | "unsupported" {
  return supported() ? Notification.permission : "unsupported";
}

// web-push's VAPID key ships base64url; PushManager.subscribe wants a raw ArrayBuffer.
function urlBase64ToUint8Array(base64url: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return bytes.buffer;
}

/** Registers (or finds) the push worker and waits until it is active. */
async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(PUSH_SW_URL, { scope: "/" });
  if (reg.active) return reg;
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return reg;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The notification service didn't start — try again.")), 15000);
    const done = () => { window.clearTimeout(timer); resolve(); };
    if (worker.state === "activated") return done();
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") done();
      else if (worker.state === "redundant") { window.clearTimeout(timer); reject(new Error("The notification service couldn't start.")); }
    });
  });
  return reg;
}

async function saveSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? "",
    p_auth: json.keys?.auth ?? "",
  });
  if (error) throw error;
}

export async function getPushState(): Promise<PushState> {
  if (!supported()) return pushNeedsInstall() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg || reg.scope !== `${location.origin}/`) return "unsubscribed";
  const sub = await reg.pushManager.getSubscription();
  return sub ? "subscribed" : "unsubscribed";
}

/**
 * Asks for permission (must be called straight from a tap — Safari requires the
 * gesture, and every browser punishes prompts that aren't one), subscribes and
 * saves the subscription against the signed-in parent.
 */
export async function subscribeToPush(): Promise<PushState> {
  if (!supported()) return pushNeedsInstall() ? "needs-install" : "unsupported";

  // First await in the handler, before anything else, to keep the user gesture.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "unsubscribed";

  const reg = await pushRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!),
    });
  }
  await saveSubscription(sub);
  return "subscribed";
}

export async function unsubscribeFromPush(): Promise<PushState> {
  if (!("serviceWorker" in navigator)) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return "unsubscribed";
  await supabase.rpc("delete_push_subscription", { p_endpoint: sub.endpoint });
  await sub.unsubscribe();
  return "unsubscribed";
}

let syncedFor: string | null = null;

/**
 * Permission was already granted (earlier visit, or another account on this
 * device): quietly make sure this device's subscription exists and belongs to
 * whoever is signed in now. No prompt. Once per user per page load.
 */
export async function syncPushSubscription(userId: string): Promise<void> {
  if (!supported() || Notification.permission !== "granted" || syncedFor === userId) return;
  syncedFor = userId;
  try {
    const reg = await pushRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!),
      });
    }
    await saveSubscription(sub);
  } catch (err) {
    syncedFor = null; // try again next load
    console.error("[push] subscription sync failed", err);
  }
}

// --- "Notifications first" coordination with the install banner -------------

export const PUSH_SNOOZE_KEY = "bb_push_snooze_until";
export const PUSH_NOT_NOW_MS = 3 * 24 * 60 * 60 * 1000; // "Not now": 3 days
export const PUSH_CLOSE_MS = 24 * 60 * 60 * 1000; // the cross: 24 hours

export function isPushSnoozed(): boolean {
  try { return Number(localStorage.getItem(PUSH_SNOOZE_KEY) ?? 0) > Date.now(); } catch { return false; }
}
export function snoozePush(ms: number) {
  try { localStorage.setItem(PUSH_SNOOZE_KEY, String(Date.now() + ms)); } catch { /* it may come back sooner */ }
}

let promptWanted = false;
const promptListeners = new Set<() => void>();

/** The notification prompt is due (or showing). The install banner waits while this is true, so
 *  notifications are always asked for first. */
export function setPushPromptWanted(v: boolean) {
  if (promptWanted === v) return;
  promptWanted = v;
  promptListeners.forEach((l) => l());
}

export function usePushPromptWanted(): boolean {
  return useSyncExternalStore(
    (cb) => { promptListeners.add(cb); return () => { promptListeners.delete(cb); }; },
    () => promptWanted,
    () => false
  );
}
