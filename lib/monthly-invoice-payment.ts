import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { recordSale } from '@/lib/commercials';

/**
 * A monthly invoice (migration 00268) has been paid through Stripe Checkout.
 *
 * Shared by the Stripe webhook and /api/stripe/reconcile, which both see the
 * same checkout: whichever runs first marks the invoice paid, and the other is
 * a no-op. monthly_mark_invoice_paid reports whether it was the one that
 * changed anything, but the ledger entry is written either way, because
 * recordSale is idempotent on the payment intent and a first delivery that died
 * between the two steps must not leave the sale off the vendor's earnings.
 *
 * `scopeUserId` is set by the reconcile route: a checkout only settles an
 * invoice for the parent who started it.
 */
export async function settleMonthlyInvoice(
  admin: SupabaseClient<Database>,
  session: Stripe.Checkout.Session,
  scopeUserId?: string,
): Promise<{ ok: boolean; invoiceId: string | null }> {
  const invoiceId = session.metadata?.invoice_id ?? null;
  if (!invoiceId) return { ok: false, invoiceId: null };
  if (scopeUserId && session.metadata?.user_id !== scopeUserId) return { ok: false, invoiceId };

  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null);

  const rpc = admin.rpc as unknown as (
    fn: 'monthly_mark_invoice_paid',
    args: { p_invoice_id: string; p_payment_intent: string | null; p_checkout_session: string },
  ) => Promise<{ error: { message: string } | null }>;
  const { error } = await rpc.call(admin, 'monthly_mark_invoice_paid', {
    p_invoice_id: invoiceId,
    p_payment_intent: paymentIntent,
    p_checkout_session: session.id,
  });
  if (error) {
    console.error('[monthly] could not mark invoice paid', invoiceId, error.message);
    return { ok: false, invoiceId };
  }

  const db = admin as unknown as SupabaseClient;
  const { data: invoice } = await db
    .from('monthly_invoices')
    .select('provider_id, amount_cents')
    .eq('id', invoiceId)
    .maybeSingle();
  if (invoice) {
    await recordSale(admin, {
      providerId: invoice.provider_id as string,
      source: 'monthly',
      monthlyInvoiceId: invoiceId,
      grossCents: invoice.amount_cents as number,
      paymentIntentId: paymentIntent,
    });
  }
  return { ok: true, invoiceId };
}
