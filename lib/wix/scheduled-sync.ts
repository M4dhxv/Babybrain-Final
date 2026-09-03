import { createAdminClient } from '@/lib/supabase/admin';
import { syncWixServicesToActivities } from './sync';
import { syncProviderWixEvents } from './events-sync';

/**
 * 24/7 background sync — the cron equivalent of the vendor's "Sync services"
 * button (app/api/vendor/wix-services-sync + wix-events-sync), but running
 * for EVERY connected provider on a schedule regardless of whether that
 * vendor is logged in. A change made directly on Wix (price, capacity,
 * location, a new event) used to sit stale on the parent-facing site until
 * the vendor next clicked the button; this closes that gap.
 *
 * Mirrors runVendorRefresh's shape (lib/vendor-refresh.ts) — same
 * run-logged, cron-or-manual-triggered, per-item try/catch pattern — but
 * against provider_wix_credentials instead of the auto-listed directory.
 */

export type WixProviderSyncOutcome = {
  provider_id: string;
  business_name: string | null;
  status: 'ok' | 'error';
  services?: { created: number; updated: number; removed: number; revived: number };
  events?: { created: number; updated: number; removed: number; revived: number; eventsAppNotInstalled: boolean };
  error?: string;
};

export type WixScheduledSyncSummary = {
  run_id: string | null;
  trigger: 'cron' | 'manual';
  providers_checked: number;
  providers_failed: number;
  services_created: number;
  services_updated: number;
  events_created: number;
  events_updated: number;
  at: string;
};

export async function runWixScheduledSync(
  trigger: 'cron' | 'manual',
  triggeredBy?: string | null
): Promise<WixScheduledSyncSummary> {
  const admin = createAdminClient();

  // Open a run row so an in-progress/crashed run is still visible, same
  // convention as vendor_sync_runs.
  const { data: run } = await admin
    .from('wix_sync_runs')
    .insert({ trigger, triggered_by: triggeredBy ?? null })
    .select('id')
    .single();
  const runId = run?.id ?? null;

  try {
    const { data: credRows } = await admin
      .from('provider_wix_credentials')
      .select('provider_id, wix_api_key, wix_site_id');
    const providerIds = (credRows ?? []).map((r) => r.provider_id);
    const { data: providerRows } = providerIds.length
      ? await admin.from('providers').select('id, business_name').in('id', providerIds)
      : { data: [] as { id: string; business_name: string }[] };
    const nameById = new Map((providerRows ?? []).map((p) => [p.id, p.business_name]));

    const now = new Date().toISOString();
    const results: WixProviderSyncOutcome[] = [];
    let servicesCreated = 0;
    let servicesUpdated = 0;
    let eventsCreated = 0;
    let eventsUpdated = 0;
    let failed = 0;

    // Each provider's own API key/site is independent — one revoked key or
    // one Wix outage on a single site must never sink the whole run, so
    // every provider gets its own try/catch and the batch still runs in
    // parallel (Wix API calls are direct HTTP, not a slow external crawl,
    // so there's no need for vendor-refresh's crawl-budget/deadline
    // machinery here).
    await Promise.all(
      (credRows ?? []).map(async (row) => {
        const creds = { accessToken: row.wix_api_key, siteId: row.wix_site_id };
        const outcome: WixProviderSyncOutcome = {
          provider_id: row.provider_id,
          business_name: nameById.get(row.provider_id) ?? null,
          status: 'ok',
        };
        try {
          // Both called blanket (no onlyServiceIds/onlyEventIds), which is
          // now refresh-only: they update and reconcile the activities this
          // vendor has already imported via the pickers, and never create
          // new ones. A service/event added on Wix waits, unchecked, in the
          // "Import specific …" picker until the vendor opts it in.
          const services = await syncWixServicesToActivities(admin, row.provider_id, creds);
          const events = await syncProviderWixEvents(admin, row.provider_id, creds);
          outcome.services = {
            created: services.created,
            updated: services.updated,
            removed: services.removed,
            revived: services.revived,
          };
          outcome.events = {
            created: events.created,
            updated: events.updated,
            removed: events.removed,
            revived: events.revived,
            eventsAppNotInstalled: events.eventsAppNotInstalled,
          };
          servicesCreated += services.created;
          servicesUpdated += services.updated;
          eventsCreated += events.created;
          eventsUpdated += events.updated;
        } catch (e) {
          failed += 1;
          outcome.status = 'error';
          outcome.error = e instanceof Error ? e.message : String(e);
        }
        results.push(outcome);
      })
    );

    if (runId) {
      await admin
        .from('wix_sync_runs')
        .update({
          status: 'success',
          providers_checked: credRows?.length ?? 0,
          providers_failed: failed,
          services_created: servicesCreated,
          services_updated: servicesUpdated,
          events_created: eventsCreated,
          events_updated: eventsUpdated,
          results,
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId);
    }

    return {
      run_id: runId,
      trigger,
      providers_checked: credRows?.length ?? 0,
      providers_failed: failed,
      services_created: servicesCreated,
      services_updated: servicesUpdated,
      events_created: eventsCreated,
      events_updated: eventsUpdated,
      at: now,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (runId) {
      await admin
        .from('wix_sync_runs')
        .update({ status: 'error', error: msg, finished_at: new Date().toISOString() })
        .eq('id', runId);
    }
    throw e;
  }
}
