import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { fragmentBounce, redirectSignedIn, safeNext, verifyEmailToken } from '@/lib/auth-links';

/**
 * OAuth / email-link landing point. Three shapes arrive here:
 *
 * - Supabase's own /verify link (the confirm-signup email's
 *   {{ .ConfirmationURL }}, with RedirectTo `/auth/callback?next=/profile`).
 *   Supabase has already confirmed the account and sends the new session —
 *   or why it failed — in the URL fragment, which never reaches the server.
 *   This used to answer it with /login?error=auth: the browser carried the
 *   fragment along, so the parent was in fact signed in, but was shown the
 *   log-in form. Now the fragment goes on to `next` (see fragmentBounce).
 *
 * - A `token_hash` link: the older branded confirmation email linked to
 *   `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`, and the app's
 *   RedirectTo is already `/auth/callback?next=/profile`, so the link arrives
 *   as `/auth/callback?next=/profile?token_hash=…&type=signup`: `token_hash`
 *   is swallowed into the `next` value and `type` is left as a sibling. Both
 *   the clean and the nested shapes work. The session goes to the app in the
 *   fragment, as Supabase's own link does.
 *
 * - A PKCE `code` (OAuth). Exchanged for a cookie session; explicit ?next=
 *   wins, otherwise onboarding status decides.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  let tokenHash = searchParams.get('token_hash');
  let type = searchParams.get('type');
  let rawNext = searchParams.get('next');

  // "/profile?token_hash=…": pull the token back out of `next`.
  if (rawNext && rawNext.includes('?')) {
    const i = rawNext.indexOf('?');
    const inner = new URLSearchParams(rawNext.slice(i + 1));
    tokenHash ??= inner.get('token_hash');
    type ??= inner.get('type');
    rawNext = rawNext.slice(0, i);
  }
  const next = safeNext(rawNext);

  if (tokenHash && type) {
    const { session, error } = await verifyEmailToken(tokenHash, type as EmailOtpType);
    if (!error) return redirectSignedIn(origin, next ?? '/profile', session, type);
    // Already used (a mail scanner often opens it first) or expired.
    return NextResponse.redirect(`${origin}/login?link=expired`);
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (next) return NextResponse.redirect(`${origin}${next}`);

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        // A confirmed account always lands on the parent's own profile — QA
        // found the old /onboarding fallback made people fill the sign-up
        // form in a second time. Anyone who signed up without finishing
        // onboarding can still complete it from Edit profile.
        const { data: kids } = await supabase
          .from('children')
          .select('id')
          .eq('parent_id', user.id)
          .limit(1);
        return NextResponse.redirect(
          `${origin}${kids && kids.length > 0 ? '/profile' : '/onboarding'}`
        );
      }
    }
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  return fragmentBounce(next ?? '/profile');
}
