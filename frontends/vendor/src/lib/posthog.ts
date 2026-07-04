import posthog from "posthog-js";

/**
 * PostHog product analytics. No-ops unless VITE_POSTHOG_KEY is set. The vendor
 * app is a HashRouter SPA, so pageviews are captured manually on route change
 * (see PageviewTracker in App.tsx) rather than by the default capture.
 */
let started = false;

export function initPostHog() {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (started || !key) return;
  started = true;
  posthog.init(key, {
    api_host: (import.meta.env.VITE_POSTHOG_HOST as string) || "https://eu.i.posthog.com",
    person_profiles: "identified_only",
    capture_pageview: false,
    capture_pageleave: true,
  });
}

export function capturePageview() {
  if (started) posthog.capture("$pageview");
}

/** Tie events to a signed-in vendor user; call resetUser() on sign-out. */
export function identifyUser(userId: string, email?: string | null) {
  if (!started) return;
  posthog.identify(userId, email ? { email } : undefined);
}

export function resetUser() {
  if (!started) return;
  posthog.reset();
}

export { posthog };
