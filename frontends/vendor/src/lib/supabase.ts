import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

/**
 * `fetch` with a hard ceiling. A tab restored after a browser restart can be
 * handed a wedged socket, and Supabase's own requests carry no timeout — so
 * `getSession()` / the first PostgREST call would hang forever and the app
 * would sit on its "Loading…" gate until a manual hard refresh. Abort after
 * 15s so the caller gets a rejection it can recover from instead.
 */
const timeoutFetch: typeof fetch = (input, init) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  const caller = init?.signal;
  if (caller) {
    if (caller.aborted) ac.abort();
    else caller.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
};

// Own storage key, distinct from the parent app's — see the matching
// comment in frontends/parent/src/lib/supabase.ts for why: same Supabase
// project (and, in production, same origin) means the SDK's default key
// would otherwise be identical for both apps, so a vendor following a link
// out to the parent site would land there already "signed in".
export const AUTH_STORAGE_KEY = 'sb-babybrain-vendor-auth-token';

// Browser Supabase client (localStorage session). RLS scopes every query
// to the signed-in vendor's provider(s) — same backend as the parent app.
export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  { global: { fetch: timeoutFetch }, auth: { storageKey: AUTH_STORAGE_KEY } }
);
