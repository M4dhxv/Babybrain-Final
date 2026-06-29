import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

// Browser Supabase client (localStorage session). RLS scopes every query
// to the signed-in vendor's provider(s) — same backend as the parent app.
export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
);
