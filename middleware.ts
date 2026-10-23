import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { corsHeaders } from '@/lib/cors';

export async function middleware(request: NextRequest) {
  // The cross-origin Vite SPAs hit `/api/**` with a Bearer token. Handle
  // the CORS preflight here and stamp CORS headers on every API response
  // so it works regardless of which route (or error) produced it.
  //
  // No session refresh here: every route reads its caller from the Bearer
  // token (or, in getAuthedContext, from the cookie itself). Refreshing a
  // cookie session on the way in cost a Supabase Auth round trip on every API
  // call that carried one, edge-cached Explore queries included.
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers: cors });
    }
    const response = NextResponse.next();
    for (const [key, value] of Object.entries(cors)) {
      response.headers.set(key, value);
    }
    return response;
  }

  return updateSession(request);
}

export const config = {
  // Only what Next itself serves. Every other page is a Vite SPA (the parent
  // app at `/`, the portal at `/vendor/`) that signs in with localStorage, so
  // a cookie session means nothing to it. The old catch-all also ran on every
  // JS chunk under /app/assets and /vendor/assets (its `assets/` exclusion
  // only matched a top-level folder), each with a Supabase Auth round trip for
  // anyone holding a cookie session.
  matcher: ['/api/:path*', '/admin/:path*', '/auth/:path*'],
};
