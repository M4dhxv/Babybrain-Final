import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { pushEnabled, sendPushToUser } from '@/lib/push';

/**
 * Settings → Notifications → "Send a test notification". Pushes one test
 * message to the signed-in parent's own subscribed devices and reports what
 * happened, so a parent (or us) can prove push works end to end.
 *
 * Only ever targets the caller's own devices.
 */
export async function POST(request: Request) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  if (!pushEnabled()) {
    return NextResponse.json({ error: 'Push notifications are not switched on for this site yet.' }, { status: 503 });
  }

  const result = await sendPushToUser(user.id, {
    title: 'BabyBrain notifications are on 🎉',
    body: "This is a test. You'll get one like this when a booking is confirmed or a class is coming up.",
    url: '/profile',
  });

  return NextResponse.json({ ok: result.outcome === 'sent', ...result });
}
