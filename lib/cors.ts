/**
 * CORS for the `/api/**` routes the cross-origin Vite SPAs
 * (parent + vendor portals) call with a Bearer token.
 *
 * Origins are read from CORS_ALLOWED_ORIGINS (comma-separated) and fall
 * back to the known frontend deployments + local Vite dev servers.
 */
const DEFAULT_ORIGINS = [
  'https://babybrain-parent.vercel.app',
  'https://babybrain-vendor.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
];

export function allowedOrigins(): string[] {
  const env = process.env.CORS_ALLOWED_ORIGINS;
  if (env) {
    return env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_ORIGINS;
}

/**
 * The SPA origin to send a browser back to after a Stripe hosted flow.
 * Echoes the request Origin when allow-listed (so parent vs vendor SPA each
 * return to themselves), else pins the first allowed origin. Never trusts an
 * arbitrary Origin, so it can't be turned into an open redirect.
 */
export function appOrigin(request: Request): string {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins();
  if (origin && allowed.includes(origin)) return origin;
  // Same-origin call (in production the SPA is served by this same deployment,
  // so the browser sends no/off-list Origin). Return where the user actually
  // is — this deployment's own host — so Stripe redirects back to a real page
  // instead of the hard-coded fallback domain. Falls back to the app URL.
  const host = request.headers.get('host');
  if (host) return `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
  return process.env.NEXT_PUBLIC_APP_URL || allowed[0];
}

/**
 * Headers to attach to an `/api/**` response. Echoes the request Origin
 * when it is allow-listed; otherwise pins the first allowed origin so a
 * disallowed origin's browser blocks the response.
 */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins();
  const allow = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
