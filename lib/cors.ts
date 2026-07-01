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

function allowedOrigins(): string[] {
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
