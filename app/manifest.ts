import type { MetadataRoute } from 'next';

/**
 * Served at /manifest.webmanifest.
 *
 * Without one, "Add to Home screen" has no name or icon to work with and the
 * browser draws a grey letter tile. The two Vite SPAs embedded in this
 * deployment ship their own manifests scoped to /app/ and /vendor/; this one
 * covers the Next.js site at the root.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BabyBrain.sg',
    short_name: 'BabyBrain',
    description:
      'Discover activities and play spaces that match your child’s age, interests and stage of growth.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FFFCF8',
    theme_color: '#FA4D8D',
    icons: [
      {
        src: '/assets/brand/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/assets/brand/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/assets/brand/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
