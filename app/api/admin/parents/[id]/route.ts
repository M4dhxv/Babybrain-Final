import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { invalidateParents, loadParents } from '@/lib/admin-parents';
import { getStripe } from '@/lib/stripe';

/**
 * One parent, for the /admin → Parents detail panel.
 *
 * GET   — everything held on the account: profile, consent and terms, children,
 *         preferences, plan, and booking history.
 * PATCH — { is_test: boolean } marks / unmarks the account as a test account.
 */

type Params = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: Params) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such parent.' }, { status: 404 });
  const db = createAdminClient() as unknown as SupabaseClient;

  const [profile, kids, prefs, sub, bookings, parentRows] = await Promise.all([
    db.from('parent_profiles').select('*').eq('id', id).maybeSingle(),
    db.from('children').select('id, name, date_of_birth, gender, interests, notes, created_at').eq('parent_id', id).order('date_of_birth', { ascending: false }),
    db.from('user_preferences').select('preferred_days, preferred_times, preferred_regions, budget_min, budget_max, interests').eq('user_id', id).maybeSingle(),
    db.from('customer_subscriptions').select('plan, billing_interval, status, current_period_end, cancel_at_period_end, stripe_customer_id').eq('user_id', id).maybeSingle(),
    db.from('bookings')
      .select('id, status, payment_status, amount, created_at, guest_name, child_id, session:activity_sessions(starts_at, activity:activities(title))')
      .eq('user_id', id).order('created_at', { ascending: false }).limit(100),
    loadParents(db),
  ]);
  if (profile.error) return NextResponse.json({ error: profile.error.message }, { status: 500 });
  if (!profile.data) return NextResponse.json({ error: 'No such parent.' }, { status: 404 });

  // What the parent has paid for their plan lives only in Stripe: read their paid invoices.
  // If Stripe can't be reached (or the customer is from the other Stripe mode) the panel just omits it.
  let planPayments: { id: string; paidAt: string; amount: number; currency: string; description: string | null }[] = [];
  const customerId = (sub.data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
  if (customerId) {
    try {
      const list = await getStripe().invoices.list({ customer: customerId, status: 'paid', limit: 24 });
      planPayments = list.data
        .filter((i) => i.amount_paid > 0)
        .map((i) => ({
          id: i.id ?? '',
          paidAt: new Date((i.status_transitions?.paid_at ?? i.created) * 1000).toISOString(),
          amount: i.amount_paid / 100,
          currency: i.currency,
          description: i.lines.data[0]?.description ?? null,
        }));
    } catch { /* leave empty */ }
  }

  const p = profile.data as Record<string, unknown> & { email: string; is_test?: boolean | null };
  const row = parentRows.find((r) => r.id === id);
  return NextResponse.json({
    profile: p,
    children: kids.data ?? [],
    preferences: prefs.data ?? null,
    subscription: sub.data ?? null,
    planPayments,
    bookings: bookings.data ?? [],
    isTest: row?.isTest ?? !!p.is_test,
    testSource: row?.testSource ?? (p.is_test ? 'manual' : null),
    testReason: row?.testReason ?? null,
    isVendor: row?.isVendor ?? false,
    vendorNames: row?.vendorNames ?? [],
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such parent.' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { is_test?: unknown } | null;
  if (!body || typeof body.is_test !== 'boolean') {
    return NextResponse.json({ error: 'Expected { is_test: boolean }.' }, { status: 400 });
  }

  const db = createAdminClient() as unknown as SupabaseClient;
  const { data, error } = await db.from('parent_profiles').update({ is_test: body.is_test }).eq('id', id).select('id').maybeSingle();
  if (error) {
    const needsMigration = /is_test/.test(error.message);
    return NextResponse.json({
      error: needsMigration ? 'Marking test accounts needs migration 00207 applied to the database first.' : error.message,
    }, { status: needsMigration ? 409 : 500 });
  }
  if (!data) return NextResponse.json({ error: 'No such parent.' }, { status: 404 });
  invalidateParents();
  return NextResponse.json({ ok: true, is_test: body.is_test });
}
