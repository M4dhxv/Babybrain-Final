import { supabase } from './supabase';

/**
 * Calls a Next.js backend route (Stripe / chat token / staff invite),
 * attaching the Supabase access token as a Bearer header.
 *
 * PHASE 2: these routes still need Bearer-auth + CORS enabled server-side.
 * Until then `apiPost` will fail for cross-origin secret routes — the UI
 * should treat those features (billing redirect, live chat) as "coming soon".
 */
export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const base = import.meta.env.VITE_API_BASE as string;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
  return res.json() as Promise<T>;
}
