import type { createAdminClient } from '@/lib/supabase/admin';

/**
 * Mode-scoped Stripe configuration in `app_config`.
 *
 * `app_config` is `key text primary key` and there is ONE hosted database
 * shared by production, previews and every developer's machine. The Stripe ids
 * stored in it (`price_`, `bpc_`) exist in exactly one Stripe mode: test and
 * live share no objects. So a single `stripe_plus_price_id` row cannot serve
 * both — the moment production is pointed at a live key and that row holds a
 * live price, every local or preview checkout running the test key hands
 * Stripe a live price id and 500s, and vice versa.
 *
 * Keys are therefore looked up mode-first and fall back to the bare key:
 *
 *   live  →  `live_stripe_plus_price_id`, else `stripe_plus_price_id`
 *   test  →  `test_stripe_plus_price_id`, else `stripe_plus_price_id`
 *
 * The fallback is what makes this safe to deploy: the bare rows that exist
 * today keep working untouched, so nothing changes until mode-scoped rows are
 * written. `npm run stripe:bootstrap -- --apply` writes the scoped ones.
 *
 * Values that are not Stripe object ids (`stripe_boost_amount_cents` is just a
 * number of cents) don't need scoping and can keep using a bare key.
 */

export type StripeMode = 'live' | 'test';

/** Which Stripe mode the running process is in, from the secret key. */
export function stripeMode(): StripeMode {
  return (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live') ? 'live' : 'test';
}

/** The mode-scoped name for a config key, e.g. `live_stripe_plus_price_id`. */
export function scopedKey(key: string, mode: StripeMode = stripeMode()): string {
  return `${mode}_${key}`;
}

/**
 * Read Stripe config keys, preferring the current mode's value.
 *
 * Returns a map from the LOGICAL key (the bare name the caller asked for) to
 * whichever value applies, so callers are unchanged apart from going through
 * this function.
 */
export async function stripeConfig(
  admin: ReturnType<typeof createAdminClient>,
  keys: string[]
): Promise<Record<string, string | undefined>> {
  const mode = stripeMode();
  const wanted = [...keys, ...keys.map((k) => scopedKey(k, mode))];

  const { data } = await admin.from('app_config').select('key, value').in('key', wanted);
  const rows = new Map((data ?? []).map((r) => [r.key, r.value]));

  return Object.fromEntries(
    keys.map((k) => [k, rows.get(scopedKey(k, mode)) ?? rows.get(k)])
  );
}

/**
 * The reverse lookup the webhook needs: which of these keys holds `value`.
 *
 * Returns the LOGICAL key, so `planForPrice` can keep pattern-matching on
 * `stripe_pro_` without caring whether the row it came from was scoped.
 */
export async function stripeConfigKeyFor(
  admin: ReturnType<typeof createAdminClient>,
  keys: string[],
  value: string
): Promise<string | null> {
  const cfg = await stripeConfig(admin, keys);
  return keys.find((k) => cfg[k] === value) ?? null;
}
