import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { logAdminAction } from '@/lib/admin-audit';
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
    await logAdminAction(createAdminClient() as unknown as SupabaseClient, { ...auth.user, role: auth.role }, {
      action: 'sync.vendor_prices', entityType: 'sync', summary: 'Ran the vendor price refresh by hand',
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Refresh failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
