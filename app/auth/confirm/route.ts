import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

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
 * ever points at our own domain.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = searchParams.get('next') || '/profile';

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
