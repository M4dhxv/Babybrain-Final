import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { redirectSignedIn, safeNext, verifyEmailToken } from '@/lib/auth-links';

/**
 * Email-link landing point for signup confirmation, password recovery,
 * magic links and email-change confirmation.
 *
 * The branded email (see app/api/auth/send-email) used to link straight to
 * Supabase's own `/auth/v1/verify`, which exposed the raw project ref
 * (`<ref>.supabase.co`) and the verification token in the visible "paste
 * this into your browser" fallback text — a parent could see exactly which
 * Supabase project and deployment backed the app. This route does the same
 * verification server-side via `verifyOtp`, so the link a parent sees only
 * ever points at our own domain, and hands the session to the app it lands in
 * (see lib/auth-links.ts).
 *
 * `next` is checked like /auth/callback's: it was used as-is, so
 * `next=@evil.example` (or `.evil.example`) sent a freshly signed-in browser
 * to another site.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = safeNext(searchParams.get('next')) ?? '/profile';

  if (tokenHash && type) {
    const { session, error } = await verifyEmailToken(tokenHash, type);
    if (!error) return redirectSignedIn(origin, next, session, type);
  }

  // Used (mail scanners often open links first) or expired: back to the app the link was for.
  return NextResponse.redirect(
    next.startsWith('/vendor') ? `${origin}/vendor/#/forgot-password?expired=1` : `${origin}/login?link=expired`
  );
}
