import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { runWixScheduledSync } from '@/lib/wix/scheduled-sync';

/**
 * Manually kick off the Wix background sync from /admin — the same routine
 * the pg_cron job runs every 15 minutes, so it can be triggered on demand
 * (e.g. right after a vendor reports a change on Wix) without waiting for
 * the next scheduled run. Admin-gated.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const summary = await runWixScheduledSync('manual', auth.user.email ?? null);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Refresh failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
