import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { corsHeaders } from '@/lib/cors';

export async function middleware(request: NextRequest) {
  // The cross-origin Vite SPAs hit `/api/**` with a Bearer token. Handle
  // the CORS preflight here and stamp CORS headers on every API response
  // so it works regardless of which route (or error) produced it.
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers: cors });
    }
    const response = await updateSession(request);
    for (const [key, value] of Object.entries(cors)) {
      response.headers.set(key, value);
    }
    return response;
  }

  return updateSession(request);
}

export const config = {
  matcher: [
    // Refresh sessions everywhere except static assets.
    '/((?!_next/static|_next/image|favicon.ico|assets/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css)$).*)',
  ],
};
