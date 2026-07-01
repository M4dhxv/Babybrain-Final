import {
  createClient as createSupabaseClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { createClient as createCookieClient } from '@/lib/supabase/server';
import type { Database } from '@/types/database';

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Resolve the authenticated user + an RLS-scoped Supabase client for a
 * route handler, accepting EITHER an `Authorization: Bearer <access_token>`
 * header (the cross-origin Vite SPAs) OR the cookie session (same-origin
 * SSR / the original Next.js app).
 *
 * The returned client carries the caller's JWT, so `.from()` queries stay
 * RLS-scoped exactly like the cookie client did.
 */
export async function getAuthedContext(request: Request): Promise<{
  supabase: SupabaseClient<Database>;
  user: User | null;
}> {
  const token = bearerToken(request);
  if (token) {
    const supabase = createSupabaseClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );
    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    return { supabase, user };
  }

  const supabase = await createCookieClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}
