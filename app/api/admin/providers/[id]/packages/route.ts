import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { logAdminAction } from '@/lib/admin-audit';
import { requireAdmin } from '@/lib/admin';
import { deletePackage, savePackage, type PackageInput } from '@/lib/admin-vendor-content';

/**
 * A vendor's class packs, from the /admin vendor editor.
 *
 * POST   — add one.
 * PATCH  — change one ({ packageId, ...fields }); `active` pauses / resumes it.
 * DELETE — ?packageId=…; refused once anyone has bought it (pause it instead).
 */
type Body = PackageInput & { packageId?: string };

async function audit(auth: Extract<Awaited<ReturnType<typeof requireAdmin>>, { ok: true }>,
                     providerId: string, action: string, summary: string, packageId: string) {
  await logAdminAction(createAdminClient() as unknown as SupabaseClient, { ...auth.user, role: auth.role }, {
    action, entityType: 'vendor', entityId: providerId, summary, details: { packageId },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  try {
    const saved = await savePackage(id, null, body);
    await audit(auth, id, 'vendor.package.create', `Added pack "${saved.name}"`, saved.id);
    return NextResponse.json({ ok: true, package: saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not save' }, { status: 400 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.packageId) return NextResponse.json({ error: 'packageId required' }, { status: 400 });
  try {
    const saved = await savePackage(id, body.packageId, body);
    const verb = body.active === false ? 'Paused' : body.active === true ? 'Resumed' : 'Edited';
    await audit(auth, id, 'vendor.package.update', `${verb} pack "${saved.name}"`, saved.id);
    return NextResponse.json({ ok: true, package: saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not save' }, { status: 400 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const packageId = new URL(request.url).searchParams.get('packageId');
  if (!packageId) return NextResponse.json({ error: 'packageId required' }, { status: 400 });
  try {
    const gone = await deletePackage(id, packageId);
    await audit(auth, id, 'vendor.package.delete', `Deleted pack "${gone.name}"`, gone.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not delete' }, { status: 409 });
  }
}
