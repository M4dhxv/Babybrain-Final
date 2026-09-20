import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Serializes Wix sync runs per provider.
 *
 * syncWixServicesToActivities and syncProviderWixEvents do check-then-insert
 * location dedup with no lock, so two overlapping runs for the same provider
 * (the 15-min pg_cron sync vs. a manual "Sync services"/"Sync events" click)
 * can race: create duplicate provider_locations rows, or silently write a
 * null location onto an activity when the losing insert's unique-constraint
 * error goes unchecked. See supabase/migrations/00157_wix_sync_locks.sql for
 * why this is a table rather than a native advisory lock.
 *
 * A lock older than STALE_MS is treated as abandoned (a crashed function
 * never reached its `finally`) and is stolen rather than blocking forever.
 */
const STALE_MS = 5 * 60 * 1000;

export class WixSyncLockedError extends Error {
  constructor(providerId: string) {
    super(`A Wix sync is already running for provider ${providerId}`);
    this.name = 'WixSyncLockedError';
  }
}

async function acquire(admin: SupabaseClient<Database>, providerId: string, label: string): Promise<void> {
  const { error: insertError } = await admin
    .from('wix_sync_locks')
    .insert({ provider_id: providerId, locked_by: label });
  if (!insertError) return;

  // Row already exists — steal it only if it's stale (an abandoned lock from
  // a run that crashed before its `finally`), otherwise a real sync is in
  // progress and this caller backs off rather than racing it.
  const { data: existing } = await admin
    .from('wix_sync_locks')
    .select('locked_at')
    .eq('provider_id', providerId)
    .maybeSingle();
  const isStale = existing && Date.now() - new Date(existing.locked_at).getTime() > STALE_MS;
  if (!isStale) throw new WixSyncLockedError(providerId);

  const { error: stealError } = await admin
    .from('wix_sync_locks')
    .update({ locked_at: new Date().toISOString(), locked_by: label })
    .eq('provider_id', providerId);
  // Lost the race to steal it too (another caller stole it first, or the
  // original run finished and released it) — either way, don't proceed
  // alongside whatever's holding it now.
  if (stealError) throw new WixSyncLockedError(providerId);
}

async function release(admin: SupabaseClient<Database>, providerId: string): Promise<void> {
  await admin.from('wix_sync_locks').delete().eq('provider_id', providerId);
}

/**
 * Runs `fn` only if no other sync is currently holding this provider's lock.
 * Always releases on the way out, success or failure.
 */
export async function withWixSyncLock<T>(
  admin: SupabaseClient<Database>,
  providerId: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  await acquire(admin, providerId, label);
  try {
    return await fn();
  } finally {
    await release(admin, providerId);
  }
}
