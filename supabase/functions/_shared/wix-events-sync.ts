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

async function resolveEventLocation(
  admin: SupabaseClient,
  providerId: string,
  event: WixEvent
): Promise<string | null> {
  if (event.location.locationTbd || event.location.type === 'ONLINE' || !event.location.formattedAddress) {
    return null;
  }
  const { data: existing } = await admin
    .from('provider_locations')
    .select('id')
    .eq('provider_id', providerId)
    .eq('address', event.location.formattedAddress)
    .maybeSingle();
  if (existing) return existing.id;

  const { count } = await admin
    .from('provider_locations')
    .select('id', { count: 'exact', head: true })
    .eq('provider_id', providerId);

  const { data: created } = await admin
    .from('provider_locations')
    .insert({
      provider_id: providerId,
      name: event.location.name || event.location.city || 'Event location',
      address: event.location.formattedAddress,
      postal_code: event.location.postalCode,
      is_primary: (count ?? 0) === 0,
    })
    .select('id')
    .single();
  return created?.id ?? null;
}

async function syncEventActivityMirror(
  admin: SupabaseClient,
  providerId: string,
  localEventId: string,
  event: WixEvent
): Promise<void> {
  const { data: ticketTypes } = await admin
    .from('event_ticket_types')
    .select('price_cents, capacity_total, fee_type, fee_rate_percent')
    .eq('event_id', localEventId)
    .eq('hidden', false)
    .order('price_cents', { ascending: true });
  const price =
    ticketTypes && ticketTypes.length > 0
      ? ticketPriceWithFeeCents(ticketTypes[0].price_cents, ticketTypes[0].fee_type, ticketTypes[0].fee_rate_percent) / 100
      : null;
  const capacity =
    ticketTypes && ticketTypes.length > 0 && ticketTypes.every((t: any) => t.capacity_total != null)
      ? ticketTypes.reduce((sum: number, t: any) => sum + (t.capacity_total as number), 0)
      : null;

  const locationId = await resolveEventLocation(admin, providerId, event);

  const { data: existing } = await admin
    .from('activities')
    .select('id')
    .eq('provider_id', providerId)
    .eq('wix_event_id', localEventId)
    .maybeSingle();

  let activityId: string;
  if (existing) {
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
      .eq('id', existing.id);
    activityId = existing.id;
  } else {
    const { data: category } = await admin
      .from('activity_categories')
      .select('id')
      .eq('slug', 'community-events')
      .maybeSingle();
    if (!category) return;

    const { data: inserted, error } = await admin
      .from('activities')
      .insert({
        slug: `${slugify(event.title)}-${event.id.slice(0, 6)}`,
        title: event.title,
        description: event.description || 'Imported from Wix Events. Review and publish this listing when ready.',
        category_id: category.id,
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

  const { data: sessionRows } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('activity_id', activityId)
    .order('starts_at', { ascending: true });
  const rows = sessionRows ?? [];
  if (rows.length === 0) {
    await admin.from('activity_sessions').insert({
      activity_id: activityId,
      starts_at: event.startDate,
      ends_at: event.endDate,
      capacity,
    });
  } else {
    const ids = rows.map((r: any) => r.id);
    const { data: bookedRows } = await admin
      .from('bookings')
      .select('session_id')
      .in('session_id', ids)
      .neq('status', 'cancelled');
    const booked = new Set((bookedRows ?? []).map((b: any) => b.session_id));
    const canonicalId = rows.find((r: any) => booked.has(r.id))?.id ?? rows[0].id;
    await admin
      .from('activity_sessions')
      .update({ starts_at: event.startDate, ends_at: event.endDate, ...(capacity != null ? { capacity } : {}) })
      .eq('id', canonicalId);
    const stale = ids.filter((id: string) => id !== canonicalId && !booked.has(id));
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

  for (const event of events) {
    const { data: existing } = await admin
      .from('wix_events')
      .select('id, wix_missing_since')
      .eq('provider_id', providerId)
      .eq('wix_event_id', event.id)
      .maybeSingle();

    const fields = {
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

    let localEventId: string;
    if (existing) {
      await admin.from('wix_events').update(fields).eq('id', existing.id);
      if (existing.wix_missing_since) result.revived++;
      result.updated++;
      localEventId = existing.id;
    } else {
      const { data: inserted, error } = await admin
        .from('wix_events')
        .insert({ provider_id: providerId, wix_event_id: event.id, ...fields })
        .select('id')
        .single();
      if (error || !inserted) {
        console.error('Could not insert wix_events row', event.id, error);
        continue;
      }
      result.created++;
      localEventId = inserted.id;
    }

    try {
      const defs = await fetchWixTicketDefinitions(creds, event.id);
      for (const def of defs) {
        const priceCents = def.priceValue != null ? Math.round(Number(def.priceValue) * 100) : 0;

        const { data: existingType } = await admin
          .from('event_ticket_types')
          .select('fee_rate_percent')
          .eq('event_id', localEventId)
          .eq('wix_ticket_definition_id', def.id)
          .maybeSingle();
        let feeRatePercent = existingType?.fee_rate_percent ?? null;
        if (def.feeType === 'FEE_ADDED_AT_CHECKOUT' && !def.free && !def.soldOut && feeRatePercent == null) {
          try {
            feeRatePercent = await fetchTicketFeeRatePercent(creds, def.id);
          } catch {
            // best-effort — display falls back to the bare price this run, retried next sync
          }
        }

        await admin
          .from('event_ticket_types')
          .upsert(
            {
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
              hidden: def.hidden,
              fee_type: def.feeType,
              fee_rate_percent: feeRatePercent,
            },
            { onConflict: 'event_id,wix_ticket_definition_id' }
          );
      }
    } catch (e) {
      if (isMissingEventsApp(e)) {
        result.ticketPricingSkipped.push(event.title);
      } else {
        throw e;
      }
    }

    if ((explicitIds && explicitIds.has(event.id)) || (!explicitIds && mirroredLocalIds.has(localEventId))) {
      await syncEventActivityMirror(admin, providerId, localEventId, event);
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
