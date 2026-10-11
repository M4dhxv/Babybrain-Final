import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { logAdminAction } from '@/lib/admin-audit';
import { createAdminClient } from '@/lib/supabase/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mark an event issue (a registrant's "Report issue" / "email corrected" item) resolved, or reopen it. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such issue.' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
  const status = body?.status;
  if (status !== 'resolved' && status !== 'open') return NextResponse.json({ error: 'Status must be resolved or open.' }, { status: 400 });

  const db = createAdminClient() as unknown as SupabaseClient;
  const { data, error } = await db.from('event_issues')
    .update({
      status,
      resolved_at: status === 'resolved' ? new Date().toISOString() : null,
      resolved_by: status === 'resolved' ? (auth.user.email ?? 'admin') : null,
    })
    .eq('id', id).select('id').maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'No such issue.' }, { status: 404 });

  await logAdminAction(db, { ...auth.user, role: auth.role }, {
    action: 'event_issue.status',
    entityType: 'event_issue',
    entityId: id,
    summary: `Marked an event issue ${status}`,
  });
  return NextResponse.json({ ok: true, status });
}
