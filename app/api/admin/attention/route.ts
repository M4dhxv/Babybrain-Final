import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAll } from '@/lib/admin-test-data';
import { isLiveEarning } from '@/lib/admin-test-rules';

/**
 * Admin → "Needs attention": the things that are waiting on a person, each pointing at the tab
 * that fixes it. Every check is independent and best effort, so one failing query drops its own
 * item and never the whole list. Support logins only see the inbox-type items.
 */
export type AttentionItem = {
  id: string;
  severity: 'warn' | 'info';
  title: string;
  detail: string;
  tab: string;
  /** Parents-tab filters to apply when the item opens the Parents tab. */
  filters?: Record<string, string>;
};

const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
  try { const r = await q; return r.error ? 0 : r.count ?? 0; } catch { return 0; }
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function GET(request: Request) {
  const auth = await requireAdmin(request, ['admin', 'support']);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const db = createAdminClient() as unknown as SupabaseClient;
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const items: AttentionItem[] = [];

  const [undelivered, emailFailures] = await Promise.all([
    count(db.from('contact_messages').select('id', { count: 'exact', head: true }).eq('emailed', false)),
    count(db.from('notifications').select('id', { count: 'exact', head: true }).eq('email_status', 'failed').gte('created_at', since30)),
  ]);
  if (undelivered > 0) {
    items.push({ id: 'contact-undelivered', severity: 'warn', tab: 'contact',
      title: `${plural(undelivered, 'contact message')} not emailed`,
      detail: 'These were saved but the email to you did not go out. Read them in the Contact form tab.' });
  }
  if (emailFailures > 0) {
    items.push({ id: 'email-failures', severity: 'warn', tab: 'flows',
      title: `${plural(emailFailures, 'email')} failed to send in the last 30 days`,
      detail: 'Check the sending domain and the Email flows tab.' });
  }

  if (auth.role === 'admin') {
    const stuckEventOrders = await count(
      db.from('event_ticket_orders').select('id', { count: 'exact', head: true }).eq('status', 'pending').eq('payment_status', 'paid')
    );
    // The 10-minute Wix Events job (migration 00219) stamps every event activity it checks. If the newest
    // stamp is old while event activities exist, the job has stopped (cron off, route erroring, secret
    // changed) and nothing else would say so.
    const { data: lastCheck } = await db
      .from('activities')
      .select('wix_event_checked_at')
      .or('wix_event_id.not.is.null,wix_series_id.not.is.null')
      .is('wix_removed_at', null)
      .order('wix_event_checked_at', { ascending: false, nullsFirst: false })
      .limit(1);
    const lastCheckedAt = (lastCheck as { wix_event_checked_at: string | null }[] | null)?.[0]?.wix_event_checked_at ?? null;
    if (lastCheck && lastCheck.length > 0 && (!lastCheckedAt || Date.now() - Date.parse(lastCheckedAt) > 60 * 60_000)) {
      items.push({ id: 'wix-events-job-stale', severity: 'warn', tab: 'vendors',
        title: 'Wix Events aren\'t being re-checked',
        detail: lastCheckedAt
          ? `The background check (every 10 minutes) last ran ${Math.round((Date.now() - Date.parse(lastCheckedAt)) / 60_000)} minutes ago. Paid tickets Wix refused won't be retried and cancellations on Wix won't reach parents until it runs again.`
          : 'The background check has never run since Wix Events were connected.' });
    }
    if (stuckEventOrders > 0) {
      items.push({ id: 'event-orders-stuck', severity: 'warn', tab: 'payments',
        title: `${plural(stuckEventOrders, 'paid event ticket')} not on the vendor's Wix`,
        detail: 'The parent was charged but Wix refused the order, so they have no ticket. Retry or refund it in the Payments tab.' });
    }

    const [pastDue, owedRows] = await Promise.all([
      count(db.from('customer_subscriptions').select('user_id', { count: 'exact', head: true }).eq('plan', 'plus').eq('status', 'past_due')),
      (async () => {
        type Owed = { commission_cents: number | null; livemode?: boolean | null; is_test?: boolean | null; provider: { is_test: boolean | null } | null };
        // is_test (a payment an admin flagged as test) comes from migration 00212; read it when it exists.
        const flagged = !(await db.from('provider_earnings').select('is_test').limit(1)).error;
        const cols = `commission_cents, livemode, provider:providers(is_test)${flagged ? ', is_test' : ''}`;
        return fetchAll<Owed>((f, t) =>
          db.from('provider_earnings').select(cols).eq('status', 'platform_owed').eq('routed_to_connect', false).range(f, t) as unknown as PromiseLike<{ data: Owed[] | null; error: { message: string } | null }>);
      })(),
    ]);
    if (pastDue > 0) {
      items.push({ id: 'plus-past-due', severity: 'warn', tab: 'parents', filters: { plan: 'plus_past_due' },
        title: `${plural(pastDue, 'Plus subscriber')} with a failed payment`, detail: 'Their card payment failed. Stripe retries, but they may lapse.' });
    }
    const owed = owedRows.filter((r) => isLiveEarning({ vendorIsTest: r.provider?.is_test === true, livemode: r.livemode, flaggedTest: r.is_test }));
    if (owed.length > 0) {
      const dollars = owed.reduce((t, r) => t + Number(r.commission_cents ?? 0), 0) / 100;
      items.push({ id: 'commission-owed', severity: 'info', tab: 'payments',
        title: `$${dollars.toFixed(2)} commission to collect by hand`,
        detail: `${plural(owed.length, 'sale')} on vendors you settle manually. See the Payments tab.` });
    }
  }

  return NextResponse.json({ items });
}
