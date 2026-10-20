import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { logAdminAction } from '@/lib/admin-audit';
import { requireAdmin } from '@/lib/admin';
import { savePolicy, type PolicyInput } from '@/lib/admin-vendor-content';

/**
 * A vendor's waivers & consents, from the /admin vendor editor.
 *
 * POST  — add one ({ title, body, document_url, required, activity_ids }).
 * PATCH — change one ({ policyId, ...fields }); `active: false` turns it off. Policies are
 *         never deleted: acceptance records point at them (same as the vendor portal).
 */
async function handle(request: Request, params: Promise<{ id: string }>, mode: 'create' | 'update') {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as (PolicyInput & { policyId?: string }) | null;
  if (!body) return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  if (mode === 'update' && !body.policyId) return NextResponse.json({ error: 'policyId required' }, { status: 400 });

  try {
    const saved = await savePolicy(id, mode === 'update' ? body.policyId! : null, body);
    await logAdminAction(createAdminClient() as unknown as SupabaseClient, { ...auth.user, role: auth.role }, {
      action: mode === 'create' ? 'vendor.policy.create' : 'vendor.policy.update',
      entityType: 'vendor', entityId: id,
      summary: `${mode === 'create' ? 'Added' : body.active === false ? 'Turned off' : body.active === true ? 'Turned on' : 'Edited'} waiver/consent "${saved.title}"`,
      details: { policyId: saved.id },
    });
    return NextResponse.json({ ok: true, policy: saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not save' }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'create');
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'update');
}
