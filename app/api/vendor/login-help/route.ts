import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { rateLimited, clientIp } from '@/lib/rate-limit';
import { maskEmail } from '@/lib/launch-event-manage';

/**
 * Tells the vendor portal's sign-in and forgot-password pages WHY an email
 * didn't work, instead of Supabase's generic "Invalid login credentials" /
 * silent "we've sent a link". Vendors kept typing their business's public
 * contact email (providers.contact_email), which is not a login — the login
 * is auth.users.email, and nothing keeps the two in sync.
 *
 * Body: { email }  →  one of
 *   { status: 'login' }                                     an account uses this email
 *   { status: 'contact_only', business_name, login_hint }   a business's contact email, not a login;
 *                                                           login_hint is the owner's login, masked
 *   { status: 'unknown' }                                   neither
 *
 * Unauthenticated and answers "is this email registered", so it's rate limited
 * per IP and per email, and returns nothing beyond the above. Only called after
 * a failed sign-in or on a reset request.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 });
  }

  const admin = createAdminClient();
  const throttled =
    (await rateLimited(admin, `login-help:ip:${clientIp(request)}`, 20, 600)) ||
    (await rateLimited(admin, `login-help:email:${email}`, 10, 600));
  if (throttled) {
    return NextResponse.json({ error: 'Too many attempts — please wait a few minutes.' }, { status: 429 });
  }

  if (await findLoginEmail(email)) return NextResponse.json({ status: 'login' });

  const { data: provider } = await admin
    .from('providers')
    .select('business_name, owner_id')
    .ilike('contact_email', email)
    .not('owner_id', 'is', null)
    .limit(1)
    .maybeSingle();
  if (provider?.owner_id) {
    const { data } = await admin.auth.admin.getUserById(provider.owner_id);
    return NextResponse.json({
      status: 'contact_only',
      business_name: provider.business_name,
      login_hint: data.user?.email ? maskEmail(data.user.email) : null,
    });
  }

  return NextResponse.json({ status: 'unknown' });
}

/**
 * GoTrue's admin `filter` is a substring match on email, so one call narrows
 * to a handful of users and the exact match is checked here. (listUsers()
 * paging through every user on each failed sign-in would be far heavier.)
 */
async function findLoginEmail(email: string): Promise<boolean> {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=50`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`auth admin lookup failed: ${res.status}`);
  const { users = [] } = (await res.json()) as { users?: { email?: string }[] };
  return users.some((u) => u.email?.toLowerCase() === email);
}
