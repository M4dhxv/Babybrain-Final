import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

/**
 * OAuth / email-link landing point. Exchanges the code for a session,
 * then routes: explicit ?next= wins; otherwise onboarding status decides.
 *
 * Also verifies a `token_hash` email link. The branded signup-confirmation
 * email links to `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`,
 * and the app's RedirectTo is already `/auth/callback?next=/profile`, so the
 * link arrives as `/auth/callback?next=/profile?token_hash=…&type=signup`:
 * `token_hash` is swallowed into the `next` value and `type` is left as a
 * sibling. This route used to look only for `code`, so every such link fell
 * through to /login?error=auth and the account stayed unconfirmed ("Email not
 * confirmed" on every login). Both the clean and the nested shapes work now.
 */

/** Only ever redirect to a path on our own origin ("/profile", never
 *  "//evil.com" or "@evil.com", which `${origin}${next}` would turn into a
 *  different host). */
function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  return next;
}

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
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(`${origin}${next ?? '/profile'}`);
    return NextResponse.redirect(`${origin}/login?error=auth`);
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
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
