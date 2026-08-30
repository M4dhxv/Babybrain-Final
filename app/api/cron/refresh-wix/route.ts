import { NextResponse } from 'next/server';
import { runWixScheduledSync } from '@/lib/wix/scheduled-sync';

/**
 * Background sync of every connected Wix account (Bookings + Events),
 * independent of vendor login. Triggered by Supabase pg_cron via pg_net
 * (see migration 00072), guarded by the same shared secret as
 * /api/cron/refresh-vendors. The actual work + run logging lives in
 * {@link runWixScheduledSync}; this route just authenticates the cron
 * caller. The same routine is reachable manually from /admin (see
 * app/api/admin/wix-sync/refresh).
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.WEBHOOK_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await runWixScheduledSync('cron');
  return NextResponse.json({ ok: true, ...summary });
}
