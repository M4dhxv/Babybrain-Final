import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
// The vendor portal is served under `/vendor` of the single Next.js
// deployment: `base` prefixes every emitted asset URL, and the build
// output lands in the Next app's `public/vendor/` so it ships as static
// files at `/vendor/`.
export default defineConfig({
  base: '/vendor/',
  plugins: [inspectAttr(), react()],
  server: {
    // 5174 avoids colliding with the Next.js backend on 3000; host +
    // allowedHosts let it run behind the Claude preview proxy.
    host: true,
    port: 5174,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    outDir: path.resolve(__dirname, '../../public/vendor'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the rarely-changing vendor libs into their own chunks so a
        // deploy only re-downloads app code and the browser parses these in
        // parallel with the entry chunk.
        manualChunks(id) {
          if (
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react/') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'react'
          }
          if (id.includes('node_modules/@supabase')) return 'supabase'
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'recharts'
          if (id.includes('node_modules/@radix-ui')) return 'radix'
          return undefined
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
