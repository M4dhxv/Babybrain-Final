import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncParentClassAccess } from '@/lib/class-chat';

/**
 * Called by the bookings_chat_sync pg_net trigger when a booking's status or
 * session changes (cancel, reschedule, Wix-side cancellation, restore…), so a
 * parent's class-group access follows their booking even if they never reopen
 * the chat. Revocation only — joining a slot happens when the parent opens it.
 * Idempotent: it recomputes from the bookings table, not from the payload.
 * Body: { user_id, session_ids: string[] } (old + new session of the booking).
 */
export async function POST(request: Request) {
  if (request.headers.get('x-webhook-secret') !== process.env.WEBHOOK_SHARED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user_id: userId, session_ids: sessionIds } = (await request.json().catch(() => ({}))) as {
    user_id?: string;
    session_ids?: string[];
  };
  if (!userId || !Array.isArray(sessionIds) || !sessionIds.length) {
    return NextResponse.json({ error: 'user_id and session_ids required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: sessions } = await admin.from('activity_sessions').select('activity_id').in('id', sessionIds);
  const activityIds = [...new Set((sessions ?? []).map((s) => s.activity_id))];

  let failed = 0;
  for (const activityId of activityIds) {
    try {
      await syncParentClassAccess(admin, activityId, userId, { ensure: false });
    } catch (e) {
      failed++;
      console.error('[booking-chat] sync failed', activityId, userId, e);
    }
  }
  // 500 lets pg_net's failure show in net._http_response; the next chat open
  // re-syncs anyway, so a miss here never grants access, it only delays revoke.
  return NextResponse.json({ ok: failed === 0 }, { status: failed ? 500 : 200 });
}
