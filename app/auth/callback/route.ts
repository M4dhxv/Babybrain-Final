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
        const { data: profile } = await supabase
          .from('parent_profiles')
          .select('onboarding_completed_at')
          .eq('id', user.id)
          .single();
        return NextResponse.redirect(
          `${origin}${profile?.onboarding_completed_at ? '/dashboard' : '/onboarding'}`
        );
      }
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
