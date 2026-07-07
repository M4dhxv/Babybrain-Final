import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { runVendorRefresh } from '@/lib/vendor-refresh';

/**
 * Manually kick off a vendor directory-refresh batch from /admin — the same
 * routine the weekly pg_cron job runs, so the founder can trigger it herself.
 * Processes the next batch (oldest-synced first); click again to churn through
 * the rest. Admin-gated.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const summary = await runVendorRefresh('manual', auth.user.email ?? null);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Refresh failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
