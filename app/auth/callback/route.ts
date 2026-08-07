import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * OAuth / email-link landing point. Exchanges the code for a session,
 * then routes: explicit ?next= wins; otherwise onboarding status decides.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');

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
