/** @type {import('next').NextConfig} */
const nextConfig = {
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
