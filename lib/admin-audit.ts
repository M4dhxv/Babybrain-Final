import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Record one admin action in `admin_audit_log` (migration 00211).
 *
 * Best effort by design: a missing table (migration not applied yet) or a write error must never
 * block or fail the admin action itself, so every failure is swallowed.
 */
export type AuditEntry = {
  action: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  details?: Record<string, unknown>;
};

export async function logAdminAction(
  db: SupabaseClient,
  actor: { email?: string | null; role?: string | null },
  entry: AuditEntry
): Promise<void> {
  try {
    await db.from('admin_audit_log').insert({
      actor_email: actor.email ?? 'unknown',
      actor_role: actor.role ?? null,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      summary: entry.summary,
      details: entry.details ?? null,
    });
  } catch {
    /* never let logging break the action */
  }
}
