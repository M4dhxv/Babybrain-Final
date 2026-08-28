/** @type {import('next').NextConfig} */

// The SPA entry documents must never be reused from a stale browser cache
// across a restart: an old shell points at hashed bundles a newer deploy has
// already removed, so the restored tab hangs on a blank "Loading…" with no way
// back but a manual hard refresh (and `no-store` also opts the page out of the
// bfcache, so a restored tab always re-fetches). These 8-9 KB documents are
// cheap to refetch; the hashed assets under /vendor/assets and /app/assets keep
// their own caching and are untouched.
const NO_STORE = [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }];

const nextConfig = {
  async headers() {
    return [
      { source: '/vendor', headers: NO_STORE },
      { source: '/vendor/', headers: NO_STORE },
      { source: '/', headers: NO_STORE },
    ];
  },

  async rewrites() {
    return {
      // beforeFiles run before Next's own pages, so the parent SPA at `/`
      // overrides the legacy Next pages (/, /explore, /login, …). It
      // serves the Vite parent build (public/app) for every user-facing
      // route, excluding the API, the two SPA asset dirs, Next internals,
      // and static files.
      beforeFiles: [
        { source: '/vendor', destination: '/vendor/index.html' },
        { source: '/vendor/', destination: '/vendor/index.html' },
        {
          // `auth/` must stay excluded: /auth/callback is the Supabase email
          // confirmation + OAuth landing route. Without it the rewrite served
          // the SPA instead, so confirming an email dropped parents back on
          // the sign-up form rather than their new profile.
          source: '/((?!api|auth/|admin|vendor|app/|_next/|assets/|favicon).*)',
          destination: '/app/index.html',
        },
      ],
    };
  },
};

export default nextConfig;
