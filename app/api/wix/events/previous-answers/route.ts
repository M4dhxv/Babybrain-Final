import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadRememberedAnswers } from '@/lib/wix/previous-answers';

/**
 * What this parent already told other organisers about this child, to prefill the same questions on
 * this event's booking page ("Does your child have any allergies?" is asked again for every event).
 * See lib/wix/previous-answers. Only the signed-in parent's own earlier answers, only for the child named.
 * Query: ?eventId=<local wix_events id>&childId=
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get('eventId');
  const childId = searchParams.get('childId');
  if (!eventId || !childId) return NextResponse.json({ answers: {} });

  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const answers = await loadRememberedAnswers(createAdminClient(), { userId: user.id, eventId, childId });
  return NextResponse.json({ answers });
}
