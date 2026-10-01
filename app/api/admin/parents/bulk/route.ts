import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { invalidateParents } from '@/lib/admin-parents';
import { logAdminAction } from '@/lib/admin-audit';
import { OVERRIDE_LABEL, applyOverride, parseOverride } from '@/lib/admin-test-override';

/**
 * Admin → Parents bulk action: set several parents to automatic / test / real parent at once.
 * Body: { ids: string[], mode: 'auto' | 'test' | 'real' } (the older { is_test } still works).
 * Admin only; at most 200 per call; one audit entry.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await request.json().catch(() => null)) as { ids?: unknown; mode?: unknown; is_test?: unknown } | null;
  const mode = parseOverride(body);
  if (!body || !Array.isArray(body.ids) || !mode) {
    return NextResponse.json({ error: "Expected { ids: string[], mode: 'auto' | 'test' | 'real' }." }, { status: 400 });
  }
  const ids = [...new Set(body.ids.filter((i): i is string => typeof i === 'string' && UUID.test(i)))];
  if (ids.length === 0) return NextResponse.json({ error: 'No valid parents selected.' }, { status: 400 });
  if (ids.length > 200) return NextResponse.json({ error: 'Select at most 200 parents at a time.' }, { status: 400 });

  const db = createAdminClient() as unknown as SupabaseClient;
  const r = await applyOverride(db, ids, mode);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  invalidateParents();
  await logAdminAction(db, { ...auth.user, role: auth.role }, {
    action: `parent.bulk_override_${mode}`, entityType: 'parent',
    summary: `${r.rows.length} parent${r.rows.length === 1 ? '' : 's'} ${OVERRIDE_LABEL[mode]}`,
    details: { emails: r.rows.map((c) => c.email) },
  });
  return NextResponse.json({ ok: true, updated: r.rows.length, mode });
}
