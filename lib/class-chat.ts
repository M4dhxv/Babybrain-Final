import type { SupabaseClient } from '@supabase/supabase-js';
import { getStreamServerClient, sessionChannelId } from '@/lib/stream';

/** Booking statuses that entitle a parent to the slot's group chat. */
export const LIVE_BOOKING_STATUSES = ['pending', 'confirmed', 'completed'] as const;

type Admin = SupabaseClient<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const slotLabel = (startsAt: string) =>
  new Date(startsAt).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });

async function activeStaffIds(admin: Admin, providerId: string): Promise<string[]> {
  const { data } = await admin
    .from('provider_members')
    .select('user_id')
    .eq('provider_id', providerId)
    .eq('status', 'active');
  return (data ?? []).map((s: { user_id: string }) => s.user_id);
}

/**
 * Create the slot's group channel if missing and make `parentIds` + staff
 * members. Idempotent: the channel id is deterministic (sessionChannelId), so
 * the vendor's "Message parents" and a parent's "Class group chat" always land
 * on the same channel, whichever created it first.
 */
export async function ensureSessionChannel(
  admin: Admin,
  sessionId: string,
  parentIds: string[],
  createdBy: string,
): Promise<{ channelId: string; memberCount: number } | null> {
  const { data: sessionRow } = await admin
    .from('activity_sessions')
    .select('activity_id, starts_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (!sessionRow) return null;
  const { data: activity } = await admin
    .from('activities')
    .select('title, provider_id')
    .eq('id', sessionRow.activity_id)
    .maybeSingle();
  if (!activity?.provider_id) return null;
  const providerId: string = activity.provider_id;

  const [{ data: provider }, { data: profiles }, staffIds] = await Promise.all([
    admin.from('providers').select('business_name').eq('id', providerId).maybeSingle(),
    parentIds.length
      ? admin.from('parent_profiles').select('id, full_name').in('id', parentIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
    activeStaffIds(admin, providerId),
  ]);
  const providerName = provider?.business_name || 'Provider';
  const nameById = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name]));

  const stream = getStreamServerClient();
  const channelId = sessionChannelId(sessionId);
  const members = [...new Set([...parentIds, ...staffIds])];

  await stream.upsertUsers([
    ...parentIds.map((id) => ({ id, name: nameById[id] || 'Parent' })),
    ...staffIds.map((id) => ({ id, name: providerName })),
  ]);

  const channel = stream.channel('messaging', channelId, {
    members,
    created_by_id: createdBy,
    name: `${activity.title} — ${slotLabel(sessionRow.starts_at)}`,
    bb_kind: 'session',
    bb_provider_id: providerId,
    bb_activity_id: sessionRow.activity_id,
    bb_session_id: sessionId,
  } as never);
  await channel.create(); // no-op if it already exists
  // Pre-existing channel: top up anyone who joined since (new parent, new staff).
  await channel.addMembers(members);

  return { channelId, memberCount: members.length };
}

/**
 * Remove a parent from every group channel of this activity except the slots
 * they still hold a live booking on. This is what revokes access on cancel and
 * on reschedule (old slot out, new slot in). Also retires the legacy
 * whole-class channel (`class-…`), which had no per-slot scoping.
 */
export async function revokeStaleAccess(
  admin: Admin,
  activityId: string,
  parentId: string,
  keepSessionIds: Set<string>,
): Promise<void> {
  const stream = getStreamServerClient();
  const found = await stream.queryChannels(
    { type: 'messaging', bb_activity_id: activityId, members: { $in: [parentId] } } as never,
    {},
    { limit: 100, state: false, watch: false },
  );
  for (const ch of found) {
    const sid = (ch.data as { bb_session_id?: string } | undefined)?.bb_session_id;
    if (sid && keepSessionIds.has(sid)) continue;
    try {
      await ch.removeMembers([parentId]);
    } catch (e) {
      console.error('[class-chat] removeMembers failed', ch.id, parentId, e);
    }
  }
}

/** Sessions of `activityId` the parent currently holds a live booking on, soonest first. */
export async function liveSessionsForParent(
  admin: Admin,
  activityId: string,
  parentId: string,
): Promise<{ id: string; starts_at: string }[]> {
  const { data } = await admin
    .from('bookings')
    .select('session_id, activity_sessions!inner(id, starts_at, activity_id, status)')
    .eq('user_id', parentId)
    .in('status', [...LIVE_BOOKING_STATUSES])
    .eq('activity_sessions.activity_id', activityId);
  const rows = (data ?? []) as unknown as Array<{
    activity_sessions: { id: string; starts_at: string; status: string | null };
  }>;
  const byId = new Map<string, { id: string; starts_at: string }>();
  for (const r of rows) {
    if (r.activity_sessions.status === 'cancelled') continue;
    byId.set(r.activity_sessions.id, { id: r.activity_sessions.id, starts_at: r.activity_sessions.starts_at });
  }
  return [...byId.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** The slot a parent's "Class group chat" should open: next upcoming, else the latest past one. */
export function pickSlot(sessions: { id: string; starts_at: string }[]): string | null {
  if (!sessions.length) return null;
  const now = Date.now();
  const upcoming = sessions.find((s) => new Date(s.starts_at).getTime() >= now);
  return (upcoming ?? sessions[sessions.length - 1]).id;
}

/**
 * Reconcile one parent's chat access for one activity with their bookings.
 * `ensure` true (parent opened the chat): create/join the chosen slot's group.
 * `ensure` false (booking changed in the background): only revoke — never spin
 * up channels nobody asked for; the parent joins the new slot when they open it.
 */
export async function syncParentClassAccess(
  admin: Admin,
  activityId: string,
  parentId: string,
  opts: { ensure: boolean },
): Promise<{ channelId: string | null }> {
  const live = await liveSessionsForParent(admin, activityId, parentId);
  await revokeStaleAccess(admin, activityId, parentId, new Set(live.map((s) => s.id)));

  const chosen = pickSlot(live);
  if (!chosen) return { channelId: null };
  if (opts.ensure) {
    const res = await ensureSessionChannel(admin, chosen, [parentId], parentId);
    return { channelId: res?.channelId ?? null };
  }
  return { channelId: sessionChannelId(chosen) };
}
