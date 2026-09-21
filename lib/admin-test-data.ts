import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Which rows count as "test" for the founder's admin Metrics and Payments.
 *
 * Production and preview deployments share one database, so demo vendors and
 * test-site purchases sit alongside real activity. Nothing is deleted; the admin
 * pages just leave test rows out (unless "include test data" is switched on):
 *
 *   - a vendor flagged `providers.is_test` — and everything it owns;
 *   - an earnings row with `livemode = false` (a Stripe test-mode payment);
 *   - a parent whose email looks like a test address (see isTestEmail).
 *
 * Both columns come from migration 00161. Until it is applied the reads below
 * fail quietly and nothing is treated as test, so the admin pages keep working.
 */

/** Emails that are staff, demo or QA logins rather than real families. */
const TEST_EMAIL = /(@babybrain\.(sg|com)$|@example\.(com|org|net)$|\.test$|@mailinator\.com$)/i;

export const isTestEmail = (email: string | null | undefined): boolean =>
  !!email && TEST_EMAIL.test(email.trim());

/** Supabase returns at most 1000 rows per request; read every page. */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  maxPages = 20
): Promise<T[]> {
  const size = 1000;
  const out: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    const { data, error } = await page(i * size, (i + 1) * size - 1);
    if (error || !data) break;
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

/** Ids of vendors flagged as test/demo. Empty if the column doesn't exist yet. */
export async function testProviderIds(admin: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await admin.from('providers').select('id').eq('is_test', true);
  if (error) return new Set();
  return new Set((data ?? []).map((r: { id: string }) => r.id));
}
