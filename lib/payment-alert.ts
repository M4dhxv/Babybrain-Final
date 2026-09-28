import { Resend } from 'resend';
import type Stripe from 'stripe';
import { guardOperationalRecipients } from './deployment-guard';

/**
 * "Tell me every time money comes in."
 *
 * A plain internal alert to the founder on every completed checkout — bookings,
 * class packs, Boost, and both kinds of subscription. Deliberately not a
 * branded customer email: this is an operations ping, so it stays plain text
 * and says only what a quick glance needs.
 *
 * Recipients are ADMIN_EMAILS, the same allowlist that gates /admin, so there
 * is no second list to keep in step.
 *
 * Never throws. A failed alert must not fail the webhook — Stripe would retry
 * the event and the booking would be processed twice.
 */

const KIND_LABEL: Record<string, string> = {
  booking: 'Class booking',
  package: 'Class package',
  boost: 'Boost',
  subscription: 'Vendor subscription',
  customer_subscription: 'Parent Plus subscription',
};

const money = (cents: number | null | undefined, currency: string | null | undefined) =>
  cents == null ? '—' : `${(cents / 100).toFixed(2)} ${(currency ?? 'sgd').toUpperCase()}`;

export async function sendPaymentAlert(session: Stripe.Checkout.Session): Promise<void> {
  try {
    // No live payment had ever produced an alert (checked 28 Sep): every failure
    // below was swallowed, so nobody could see why. Accept any separator in
    // ADMIN_EMAILS, fall back to the founder inbox, and log every early exit.
    const configured = (process.env.ADMIN_EMAILS ?? '')
      .split(/[\s,;]+/)
      .map((s) => s.trim().replace(/^["'<]+|[>"']+$/g, ''))
      .filter((s) => s.includes('@'));
    const to = guardOperationalRecipients(configured.length ? configured : ['hello@babybrain.sg']);
    if (!to.length || !process.env.RESEND_API_KEY) {
      console.error('[payment-alert] not sent: no recipient or RESEND_API_KEY', { recipients: to.length });
      return;
    }

    const kind = session.metadata?.kind ?? 'payment';
    const label = KIND_LABEL[kind] ?? kind;
    const live = session.livemode ? '' : '[TEST] ';

    // What the vendor is actually left with, when the split ran. Absent on
    // subscriptions and on bookings for vendors without Connect.
    const fee = session.metadata?.application_fee_cents;
    const lines = [
      `${label} — ${money(session.amount_total, session.currency)}`,
      '',
      `Customer : ${session.customer_details?.email ?? session.customer_email ?? '—'}`,
      `Session  : ${session.id}`,
      fee ? `BabyBrain: ${money(Number(fee), session.currency)}` : null,
      session.metadata?.provider_id ? `Provider : ${session.metadata.provider_id}` : null,
      '',
      session.livemode
        ? 'This is a live payment.'
        : 'This is a TEST-mode payment — no real money moved.',
    ].filter(Boolean);

    // Resend reports a rejected send in `error` rather than throwing.
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.EMAIL_FROM || 'BabyBrain <hello@updates.babybrain.sg>',
      to,
      subject: `${live}${label}: ${money(session.amount_total, session.currency)}`,
      text: lines.join('\n'),
    });
    if (error) console.error('[payment-alert] Resend rejected the alert:', error);
  } catch (e) {
    // Bookkeeping only — see the note above about never failing the webhook.
    console.error('[payment-alert] failed:', e);
  }
}
