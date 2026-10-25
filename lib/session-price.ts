import type { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * What one session costs, from the database's own session_price() — the same
 * rule the booking and waitlist triggers use to decide free vs paid, so a
 * checkout can't charge something they disagree with. Since 00250 that rule is
 * a venue's weekday price, then the session's own price, then the venue's
 * price, then the activity's. Returns null when the session is unknown.
 */
export async function sessionPrice(admin: Admin, sessionId: string): Promise<number | null> {
  const rpc = admin.rpc as unknown as (
    fn: 'session_price',
    args: { p_session: string },
  ) => PromiseLike<{ data: number | string | null; error: { message: string } | null }>;
  const { data, error } = await rpc.call(admin, 'session_price', { p_session: sessionId });
  if (error) throw new Error(`session_price failed: ${error.message}`);
  return data == null ? null : Number(data);
}

/** session_price() for several sessions at once (one round trip each, in parallel). */
export async function sessionPrices(admin: Admin, sessionIds: string[]): Promise<Map<string, number | null>> {
  const unique = [...new Set(sessionIds)];
  const prices = await Promise.all(unique.map((id) => sessionPrice(admin, id)));
  return new Map(unique.map((id, i) => [id, prices[i]]));
}
