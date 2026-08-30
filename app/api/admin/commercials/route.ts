import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Database, FeePayer, SubscriptionPlan } from '@/types/database';

/**
 * Bespoke commercial terms per vendor, for the founder's /admin panel.
 *
 * GET   — every vendor that can take bookings, with its terms and what it has
 *         earned BabyBrain so far.
 * PATCH — set one vendor's terms. { provider_id, commission_rate?,
 *         commission_flat_cents?, fee_payer?, commission_on_packages? }
 *
 * Terms are read at checkout and stamped onto each sale, so a change here
 * applies to future sales only — past earnings keep the deal they were made
 * under. See lib/commercials.ts.
 */

/** Guard rails on a hand-typed rate: 0–50%, and no negative flat fee. */
function validate(body: Record<string, unknown>): string | null {
  if (body.commission_rate !== undefined) {
    const rate = Number(body.commission_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 0.5) {
      return 'Commission rate must be between 0 and 0.5 (0–50%).';
    }
  }
  if (body.commission_flat_cents !== undefined) {
    const flat = Number(body.commission_flat_cents);
    if (!Number.isInteger(flat) || flat < 0) return 'Flat fee must be a whole number of cents, 0 or more.';
  }
  if (body.fee_payer !== undefined && !['platform', 'vendor'].includes(String(body.fee_payer))) {
    return "fee_payer must be 'platform' or 'vendor'.";
  }
  return null;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data: subs } = await admin
    .from('subscriptions')
    .select('provider_id, plan, commission_rate, commission_flat_cents, fee_payer, commission_on_packages, custom_terms');

  const providerIds = (subs ?? []).map((s) => s.provider_id);
  const { data: providers } = providerIds.length
    ? await admin
        .from('providers')
        .select('id, business_name, stripe_account_id, payouts_enabled')
        .in('id', providerIds)
    : { data: [] };
  const byId = new Map((providers ?? []).map((p) => [p.id, p]));

  // Lifetime totals per vendor, so the founder can see what a rate is worth
  // before changing it.
  const { data: earnings } = await admin
    .from('provider_earnings')
    .select('provider_id, gross_cents, commission_cents, net_cents, status');
  const totals = new Map<string, { gross: number; commission: number; net: number; sales: number }>();
  for (const e of earnings ?? []) {
    if (e.status === 'refunded') continue;
    const t = totals.get(e.provider_id) ?? { gross: 0, commission: 0, net: 0, sales: 0 };
    t.gross += e.gross_cents;
    t.commission += e.commission_cents;
    t.net += e.net_cents;
    t.sales += 1;
    totals.set(e.provider_id, t);
  }

  const rows = (subs ?? [])
    .map((s) => {
      const provider = byId.get(s.provider_id);
      const t = totals.get(s.provider_id);
      return {
        provider_id: s.provider_id,
        business_name: provider?.business_name ?? '(unknown)',
        plan: s.plan as SubscriptionPlan,
        connected: Boolean(provider?.stripe_account_id),
        payouts_enabled: Boolean(provider?.payouts_enabled),
        commission_rate: Number(s.commission_rate),
        commission_flat_cents: s.commission_flat_cents,
        fee_payer: s.fee_payer as FeePayer,
        commission_on_packages: s.commission_on_packages,
        custom_terms: s.custom_terms,
        lifetime_gross_cents: t?.gross ?? 0,
        lifetime_commission_cents: t?.commission ?? 0,
        lifetime_net_cents: t?.net ?? 0,
        sales_count: t?.sales ?? 0,
      };
    })
    .sort((a, b) => b.lifetime_commission_cents - a.lifetime_commission_cents);

  return NextResponse.json({ vendors: rows });
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const providerId = body?.provider_id ? String(body.provider_id) : null;
  if (!body || !providerId) {
    return NextResponse.json({ error: 'provider_id required' }, { status: 400 });
  }
  const invalid = validate(body);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  // Patch-style: only what was sent is written, so one field can be changed
  // without resetting the rest of the deal.
  const patch: Database['public']['Tables']['subscriptions']['Update'] = {};
  if (body.commission_rate !== undefined) patch.commission_rate = Number(body.commission_rate);
  if (body.commission_flat_cents !== undefined) patch.commission_flat_cents = Number(body.commission_flat_cents);
  if (body.fee_payer !== undefined) patch.fee_payer = body.fee_payer as FeePayer;
  if (body.commission_on_packages !== undefined) {
    patch.commission_on_packages = Boolean(body.commission_on_packages);
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 });
  }
  // Setting a rate or flat fee by hand makes this a negotiated deal, so a
  // later plan change stops overwriting it (see 00052_commission_follows_plan).
  if (patch.commission_rate !== undefined || patch.commission_flat_cents !== undefined) {
    patch.custom_terms = true;
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from('subscriptions')
    .update(patch)
    .eq('provider_id', providerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, applied: patch });
}
