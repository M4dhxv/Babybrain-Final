import { supabase } from "./supabase";

/**
 * Calls a Next.js backend route (chat token / enquiry / booking), attaching
 * the Supabase access token as a Bearer header. The routes accept the Bearer
 * token and send CORS headers, so these work cross-origin.
 */
export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const base = (import.meta.env.VITE_API_BASE as string) || "";
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
  return res.json() as Promise<T>;
}

/** GET variant — same Bearer auth. Used for the Stream chat token. */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const base = (import.meta.env.VITE_API_BASE as string) || "";
  const res = await fetch(`${base}${path}`, {
    headers: {
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
  return res.json() as Promise<T>;
}
