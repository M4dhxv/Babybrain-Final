import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { logAdminAction } from '@/lib/admin-audit';

/**
 * Flag one payment (a provider_earnings row) as test, or clear the flag. A flagged payment is left
 * out of admin Metrics, Payments totals and a parent's spend, without hiding the vendor or the parent.
 * Body: { is_test: boolean }. Admin only. Needs migration 00212.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such payment.' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { is_test?: unknown } | null;
  if (!body || typeof body.is_test !== 'boolean') return NextResponse.json({ error: 'Expected { is_test: boolean }.' }, { status: 400 });

  const db = createAdminClient() as unknown as SupabaseClient;
  const { data, error } = await db.from('provider_earnings').update({ is_test: body.is_test }).eq('id', id)
    .select('id, gross_cents, stripe_payment_intent').maybeSingle();
  if (error) {
    const needs = /is_test/.test(error.message);
    return NextResponse.json({ error: needs ? 'Flagging a payment as test needs migration 00212 applied to the database first.' : error.message }, { status: needs ? 409 : 500 });
  }
  if (!data) return NextResponse.json({ error: 'No such payment.' }, { status: 404 });
  const row = data as { gross_cents: number; stripe_payment_intent: string | null };
  await logAdminAction(db, { ...auth.user, role: auth.role }, {
    action: body.is_test ? 'payment.mark_test' : 'payment.unmark_test', entityType: 'payment', entityId: id,
    summary: `${body.is_test ? 'Flagged' : 'Unflagged'} a $${(row.gross_cents / 100).toFixed(2)} payment as test${row.stripe_payment_intent ? ` (${row.stripe_payment_intent})` : ''}`,
  });
  return NextResponse.json({ ok: true, is_test: body.is_test });
}
