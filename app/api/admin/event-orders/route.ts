import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { listStuckEventOrders } from '@/lib/wix/event-order-admin';

/**
 * Admin → Payments: Wix Events tickets a parent has PAID for that never made it
 * onto the vendor's Wix. Each shows Wix's actual error, how often it has been
 * retried, and gets Retry / Refund buttons (POST /api/admin/event-orders/[id]).
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request, ['admin', 'support']);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const orders = await listStuckEventOrders(createAdminClient());
  return NextResponse.json({ orders });
}
