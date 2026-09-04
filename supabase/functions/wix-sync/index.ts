import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { syncWixServicesToActivities } from '../_shared/wix-sync.ts';
import { syncProviderWixEvents } from '../_shared/wix-events-sync.ts';

/**
 * Supabase Edge Function replacement for app/api/cron/refresh-wix on Vercel
 * — the 24/7 background sync of every connected Wix account (Bookings +
 * Events), independent of any vendor logging in. Moved here so the actual
 * compute (mostly idle time waiting on the Wix API, run every 5-15 minutes
 * regardless of site traffic) lands on Supabase's own billing instead of
 * Vercel's.
 *
 * Deploy:
 *   supabase functions deploy wix-sync --no-verify-jwt
 *   supabase secrets set CRON_SHARED_SECRET=<same value as Vercel's WEBHOOK_SHARED_SECRET>
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically for
 * every Edge Function — no secret needed for those two.
 *
 * Auth: a single shared-secret header, same shape as the Vercel route this
 * replaces (app/api/cron/refresh-wix/route.ts) — deliberately not Supabase's
 * own JWT verification (`--no-verify-jwt` above), since the only caller is
 * pg_cron via pg_net, not a browser.
 *
 * The Vercel route (and its manual /admin trigger) are left in the codebase
 * untouched — pg_cron is simply re-pointed at this function's URL instead
 * (see the accompanying migration). If this Edge Function ever needs to be
 * rolled back, re-pointing the cron URL back to Vercel is a one-line change.
 */

type WixProviderSyncOutcome = {
  provider_id: string;
  business_name: string | null;
  status: 'ok' | 'error';
  services?: { created: number; updated: number; removed: number; revived: number };
  events?: { created: number; updated: number; removed: number; revived: number; eventsAppNotInstalled: boolean };
  error?: string;
};

async function runWixScheduledSync(admin: SupabaseClient) {
  const { data: run } = await admin
    .from('wix_sync_runs')
    .insert({ trigger: 'cron', triggered_by: null })
    .select('id')
    .single();
  const runId = run?.id ?? null;

  try {
    const { data: credRows } = await admin
      .from('provider_wix_credentials')
      .select('provider_id, wix_api_key, wix_site_id');
    const providerIds = (credRows ?? []).map((r: any) => r.provider_id);
    const { data: providerRows } = providerIds.length
      ? await admin.from('providers').select('id, business_name').in('id', providerIds)
      : { data: [] as { id: string; business_name: string }[] };
    const nameById = new Map((providerRows ?? []).map((p: any) => [p.id, p.business_name]));

    const results: WixProviderSyncOutcome[] = [];
    let servicesCreated = 0;
    let servicesUpdated = 0;
    let eventsCreated = 0;
    let eventsUpdated = 0;
    let failed = 0;

    await Promise.all(
      (credRows ?? []).map(async (row: any) => {
        const creds = { accessToken: row.wix_api_key, siteId: row.wix_site_id };
        const outcome: WixProviderSyncOutcome = {
          provider_id: row.provider_id,
          business_name: nameById.get(row.provider_id) ?? null,
          status: 'ok',
        };
        try {
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
      ok: true,
      providers_checked: credRows?.length ?? 0,
      providers_failed: failed,
      services_created: servicesCreated,
      services_updated: servicesUpdated,
      events_created: eventsCreated,
      events_updated: eventsUpdated,
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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== Deno.env.get('CRON_SHARED_SECRET')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  try {
    const summary = await runWixScheduledSync(admin);
    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('wix-sync run failed', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'sync failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
