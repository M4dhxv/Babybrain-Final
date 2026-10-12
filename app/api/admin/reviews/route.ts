import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Every parent review, for the /admin → Reviews tab.
 *
 * Returns the reviews (newest first) with the activity and vendor each belongs
 * to and the reviewer's name, plus the vendor list for the filter. Filtering by
 * vendor and grouping by activity happen in the page, so switching vendor
 * doesn't re-read the database.
 */

type Review = {
  id: string; user_id: string; activity_id: string; rating: number; comment: string | null;
  created_at: string; provider_response: string | null; provider_responded_at: string | null;
};

async function all<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await read(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const db = createAdminClient() as unknown as SupabaseClient;

  try {
    const reviews = await all<Review>((f, t) =>
      db.from('reviews')
        .select('id, user_id, activity_id, rating, comment, created_at, provider_response, provider_responded_at')
        .order('created_at', { ascending: false }).range(f, t) as never);

    const activityIds = [...new Set(reviews.map((r) => r.activity_id))];
    const userIds = [...new Set(reviews.map((r) => r.user_id))];
    const [activities, parents] = await Promise.all([
      activityIds.length === 0 ? [] : all<{ id: string; title: string; slug: string | null; provider_id: string | null; provider_name: string | null }>((f, t) =>
        db.from('activities').select('id, title, slug, provider_id, provider_name').in('id', activityIds).range(f, t) as never),
      userIds.length === 0 ? [] : all<{ id: string; full_name: string | null; email: string | null }>((f, t) =>
        db.from('parent_profiles').select('id, full_name, email').in('id', userIds).range(f, t) as never),
    ]);
    // activities.provider_name is free text and blank on many listings; the vendor's real name is
    // the provider row the activity belongs to.
    const providerIds = [...new Set(activities.map((a) => a.provider_id).filter((v): v is string => !!v))];
    const providers = providerIds.length === 0 ? [] : await all<{ id: string; business_name: string | null }>((f, t) =>
      db.from('providers').select('id, business_name').in('id', providerIds).range(f, t) as never);
    const providerName = new Map(providers.map((p) => [p.id, p.business_name?.trim() || '']));
    const actBy = new Map(activities.map((a) => [a.id, a]));
    const parentBy = new Map(parents.map((p) => [p.id, p]));

    const vendors = new Map<string, string>();
    const rows = reviews.map((r) => {
      const a = actBy.get(r.activity_id);
      const vendorName = (a?.provider_id && providerName.get(a.provider_id)) || a?.provider_name?.trim() || 'Unknown vendor';
      const vendorKey = a?.provider_id ?? `name:${vendorName}`;
      vendors.set(vendorKey, vendorName);
      const p = parentBy.get(r.user_id);
      return {
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.created_at,
        reviewer: p?.full_name?.trim() || p?.email || 'Parent',
        response: r.provider_response,
        respondedAt: r.provider_responded_at,
        activityId: r.activity_id,
        activityTitle: a?.title ?? 'Removed activity',
        activitySlug: a?.slug ?? null,
        vendorKey,
        vendorName,
      };
    });

    return NextResponse.json({
      rows,
      vendors: [...vendors.entries()].map(([key, name]) => ({ key, name })).sort((x, y) => x.name.localeCompare(y.name)),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
