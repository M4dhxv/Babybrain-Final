/**
 * The renewal and commission terms a subscriber must see before paying.
 *
 * Stripe gives exactly one place to state these inside its own UI: Checkout's
 * `custom_text.submit.message`, shown directly above the pay button. The
 * Billing Portal takes only a headline and Terms/Privacy links — it cannot
 * render arbitrary text — so the portal relies on the linked Terms page and
 * this is the single pre-payment disclosure.
 *
 * Stripe caps this string at 1200 characters and renders it as plain text.
 */

/** Commission charged on bookings, by plan. Mirrors plan_commission_rate() in 00064. */
const COMMISSION: Record<string, string> = {
  free: '12%',
  growth: '10%', // the Plans page calls this Pro
  pro: '8%', // the Plans page calls this Premium
  premium: '8%',
};

/** Days of notice required before a renewal to avoid being charged for it. */
export const CANCELLATION_NOTICE_DAYS = 14;

/** A vendor's negotiated commission (subscriptions.custom_terms = true), which
 *  plan changes don't touch (00052) — so the plan's published rate would be
 *  the wrong thing to show them. */
export interface CustomCommission {
  rate: number;
  flatCents: number;
  feePayer: 'platform' | 'vendor';
}

function customCommissionLine(c: CustomCommission): string {
  const pct = `${Number((c.rate * 100).toFixed(1))}%`;
  const flat = c.flatCents > 0 ? `$${(c.flatCents / 100).toFixed(2).replace(/\.00$/, '')} per booking` : '';
  const parts = [c.rate > 0 ? `${pct} commission` : '', flat].filter(Boolean);
  const stripeFees =
    c.feePayer === 'vendor' ? " Stripe's payment processing fees still apply." : '';
  return parts.length
    ? ` BabyBrain charges ${parts.join(' plus ')} on classes booked through the platform.${stripeFees}`
    : ` BabyBrain charges no commission on classes booked through the platform.${stripeFees}`;
}

export function renewalTerms(
  plan: string,
  billing: 'monthly' | 'annual',
  custom?: CustomCommission | null
): string {
  const notice = `Cancel at least ${CANCELLATION_NOTICE_DAYS} days before your renewal date. If you cancel with less than ${CANCELLATION_NOTICE_DAYS} days' notice you will be charged for the coming period. You keep access until the end of the period you have paid for.`;

  const billingLine =
    billing === 'annual'
      ? 'This is an annual subscription, charged today for 12 months at the price of 11. It renews automatically each year. Cancellations are not refunded pro rata.'
      : 'This is a monthly subscription, charged today and renewing automatically each month.';

  // Parents pay no commission — Plus is a flat subscription, so the commission
  // sentence would be meaningless (and alarming) on that checkout.
  const commission = COMMISSION[plan];
  const commissionLine = custom
    ? customCommissionLine(custom)
    : commission
    ?` BabyBrain charges ${commission} commission on classes booked through the platform, plus Stripe's payment processing fees.`
    : '';

  return `${billingLine} ${notice}${commissionLine}`;
}
