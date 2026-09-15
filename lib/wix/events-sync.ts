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
 *  one with no address at all — nothing real to link.
 *
 *  `cache` is every one of this provider's existing provider_locations,
 *  pre-loaded once by the caller (address -> id) rather than a per-event
 *  "does this address already exist?" SELECT — a real cost when a blanket
 *  sync mirrors a few dozen events every run. `countRef` mirrors what used
 *  to be a fresh `count(*)` per newly-created location (only the FIRST
 *  location for a provider is `is_primary`); seeded once from the same
 *  prefetch and incremented in place as this run creates new ones, so two
 *  events sharing a not-yet-seen address within the same run still only
 *  create it once and never both claim `is_primary` — the whole point of
 *  keeping this loop serial (see the caller's own comment on that). */
async function resolveEventLocation(
  admin: SupabaseClient<Database>,
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

/** Everything syncEventActivityMirror needs that used to be its own
 *  per-event SELECT — gathered once by the caller across every event being
 *  mirrored this run instead of re-fetched per event, which is what made a
 *  blanket sync of a few dozen already-imported events slow enough to risk
 *  the route's own time budget (each mirror call was 4-5 sequential Supabase
 *  REST round trips). See the long comment on syncProviderWixEvents's own
 *  prefetching for why each piece here is safe to read once up front. */
interface EventMirrorContext {
  locationCache: Map<string, string>;
  locationCountRef: { count: number };
  ticketTypesByEventId: Map<
    string,
    { price_cents: number; capacity_total: number | null; fee_type: string | null; fee_rate_percent: number | null }[]
  >;
  existingActivityIdByLocalEventId: Map<string, string>;
  sessionsByActivityId: Map<string, { id: string }[]>;
  bookedSessionIds: Set<string>;
  communityEventsCategoryId: number | null;
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
  event: WixEvent,
  ctx: EventMirrorContext
): Promise<void> {
  // Cheapest non-hidden ticket type's price stands in for `activities.price`
  // (a single flat number) — the real per-type prices live on
  // event_ticket_types and are what the booking page's ticket picker
  // actually reads. Total capacity across every non-hidden ticket type
  // stands in for `activities.default_capacity`/`activity_sessions.capacity`
  // similarly — null (unknown, or genuinely unlimited on Wix) leaves
  // whatever's already there alone rather than blanking it, same convention
  // wixServiceCapacity/wixServicePrice use for Bookings. Sourced from
  // ctx.ticketTypesByEventId — a real DB read the caller did in bulk *after*
  // this run's own ticket-type upserts landed, not from the caller's
  // in-memory Wix fetch — so this stays correct even on a run where that
  // fetch failed/was skipped (see isMissingEventsApp above) and existing
  // ticket_types rows were simply left as they were.
  const ticketTypes = ctx.ticketTypesByEventId.get(localEventId) ?? [];
  const price =
    ticketTypes.length > 0
      ? ticketPriceWithFeeCents(ticketTypes[0].price_cents, ticketTypes[0].fee_type, ticketTypes[0].fee_rate_percent) / 100
      : null;
  const capacity =
    ticketTypes.length > 0 && ticketTypes.every((t) => t.capacity_total != null)
      ? ticketTypes.reduce((sum, t) => sum + (t.capacity_total as number), 0)
      : null;

  // Wix stays the source of truth for location/capacity/price/photo/
  // description on every sync (create AND update) — same philosophy
  // syncWixServicesToActivities documents for Bookings-linked activities.
  // Category, age range and publish state are the vendor's own to set and
  // are never touched here past first import.
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
        // Wix knows about this event again (this fetch found it) — same
        // revival rule the wix_events row itself just got above.
        wix_missing_since: null,
      })
      .eq('id', existingActivityId);
    activityId = existingActivityId;
  } else {
    if (!ctx.communityEventsCategoryId) return; // no fallback category exists yet — extremely unlikely; mirrors syncWixServicesToActivities's own bail-out in lib/wix/sync.ts

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
  //
  // A Wix event has exactly one occurrence, so this activity carries exactly
  // one session. This used to find it with `.eq('activity_id', …).maybeSingle()`,
  // but `.maybeSingle()` resolves to an *error* (data === null) the moment
  // more than one row matches — and with that error unchecked, every sync
  // after the first duplicate fell straight through to the INSERT branch and
  // stacked another one. So it self-multiplied: N sessions in, N+1 out, once
  // per scheduled run. Collapse to one instead — keep a single canonical row
  // (whichever already has a live booking on it, so a sold ticket is never
  // stranded; otherwise the earliest), point it at the event's current
  // date/time, and delete any other unbooked rows. `rows` (and which of them
  // are booked) come from ctx — a brand-new activityId just inserted above
  // simply won't be a key in either map, which correctly falls through to
  // "no existing sessions" below exactly like the old per-activity SELECT
  // would have for a row that didn't exist yet.
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
  // account correct, not exposing anything to parents. `onlyEventIds` gates
  // the *activities* mirror below (the part a parent can see/book): it's
  // the set the "Import specific events" picker wants mirrored, and the
  // only way a Wix event becomes a listing here. A blanket caller (the
  // "Sync events" button, the pg_cron background sync) passes nothing —
  // those runs refresh events a vendor has already imported but never
  // mirror a new one, matching syncWixServicesToActivities.
  const explicitIds = options?.onlyEventIds ? new Set(options.onlyEventIds) : null;

  // Local wix_events.id of every event already mirrored into `activities`,
  // so a blanket run knows which ones to keep refreshing.
  const { data: mirroredRows } = await admin
    .from('activities')
    .select('wix_event_id')
    .eq('provider_id', providerId)
    .not('wix_event_id', 'is', null);
  const mirroredLocalIds = new Set((mirroredRows ?? []).map((r) => r.wix_event_id as string));

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

  // The two Wix-side calls below are what actually eat the clock: a
  // ticket-definitions fetch per event, each with its own 20s timeout and a
  // 429 retry (see wixFetch in client.ts). Fetching them one event at a time
  // meant a vendor importing even a handful of events could walk straight
  // into the route's 60s budget (see the maxDuration comment in
  // wix-events-import/route.ts) purely on Wix latency — the client then
  // shows a generic "network dropped" error even though nothing was
  // actually wrong, the request just ran out of time before finishing.
  // Prefetching them concurrently here (allSettled, so one event's failure
  // doesn't stop the others) turns N sequential 20s-worst-case calls into
  // roughly one.
  const ticketDefsSettled = await Promise.allSettled(events.map((event) => fetchWixTicketDefinitions(creds, event.id)));
  const ticketDefsByEventId = new Map<string, Awaited<ReturnType<typeof fetchWixTicketDefinitions>>>();
  const ticketDefsErrorByEventId = new Map<string, unknown>();
  events.forEach((event, i) => {
    const settled = ticketDefsSettled[i];
    if (settled.status === 'fulfilled') ticketDefsByEventId.set(event.id, settled.value);
    else ticketDefsErrorByEventId.set(event.id, settled.reason);
  });
  // Matches the old per-event behaviour exactly: any ticket-definitions
  // fetch failure that isn't "this account has no Events & Tickets app" is
  // treated as fatal for the whole run — checked up front now rather than
  // discovered mid-loop, so this never leaves a half-synced run behind
  // (some events' wix_events rows written, later ones not) the way throwing
  // partway through the old per-event loop could.
  for (const event of events) {
    const prefetchError = ticketDefsErrorByEventId.get(event.id);
    if (prefetchError !== undefined && !isMissingEventsApp(prefetchError)) throw prefetchError;
  }

  // --- Batch 1: wix_events (was 1-2 round trips PER event) ------------------
  // The one Supabase write every fetched event needs regardless of whether
  // it ends up mirrored — a plain upsert on (provider_id, wix_event_id)
  // works because, unlike activities below, `fields` is identical whichever
  // branch would have run: there's no insert-only column (slug/category/
  // is_published) that a blind upsert could clobber on an existing row.
  const existingEventRows = events.length
    ? (
        await admin
          .from('wix_events')
          .select('id, wix_event_id, wix_missing_since')
          .eq('provider_id', providerId)
          .in('wix_event_id', events.map((e) => e.id))
      ).data ?? []
    : [];
  const existingEventByWixId = new Map(existingEventRows.map((r) => [r.wix_event_id, r]));

  const eventRowsToUpsert = events.map((event) => {
    const existing = existingEventByWixId.get(event.id);
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
      // Wix knows about this event again (this fetch found it) — same
      // revival rule syncWixServicesToActivities uses for wix_missing_since.
      wix_missing_since: null,
    };
  });
  const localEventIdByWixId = new Map(existingEventRows.map((r) => [r.wix_event_id, r.id] as const));
  if (eventRowsToUpsert.length) {
    const { data: upserted, error } = await admin
      .from('wix_events')
      .upsert(eventRowsToUpsert, { onConflict: 'provider_id,wix_event_id' })
      .select('id, wix_event_id');
    if (error) {
      // One malformed row used to only cost that one event (the old
      // per-event insert logged-and-skipped; an update's error wasn't even
      // checked) — a single bulk call fails atomically, so surfacing this as
      // a hard throw would turn one bad event into an aborted run for every
      // event, including ones that already had a perfectly good id from the
      // prefetch above. Log and carry on instead: existing events keep the
      // id they already had (their fields just don't get this run's refresh
      // this one time), and any brand-new event simply has no id to find
      // below, which the eventsWithLocalId filter already treats as "skip
      // ticket sync/mirroring for it this run" rather than a crash.
      console.error('wix_events bulk upsert failed', error);
    } else {
      for (const row of upserted ?? []) localEventIdByWixId.set(row.wix_event_id, row.id);
    }
  }

  // Every event this run actually knows a local id for, in original Wix
  // order — an id can be missing only if the upsert above somehow didn't
  // return a row for it, which .select() on a successful upsert never does;
  // kept as a filter rather than a throw so one unexplained gap can't take
  // down ticket pricing/mirroring for every other event in the batch.
  const eventsWithLocalId = events
    .map((event) => ({ event, localEventId: localEventIdByWixId.get(event.id) }))
    .filter((x): x is { event: WixEvent; localEventId: string } => !!x.localEventId);

  // --- Batch 2: event_ticket_types fee-rate cache + upsert (was 2 round
  // trips PER TICKET DEFINITION) --------------------------------------------
  const eventsNeedingTicketSync = eventsWithLocalId.filter(({ event }) => {
    const prefetchError = ticketDefsErrorByEventId.get(event.id);
    if (prefetchError !== undefined) {
      result.ticketPricingSkipped.push(event.title); // must be isMissingEventsApp — anything else already threw above
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
    (cachedTicketTypeRows ?? []).map((r) => [`${r.event_id}:${r.wix_ticket_definition_id}`, r.fee_rate_percent])
  );

  // Different ticket definitions upsert different rows (unique on event_id +
  // wix_ticket_definition_id) with no shared state between them, so — unlike
  // the location-dedup step below — resolving every definition across every
  // event concurrently is safe. This is also where the other slow Wix call
  // lives: fetchTicketFeeRatePercent is a live reservation, one per
  // definition without a cached rate yet (i.e. every definition on a first
  // import).
  const ticketTypeRows = (
    await Promise.all(
      eventsNeedingTicketSync.flatMap(({ event, localEventId }) =>
        (ticketDefsByEventId.get(event.id) ?? []).map(async (def) => {
          const priceCents = def.priceValue != null ? Math.round(Number(def.priceValue) * 100) : 0;
          // The fee *rate* only ever comes from a live reservation, so it's
          // discovered once (a throwaway hold, see fetchTicketFeeRatePercent)
          // and cached rather than re-reserved on every sync.
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
            // Wix's own "no tickets left" flag — the parent booking UI reads
            // this to show a disabled "Sold out" state (Wix Events have no
            // BabyBrain waitlist, see 00107). Refreshed every sync, so a
            // vendor raising the ticket limit on Wix clears it automatically.
            sold_out: def.soldOut,
            hidden: def.hidden,
            fee_type: def.feeType,
            fee_rate_percent: feeRatePercent,
          };
        })
      )
    )
  );
  if (ticketTypeRows.length) {
    await admin.from('event_ticket_types').upsert(ticketTypeRows, { onConflict: 'event_id,wix_ticket_definition_id' });
  }

  // --- Batch 3: everything syncEventActivityMirror used to SELECT per event
  // (was 3-4 more round trips PER MIRRORED event) ----------------------------
  // Explicitly requested by the picker, or already imported and just being
  // kept fresh — a blanket run never mirrors a brand-new event.
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
    const existingActivityIdByLocalEventId = new Map(
      (existingMirrorRows ?? []).map((r) => [r.wix_event_id as string, r.id])
    );

    type FreshTicketTypeRow = {
      event_id: string;
      price_cents: number;
      capacity_total: number | null;
      fee_type: string | null;
      fee_rate_percent: number | null;
    };
    const { data: freshTicketTypeRows }: { data: FreshTicketTypeRow[] | null } = await admin
      .from('event_ticket_types')
      .select('event_id, price_cents, capacity_total, fee_type, fee_rate_percent')
      .in('event_id', localEventIdsToMirror)
      .eq('hidden', false)
      .order('price_cents', { ascending: true });
    const ticketTypesByEventId = new Map<string, FreshTicketTypeRow[]>();
    for (const row of freshTicketTypeRows ?? []) {
      const list = ticketTypesByEventId.get(row.event_id) ?? [];
      list.push(row);
      ticketTypesByEventId.set(row.event_id, list);
    }

    const knownActivityIds = [...existingActivityIdByLocalEventId.values()];
    const { data: existingSessionRows } = knownActivityIds.length
      ? await admin.from('activity_sessions').select('id, activity_id').in('activity_id', knownActivityIds).order('starts_at', { ascending: true })
      : { data: [] };
    const sessionsByActivityId = new Map<string, { id: string }[]>();
    for (const row of existingSessionRows ?? []) {
      const list = sessionsByActivityId.get(row.activity_id) ?? [];
      list.push({ id: row.id });
      sessionsByActivityId.set(row.activity_id, list);
    }

    const knownSessionIds = (existingSessionRows ?? []).map((r) => r.id);
    const { data: bookedRows } = knownSessionIds.length
      ? await admin.from('bookings').select('session_id').in('session_id', knownSessionIds).neq('status', 'cancelled')
      : { data: [] };
    const bookedSessionIds = new Set((bookedRows ?? []).map((b) => b.session_id));

    const { data: communityEventsCategory } = await admin
      .from('activity_categories')
      .select('id')
      .eq('slug', 'community-events')
      .maybeSingle();

    const mirrorCtx: EventMirrorContext = {
      locationCache,
      locationCountRef,
      ticketTypesByEventId,
      existingActivityIdByLocalEventId,
      sessionsByActivityId,
      bookedSessionIds,
      communityEventsCategoryId: communityEventsCategory?.id ?? null,
    };

    // The actual per-event writes — still fully serial, in original Wix
    // order, exactly as before. This is the one part that must NOT be
    // parallelized: resolveEventLocation does check-then-insert location
    // dedup by address (now against mirrorCtx.locationCache, updated in
    // place as each new address is created) that isn't safe to run
    // concurrently across events sharing a venue — two events landing on the
    // same not-yet-seen address at once could each miss the other's insert
    // and create two location rows for one address.
    for (const { event, localEventId } of eventsToMirror) {
      await syncEventActivityMirror(admin, providerId, localEventId, event, mirrorCtx);
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
    if (fetchedIds.has(row.wix_event_id)) continue;
    const missingSince = new Date().toISOString();
    await admin
      .from('wix_events')
      .update({ wix_missing_since: missingSince, is_published: false })
      .eq('id', row.id);
    // Same "gone" flag propagated to the mirrored activity — matches
    // scripts/reset-wix-demo-vendor.mjs's reconciliation for Wix Bookings.
    const { data: mirrored } = await admin
      .from('activities')
      .update({ wix_missing_since: missingSince, is_published: false })
      .eq('provider_id', providerId)
      .eq('wix_event_id', row.id)
      .select('id');
    result.removed++;

    // A cancelled or deleted Wix event strands whatever tickets were sold
    // against it — the mirrored `bookings` rows used to be left `confirmed`
    // forever. Cancel them so the roster is correct and, via
    // compensate_cancelled_booking (00080), every paid ticket-holder gets a
    // make-up token; free RSVPs just move to cancelled. The authoritative
    // `event_ticket_orders` rows are moved in step. Only fires on the
    // transition (next run the row is already `wix_missing_since`-flagged and
    // filtered out above), so nothing is cancelled twice or on a transient
    // sync gap that leaves the fetch throwing rather than short.
    const activityIds = (mirrored ?? []).map((a) => a.id);
    if (activityIds.length) {
      const { data: sessions } = await admin
        .from('activity_sessions')
        .select('id')
        .in('activity_id', activityIds);
      const sessionIds = (sessions ?? []).map((s) => s.id);
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
