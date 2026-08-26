import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  fetchTicketFeeRatePercent,
  fetchWixEvents,
  fetchWixTicketDefinitions,
  ticketPriceWithFeeCents,
  WixApiError,
  type WixCredentials,
  type WixEvent,
} from './client';

/**
 * Wix Events & Tickets — a separate Wix app/API from Bookings, so this is
 * deliberately its own sync module rather than folded into sync.ts. Mirrors
 * syncWixServicesToActivities's shape (upsert what's live, flag what
 * disappeared) but against wix_events/event_ticket_types instead of
 * activities/activity_sessions.
 */

export interface WixEventsSyncResult {
  created: number;
  updated: number;
  removed: number;
  revived: number;
  /** Ticket pricing wasn't touched this run for these events — either the
   *  API key lacks SCOPE.DC-EVENTS.MANAGE-TICKET-DEF (required even to just
   *  read prices — confirmed live, there's no separate read-only scope for
   *  it), or the per-event fetch failed. Existing ticket_types rows for
   *  these events are left exactly as they were, not blanked. */
  ticketPricingSkipped: string[];
  /** True if the account has no Wix Events & Tickets app installed at all
   *  (confirmed live: a 428 "MISSING_REQUEST_SITE_CONTEXT / No Events App
   *  identity response" — a vendor connected for Bookings only never has
   *  this app). Not an error — same treatment fetchWixLocations already
   *  gets in sync.ts for a missing capability. */
  eventsAppNotInstalled: boolean;
}

const DAYS_AHEAD = 365;

function isMissingEventsApp(e: unknown): boolean {
  return e instanceof WixApiError && (e.status === 428 || e.status === 403 || e.status === 404);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wix-event';
}

/** Wix Events embed their location inline with no stable id the way a Wix
 *  Bookings service has via `service.locations[].id` (see
 *  resolveWixServiceLocation in sync.ts, which dedupes on that id) — so this
 *  dedupes on matching formatted-address text against this provider's
 *  existing locations instead. Returns null for an ONLINE or TBD event, or
 *  one with no address at all — nothing real to link. */
async function resolveEventLocation(
  admin: SupabaseClient<Database>,
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

/** Mirrors a synced Wix Event into `activities` (+ one `activity_sessions`
 *  row for its date) so it appears in the exact same listing/search/detail/
 *  booking page every other activity already uses — see
 *  00070_wix_events_as_activities.sql. `wix_service_id` is deliberately left
 *  null so no existing Wix *Bookings* code path (which gates purely on it —
 *  app/api/wix/slots, frontends/parent/src/lib/data.ts) ever sees this row;
 *  `wix_event_id` + `wix_service_type = 'EVENT'` are the only signals a
 *  caller should key on. A brand new one comes in unpublished, same as a
 *  freshly-imported Wix Bookings service (lib/wix/sync.ts) — a vendor
 *  reviews and publishes it like anything else, this never auto-exposes a
 *  listing to parents on its own. */
async function syncEventActivityMirror(
  admin: SupabaseClient<Database>,
  providerId: string,
  localEventId: string,
  event: WixEvent
): Promise<void> {
  // Cheapest non-hidden ticket type's price stands in for `activities.price`
  // (a single flat number) — the real per-type prices live on
  // event_ticket_types and are what the booking page's ticket picker
  // actually reads. Total capacity across every non-hidden ticket type
  // stands in for `activities.default_capacity`/`activity_sessions.capacity`
  // similarly — null (unknown, or genuinely unlimited on Wix) leaves
  // whatever's already there alone rather than blanking it, same convention
  // wixServiceCapacity/wixServicePrice use for Bookings. Both re-selected
  // fresh rather than threaded through from the caller's ticket-definitions
  // fetch, so this stays correct even on a run where that fetch failed/was
  // skipped (see isMissingEventsApp above) and existing ticket_types rows
  // were simply left as they were.
  const { data: ticketTypes } = await admin
    .from('event_ticket_types')
    .select('price_cents, capacity_total, fee_type, fee_rate_percent')
    .eq('event_id', localEventId)
    .eq('hidden', false)
    .order('price_cents', { ascending: true });
  // Inclusive of Wix's own service fee where it applies (fee_rate_percent is
  // discovered once per ticket type, see fetchTicketFeeRatePercent) — so
  // this mirrored price, which both the parent explore/detail pages and the
  // vendor's own activity price field read directly, is never an
  // understatement of the real charge.
  const price =
    ticketTypes && ticketTypes.length > 0
      ? ticketPriceWithFeeCents(ticketTypes[0].price_cents, ticketTypes[0].fee_type, ticketTypes[0].fee_rate_percent) / 100
      : null;
  const capacity =
    ticketTypes && ticketTypes.length > 0 && ticketTypes.every((t) => t.capacity_total != null)
      ? ticketTypes.reduce((sum, t) => sum + (t.capacity_total as number), 0)
      : null;

  // Wix stays the source of truth for location/capacity/price/photo/
  // description on every sync (create AND update) — same philosophy
  // syncWixServicesToActivities documents for Bookings-linked activities.
  // Category, age range and publish state are the vendor's own to set and
  // are never touched here past first import.
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
        // Wix knows about this event again (this fetch found it) — same
        // revival rule the wix_events row itself just got above.
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
    if (!category) return; // no fallback category exists yet — extremely unlikely; mirrors syncWixServicesToActivities's own bail-out in lib/wix/sync.ts

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

  // One session row = the event's own occurrence — this is what makes it
  // show up in the existing "upcoming sessions" list and lets `bookings`
  // (written per-ticket by finalizeWixEventTicketCheckout / the RSVP route)
  // FK to something real. `capacity` here is display/vendor-facing only
  // (same total computed above) — it's never what actually gates a
  // purchase. Wix's own live ticket reservation, made at checkout time, is
  // the real gate (app/api/wix/events/{checkout,rsvp}), and every local
  // `bookings` row is only ever written *after* Wix has already confirmed
  // the ticket — so the local capacity/waitlist trigger can never see more
  // confirmed bookings than Wix actually sold, and this number is safe to
  // set precisely rather than left null "to be safe".
  const { data: existingSession } = await admin
    .from('activity_sessions')
    .select('id')
    .eq('activity_id', activityId)
    .maybeSingle();
  if (existingSession) {
    await admin
      .from('activity_sessions')
      .update({ starts_at: event.startDate, ends_at: event.endDate, ...(capacity != null ? { capacity } : {}) })
      .eq('id', existingSession.id);
  } else {
    await admin.from('activity_sessions').insert({
      activity_id: activityId,
      starts_at: event.startDate,
      ends_at: event.endDate,
      capacity,
    });
  }
}

/** A vendor deliberately unchecking an event in the "Import specific
 *  events" picker — mirrors unlinkWixActivities in sync.ts (unpublish,
 *  clear the link, rename the slug out of the way) but for wix_event_id.
 *  Unlike syncProviderWixEvents's own reconciliation (wix_missing_since,
 *  which stays revivable if the event reappears), this is permanent: the
 *  next sync will never re-link this activity even if the same event is
 *  still on the account. The wix_events/event_ticket_types rows themselves
 *  are left untouched — this only detaches the activities mirror.
 *
 * Refuses to unlink an activity that already has a real (non-cancelled)
 * booking on its session — confirmed live that unchecking an event with a
 * genuine paid ticket on it silently detached that ticket's activity from
 * Wix (still recorded, still valid, but orphaned from any future sync, and
 * a fresh re-import created an unrelated duplicate instead of reviving it).
 * A vendor's own "stop listing this" click shouldn't be able to strand a
 * parent's ticket that way — those go back in `protectedTitles` instead of
 * being unlinked, so the caller can tell the vendor why. */
export async function unlinkWixEventActivities(
  admin: SupabaseClient<Database>,
  providerId: string,
  wixEventIds: string[]
): Promise<{ removed: number; protectedEvents: { wixEventId: string; title: string }[] }> {
  if (wixEventIds.length === 0) return { removed: 0, protectedEvents: [] };

  const { data: rows } = await admin
    .from('wix_events')
    .select('id, wix_event_id')
    .eq('provider_id', providerId)
    .in('wix_event_id', wixEventIds);
  const localIdToWixId = new Map((rows ?? []).map((r) => [r.id, r.wix_event_id]));
  const localEventIds = [...localIdToWixId.keys()];
  if (localEventIds.length === 0) return { removed: 0, protectedEvents: [] };

  const { data: activityRows } = await admin
    .from('activities')
    .select('id, slug, title, wix_event_id')
    .eq('provider_id', providerId)
    .in('wix_event_id', localEventIds);
  if (!activityRows || activityRows.length === 0) return { removed: 0, protectedEvents: [] };

  let removed = 0;
  const protectedEvents: { wixEventId: string; title: string }[] = [];
  for (const row of activityRows) {
    const { data: sessions } = await admin.from('activity_sessions').select('id').eq('activity_id', row.id);
    const sessionIds = (sessions ?? []).map((s) => s.id);
    const { count } = sessionIds.length
      ? await admin
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .in('session_id', sessionIds)
          .neq('status', 'cancelled')
      : { count: 0 };
    if ((count ?? 0) > 0) {
      protectedEvents.push({ wixEventId: localIdToWixId.get(row.wix_event_id as string) as string, title: row.title });
      continue;
    }

    const { error } = await admin
      .from('activities')
      .update({
        is_published: false,
        wix_event_id: null,
        wix_service_type: null,
        wix_removed_at: new Date().toISOString(),
        slug: `${row.slug}-removed-${row.id.slice(0, 6)}`,
      })
      .eq('id', row.id);
    if (!error) removed++;
  }
  return { removed, protectedEvents };
}

export async function syncProviderWixEvents(
  admin: SupabaseClient<Database>,
  providerId: string,
  creds: WixCredentials,
  options?: { onlyEventIds?: string[] }
): Promise<WixEventsSyncResult> {
  // wix_events/event_ticket_types stay in step for every fetched event
  // regardless — that's just keeping BabyBrain's cache of what's on the
  // account correct, not exposing anything to parents. `onlyEventIds` only
  // gates the *activities* mirror below (the part a parent can actually
  // see/book), matching syncWixServicesToActivities's onlyServiceIds.
  const onlyIds = options?.onlyEventIds ? new Set(options.onlyEventIds) : null;
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
      // Wix knows about this event again (this fetch found it) — same
      // revival rule syncWixServicesToActivities uses for wix_missing_since.
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

        // The fee *rate* only ever comes from a live reservation, so it's
        // discovered once (a throwaway hold, see fetchTicketFeeRatePercent)
        // and cached rather than re-reserved on every sync.
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

    if (!onlyIds || onlyIds.has(event.id)) {
      await syncEventActivityMirror(admin, providerId, localEventId, event);
    }
  }

  // Reconciliation only covers events that SHOULD have appeared in this
  // fetch (future, inside the window just queried) — fetchWixEvents excludes
  // both past events and anything beyond `days`, so touching rows outside
  // that range would flag a still-real event as missing just because it
  // already started or is further out than we looked. See
  // syncWixServicesToActivities's equivalent reconciliation in sync.ts.
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
    if (!fetchedIds.has(row.wix_event_id)) {
      const missingSince = new Date().toISOString();
      await admin
        .from('wix_events')
        .update({ wix_missing_since: missingSince, is_published: false })
        .eq('id', row.id);
      // Same "gone" flag propagated to the mirrored activity — matches
      // scripts/reset-wix-demo-vendor.mjs's reconciliation for Wix Bookings
      // (wix_missing_since + unpublish, leave sessions/bookings untouched).
      await admin
        .from('activities')
        .update({ wix_missing_since: missingSince, is_published: false })
        .eq('provider_id', providerId)
        .eq('wix_event_id', row.id);
      result.removed++;
    }
  }

  return result;
}
