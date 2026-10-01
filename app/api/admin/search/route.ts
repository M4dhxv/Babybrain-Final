import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Admin quick search (Ctrl/Cmd+K): parents by name, email, phone or postal code, and, for admins
 * (not support), vendors by business name. A handful of results each; the full lists have their
 * own filters.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request, ['admin', 'support']);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Strip characters that mean something inside a PostgREST filter expression.
  const q = (new URL(request.url).searchParams.get('q') ?? '').replace(/[,()%_*\\]/g, ' ').trim().slice(0, 60);
  if (q.length < 2) return NextResponse.json({ parents: [], vendors: [] });

  const db = createAdminClient() as unknown as SupabaseClient;
  const like = `%${q}%`;
  const [parents, vendors] = await Promise.all([
    db.from('parent_profiles').select('id, full_name, email, phone')
      .or(`full_name.ilike.${like},email.ilike.${like},phone.ilike.${like},postal_code.ilike.${like}`)
      .order('created_at', { ascending: false }).limit(6),
    auth.role === 'admin'
      ? db.from('providers').select('id, business_name, status').ilike('business_name', like).order('business_name').limit(6)
      : Promise.resolve({ data: [] as { id: string; business_name: string; status: string }[], error: null }),
  ]);
  return NextResponse.json({
    parents: (parents.data ?? []).map((p: { id: string; full_name: string | null; email: string; phone: string | null }) =>
      ({ id: p.id, name: p.full_name || p.email, email: p.email, phone: p.phone })),
    vendors: (vendors.data ?? []).map((v: { id: string; business_name: string; status: string }) => ({ id: v.id, name: v.business_name, status: v.status })),
  });
}
