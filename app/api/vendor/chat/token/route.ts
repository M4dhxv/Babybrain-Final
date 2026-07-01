import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { getStreamServerClient } from '@/lib/stream';

/**
 * Mints a Stream token for the logged-in user (parent or vendor staff).
 * The client then queries its channels by membership
 * (filter: { members: { $in: [userId] } }) — no per-channel setup needed.
 */
export async function GET(request: Request) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const stream = getStreamServerClient();
  await stream.upsertUser({ id: user.id });

  return NextResponse.json({
    apiKey: process.env.NEXT_PUBLIC_STREAM_KEY,
    token: stream.createToken(user.id),
    userId: user.id,
  });
}
