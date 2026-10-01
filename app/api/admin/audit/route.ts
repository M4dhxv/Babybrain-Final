import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Admin → Audit log: who changed what, newest first. Admin only.
 *   ?limit=100..1000   ?action=parent.mark_test (prefix match, e.g. "vendor")   ?q=text in the summary
 * Returns { rows: [], missing: true } until migration 00211 has been applied.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sp = new URL(request.url).searchParams;
  const requested = Number(sp.get('limit') ?? 200);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 1000) : 200;
  const action = (sp.get('action') ?? '').trim();
  const q = (sp.get('q') ?? '').trim();

  const db = createAdminClient() as unknown as SupabaseClient;
  let query = db.from('admin_audit_log').select('id, at, actor_email, actor_role, action, entity_type, entity_id, summary, details')
    .order('at', { ascending: false }).limit(limit);
  if (action) query = query.ilike('action', `${action.replace(/[%_]/g, '')}%`);
  if (q) query = query.ilike('summary', `%${q.replace(/[%_]/g, '')}%`);
  const { data, error } = await query;
  if (error) {
    // Table not created yet: the page says so instead of failing.
    if (/admin_audit_log/.test(error.message)) return NextResponse.json({ rows: [], missing: true });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [], missing: false });
}
