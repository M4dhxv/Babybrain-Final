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

// A reset/confirm link that was already used or has expired comes back as
// `/vendor#error=access_denied&error_code=otp_expired&…`. The HashRouter reads
// that fragment as a route path and renders the catch-all 404, and Supabase
// leaves it in place on error. Swap it for the forgot-password page before the
// client or router ever sees it. (Email security scanners that pre-open links
// burn the one-time token, so the vendor's own click is often the "used" one.)
if (typeof window !== 'undefined') {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith('/') && /(^|&)error(_code|_description)?=/.test(hash)) {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}#/forgot-password?expired=1`
    );
  }
  // Scanner-proof reset links arrive as `/vendor?token_hash=…&type=recovery`.
  // Nothing is spent until the vendor presses the button on the reset page, so
  // a mail scanner opening the link first no longer burns it. Move the token
  // into the hash route that page reads.
  const q = new URLSearchParams(window.location.search);
  const tokenHash = q.get('token_hash');
  if (tokenHash && q.get('type') === 'recovery') {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}#/reset-password?token_hash=${encodeURIComponent(tokenHash)}`
    );
  }
}

// Browser Supabase client (localStorage session). RLS scopes every query
// to the signed-in vendor's provider(s) — same backend as the parent app.
export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  { global: { fetch: timeoutFetch }, auth: { storageKey: AUTH_STORAGE_KEY } }
);
