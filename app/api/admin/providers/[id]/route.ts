import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { getProviderDetail, updateProviderWithCatalogue } from '@/lib/admin-update-provider';

/**
 * One directory vendor, for the /admin editor.
 *
 * GET   — the business plus its venues and classes, ready to fill the form.
 * PATCH — save changes. Patch-style: only what's sent is written, so the form
 *         can save one section without blanking the others.
 *
 * Venue edits re-run the OneMap lookup, so allow more than the default window.
 */
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  try {
    const detail = await getProviderDetail(id);
    if (!detail) return NextResponse.json({ error: 'No such vendor.' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not load' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Parameters<typeof updateProviderWithCatalogue>[1] | null;
  if (!body) return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });

  try {
    const result = await updateProviderWithCatalogue(id, body);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // The helper raises readable messages (slug clash, unknown category,
    // vendor gone), so pass them through rather than a generic 500.
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not save' }, { status: 400 });
  }
}
