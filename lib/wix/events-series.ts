import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { ticketPriceWithFeeCents, type WixEvent } from './client';
import { LOCATION_ENTRY_COLUMNS, resolveEventLocation, type LocationEntry } from './events-sync';
import { splitMultiDay } from './event-days';

/**
 * Recurring Wix events as ONE activity.
 *
 * In Wix a recurring event is a *series of separate events* that share one
 * `recurringEvents.categoryId` (the "series id"): each date has its own event
 * id, its own ticket definitions, its own capacity. We used to mirror every
 * date as its own activity, so BeAlere's handful of weekly classes appeared as
 * 36 near-identical activities.
 *
 * A series is now one activity (`activities.wix_series_id`) with one session
 * per date (`activity_sessions.wix_event_id` = the local wix_events row for
 * that date, which in turn owns the date's ticket types). Parents pick a date
 * and then a ticket type of *that* date.
 *
 * A series activity keeps `wix_event_id` NULL on purpose. The 15-minute sync
 * (both its Next and Deno copies) only maintains activities that have a
 * `wix_event_id`, and its "an event has exactly one session" collapse would
 * delete a series' other dates. Everything about a series — dates coming and
 * going, merging earlier per-date activities into it, refreshing its details —
 * is owned here, run by the reconcile job and the vendor's import.
 *
 * The decision part ({@link planSeries}) is pure so it can be tested against
 * real data; {@link applySeriesPlan} is the thin part that writes it.
 */

type Admin = SupabaseClient<Database>;

export interface SeriesOccurrence {
  localEventId: string;
  wixEventId: string;
  startDate: string;
  endDate: string;
  /** Multi-day events: the calendar day (event time zone) this occurrence is; absent for an ordinary date. */
  day?: string | null;
}

export interface SeriesActivityRow {
  id: string;
  /** Local wix_events id for an old per-date activity; null for a series activity. */
  wixEventId: string | null;
  wixSeriesId: string | null;
  isPublished: boolean;
  createdAt: string;
  liveBookings: number;
}

export interface SeriesSessionRow {
  id: string;
  activityId: string;
  wixEventId: string | null;
  status: string | null;
  startsAt: string;
  endsAt: string | null;
  /** Multi-day events: the calendar day this session is; null/absent for an ordinary date. */
  wixDay?: string | null;
}

export interface SeriesPlan {
  seriesId: string;
  canonicalActivityId: string;
  /** The canonical activity is still a per-date one and becomes the series activity. */
  convertCanonical: boolean;
  /** Other activities of the same series, folded into the canonical one then retired. */
  mergeActivityIds: string[];
  /** Existing sessions to point at the canonical activity / stamp with their event. */
  moveSessions: { sessionId: string; localEventId: string | null }[];
  createSessions: SeriesOccurrence[];
  updateSessions: { sessionId: string; occurrence: SeriesOccurrence }[];
  /** Dates whose Wix event is gone, or days a multi-day event no longer covers — cancelled with their bookings (vendor cancellation). */
  cancelSessions: string[];
  /** A single-span session superseded by per-day sessions (or the reverse): removed quietly when it holds no bookings. */
  retireSessions: string[];
}

export interface SeriesPlanInput {
  /** Upcoming, not-cancelled occurrences found on Wix, grouped by series id. */
  occurrencesBySeries: Map<string, SeriesOccurrence[]>;
  /** Every local event id known to belong to a series (including ones no longer on Wix). */
  localEventIdsBySeries: Map<string, Set<string>>;
  /** Local event ids Wix no longer offers (cancelled / deleted). */
  goneLocalEventIds: Set<string>;
  activities: SeriesActivityRow[];
  sessions: SeriesSessionRow[];
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && new Date(a).getTime() === new Date(b).getTime();

/** Which series to act on and exactly what to change. A series is in scope once
 *  the vendor has imported any of its dates (a per-date activity exists) or it
 *  already has a series activity. Pure. */
export function planSeries(input: SeriesPlanInput): SeriesPlan[] {
  const plans: SeriesPlan[] = [];
  const seriesIds = new Set<string>([...input.occurrencesBySeries.keys(), ...input.localEventIdsBySeries.keys()]);

  for (const seriesId of seriesIds) {
    const members = input.localEventIdsBySeries.get(seriesId) ?? new Set<string>();
    const existingSeriesActivity = input.activities.find((a) => a.wixSeriesId === seriesId);
    const perDate = input.activities.filter((a) => !a.wixSeriesId && a.wixEventId && members.has(a.wixEventId));
    if (!existingSeriesActivity && perDate.length === 0) continue; // never imported

    // The one that survives: an existing series activity, else the best per-date
    // one — published first, then the one with live bookings, then the oldest.
    const ranked = [...perDate].sort(
      (a, b) =>
        Number(b.isPublished) - Number(a.isPublished) ||
        b.liveBookings - a.liveBookings ||
        a.createdAt.localeCompare(b.createdAt)
    );
    const canonical = existingSeriesActivity ?? ranked[0];
    const merge = perDate.filter((a) => a.id !== canonical.id);
    const mergeIds = new Set(merge.map((a) => a.id));
    const involved = new Set([canonical.id, ...mergeIds]);

    // Which Wix event each existing session is — stamped explicitly, or implied by
    // the per-date activity it belonged to.
    const eventOfActivity = new Map(perDate.map((a) => [a.id, a.wixEventId as string]));
    const sessionEvent = (s: SeriesSessionRow) => s.wixEventId ?? eventOfActivity.get(s.activityId) ?? null;

    const moveSessions: SeriesPlan['moveSessions'] = [];
    // A date is identified by its event AND, for a multi-day event, its calendar day.
    const slot = (ev: string, day: string | null | undefined) => `${ev}|${day ?? ''}`;
    const bySlot = new Map<string, SeriesSessionRow>();
    const live: (SeriesSessionRow & { ev: string })[] = [];
    for (const sess of input.sessions.filter((x) => involved.has(x.activityId))) {
      const ev = sessionEvent(sess);
      // Folded-in activities' sessions move; an unstamped session gets its event (only if we know it).
      if (mergeIds.has(sess.activityId) || (sess.wixEventId == null && ev)) {
        moveSessions.push({ sessionId: sess.id, localEventId: ev });
      }
      // A cancelled date is history, not the date's current session: a date that comes back
      // gets a fresh one. Two live sessions for one date (earlier duplication) keep the first.
      if (ev && sess.status !== 'cancelled') {
        live.push({ ...sess, ev });
        if (!bySlot.has(slot(ev, sess.wixDay))) bySlot.set(slot(ev, sess.wixDay), sess);
      }
    }

    const occurrences = input.occurrencesBySeries.get(seriesId) ?? [];
    const createSessions: SeriesOccurrence[] = [];
    const updateSessions: SeriesPlan['updateSessions'] = [];
    for (const occ of occurrences) {
      const existing = bySlot.get(slot(occ.localEventId, occ.day));
      if (!existing) createSessions.push(occ);
      else if (!same(existing.startsAt, occ.startDate) || !same(existing.endsAt, occ.endDate)) {
        updateSessions.push({ sessionId: existing.id, occurrence: occ });
      }
    }

    // Which events are split into days now, and which days each still covers.
    const wanted = new Set(occurrences.map((o) => slot(o.localEventId, o.day)));
    const splitEvents = new Set(occurrences.filter((o) => o.day).map((o) => o.localEventId));
    const singleEvents = new Set(occurrences.filter((o) => !o.day).map((o) => o.localEventId));

    const cancelSessions: string[] = [];
    const retireSessions: string[] = [];
    for (const sess of live) {
      if (input.goneLocalEventIds.has(sess.ev)) {
        cancelSessions.push(sess.id); // Wix dropped the event
      } else if (sess.wixDay && splitEvents.has(sess.ev) && !wanted.has(slot(sess.ev, sess.wixDay))) {
        cancelSessions.push(sess.id); // the event no longer covers this day
      } else if (!sess.wixDay && splitEvents.has(sess.ev)) {
        retireSessions.push(sess.id); // the old one-span session, superseded by the days
      } else if (sess.wixDay && singleEvents.has(sess.ev)) {
        retireSessions.push(sess.id); // no longer a multi-day event: back to a single date
      }
    }

    plans.push({
      seriesId,
      canonicalActivityId: canonical.id,
      convertCanonical: !existingSeriesActivity,
      mergeActivityIds: merge.map((a) => a.id),
      moveSessions,
      createSessions,
      updateSessions,
      cancelSessions,
      retireSessions,
    });
  }
  return plans;
}

/** A picker row id for a whole series. */
export const seriesPickerId = (seriesId: string) => `series:${seriesId}`;

/** Wix event ids to hand to the single-event mirror for a picker selection: a
 *  plain event id stays as is; a `series:<id>` becomes its earliest upcoming
 *  date (the mirror creates one per-date activity, which {@link planSeries}
 *  then turns into the series activity and fills with the other dates). */
export function representativeEventIds(
  selected: string[],
  events: Pick<WixEvent, 'id' | 'startDate' | 'recurrence'>[]
): string[] {
  const out = new Set<string>();
  for (const id of selected) {
    if (!id.startsWith('series:')) {
      out.add(id);
      continue;
    }
    const seriesId = id.slice('series:'.length);
    const first = events
      .filter((e) => e.recurrence.seriesId === seriesId)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    if (first) out.add(first.id);
  }
  return [...out];
}

export interface PickerGroup {
  /** A plain Wix event id, or `series:<id>` for a whole recurring series. */
  id: string;
  seriesId: string | null;
  name: string;
  /** The first upcoming date. */
  startDate: string;
  occurrences: number;
  /** Every Wix event id in the group. */
  memberIds: string[];
}

/** The import picker's rows: one per recurring series, one per standalone event. Pure. */
export function groupEventsForPicker(events: Pick<WixEvent, 'id' | 'title' | 'startDate' | 'recurrence'>[]): PickerGroup[] {
  const groups = new Map<string, PickerGroup>();
  for (const e of [...events].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const seriesId = e.recurrence.seriesId;
    // Wix gives every one-off event a series id of null; a recurring one shares it.
    const key = seriesId ? seriesPickerId(seriesId) : e.id;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences++;
      existing.memberIds.push(e.id);
    } else {
      groups.set(key, { id: key, seriesId, name: e.title, startDate: e.startDate, occurrences: 1, memberIds: [e.id] });
    }
  }
  return [...groups.values()];
}

export interface SeriesUnlinkResult {
  removed: number;
  protectedSeries: { seriesId: string; title: string }[];
}

/** A vendor unticks a recurring series in the picker. Like unlinking a single event, it is
 *  refused while any date holds a real booking (stranding a parent's ticket is worse than
 *  a stale listing); otherwise the series activity is retired and the series is detached so
 *  it is not re-imported by the reconcile job. */
export async function unlinkWixSeries(admin: Admin, providerId: string, seriesIds: string[]): Promise<SeriesUnlinkResult> {
  const result: SeriesUnlinkResult = { removed: 0, protectedSeries: [] };
  for (const seriesId of seriesIds) {
    const { data: act } = await admin
      .from('activities')
      .select('id, slug, title')
      .eq('provider_id', providerId)
      .eq('wix_series_id', seriesId)
      .maybeSingle();
    if (!act) continue;
    const { data: sessions } = await admin.from('activity_sessions').select('id').eq('activity_id', act.id);
    const sessionIds = (sessions ?? []).map((s) => s.id);
    const { count } = sessionIds.length
      ? await admin.from('bookings').select('id', { count: 'exact', head: true }).in('session_id', sessionIds).neq('status', 'cancelled')
      : { count: 0 };
    if ((count ?? 0) > 0) {
      result.protectedSeries.push({ seriesId, title: act.title });
      continue;
    }
    const { error } = await admin
      .from('activities')
      .update({
        is_published: false,
        wix_series_id: null,
        wix_service_type: null,
        wix_removed_at: new Date().toISOString(),
        slug: `${act.slug}-removed-${act.id.slice(0, 6)}`,
      })
      .eq('id', act.id);
    if (!error) result.removed++;
  }
  return result;
}

export interface SeriesApplyContext {
  providerId: string;
  /** Wix events (upcoming window) keyed by Wix id — details to refresh the activity from. */
  wixEventsById: Map<string, WixEvent>;
  /** Local wix_events id -> Wix event id. */
  wixIdByLocal: Map<string, string>;
  /** Non-hidden ticket types per local event, for price and capacity. */
  ticketTypes: Map<
    string,
    { price_cents: number; capacity_total: number | null; fee_type: string | null; fee_rate_percent: number | null }[]
  >;
}

export interface SeriesApplyResult {
  converted: number;
  merged: number;
  sessionsCreated: number;
  sessionsUpdated: number;
  sessionsCancelled: number;
  sessionsRetired: number;
}

const capacityOf = (types: { capacity_total: number | null }[] | undefined): number | null =>
  types && types.length > 0 && types.every((t) => t.capacity_total != null)
    ? types.reduce((sum, t) => sum + (t.capacity_total as number), 0)
    : null;

/** Writes one series' plan. Idempotent: running it again on the same state is a no-op. */
export async function applySeriesPlan(admin: Admin, plan: SeriesPlan, ctx: SeriesApplyContext): Promise<SeriesApplyResult> {
  const result: SeriesApplyResult = { converted: 0, merged: 0, sessionsCreated: 0, sessionsUpdated: 0, sessionsCancelled: 0, sessionsRetired: 0 };

  // 1. The surviving activity becomes the series activity. Done first: the unique
  //    (provider, series) index means exactly one activity may hold the id.
  if (plan.convertCanonical) {
    const { error } = await admin
      .from('activities')
      .update({ wix_series_id: plan.seriesId, wix_event_id: null })
      .eq('id', plan.canonicalActivityId);
    if (error) {
      console.error('[events-series] could not convert to a series activity', plan.seriesId, error);
      return result;
    }
    result.converted++;
  }

  // 2. Sessions of folded-in activities (and any not yet stamped) point at the series
  //    activity and carry their event. Their bookings follow the session.
  for (const m of plan.moveSessions) {
    await admin
      .from('activity_sessions')
      .update({ activity_id: plan.canonicalActivityId, ...(m.localEventId ? { wix_event_id: m.localEventId } : {}) })
      .eq('id', m.sessionId);
  }

  // 3. Retire the folded-in per-date activities: out of the listing, and detached so the
  //    sync (which only maintains activities with a wix_event_id) never touches them.
  for (const id of plan.mergeActivityIds) {
    const { data: row } = await admin.from('activities').select('slug').eq('id', id).maybeSingle();
    await admin
      .from('activities')
      .update({
        is_published: false,
        archived_at: new Date().toISOString(),
        wix_removed_at: new Date().toISOString(),
        wix_event_id: null,
        wix_service_type: null,
        slug: `${row?.slug ?? 'event'}-merged-${id.slice(0, 6)}`,
      })
      .eq('id', id);
    result.merged++;
  }

  // 4. New dates.
  if (plan.createSessions.length) {
    const rows = plan.createSessions.map((o) => ({
      activity_id: plan.canonicalActivityId,
      wix_event_id: o.localEventId,
      starts_at: o.startDate,
      ends_at: o.endDate,
      // A day of a multi-day event has no capacity of its own on Wix (the ticket limits are per ticket
      // type for the whole event), so none is shown; Wix's live reservation is the gate.
      capacity: o.day ? null : capacityOf(ctx.ticketTypes.get(o.localEventId)),
      wix_day: o.day ?? null,
    }));
    const { error } = await admin.from('activity_sessions').insert(rows);
    if (error) console.error('[events-series] could not add dates', plan.seriesId, error);
    else result.sessionsCreated += rows.length;
  }

  // 5. Dates that moved. A starts_at change fires notify_session_rescheduled (00209), so booked
  //    parents are told.
  for (const u of plan.updateSessions) {
    const capacity = u.occurrence.day ? null : capacityOf(ctx.ticketTypes.get(u.occurrence.localEventId));
    await admin
      .from('activity_sessions')
      .update({ starts_at: u.occurrence.startDate, ends_at: u.occurrence.endDate, ...(capacity != null ? { capacity } : {}) })
      .eq('id', u.sessionId);
    result.sessionsUpdated++;
  }

  // 6. Dates Wix no longer has: cancelled as a vendor cancellation, so parents get the
  //    branded email and a paid ticket-holder the make-up token (00146 / 00080).
  for (const sessionId of plan.cancelSessions) {
    const { error } = await admin.rpc('cancel_wix_session', { p_session_id: sessionId });
    if (error) {
      console.error('[events-series] cancel_wix_session failed', sessionId, error);
      await admin
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('session_id', sessionId)
        .in('status', ['pending', 'confirmed', 'waitlisted']);
    }
    result.sessionsCancelled++;
  }

  // 7. A superseded single-span session goes quietly - but only if nobody holds a place on it.
  for (const sessionId of plan.retireSessions) {
    const { count } = await admin
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .in('status', ['pending', 'confirmed', 'waitlisted']);
    if ((count ?? 0) > 0) {
      console.error('[events-series] a superseded session still has bookings, left in place', sessionId);
      continue;
    }
    await admin.from('activity_sessions').update({ status: 'cancelled' }).eq('id', sessionId);
    result.sessionsRetired++;
  }

  await refreshSeriesActivity(admin, plan, ctx);
  return result;
}

/** Keeps the series activity's own details (title, blurb, picture, venue, price,
 *  capacity, registration type) in step with Wix, from the next upcoming date. */
async function refreshSeriesActivity(admin: Admin, plan: SeriesPlan, ctx: SeriesApplyContext) {
  const { data: sessions } = await admin
    .from('activity_sessions')
    .select('wix_event_id, starts_at, status')
    .eq('activity_id', plan.canonicalActivityId)
    .neq('status', 'cancelled')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true });

  // The next date Wix still offers.
  let next: { event: WixEvent; localEventId: string } | null = null;
  for (const s of sessions ?? []) {
    if (!s.wix_event_id) continue;
    const wixId = ctx.wixIdByLocal.get(s.wix_event_id);
    const event = wixId ? ctx.wixEventsById.get(wixId) : undefined;
    if (event) {
      next = { event, localEventId: s.wix_event_id };
      break;
    }
  }
  if (!next) return;

  const types = ctx.ticketTypes.get(next.localEventId) ?? [];
  const cheapest = types.length
    ? Math.min(...types.map((t) => ticketPriceWithFeeCents(t.price_cents, t.fee_type, t.fee_rate_percent)))
    : null;

  const { data: current } = await admin
    .from('activities')
    .select('address, postal_code, location_id, wix_locked_fields')
    .eq('id', plan.canonicalActivityId)
    .maybeSingle();
  const ev = next.event;
  let locationId = current?.location_id ?? null;
  // Also when the activity has no postal code: Wix can send an address with none (The Crest), and the address
  // never changes afterwards, so without this its venue would never be completed (see resolveEventLocation).
  if (ev.location.formattedAddress && (ev.location.formattedAddress !== current?.address || !current?.postal_code)) {
    const { data: locs } = await admin.from('provider_locations').select(LOCATION_ENTRY_COLUMNS).eq('provider_id', ctx.providerId);
    const cache = new Map<string, LocationEntry>();
    for (const l of locs ?? []) if (l.address) cache.set(l.address, l);
    locationId = (await resolveEventLocation(admin, ctx.providerId, ev, cache, { count: (locs ?? []).length })) ?? locationId;
  }

  // A name or photos the vendor set on BabyBrain are theirs (activities.wix_locked_fields, see lib/wix/sync.ts).
  const locked = current?.wix_locked_fields ?? [];
  await admin
    .from('activities')
    .update({
      ...(locked.includes('title') ? {} : { title: ev.title }),
      ...(ev.description ? { description: ev.description } : {}),
      ...(ev.mainImageUrl && !locked.includes('image_urls') ? { image_urls: [ev.mainImageUrl] } : {}),
      ...(cheapest != null ? { price: cheapest / 100 } : {}),
      ...(capacityOf(types) != null && !splitMultiDay(ev) ? { default_capacity: capacityOf(types) } : {}),
      location_id: locationId,
      address: ev.location.formattedAddress,
      postal_code: ev.location.postalCode,
      wix_service_type: 'EVENT',
      wix_missing_since: null,
      wix_registration_type: ev.registration?.type ?? 'TICKETING',
      ...(ev.registration?.type === 'EXTERNAL' && ev.registration.externalUrl ? { external_booking_url: ev.registration.externalUrl } : {}),
    })
    .eq('id', plan.canonicalActivityId);
}
