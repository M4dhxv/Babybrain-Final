import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { logAdminAction } from '@/lib/admin-audit';
import { createAdminClient } from '@/lib/supabase/admin';
import { fulfilPaidWixEventOrder } from '@/lib/wix/finalize-event-checkout';
import { refundWixEventOrder } from '@/lib/wix/event-order-admin';

/**
 * Resolve a paid-but-unfulfilled Wix Events ticket. Admin only (it moves money).
 *   { action: 'retry' }  — try the Wix order again now (after fixing the cause on the vendor's Wix).
 *   { action: 'refund' } — refund the parent in full.
 */
export const maxDuration = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such order.' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== 'retry' && action !== 'refund') {
    return NextResponse.json({ error: 'Expected { action: "retry" | "refund" }.' }, { status: 400 });
  }

  const admin = createAdminClient();
  const actor = { ...auth.user, role: auth.role };
  const audit = admin as unknown as SupabaseClient;

  if (action === 'retry') {
    const outcome = await fulfilPaidWixEventOrder(admin, id, { source: 'retry' });
    await logAdminAction(audit, actor, {
      action: 'event_order.retry',
      entityType: 'event_ticket_order',
      entityId: id,
      summary: `Retried a Wix event ticket order — ${outcome.status}`,
      details: { outcome },
    });
    if (outcome.status === 'fulfilled') {
      return NextResponse.json({
        ok: true,
        message: `Done — Wix order ${outcome.orderNumber}${outcome.adopted ? ' (adopted an order already on Wix)' : ''} created and the booking recorded.`,
      });
    }
    if (outcome.status === 'already') return NextResponse.json({ ok: true, message: 'This order was already fulfilled.' });
    if (outcome.status === 'busy') {
      return NextResponse.json({ error: 'An attempt on this order is in progress or just finished — give it a few minutes, then retry.' }, { status: 409 });
    }
    if (outcome.status === 'not_payable') {
      return NextResponse.json({ error: 'This order isn’t waiting on Wix any more (refunded, cancelled or unpaid).' }, { status: 409 });
    }
    return NextResponse.json({ error: `Wix still refused it: ${outcome.error}` }, { status: 422 });
  }

  const result = await refundWixEventOrder(admin, id);
  await logAdminAction(audit, actor, {
    action: 'event_order.refund',
    entityType: 'event_ticket_order',
    entityId: id,
    summary: result.ok
      ? `Refunded a Wix event ticket order (${result.refundId})`
      : `Refund of a Wix event ticket order failed: ${result.error}`,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({
    ok: true,
    message: result.wixOrderNumber
      ? `Refunded. This order also exists on the vendor’s Wix (${result.wixOrderNumber}) — cancel it there too.`
      : 'Refunded.',
  });
}
