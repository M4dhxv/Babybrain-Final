/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // The vendor portal is a static SPA (HashRouter) built into
    // public/vendor. Next serves files under /vendor/* directly, but a
    // bare /vendor (or /vendor/) needs to resolve to its index.html.
    return [
      { source: '/vendor', destination: '/vendor/index.html' },
      { source: '/vendor/', destination: '/vendor/index.html' },
    ];
  },
};

export default nextConfig;
