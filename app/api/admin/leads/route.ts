import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Email leads: visitors who left their email without creating an account
 * (public.leads, migration 00028) from the Explore pop-up or the home page.
 * Nobody can read this table through the public API, so the admin reads it here
 * with the service role.
 *
 * Returns the rows newest first, each marked with whether that email already
 * belongs to a parent account, plus per-source counts. `?format=csv` downloads
 * the same list.
 */

type Lead = { id: string; email: string; source: string | null; child_age_months: number | null; created_at: string };

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // `leads` isn't in the generated Database types, so use an untyped client.
  const db = createAdminClient() as unknown as SupabaseClient;
  const leads: Lead[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('leads')
      .select('id, email, source, child_age_months, created_at')
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    leads.push(...((data ?? []) as Lead[]));
    if (!data || data.length < 1000) break;
  }

  const parentEmails = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('parent_profiles').select('email').range(from, from + 999);
    for (const r of (data ?? []) as { email: string | null }[]) if (r.email) parentEmails.add(r.email.trim().toLowerCase());
    if (!data || data.length < 1000) break;
  }

  const firstSeen = new Map<string, string>();
  for (const l of [...leads].reverse()) {
    const key = l.email.trim().toLowerCase();
    if (!firstSeen.has(key)) firstSeen.set(key, l.id);
  }
  const rows = leads.map((l) => {
    const key = l.email.trim().toLowerCase();
    return {
      id: l.id,
      email: l.email.trim(),
      source: l.source ?? 'unknown',
      childAgeMonths: l.child_age_months,
      createdAt: l.created_at,
      isParent: parentEmails.has(key),
      // Later submissions of an email already captured; counted once in "unique".
      duplicate: firstSeen.get(key) !== l.id,
    };
  });

  const url = new URL(request.url);
  if (url.searchParams.get('format') === 'csv') {
    const headers = ['email', 'source', 'captured_at', 'already_a_parent', 'duplicate'];
    const csv = [headers.join(','), ...rows.map((r) => [r.email, r.source, r.createdAt, r.isParent ? 'yes' : 'no', r.duplicate ? 'yes' : 'no'].map(csvCell).join(','))].join('\n') + '\n';
    return new NextResponse(csv, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="babybrain-leads.csv"' },
    });
  }

  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  return NextResponse.json({
    rows,
    total: rows.length,
    unique: firstSeen.size,
    alreadyParents: new Set(rows.filter((r) => r.isParent).map((r) => r.email.toLowerCase())).size,
    bySource,
  });
}
