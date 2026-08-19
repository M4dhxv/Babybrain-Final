import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  createProviderWithCatalogue,
  VENDOR_CATEGORIES,
  type NewProvider,
  type VendorCategory,
} from '@/lib/admin-create-provider';

/**
 * Add a directory vendor by hand from /admin, and list what's already there.
 *
 * GET  — the categories the form offers, plus the most recent vendors, so the
 *        founder can see at a glance whether a business is already listed.
 * POST — creates the provider, its venues and its classes in one go.
 *
 * Geocoding each venue means several OneMap round-trips, so allow more than the
 * default execution window.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const db = createAdminClient();
  const [cats, providers] = await Promise.all([
    db.from('activity_categories').select('slug, name').order('name'),
    db
      .from('providers')
      .select('id, business_name, slug, vendor_category, region, status, is_claimed, is_auto_listed, created_at')
      .order('created_at', { ascending: false })
      .limit(25),
  ]);

  if (cats.error) return NextResponse.json({ error: cats.error.message }, { status: 500 });
  if (providers.error) return NextResponse.json({ error: providers.error.message }, { status: 500 });

  return NextResponse.json({
    categories: cats.data ?? [],
    vendorCategories: VENDOR_CATEGORIES,
    recent: providers.data ?? [],
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await request.json().catch(() => null)) as NewProvider | null;
  if (!body) return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });

  if (!body.business_name?.trim()) {
    return NextResponse.json({ error: 'Business name is required.' }, { status: 400 });
  }
  if (!VENDOR_CATEGORIES.includes(body.vendor_category as VendorCategory)) {
    return NextResponse.json(
      { error: `Business type must be one of: ${VENDOR_CATEGORIES.join(', ')}.` },
      { status: 400 }
    );
  }

  try {
    const result = await createProviderWithCatalogue(body);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // The helper raises readable messages (duplicate slug, unknown category,
    // rolled-back create), so pass them straight through to the panel.
    const message = e instanceof Error ? e.message : 'Could not create the vendor.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
