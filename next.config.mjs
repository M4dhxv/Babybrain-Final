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
          source: '/((?!api|vendor|app/|_next/|assets/|favicon).*)',
          destination: '/app/index.html',
        },
      ],
    };
  },
};

export default nextConfig;
