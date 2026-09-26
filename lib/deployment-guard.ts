/**
 * Stops operational mail (payment alerts, the contact-form inbox) from ever
 * reaching a real, human-read inbox from a non-production deployment.
 *
 * Incident (2026-09-26): the babybrain-test Vercel project had ADMIN_EMAILS
 * and SUPPORT_EMAIL copied wholesale from production, so a test booking's
 * payment alert and a contact-form smoke test both landed in the founder's
 * real hello@babybrain.sg inbox. Fixing the env vars on that one project
 * doesn't stop it happening again on the next test/preview project someone
 * spins up, so this also gates in code.
 *
 * VERCEL_URL is set automatically by Vercel for every deployment — unlike
 * NEXT_PUBLIC_APP_URL, which depends on a human configuring it per project,
 * and that manual step is exactly what was missed here.
 */

// Real inboxes a person actually reads day to day. Extend this if another
// one turns up leaking the same way.
const PRODUCTION_ONLY_RECIPIENTS = new Set(['hello@babybrain.sg']);

export const isNonProdDeployment = (): boolean => /test/i.test(process.env.VERCEL_URL ?? '');

/** Filters a recipient list, dropping any production-only inbox when running
 *  on a deployment whose own URL looks like a test one. Logs so a
 *  misconfigured env var is visible in the function logs, not just silent. */
export function guardOperationalRecipients(to: string[]): string[] {
  if (!isNonProdDeployment()) return to;
  const safe = to.filter((addr) => !PRODUCTION_ONLY_RECIPIENTS.has(addr.trim().toLowerCase()));
  if (safe.length !== to.length) {
    console.warn(
      `[deployment-guard] blocked production-only recipient(s) on a non-production deployment ` +
        `(VERCEL_URL=${process.env.VERCEL_URL}):`,
      to.filter((a) => !safe.includes(a))
    );
  }
  return safe;
}
