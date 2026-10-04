import { NextResponse } from 'next/server';
import { runWixEventsReconcile } from '@/lib/wix/events-reconcile';

/**
 * Keeps Wix Events honest between syncs: re-reads each event's registration
 * state (can it take a booking?), reads the vendor's Wix orders back
 * (cancellations, check-ins, tickets) and retries paid orders Wix refused.
 * Triggered by Supabase pg_cron via pg_net every 10 minutes (migration 00219),
 * guarded by the same shared secret as the other cron routes. The work lives
 * in {@link runWixEventsReconcile}.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.WEBHOOK_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await runWixEventsReconcile();
  return NextResponse.json({ ok: true, ...summary });
}
