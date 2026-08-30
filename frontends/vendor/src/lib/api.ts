import { supabase } from './supabase';

/** Thrown by apiGet/apiPost/apiDelete on a non-2xx response — carries the
 *  HTTP status so callers can special-case e.g. 401 (expired session)
 *  without string-matching the error message. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function errorFor(res: Response): Promise<ApiError> {
  const message = (await res.json().catch(() => ({})))?.error ?? res.statusText;
  return new ApiError(message, res.status);
}

/**
 * Calls a Next.js backend route (Stripe / chat token / staff invite),
 * attaching the Supabase access token as a Bearer header. The routes
 * accept the Bearer token + send CORS headers, so these work cross-origin.
 */
export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const base = (import.meta.env.VITE_API_BASE as string) || "";
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFor(res);
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
  if (!res.ok) throw await errorFor(res);
  return res.json() as Promise<T>;
}

/** DELETE variant — same Bearer auth. */
export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const base = (import.meta.env.VITE_API_BASE as string) || "";
  const res = await fetch(`${base}${path}`, {
    method: 'DELETE',
    headers: {
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
  });
  if (!res.ok) throw await errorFor(res);
  return res.json() as Promise<T>;
}
