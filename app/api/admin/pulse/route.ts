import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * A few cheap counts the admin polls every minute, so it can say "new signups / bookings since you
 * opened this" and badge the inbox, without refetching whole tabs. Counts only, nothing heavy.
 */
const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
  try { const r = await q; return r.error ? 0 : r.count ?? 0; } catch { return 0; }
};

export async function GET(request: Request) {
  const auth = await requireAdmin(request, ['admin', 'support']);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const db = createAdminClient() as unknown as SupabaseClient;
  const [parents, bookings, undelivered] = await Promise.all([
    count(db.from('parent_profiles').select('id', { count: 'exact', head: true })),
    count(db.from('bookings').select('id', { count: 'exact', head: true })),
    count(db.from('contact_messages').select('id', { count: 'exact', head: true }).eq('emailed', false)),
  ]);
  // Money counts are for admins only.
  return NextResponse.json({ parents, bookings: auth.role === 'admin' ? bookings : 0, contactUndelivered: undelivered });
}
