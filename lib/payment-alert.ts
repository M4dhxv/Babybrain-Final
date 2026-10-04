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

function alertRecipients(): string[] {
  const configured = (process.env.ADMIN_EMAILS ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^["'<]+|[>"']+$/g, ''))
    .filter((s) => s.includes('@'));
  return guardOperationalRecipients(configured.length ? configured : ['hello@babybrain.sg']);
}

export async function sendPaymentAlert(session: Stripe.Checkout.Session): Promise<void> {
  try {
    // No live payment had ever produced an alert (checked 28 Sep): every failure
    // below was swallowed, so nobody could see why. Accept any separator in
    // ADMIN_EMAILS, fall back to the founder inbox, and log every early exit.
    const to = alertRecipients();
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

/**
 * A plain operations alert for something a person has to act on (not a payment
 * notification). Same recipients and the same never-throws contract as
 * {@link sendPaymentAlert}.
 */
export async function sendOpsAlert(subject: string, lines: string[]): Promise<void> {
  try {
    const to = alertRecipients();
    if (!to.length || !process.env.RESEND_API_KEY) {
      console.error('[payment-alert] ops alert not sent: no recipient or RESEND_API_KEY', { recipients: to.length, subject });
      return;
    }
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.EMAIL_FROM || 'BabyBrain <hello@updates.babybrain.sg>',
      to,
      subject,
      text: lines.join('\n'),
    });
    if (error) console.error('[payment-alert] Resend rejected the ops alert:', error);
  } catch (e) {
    console.error('[payment-alert] ops alert failed:', e);
  }
}

/**
 * "A parent has paid and the vendor's Wix did not accept the order."
 *
 * Stripe already holds the money and the parent holds no ticket, so this is
 * the one failure that needs a person today: fix whatever Wix rejected, then
 * retry the order from Admin → Payments (or refund it). Until now it was a
 * single console.error in the webhook, which is how a paid BeAlere ticket
 * (4 Oct 2026, INVALID_FORM_RESPONSE) sat unnoticed.
 */
export async function sendWixOrderFailureAlert(details: {
  kind: 'event ticket';
  orderId: string;
  eventTitle: string | null;
  providerId: string;
  customerEmail: string | null;
  amount: number | null;
  paymentIntent: string | null;
  reason: string;
  /** Retries already made by the time this alert goes out. */
  attempts?: number;
  /** True when automatic retries have stopped and only a person can resolve it. */
  gaveUp?: boolean;
}): Promise<void> {
  await sendOpsAlert(
    `ACTION NEEDED: paid ${details.kind} not created on Wix — ${details.eventTitle ?? 'event'}`,
    [
      `A parent PAID for a Wix ${details.kind}, but Wix did not accept the order.`,
      details.gaveUp
        ? 'Automatic retries have stopped. Fix the cause and retry it, or refund it, in Admin → Payments.'
        : 'BabyBrain will retry on its own for a while. If the cause needs a change on the vendor’s Wix, make it and then retry from Admin → Payments, or refund.',
      '',
      `Event    : ${details.eventTitle ?? '—'}`,
      `Customer : ${details.customerEmail ?? '—'}`,
      `Amount   : ${details.amount != null ? details.amount.toFixed(2) : '—'}`,
      `Order    : ${details.orderId}  (event_ticket_orders)`,
      `Payment  : ${details.paymentIntent ?? '—'}`,
      `Provider : ${details.providerId}`,
      details.attempts != null ? `Attempts : ${details.attempts}` : null,
      '',
      `Wix said : ${details.reason}`,
    ].filter((l): l is string => l !== null)
  );
}
