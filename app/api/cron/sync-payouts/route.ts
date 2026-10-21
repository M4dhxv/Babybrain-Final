import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { refreshStalePayouts } from '@/lib/stripe-connect';

/**
 * Hourly safety net for `providers.payouts_enabled` (pg_cron, migration 00248).
 *
 * The flag normally turns on through Stripe's `account.updated` Connect webhook. When that doesn't
 * arrive, it only refreshed when someone from the vendor opened their Billing page — so a vendor
 * who finished Stripe and never came back stayed "no Stripe" (Inspire Mum & Baby, 2026-10-21: the
 * admin editor refused to publish their classes, and their paid bookings would have been collected
 * by BabyBrain instead of being split to them). This asks Stripe about every vendor that has an
 * account but payouts off, and corrects the flag. Nothing changes when Stripe can't be reached.
 *
 * Guarded by the same shared secret as the other cron routes.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.WEBHOOK_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: stale, error } = await admin
    .from('providers')
    .select('id, business_name, stripe_account_id, payouts_enabled')
    .not('stripe_account_id', 'is', null)
    .eq('payouts_enabled', false)
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const turnedOn: string[] = [];
  let unreachable = 0;
  for (const p of stale ?? []) {
    const r = await refreshStalePayouts(admin, p);
    if (!r.checked) unreachable += 1;
    else if (r.payouts_enabled) turnedOn.push(p.business_name ?? p.id);
  }
  if (turnedOn.length) console.log(`[sync-payouts] payouts now on for: ${turnedOn.join(', ')}`);
  return NextResponse.json({ ok: true, checked: (stale ?? []).length, turned_on: turnedOn, unreachable });
}
