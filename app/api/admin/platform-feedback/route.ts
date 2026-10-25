import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * What parents think of BabyBrain itself (platform_feedback, migration 00253),
 * for the top of /admin → Reviews: every rating with its comment and who left
 * it, newest first. Read-only.
 *
 * `missing: true` when the table isn't there yet (00253 not applied), so the
 * tab says so instead of showing an error.
 */

type Row = { id: string; user_id: string; rating: number; comment: string | null; created_at: string; updated_at: string };

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const db = createAdminClient() as unknown as SupabaseClient;

  const { data, error } = await db
    .from('platform_feedback')
    .select('id, user_id, rating, comment, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(2000);
  if (error) {
    // 42P01 = undefined_table; PGRST205 = PostgREST can't find it in its schema cache.
    if (error.code === '42P01' || error.code === 'PGRST205') return NextResponse.json({ rows: [], missing: true });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const feedback = (data ?? []) as Row[];

  const userIds = [...new Set(feedback.map((r) => r.user_id))];
  const { data: parents } = userIds.length
    ? await db.from('parent_profiles').select('id, full_name, email').in('id', userIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const parentBy = new Map(((parents ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p]));

  const rows = feedback.map((r) => {
    const p = parentBy.get(r.user_id);
    return {
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      name: p?.full_name?.trim() || null,
      email: p?.email ?? null,
    };
  });
  return NextResponse.json({ rows, missing: false });
}
