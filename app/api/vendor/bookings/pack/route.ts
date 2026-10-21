import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';

/**
 * A vendor books a parent who bought one of their packs onto a class, using the pack's credits
 * (client, 2026-10-21).
 *
 *   GET  ?provider_id=…&session_id=…  → the parents holding usable credits with this business, each
 *        with their children and whether the pack can be used for this session (and why not).
 *   POST { provider_id, session_id, purchase_id, child_id?, quantity?, guest_names? } → books it
 *        through vendor_book_with_package (migration 00249): same rules and bookkeeping as the
 *        parent's own redemption, credits only spent on seats actually booked.
 *
 * Shows vendors only what they already see elsewhere (a pack's buyer name on Packages, children's
 * names on rosters). A Wix-linked class is booked on BabyBrain only, like a manual entry.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const sgParts = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return { dow: d.getUTCDay(), hhmm: d.toISOString().slice(11, 16) };
};

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const providerId = q.get('provider_id');
  const sessionId = q.get('session_id');
  if (!providerId || !sessionId) return NextResponse.json({ error: 'provider_id and session_id required' }, { status: 400 });
  const auth = await requireProviderRole(request, providerId, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const db = admin as unknown as SupabaseClient;
  const { data: session } = await db.from('activity_sessions')
    .select('id, starts_at, activity_id, activities!inner(provider_id, wix_service_id, wix_service_type)')
    .eq('id', sessionId).maybeSingle();
  const act = (session as { activities?: { provider_id: string; wix_service_id: string | null; wix_service_type: string | null } } | null)?.activities;
  if (!session || act?.provider_id !== providerId) return NextResponse.json({ error: 'That session isn\'t one of your classes.' }, { status: 404 });
  if (['EVENT', 'COURSE', 'APPOINTMENT'].includes(act.wix_service_type ?? '')) {
    return NextResponse.json({ holders: [], note: 'Pack credits can only be used on classes.' });
  }

  const nowIso = new Date().toISOString();
  const { data: purchases } = await db.from('package_purchases')
    .select('id, user_id, credits_remaining, expires_at, packages(name, activity_ids, allowed_weekday, allowed_start_time)')
    .eq('provider_id', providerId).eq('status', 'active').gt('credits_remaining', 0)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(300);
  const rows = (purchases ?? []) as unknown as Array<{
    id: string; user_id: string; credits_remaining: number; expires_at: string | null;
    packages: { name: string; activity_ids: string[] | null; allowed_weekday: number | null; allowed_start_time: string | null } | null;
  }>;
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const [{ data: parents }, { data: kids }] = await Promise.all([
    userIds.length ? db.from('parent_profiles').select('id, full_name').in('id', userIds) : Promise.resolve({ data: [] }),
    userIds.length ? db.from('children').select('id, parent_id, name').in('parent_id', userIds).order('created_at') : Promise.resolve({ data: [] }),
  ]);
  const nameOf = new Map(((parents ?? []) as { id: string; full_name: string | null }[]).map((p) => [p.id, p.full_name || 'Parent']));
  const kidsOf = new Map<string, { id: string; name: string }[]>();
  for (const k of (kids ?? []) as { id: string; parent_id: string; name: string }[]) {
    kidsOf.set(k.parent_id, [...(kidsOf.get(k.parent_id) ?? []), { id: k.id, name: k.name }]);
  }

  const when = sgParts(session.starts_at as string);
  const holders = rows.map((r) => {
    const pk = r.packages;
    let reason: string | null = null;
    if (pk?.activity_ids?.length && !pk.activity_ids.includes(session.activity_id as string)) reason = 'Pack is for other classes';
    else if (pk?.allowed_weekday != null && pk.allowed_weekday !== when.dow) reason = `Pack is for ${WEEKDAYS[pk.allowed_weekday]}s only`;
    else if (pk?.allowed_start_time && pk.allowed_start_time.slice(0, 5) !== when.hhmm) reason = `Pack is for the ${pk.allowed_start_time.slice(0, 5)} slot only`;
    return {
      purchase_id: r.id, parent_name: nameOf.get(r.user_id) ?? 'Parent', pack_name: pk?.name ?? 'Pack',
      credits_remaining: r.credits_remaining, expires_at: r.expires_at,
      children: kidsOf.get(r.user_id) ?? [], usable: !reason, reason,
    };
  }).sort((a, b) => Number(b.usable) - Number(a.usable) || a.parent_name.localeCompare(b.parent_name));

  return NextResponse.json({ holders, wix_linked: !!act.wix_service_id });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    provider_id?: string; session_id?: string; purchase_id?: string; child_id?: string | null;
    quantity?: number; guest_names?: string[];
  };
  if (!body.provider_id || !body.session_id || !body.purchase_id) {
    return NextResponse.json({ error: 'provider_id, session_id and purchase_id are required' }, { status: 400 });
  }
  const auth = await requireProviderRole(request, body.provider_id, 'manager');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const quantity = Math.min(Math.max(Math.trunc(body.quantity ?? 1), 1), 6);
  const admin = createAdminClient();
  const { data, error } = await (admin as unknown as SupabaseClient)
    .rpc('vendor_book_with_package', {
      p_provider: body.provider_id,
      p_purchase_id: body.purchase_id,
      p_session_id: body.session_id,
      p_child_id: body.child_id ?? null,
      p_quantity: quantity,
      p_guest_names: quantity > 1 ? (body.guest_names ?? []).map((n) => n?.trim() ?? '') : [],
    })
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const { data: s } = await admin.from('activity_sessions').select('activities(wix_service_id)').eq('id', body.session_id).maybeSingle();
  const r = data as { status: string; waitlisted_count: number; credits_left: number };
  return NextResponse.json({
    ok: true, status: r.status, waitlisted: r.waitlisted_count, credits_left: r.credits_left,
    wix_linked: !!(s?.activities as { wix_service_id: string | null } | null)?.wix_service_id,
  });
}
