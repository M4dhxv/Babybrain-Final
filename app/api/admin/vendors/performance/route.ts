import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadVendorPerformance } from '@/lib/admin-vendors';

/**
 * Admin → Vendor data: every vendor with its listings, sessions, bookings,
 * money and reviews (lib/admin-vendors.ts). The page filters, sorts and
 * exports on the client, so this returns the whole list. `?fresh=1` skips the
 * short in-memory cache (the Refresh button). Read-only.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  try {
    const rows = await loadVendorPerformance(createAdminClient() as unknown as SupabaseClient, fresh);
    return NextResponse.json({ rows, builtAt: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
