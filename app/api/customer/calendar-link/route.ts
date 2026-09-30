import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { isPlusParent } from '@/lib/customer-plan';

/**
 * The signed-in parent's private calendar-subscription link. Plus only (calendar
 * export / sync is a Plus feature in the app, so the API enforces it too).
 *
 *   GET  -> { url, webcalUrl }   creates the token on first use, then returns it
 *   POST -> { url, webcalUrl }   rotates the token: the old link stops working
 *
 * `url` is what Google / Outlook ask for ("subscribe from URL"); `webcalUrl` is
 * the same address with the webcal:// scheme, which opens Apple Calendar's
 * "Subscribe" prompt directly. The feed itself is
 * /api/public/calendar-feed/[token] - the token is its only credential, which
 * is why it lives in a service-role-only table (migration 00206) and is never
 * returned to anyone but its owner.
 */
type TokenTable = {
  from: (t: string) => {
    select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { token: string } | null; error: { message: string } | null }> } };
    upsert: (row: { user_id: string; token: string; created_at?: string }, o: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
  };
};

function links(request: Request, token: string) {
  const origin = new URL(request.url).origin;
  const url = `${origin}/api/public/calendar-feed/${token}.ics`;
  return { url, webcalUrl: url.replace(/^https?:/, 'webcal:') };
}

const newToken = () => randomBytes(24).toString('base64url');

async function handle(request: Request, rotate: boolean) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const admin = createAdminClient();
  if (!(await isPlusParent(admin, user.id))) {
    return NextResponse.json({ error: 'Calendar sync is a Plus feature', code: 'plus_required' }, { status: 403 });
  }
  const db = admin as unknown as TokenTable;
  if (!rotate) {
    const { data, error } = await db.from('calendar_feed_tokens').select('token').eq('user_id', user.id).maybeSingle();
    if (error) return NextResponse.json({ error: 'Could not load your calendar link' }, { status: 500 });
    if (data) return NextResponse.json(links(request, data.token), { headers: { 'Cache-Control': 'no-store' } });
  }

  const token = newToken();
  const { error } = await db
    .from('calendar_feed_tokens')
    .upsert({ user_id: user.id, token, created_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return NextResponse.json({ error: 'Could not create your calendar link' }, { status: 500 });
  return NextResponse.json(links(request, token), { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  return handle(request, false);
}

export async function POST(request: Request) {
  return handle(request, true);
}
