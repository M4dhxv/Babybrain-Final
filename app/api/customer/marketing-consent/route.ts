import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * A parent gives or withdraws marketing consent (Settings → Subscribe /
 * Unsubscribe, and the footer unsubscribe link that lands there).
 *
 * Saves parent_profiles.marketing_consent_at (stamped now, or cleared) and,
 * on withdrawal, marketing_consent_withdrawn_at (00198). Klaviyo is managed by
 * hand (decided 29 Sep), so nothing is sent to it from here: Katie exports
 * consenting parents, and withdrawals to suppress, from /admin → Marketing.
 *
 * Body: { consented: boolean }
 */
export async function POST(request: Request) {
  const { user } = await getAuthedContext(request);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { consented } = (await request.json().catch(() => ({}))) as { consented?: unknown };
  if (typeof consented !== 'boolean') {
    return NextResponse.json({ error: 'consented (true or false) is required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: before } = await admin
    .from('parent_profiles')
    .select('marketing_consent_at')
    .eq('id', user.id)
    .maybeSingle();
  const hadConsent = Boolean(before?.marketing_consent_at);

  const now = new Date().toISOString();
  const { data: profile, error } = await admin
    .from('parent_profiles')
    .update(
      consented
        ? { marketing_consent_at: now, marketing_consent_withdrawn_at: null }
        : // Only a real opt-out is a withdrawal; unsubscribing when you never
          // subscribed leaves nothing for Katie to suppress.
          { marketing_consent_at: null, ...(hadConsent ? { marketing_consent_withdrawn_at: now } : {}) }
    )
    .eq('id', user.id)
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!profile) return NextResponse.json({ error: 'No parent profile for this account' }, { status: 404 });

  return NextResponse.json({ ok: true, consented });
}
