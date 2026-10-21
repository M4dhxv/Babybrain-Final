import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * The catalogue version stamp (migration 00246): changes whenever a class, its
 * sessions, a venue or a vendor changes. The parent app adds it to its
 * /api/explore/<fn> requests, so an edit gets a fresh Explore list at once
 * instead of waiting out that route's edge cache.
 *
 * Edge-cached for 2s, so however many parents are browsing, the database reads
 * this one row at most every couple of seconds per edge region.
 * Any failure answers `{ v: null }` (never cached): the app then queries Explore
 * exactly as before, without a stamp.
 */
export async function GET() {
  try {
    const db = createAdminClient() as unknown as SupabaseClient;
    const { data, error } = await db.from('catalogue_version').select('version').eq('id', 1).maybeSingle();
    if (error || !data) throw error ?? new Error('no row');
    return NextResponse.json(
      { v: String((data as { version: number | string }).version) },
      { headers: { 'Cache-Control': 'public, s-maxage=2' } },
    );
  } catch {
    return NextResponse.json({ v: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
