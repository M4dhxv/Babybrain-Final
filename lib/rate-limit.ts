import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Serverless-safe rate limit, backed by the `rate_limit_hits` table + the
 * `rate_limit_touch` function (see migration 00080). Records one hit for
 * `bucket` and returns true when that bucket has exceeded `max` within the
 * trailing `windowSeconds`.
 *
 * Must be called with a SERVICE-ROLE client — the table/function are locked to
 * the service role. Fail-open on any error: a throttle outage must never take
 * down the public route it protects.
 */
export async function rateLimited(
  admin: SupabaseClient,
  bucket: string,
  max: number,
  windowSeconds: number
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc('rate_limit_touch', {
      p_bucket: bucket,
      p_max: max,
      p_window: `${Math.max(1, Math.floor(windowSeconds))} seconds`,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Best-effort client IP from the proxy headers Vercel sets. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}
