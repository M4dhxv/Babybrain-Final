import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { logAdminAction } from '@/lib/admin-audit';
import { adminRoleOf, requireAdmin } from '@/lib/admin';

/**
 * "Open vendor portal" in admin → Vendors. Gives the calling admin standing
 * manager-level access to this vendor (00251, no expiry) and hands back a
 * one-time sign-in link to the vendor portal as themselves, opened on that
 * vendor. The admin is never added to the vendor's team.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const db = createAdminClient();

  const { data: provider } = await db.from('providers').select('id, business_name').eq('id', id).maybeSingle();
  if (!provider) return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });

  const { error: grantErr } = await db.from('admin_vendor_access').upsert(
    { user_id: auth.user.id, provider_id: id, granted_by: auth.user.email ?? null, last_opened_at: new Date().toISOString() },
    { onConflict: 'user_id,provider_id' }
  );
  if (grantErr) {
    const missing = /admin_vendor_access/.test(grantErr.message);
    return NextResponse.json(
      { error: missing ? 'Vendor portal access needs migration 00251 applied first.' : grantErr.message },
      { status: 500 }
    );
  }

  // Grants have no expiry, so drop any left by accounts that are no longer
  // admins — the database can't see ADMIN_EMAILS for itself.
  await pruneFormerAdmins(db);

  // A fresh session of the admin's own account for the vendor portal (it keeps
  // its own sign-in, apart from the admin portal's). Nothing is emailed.
  const { data: link, error: linkErr } = await db.auth.admin.generateLink({ type: 'magiclink', email: auth.user.email! });
  const token = link?.properties?.hashed_token;
  if (linkErr || !token) {
    return NextResponse.json({ error: linkErr?.message ?? 'Could not create a sign-in link' }, { status: 500 });
  }

  await logAdminAction(db as unknown as SupabaseClient, { ...auth.user, role: auth.role }, {
    action: 'vendor.portal_open',
    entityType: 'provider',
    entityId: id,
    summary: `Opened ${provider.business_name}'s vendor portal as a manager`,
  });

  const q = new URLSearchParams({ as: id, admin_token: token });
  return NextResponse.json({ url: `/vendor/?${q}` });
}

async function pruneFormerAdmins(db: ReturnType<typeof createAdminClient>) {
  try {
    const { data } = await db.from('admin_vendor_access').select('user_id');
    const ids = [...new Set((data ?? []).map((r) => r.user_id))];
    for (const uid of ids) {
      const { data: u } = await db.auth.admin.getUserById(uid);
      if (u?.user && adminRoleOf(u.user.email) !== 'admin') {
        await db.from('admin_vendor_access').delete().eq('user_id', uid);
      }
    }
  } catch {
    /* best effort — never block opening the portal */
  }
}
