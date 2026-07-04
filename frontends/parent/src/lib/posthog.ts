import posthog from "posthog-js";

/**
 * PostHog product analytics. No-ops unless VITE_POSTHOG_KEY is set, so local
 * dev and unconfigured builds stay silent. The parent app navigates via full
 * page loads, so the default pageview capture fires on every page.
 */
let started = false;

export function initPostHog() {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (started || !key) return;
  started = true;
  posthog.init(key, {
    api_host: (import.meta.env.VITE_POSTHOG_HOST as string) || "https://eu.i.posthog.com",
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
  });
}

/** Tie events to a signed-in parent; call posthog.reset() on sign-out. */
export function identifyUser(userId: string, email?: string | null) {
  if (!started) return;
  posthog.identify(userId, email ? { email } : undefined);
}

export function resetUser() {
  if (!started) return;
  posthog.reset();
}

export { posthog };
