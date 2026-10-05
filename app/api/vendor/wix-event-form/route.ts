import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireProviderRole } from '@/lib/vendor';
import { fetchWixEventForm, getProviderWixCredentials } from '@/lib/wix/client';
import { describeWixFormHandling } from '@/lib/wix/event-form';

/**
 * How a Wix event's own registration form is handled for parents: which fields BabyBrain fills in
 * itself (parent contact, the child's name / age) and which are asked on the booking page. Read
 * live from Wix when the vendor opens the activity, so it can't be stale, and never touched by
 * the parent app. Query: ?providerId=&activityId=
 *
 * A recurring series is one activity over many Wix events that share a form; the next upcoming
 * date's form stands in for all of them.
 */
export const maxDuration = 30;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get('providerId');
  const activityId = searchParams.get('activityId');
  if (!providerId || !activityId) return NextResponse.json({ error: 'providerId and activityId required' }, { status: 400 });

  const auth = await requireProviderRole(request, providerId, 'staff');
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const { data: activity } = await admin
    .from('activities')
    .select('wix_event_id, wix_series_id')
    .eq('id', activityId)
    .eq('provider_id', providerId)
    .maybeSingle();
  if (!activity) return NextResponse.json({ error: 'Activity not found' }, { status: 404 });

  // activities.wix_event_id is the LOCAL wix_events.id; a series' dates live on its sessions.
  let localEventId: string | null = activity.wix_event_id;
  if (activity.wix_series_id) {
    const { data: next } = await admin
      .from('activity_sessions')
      .select('wix_event_id')
      .eq('activity_id', activityId)
      .neq('status', 'cancelled')
      .not('wix_event_id', 'is', null)
      .gte('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    localEventId = next?.wix_event_id ?? localEventId;
  }
  if (!localEventId) return NextResponse.json({ error: 'This activity is not linked to a Wix event' }, { status: 404 });

  const { data: eventRow } = await admin
    .from('wix_events')
    .select('wix_event_id')
    .eq('id', localEventId)
    .eq('provider_id', providerId)
    .maybeSingle();
  if (!eventRow) return NextResponse.json({ error: 'Wix event not found' }, { status: 404 });

  const creds = await getProviderWixCredentials(admin, providerId);
  if (!creds) return NextResponse.json({ error: 'This business has not connected a Wix account' }, { status: 409 });

  try {
    const inputs = await fetchWixEventForm(creds, eventRow.wix_event_id);
    return NextResponse.json({ fields: describeWixFormHandling(inputs) });
  } catch (e) {
    console.error('Wix event form read failed', e);
    return NextResponse.json({ error: 'Could not reach Wix' }, { status: 502 });
  }
}
