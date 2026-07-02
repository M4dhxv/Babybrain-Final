import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Browser Supabase client — same backend as the vendor app + Phase 1.
// Public pages (Home/Explore/Detail) work anonymously; RLS allows reading
// published activities, sessions and reviews without a session.
export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
);
