import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { invalidateBookings } from '@/lib/admin-bookings';
import { logAdminAction } from '@/lib/admin-audit';

/**
 * Admin → Bookings → "Create booking": book a customer into a class with a class-pack credit, a
 * make-up token, or as a manual (phone / walk-in) booking. Admin only.
 *
 * GET  ?q=text                      customers whose name or email matches
 * GET  ?parent_id=                  that customer's children, usable packs and unused tokens
 * GET  ?class_q=text                upcoming classes whose title or vendor matches
 * POST { action: 'verify' | 'create', method: 'credit' | 'token' | 'manual', session_id,
 *        parent_id?, purchase_id?, token_id?, child_id?, guest_name?, guest_contact?, paid?,
 *        allow_over_capacity?, reason }
 *
 * The safeguard lives in the database (migration 00270): admin_booking_checks() cross-verifies the
 * credit or token against the class (above all that both belong to the same vendor), and
 * admin_create_booking() re-runs it under row locks before it writes, then reads the balance back.
 * 'verify' only runs the checks; 'create' cannot skip them.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ['credit', 'token', 'manual'] as const;
type Method = (typeof METHODS)[number];
/** Keep user text out of PostgREST's filter syntax. */
const clean = (v: string | null) => (v ?? '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 60);
const id = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const sp = new URL(request.url).searchParams;
  const db = createAdminClient() as unknown as SupabaseClient;

  // ---- customers ----
  const q = clean(sp.get('q'));
  if (sp.has('q')) {
    if (q.length < 2) return NextResponse.json({ parents: [] });
    const { data, error } = await db.from('parent_profiles').select('id, full_name, email, phone')
      .or(`email.ilike.%${q}%,full_name.ilike.%${q}%,phone.ilike.%${q}%`).order('created_at', { ascending: false }).limit(15);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      parents: (data ?? []).map((p: { id: string; full_name: string | null; email: string; phone: string | null }) =>
        ({ id: p.id, name: p.full_name?.trim() || p.email, email: p.email, phone: p.phone })),
    });
  }

  // ---- one customer's children, packs and tokens ----
  const parentId = id(sp.get('parent_id'));
  if (sp.has('parent_id')) {
    if (!parentId) return NextResponse.json({ error: 'No such customer.' }, { status: 404 });
    const [kids, packs, toks] = await Promise.all([
      db.from('children').select('id, name').eq('parent_id', parentId).order('created_at'),
      db.from('package_purchases')
        .select('id, credits_total, credits_remaining, status, expires_at, provider_id, package:packages(name), provider:providers(business_name)')
        .eq('user_id', parentId).eq('status', 'active').gt('credits_remaining', 0).order('created_at', { ascending: false }),
      db.from('make_up_tokens')
        .select('id, expires_at, child_id, provider_id, provider:providers(business_name)')
        .eq('user_id', parentId).eq('status', 'issued').order('created_at', { ascending: false }),
    ]);
    const err = kids.error ?? packs.error ?? toks.error;
    if (err) return NextResponse.json({ error: err.message }, { status: 500 });
    const now = Date.now();
    const live = (exp: string | null) => !exp || Date.parse(exp) > now;
    const kidName = new Map(((kids.data ?? []) as { id: string; name: string }[]).map((k) => [k.id, k.name]));
    type PackRow = { id: string; credits_total: number; credits_remaining: number; expires_at: string | null; provider_id: string; package: { name: string } | null; provider: { business_name: string } | null };
    type TokRow = { id: string; expires_at: string | null; child_id: string | null; provider_id: string; provider: { business_name: string } | null };
    return NextResponse.json({
      children: kids.data ?? [],
      packs: ((packs.data ?? []) as unknown as PackRow[]).filter((p) => live(p.expires_at)).map((p) => ({
        id: p.id, name: p.package?.name ?? 'Package', vendorId: p.provider_id, vendorName: p.provider?.business_name ?? '(unknown vendor)',
        remaining: p.credits_remaining, total: p.credits_total, expiresAt: p.expires_at,
      })),
      tokens: ((toks.data ?? []) as unknown as TokRow[]).filter((t) => live(t.expires_at)).map((t) => ({
        id: t.id, vendorId: t.provider_id, vendorName: t.provider?.business_name ?? '(unknown vendor)',
        childId: t.child_id, childName: t.child_id ? kidName.get(t.child_id) ?? null : null, expiresAt: t.expires_at,
      })),
    });
  }

  // ---- upcoming classes ----
  if (sp.has('class_q')) {
    const cq = clean(sp.get('class_q'));
    if (cq.length < 2) return NextResponse.json({ classes: [] });
    const { data: vend } = await db.from('providers').select('id').ilike('business_name', `%${cq}%`).limit(20);
    const vendorIds = (vend ?? []).map((v: { id: string }) => v.id);
    const filter = vendorIds.length ? `title.ilike.%${cq}%,provider_id.in.(${vendorIds.join(',')})` : `title.ilike.%${cq}%`;
    const { data: acts, error: aerr } = await db.from('activities').select('id, title, provider_id, provider:providers(business_name, is_test)').or(filter).limit(40);
    if (aerr) return NextResponse.json({ error: aerr.message }, { status: 500 });
    type Act = { id: string; title: string; provider_id: string; provider: { business_name: string } | null };
    const actBy = new Map(((acts ?? []) as unknown as Act[]).map((a) => [a.id, a]));
    if (actBy.size === 0) return NextResponse.json({ classes: [] });
    const { data: sess, error: serr } = await db.from('activity_sessions')
      .select('id, activity_id, starts_at, capacity').in('activity_id', [...actBy.keys()]).gt('starts_at', new Date().toISOString())
      .order('starts_at').limit(40);
    if (serr) return NextResponse.json({ error: serr.message }, { status: 500 });
    const rows = (sess ?? []) as { id: string; activity_id: string; starts_at: string; capacity: number | null }[];
    const taken = new Map<string, number>();
    if (rows.length) {
      const { data: bk } = await db.from('bookings').select('session_id').in('session_id', rows.map((r) => r.id)).in('status', ['pending', 'confirmed']);
      for (const b of (bk ?? []) as { session_id: string }[]) taken.set(b.session_id, (taken.get(b.session_id) ?? 0) + 1);
    }
    return NextResponse.json({
      classes: rows.map((r) => {
        const a = actBy.get(r.activity_id)!;
        return { id: r.id, title: a.title, vendorId: a.provider_id, vendorName: a.provider?.business_name ?? '', startsAt: r.starts_at, capacity: r.capacity, taken: taken.get(r.id) ?? 0 };
      }),
    });
  }

  return NextResponse.json({ error: 'Nothing to look up.' }, { status: 400 });
}

type Body = {
  action?: string; method?: string; session_id?: string; parent_id?: string; purchase_id?: string; token_id?: string; child_id?: string;
  guest_name?: string; guest_contact?: string; paid?: boolean; allow_over_capacity?: boolean; reason?: string;
};

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = (await request.json().catch(() => ({}))) as Body;
  const method = METHODS.find((m) => m === body.method) as Method | undefined;
  const sessionId = id(body.session_id);
  if (!method || !sessionId) return NextResponse.json({ error: 'Choose a booking type and a class.' }, { status: 400 });
  if (body.action !== 'verify' && body.action !== 'create') return NextResponse.json({ error: "action must be 'verify' or 'create'." }, { status: 400 });

  const parentId = id(body.parent_id);
  const purchaseId = id(body.purchase_id);
  const tokenId = id(body.token_id);
  const childId = id(body.child_id);
  if (method !== 'manual' && !parentId) return NextResponse.json({ error: 'Choose the customer.' }, { status: 400 });
  if (method === 'credit' && !purchaseId) return NextResponse.json({ error: 'Choose the package credit to use.' }, { status: 400 });
  if (method === 'token' && !tokenId) return NextResponse.json({ error: 'Choose the make-up token to use.' }, { status: 400 });

  const db = createAdminClient() as unknown as SupabaseClient;
  const allowOver = !!body.allow_over_capacity;

  if (body.action === 'verify') {
    const { data, error } = await db.rpc('admin_booking_checks', {
      p_user_id: parentId, p_session_id: sessionId, p_method: method, p_purchase_id: purchaseId, p_token_id: tokenId,
      p_child_id: childId, p_allow_over_capacity: allowOver,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  const reason = (body.reason ?? '').trim();
  if (reason.length < 3) return NextResponse.json({ error: 'Add a short reason (it goes in the audit log).' }, { status: 400 });
  const guestName = (body.guest_name ?? '').trim();
  if (method === 'manual' && !guestName) return NextResponse.json({ error: 'Enter the customer\'s name.' }, { status: 400 });

  // Read what is being spent first, so the audit entry says what it was.
  const before = await db.rpc('admin_booking_checks', {
    p_user_id: parentId, p_session_id: sessionId, p_method: method, p_purchase_id: purchaseId, p_token_id: tokenId,
    p_child_id: childId, p_allow_over_capacity: allowOver,
  });
  const beforeData = before.data as { class?: { title?: string; vendor?: string }; funding?: { vendor?: string; label?: string; remaining?: number } | null } | null;

  const { data, error } = await db.rpc('admin_create_booking', {
    p_user_id: parentId, p_session_id: sessionId, p_method: method, p_purchase_id: purchaseId, p_token_id: tokenId, p_child_id: childId,
    p_guest_name: method === 'manual' ? guestName : null, p_guest_contact: method === 'manual' ? (body.guest_contact ?? '').trim() || null : null,
    p_paid: !!body.paid, p_allow_over_capacity: allowOver,
  });
  if (error) {
    // The function's own refusals read well ("Not booked. …"); anything else is a database error.
    const refused = error.message.startsWith('Not booked.') || error.message.includes('is required') || error.message.includes('no longer exists');
    if (!refused) console.error('admin_create_booking failed', error);
    return NextResponse.json({ error: refused ? error.message : 'Could not create the booking. Nothing was changed.' }, { status: refused ? 409 : 500 });
  }
  const out = data as { booking_id: string; status: string; credits_before?: number; credits_after?: number };

  invalidateBookings();
  const who = method === 'manual' ? guestName : parentId;
  await logAdminAction(db, { ...auth.user, role: auth.role }, {
    action: `booking.admin_create_${method}`, entityType: 'booking', entityId: out.booking_id,
    summary: `Booked ${who} into ${beforeData?.class?.title ?? 'a class'} (${beforeData?.class?.vendor ?? 'unknown vendor'}) by ${method === 'manual' ? 'manual booking' : method === 'credit' ? 'package credit' : 'make-up token'}. Reason: ${reason}`,
    details: { method, reason, sessionId, parentId, purchaseId, tokenId, childId, funding: beforeData?.funding ?? null, result: out },
  });
  return NextResponse.json({ ok: true, ...out });
}
