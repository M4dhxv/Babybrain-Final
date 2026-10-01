import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Setting how an admin has overridden the automatic test rules on parent accounts:
 *   'auto' = the rules decide, 'test' = force test, 'real' = force a real parent.
 * Stored in two columns (parent_profiles.is_test from 00207, is_real_override from 00212).
 * The older { is_test: boolean } form is still accepted so an admin tab open during a deploy keeps working.
 */
export type OverrideMode = 'auto' | 'test' | 'real';

export function parseOverride(body: { mode?: unknown; is_test?: unknown } | null): OverrideMode | null {
  if (!body) return null;
  if (body.mode === 'auto' || body.mode === 'test' || body.mode === 'real') return body.mode;
  if (typeof body.is_test === 'boolean') return body.is_test ? 'test' : 'auto';
  return null;
}

export const OVERRIDE_LABEL: Record<OverrideMode, string> = {
  auto: 'reset to automatic', test: 'marked as a test account', real: 'marked as a real parent',
};

export async function applyOverride(
  db: SupabaseClient, ids: string[], mode: OverrideMode
): Promise<{ ok: true; rows: { id: string; email: string }[] } | { ok: false; status: number; error: string }> {
  const both = { is_test: mode === 'test', is_real_override: mode === 'real' };
  let res = await db.from('parent_profiles').update(both).in('id', ids).select('id, email');
  if (res.error && /is_real_override/.test(res.error.message)) {
    // Migration 00212 isn't applied yet: 'test' and 'auto' only need is_test; 'real' can't be stored.
    if (mode === 'real') return { ok: false, status: 409, error: 'Marking a real parent needs migration 00212 applied to the database first.' };
    res = await db.from('parent_profiles').update({ is_test: mode === 'test' }).in('id', ids).select('id, email');
  }
  if (res.error) {
    const needs = /is_test/.test(res.error.message);
    return { ok: false, status: needs ? 409 : 500, error: needs ? 'Marking test accounts needs migration 00207 applied to the database first.' : res.error.message };
  }
  return { ok: true, rows: (res.data ?? []) as { id: string; email: string }[] };
}
