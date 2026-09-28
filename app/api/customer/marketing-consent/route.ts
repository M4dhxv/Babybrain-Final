import { NextResponse } from 'next/server';
import { getAuthedContext } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { setMarketingSubscription, upsertProfile } from '@/lib/klaviyo';

/**
 * A parent gives or withdraws marketing consent (Settings → Subscribe /
 * Unsubscribe, and the footer unsubscribe link that lands there).
 *
 * Saves parent_profiles.marketing_consent_at (stamped now, or cleared) and
 * mirrors the choice onto the Klaviyo list, so an unsubscribe here also stops
 * Klaviyo's marketing emails. Klaviyo is a no-op until its env vars are set.
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
  const { data: profile, error } = await admin
    .from('parent_profiles')
    .update({ marketing_consent_at: consented ? new Date().toISOString() : null })
    .eq('id', user.id)
    .select('email, full_name')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!profile) return NextResponse.json({ error: 'No parent profile for this account' }, { status: 404 });

  const email = profile.email ?? user.email;
  if (email) {
    // Only create the Klaviyo profile for someone opting in; an opt-out just
    // flips the subscription on a profile Klaviyo may already hold.
    if (consented) {
      await upsertProfile({ email, firstName: profile.full_name, properties: { babybrain_user_id: user.id, marketing_consent: true } });
    }
    await setMarketingSubscription(email, consented);
  }

  return NextResponse.json({ ok: true, consented });
}
