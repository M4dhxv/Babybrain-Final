import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Refreshes the cookie session for the pages Next renders itself (/admin,
// /auth/*; see the matcher in middleware.ts). Nothing is gated here any more:
// the parent SPA authenticates client-side with supabase-js and never sets SSR
// cookies, so gating its routes locked out even signed-in users. The legacy
// /dashboard and /support pages this used to guard were shadowed by the SPA
// long ago and now redirect to the app's own pages (next.config.mjs); gating
// them sent every parent with a stale link round /login forever.
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Do not run code between createServerClient and auth.getUser() —
  // it can cause random logouts (see Supabase SSR docs).
  await supabase.auth.getUser();

  return supabaseResponse;
}
