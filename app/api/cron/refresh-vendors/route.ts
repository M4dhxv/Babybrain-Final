import { NextResponse } from 'next/server';
import { runVendorRefresh } from '@/lib/vendor-refresh';

/**
 * Weekly refresh of AUTO-LISTED (unclaimed directory) vendors. Triggered by
 * Supabase pg_cron via pg_net (see migration 00021), guarded by a shared
 * secret. The actual work + run logging lives in {@link runVendorRefresh}; this
 * route just authenticates the cron caller. The same routine is reachable
 * manually from /admin (see app/api/admin/vendors/refresh).
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.WEBHOOK_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await runVendorRefresh('cron');
  return NextResponse.json({ ok: true, ...summary });
}
