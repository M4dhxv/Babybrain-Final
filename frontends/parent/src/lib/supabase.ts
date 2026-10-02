import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { timeoutFetch } from "./net";

// Own storage key, distinct from the vendor app's — both apps share the same
// Supabase project (same auth.users table) and, in production, the same
// origin (/app/ vs /vendor/ under one domain, see next.config's rewrites).
// Without this they'd both fall back to the SDK's default key (derived only
// from the project URL, so identical for both), meaning the exact same
// localStorage entry — a vendor signed into /vendor/ who then followed a
// "For Parents" link would land on /app/ already "signed in", because every
// account (vendor included) has a parent_profiles row too, so there was
// nothing to tell the parent app this wasn't really a parent session. Each
// app now only ever reads/writes its own key, so a vendor's own login never
// carries over to the parent site (or the reverse) even in the same tab.
export const AUTH_STORAGE_KEY = "sb-babybrain-parent-auth-token";

// Browser Supabase client — same backend as the vendor app + Phase 1.
// Public pages (Home/Explore/Detail) work anonymously; RLS allows reading
// published activities, sessions and reviews without a session.
export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  { global: { fetch: timeoutFetch }, auth: { storageKey: AUTH_STORAGE_KEY } },
);
