import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  fetchTicketFeeRatePercent,
  fetchWixEvents,
  fetchWixTicketDefinitions,
  ticketPriceWithFeeCents,
  WixApiError,
  type WixCredentials,
  type WixEvent,
} from './wix-client.ts';

/**
 * Deno port of syncProviderWixEvents from lib/wix/events-sync.ts. Ported
 * whole (this file has no split between "reachable from cron" and
 * "reachable from a vendor session" the way sync.ts does) except
 * unlinkWixEventActivities, which only the vendor's own "Import specific
 * events" picker calls and stays on Vercel.
 */

export interface WixEventsSyncResult {
  created: number;
  updated: number;
  removed: number;
  revived: number;
  ticketPricingSkipped: string[];
  eventsAppNotInstalled: boolean;
}

const DAYS_AHEAD = 365;

function isMissingEventsApp(e: unknown): boolean {
  return e instanceof WixApiError && (e.status === 428 || e.status === 403 || e.status === 404);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wix-event';
}

/** `cache`/`countRef` are prefetched once by the caller across the whole
 *  run (address -> id, and the provider's total location count) instead of
 *  a per-event SELECT + COUNT — see the identical rewrite and its full
 *  reasoning in lib/wix/events-sync.ts. */
async function resolveEventLocation(
  admin: SupabaseClient,
  providerId: string,
  event: WixEvent,
  cache: Map<string, string>,
  countRef: { count: number }
): Promise<string | null> {
  if (event.location.locationTbd || event.location.type === 'ONLINE' || !event.location.formattedAddress) {
    return null;
  }
  const address = event.location.formattedAddress;
  const cached = cache.get(address);
  if (cached) return cached;

  const { data: created } = await admin
    .from('provider_locations')
    .insert({
      provider_id: providerId,
      name: event.location.name || event.location.city || 'Event location',
      address,
      postal_code: event.location.postalCode,
      is_primary: countRef.count === 0,
    })
    .select('id')
    .single();
  if (created) {
    cache.set(address, created.id);
    countRef.count++;
  }
  return created?.id ?? null;
}

/** Everything this used to SELECT per event, gathered once by the caller —
 *  see EventMirrorContext in lib/wix/events-sync.ts for the full reasoning. */
interface EventMirrorContext {
  locationCache: Map<string, string>;
  locationCountRef: { count: number };
  ticketTypesByEventId: Map<string, any[]>;
  existingActivityIdByLocalEventId: Map<string, string>;
  sessionsByActivityId: Map<string, { id: string }[]>;
  bookedSessionIds: Set<string>;
  communityEventsCategoryId: number | null;
}

async function syncEventActivityMirror(
  admin: SupabaseClient,
  providerId: string,
  localEventId: string,
  event: WixEvent,
  ctx: EventMirrorContext
): Promise<void> {
  const ticketTypes = ctx.ticketTypesByEventId.get(localEventId) ?? [];
  const price =
    ticketTypes.length > 0
      ? ticketPriceWithFeeCents(ticketTypes[0].price_cents, ticketTypes[0].fee_type, ticketTypes[0].fee_rate_percent) / 100
      : null;
  const capacity =
    ticketTypes.length > 0 && ticketTypes.every((t: any) => t.capacity_total != null)
      ? ticketTypes.reduce((sum: number, t: any) => sum + (t.capacity_total as number), 0)
      : null;

  const locationId = await resolveEventLocation(admin, providerId, event, ctx.locationCache, ctx.locationCountRef);

  const existingActivityId = ctx.existingActivityIdByLocalEventId.get(localEventId);

  let activityId: string;
  if (existingActivityId) {
    await admin
      .from('activities')
      .update({
        title: event.title,
        ...(price != null ? { price } : {}),
        ...(capacity != null ? { default_capacity: capacity } : {}),
        ...(event.description ? { description: event.description } : {}),
        location_id: locationId,
        address: event.location.formattedAddress,
        postal_code: event.location.postalCode,
        ...(event.mainImageUrl ? { image_urls: [event.mainImageUrl] } : {}),
        wix_missing_since: null,
      })
      .eq('id', existingActivityId);
    activityId = existingActivityId;
  } else {
    if (!ctx.communityEventsCategoryId) return;

    const { data: inserted, error } = await admin
      .from('activities')
      .insert({
        slug: `${slugify(event.title)}-${event.id.slice(0, 6)}`,
        title: event.title,
        description: event.description || 'Imported from Wix Events. Review and publish this listing when ready.',
        category_id: ctx.communityEventsCategoryId,
        provider_id: providerId,
        is_published: false,
        wix_event_id: localEventId,
        wix_service_type: 'EVENT',
        location_id: locationId,
        address: event.location.formattedAddress,
        postal_code: event.location.postalCode,
        price,
        default_capacity: capacity,
        image_urls: event.mainImageUrl ? [event.mainImageUrl] : [],
      })
      .select('id')
      .single();
    if (error || !inserted) {
      console.error('Could not insert mirrored activity for Wix event', event.id, error);
      return;
    }
    activityId = inserted.id;
  }

  const rows = ctx.sessionsByActivityId.get(activityId) ?? [];
  if (rows.length === 0) {
    await admin.from('activity_sessions').insert({
      activity_id: activityId,
      starts_at: event.startDate,
      ends_at: event.endDate,
      capacity,
    });
  } else {
    const ids = rows.map((r) => r.id);
    const booked = ctx.bookedSessionIds;
    const canonicalId = rows.find((r) => booked.has(r.id))?.id ?? rows[0].id;
    await admin
      .from('activity_sessions')
      .update({ starts_at: event.startDate, ends_at: event.endDate, ...(capacity != null ? { capacity } : {}) })
      .eq('id', canonicalId);
    const stale = ids.filter((id) => id !== canonicalId && !booked.has(id));
    if (stale.length > 0) {
      await admin.from('activity_sessions').delete().in('id', stale);
    }
  }
}

export async function syncProviderWixEvents(
  admin: SupabaseClient,
  providerId: string,
  creds: WixCredentials,
  options?: { onlyEventIds?: string[] }
): Promise<WixEventsSyncResult> {
  // The scheduled caller always passes nothing — same convention as
  // syncWixServicesToActivities.
  const explicitIds = options?.onlyEventIds ? new Set(options.onlyEventIds) : null;

  const { data: mirroredRows } = await admin
    .from('activities')
    .select('wix_event_id')
    .eq('provider_id', providerId)
    .not('wix_event_id', 'is', null);
  const mirroredLocalIds = new Set((mirroredRows ?? []).map((r: any) => r.wix_event_id as string));

  const result: WixEventsSyncResult = {
    created: 0,
    updated: 0,
    removed: 0,
    revived: 0,
    ticketPricingSkipped: [],
    eventsAppNotInstalled: false,
  };

  let events: WixEvent[];
  try {
    events = await fetchWixEvents(creds, DAYS_AHEAD);
  } catch (e) {
    if (isMissingEventsApp(e)) {
      result.eventsAppNotInstalled = true;
      return result;
    }
    throw e;
  }

  const now = Date.now();
  const cutoff = now + DAYS_AHEAD * 24 * 60 * 60 * 1000;

  // Prefetch every event's ticket definitions concurrently — see
  // lib/wix/events-sync.ts's syncProviderWixEvents for the full reasoning
  // (a per-event 20s-worst-case call run serially risked the sync itself
  // timing out for an account with many events).
  const ticketDefsSettled = await Promise.allSettled(events.map((event) => fetchWixTicketDefinitions(creds, event.id)));
  const ticketDefsByEventId = new Map<string, Awaited<ReturnType<typeof fetchWixTicketDefinitions>>>();
  const ticketDefsErrorByEventId = new Map<string, unknown>();
  events.forEach((event, i) => {
    const settled = ticketDefsSettled[i];
    if (settled.status === 'fulfilled') ticketDefsByEventId.set(event.id, settled.value);
    else ticketDefsErrorByEventId.set(event.id, settled.reason);
  });
  for (const event of events) {
    const prefetchError = ticketDefsErrorByEventId.get(event.id);
    if (prefetchError !== undefined && !isMissingEventsApp(prefetchError)) throw prefetchError;
  }

  // Batched read/writes below — see the identical rewrite (and its full
  // reasoning, comment-by-comment) in lib/wix/events-sync.ts's
  // syncProviderWixEvents. This turned a per-event chain of ~7 sequential
  // Supabase REST round trips (the actual bottleneck, not the Wix API calls
  // above) into a handful of bulk queries, which is what let a ~20-event
  // account's sync drop from ~40s to ~10s and stop timing out on this
  // Edge Function's own budget. Keep this in step with the Vercel original
  // the same way every other function in this file already has to.
  const existingEventRows = events.length
    ? (
        await admin
          .from('wix_events')
          .select('id, wix_event_id, wix_missing_since')
          .eq('provider_id', providerId)
          .in('wix_event_id', events.map((e) => e.id))
      ).data ?? []
    : [];
  const existingEventByWixId = new Map(existingEventRows.map((r: any) => [r.wix_event_id, r]));

  const eventRowsToUpsert = events.map((event) => {
    const existing = existingEventByWixId.get(event.id) as any;
    if (existing) {
      result.updated++;
      if (existing.wix_missing_since) result.revived++;
    } else {
      result.created++;
    }
    return {
      provider_id: providerId,
      wix_event_id: event.id,
      title: event.title,
      slug: event.slug,
      description: event.description,
      start_date: event.startDate,
      end_date: event.endDate,
      time_zone_id: event.timeZoneId ?? null,
      location_name: event.location.name,
      location_type: event.location.type,
      city: event.location.city,
      formatted_address: event.location.formattedAddress,
      location_tbd: event.location.locationTbd,
      main_image_url: event.mainImageUrl,
      wix_status: event.status,
      wix_missing_since: null,
    };
  });
  const localEventIdByWixId = new Map(existingEventRows.map((r: any) => [r.wix_event_id, r.id] as const));
  if (eventRowsToUpsert.length) {
    const { data: upserted, error } = await admin
      .from('wix_events')
      .upsert(eventRowsToUpsert, { onConflict: 'provider_id,wix_event_id' })
      .select('id, wix_event_id');
    if (error) {
      console.error('wix_events bulk upsert failed', error);
    } else {
      for (const row of upserted ?? []) localEventIdByWixId.set(row.wix_event_id, row.id);
    }
  }

  const eventsWithLocalId = events
    .map((event) => ({ event, localEventId: localEventIdByWixId.get(event.id) }))
    .filter((x): x is { event: WixEvent; localEventId: string } => !!x.localEventId);

  const eventsNeedingTicketSync = eventsWithLocalId.filter(({ event }) => {
    const prefetchError = ticketDefsErrorByEventId.get(event.id);
    if (prefetchError !== undefined) {
      result.ticketPricingSkipped.push(event.title);
      return false;
    }
    return true;
  });
  const localEventIdsForTickets = eventsNeedingTicketSync.map(({ localEventId }) => localEventId);
  const { data: cachedTicketTypeRows } = localEventIdsForTickets.length
    ? await admin
        .from('event_ticket_types')
        .select('event_id, wix_ticket_definition_id, fee_rate_percent')
        .in('event_id', localEventIdsForTickets)
    : { data: [] };
  const cachedFeeRateByKey = new Map(
    (cachedTicketTypeRows ?? []).map((r: any) => [`${r.event_id}:${r.wix_ticket_definition_id}`, r.fee_rate_percent])
  );

  const ticketTypeRows = await Promise.all(
    eventsNeedingTicketSync.flatMap(({ event, localEventId }) =>
      (ticketDefsByEventId.get(event.id) ?? []).map(async (def) => {
        const priceCents = def.priceValue != null ? Math.round(Number(def.priceValue) * 100) : 0;
        let feeRatePercent = cachedFeeRateByKey.get(`${localEventId}:${def.id}`) ?? null;
        if (def.feeType === 'FEE_ADDED_AT_CHECKOUT' && !def.free && !def.soldOut && feeRatePercent == null) {
          try {
            feeRatePercent = await fetchTicketFeeRatePercent(creds, def.id);
          } catch {
            // best-effort — display falls back to the bare price this run, retried next sync
          }
        }
        return {
          event_id: localEventId,
          wix_ticket_definition_id: def.id,
          name: def.name,
          price_cents: priceCents,
          currency: def.currency ?? 'SGD',
          is_free: def.free,
          capacity_total: def.initialLimit,
          capacity_remaining: def.unsoldCount,
          limit_per_checkout: def.limitPerCheckout,
          sale_start_date: def.saleStartDate,
          sale_end_date: def.saleEndDate,
          sale_status: def.saleStatus,
          sold_out: def.soldOut,
          hidden: def.hidden,
          fee_type: def.feeType,
          fee_rate_percent: feeRatePercent,
        };
      })
    )
  );
  if (ticketTypeRows.length) {
    await admin.from('event_ticket_types').upsert(ticketTypeRows, { onConflict: 'event_id,wix_ticket_definition_id' });
  }

  const eventsToMirror = eventsWithLocalId.filter(
    ({ event, localEventId }) =>
      (explicitIds && explicitIds.has(event.id)) || (!explicitIds && mirroredLocalIds.has(localEventId))
  );
  const localEventIdsToMirror = eventsToMirror.map(({ localEventId }) => localEventId);

  if (localEventIdsToMirror.length) {
    const { data: existingLocationRows } = await admin.from('provider_locations').select('id, address').eq('provider_id', providerId);
    const locationCache = new Map<string, string>();
    for (const l of existingLocationRows ?? []) if (l.address) locationCache.set(l.address, l.id);
    const locationCountRef = { count: (existingLocationRows ?? []).length };

    const { data: existingMirrorRows } = await admin
      .from('activities')
      .select('id, wix_event_id')
      .eq('provider_id', providerId)
      .in('wix_event_id', localEventIdsToMirror);
    const existingActivityIdByLocalEventId = new Map((existingMirrorRows ?? []).map((r: any) => [r.wix_event_id, r.id]));

    const { data: freshTicketTypeRows } = await admin
      .from('event_ticket_types')
      .select('event_id, price_cents, capacity_total, fee_type, fee_rate_percent')
      .in('event_id', localEventIdsToMirror)
      .eq('hidden', false)
      .order('price_cents', { ascending: true });
    const ticketTypesByEventId = new Map<string, any[]>();
    for (const row of freshTicketTypeRows ?? []) {
      const list = ticketTypesByEventId.get(row.event_id) ?? [];
      list.push(row);
      ticketTypesByEventId.set(row.event_id, list);
    }

    const knownActivityIds = [...existingActivityIdByLocalEventId.values()] as string[];
    const { data: existingSessionRows } = knownActivityIds.length
      ? await admin.from('activity_sessions').select('id, activity_id').in('activity_id', knownActivityIds).order('starts_at', { ascending: true })
      : { data: [] };
    const sessionsByActivityId = new Map<string, { id: string }[]>();
    for (const row of existingSessionRows ?? []) {
      const list = sessionsByActivityId.get(row.activity_id) ?? [];
      list.push({ id: row.id });
      sessionsByActivityId.set(row.activity_id, list);
    }

    const knownSessionIds = (existingSessionRows ?? []).map((r: any) => r.id);
    const { data: bookedRows } = knownSessionIds.length
      ? await admin.from('bookings').select('session_id').in('session_id', knownSessionIds).neq('status', 'cancelled')
      : { data: [] };
    const bookedSessionIds = new Set((bookedRows ?? []).map((b: any) => b.session_id));

    const { data: communityEventsCategory } = await admin
      .from('activity_categories')
      .select('id')
      .eq('slug', 'community-events')
      .maybeSingle();

    const mirrorCtx: EventMirrorContext = {
      locationCache,
      locationCountRef,
      ticketTypesByEventId,
      existingActivityIdByLocalEventId: existingActivityIdByLocalEventId as Map<string, string>,
      sessionsByActivityId,
      bookedSessionIds,
      communityEventsCategoryId: communityEventsCategory?.id ?? null,
    };

    for (const { event, localEventId } of eventsToMirror) {
      await syncEventActivityMirror(admin, providerId, localEventId, event, mirrorCtx);
    }
  }

  const fetchedIds = new Set(events.map((e) => e.id));
  const { data: linked } = await admin
    .from('wix_events')
    .select('id, wix_event_id, start_date')
    .eq('provider_id', providerId)
    .is('wix_removed_at', null)
    .is('wix_missing_since', null)
    .gt('start_date', new Date(now).toISOString())
    .lte('start_date', new Date(cutoff).toISOString());
  for (const row of linked ?? []) {
    if (fetchedIds.has(row.wix_event_id)) continue;
    const missingSince = new Date().toISOString();
    await admin
      .from('wix_events')
      .update({ wix_missing_since: missingSince, is_published: false })
      .eq('id', row.id);
    const { data: mirrored } = await admin
      .from('activities')
      .update({ wix_missing_since: missingSince, is_published: false })
      .eq('provider_id', providerId)
      .eq('wix_event_id', row.id)
      .select('id');
    result.removed++;

    const activityIds = (mirrored ?? []).map((a: any) => a.id);
    if (activityIds.length) {
      const { data: sessions } = await admin
        .from('activity_sessions')
        .select('id')
        .in('activity_id', activityIds);
      const sessionIds = (sessions ?? []).map((s: any) => s.id);
      if (sessionIds.length) {
        await admin
          .from('bookings')
          .update({ status: 'cancelled' })
          .in('session_id', sessionIds)
          .neq('status', 'cancelled')
          .neq('status', 'completed');
      }
    }
    await admin
      .from('event_ticket_orders')
      .update({ status: 'cancelled' })
      .eq('event_id', row.id)
      .neq('status', 'cancelled');
  }

  return result;
}
