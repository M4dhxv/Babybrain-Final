/**
 * PostHog product analytics. No-ops unless VITE_POSTHOG_KEY is set, so local
 * dev and unconfigured builds stay silent.
 *
 * `posthog-js` is ~150 KB, and nothing on the first screen needs it, so it's
 * loaded on demand (from an idle callback in main.tsx, or the first
 * identify/reset call) rather than bundled into the entry chunk. posthog-js
 * hooks the History API itself, so SPA navigations still capture pageviews.
 */
type PostHogClient = (typeof import("posthog-js"))["default"];

let client: PostHogClient | null = null;
let initPromise: Promise<void> | null = null;

export function initPostHog(): Promise<void> {
  if (initPromise) return initPromise;
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) {
    initPromise = Promise.resolve();
    return initPromise;
  }
  initPromise = import("posthog-js")
    .then((mod) => {
      client = mod.default;
      client.init(key, {
        api_host:
          (import.meta.env.VITE_POSTHOG_HOST as string) || "https://eu.i.posthog.com",
        person_profiles: "identified_only",
        capture_pageview: true,
        capture_pageleave: true,
      });
    })
    .catch(() => {
      /* analytics is best-effort — a blocked or failed load must not surface */
    });
  return initPromise;
}

/** Tie events to a signed-in parent. */
export async function identifyUser(userId: string, email?: string | null) {
  await initPostHog();
  client?.identify(userId, email ? { email } : undefined);
}

/** Drop the identity on sign-out. */
export async function resetUser() {
  await initPostHog();
  client?.reset();
}
