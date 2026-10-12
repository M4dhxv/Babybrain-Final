import { NextResponse } from 'next/server';
import { pushEnabled } from '@/lib/push';

/**
 * Tells the parent app whether this deployment can actually send Web Push
 * (VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY set). The app only asks a parent for
 * notification permission when this says yes, so setting the variables and
 * redeploying switches the prompt on with no frontend rebuild, and a deploy
 * without them never asks for a permission it can't honour.
 *
 * Public and tiny; never cached, so the answer is always the live one.
 */
export async function GET() {
  return NextResponse.json({ enabled: pushEnabled() }, { headers: { 'Cache-Control': 'no-store' } });
}
