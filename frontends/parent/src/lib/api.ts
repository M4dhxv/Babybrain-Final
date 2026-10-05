import { supabase } from "./supabase";
import { resilientGet } from "./net";

/**
 * A failed call. Still a plain Error with the server's message, but it keeps the status and the whole
 * response body so a caller can use more than the message (e.g. the live questions a booking route sends
 * back when the parent's answers no longer fit the event's form).
 */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function errorFor(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null);
  return new ApiError((body as { error?: string } | null)?.error ?? res.statusText, res.status, body);
}

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

/**
 * GET for routes that are public and unauthenticated on the server (e.g.
 * /api/wix/slots, /api/public/provider-plan) — skips the `getSession()`
 * round trip and Bearer header that `apiGet` always pays for, since the
 * route ignores them anyway.
 */
export async function apiGetPublic<T = unknown>(path: string): Promise<T> {
  const base = (import.meta.env.VITE_API_BASE as string) || "";
  const res = await resilientGet(`${base}${path}`);
  if (!res.ok) throw await errorFor(res);
  return res.json() as Promise<T>;
}
