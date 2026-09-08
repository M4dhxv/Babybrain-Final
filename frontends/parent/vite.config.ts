import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The user/parent app is the site at `/`, but it ships as a static SPA
// embedded in the single Next.js deployment. `base: '/app/'` namespaces
// its assets under /app/ (no collision with Next or the /vendor SPA); a
// Next rewrite maps the user-facing routes to /app/index.html.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "../../public/app"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the rarely-changing vendor libs into their own chunks so a
        // deploy only re-downloads app code, and the browser parses these in
        // parallel with the entry chunk.
        manualChunks(id) {
          if (
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react/") ||
            id.includes("node_modules/scheduler")
          ) {
            return "react";
          }
          if (id.includes("node_modules/@supabase")) return "supabase";
          return undefined;
        },
      },
    },
  },
  // Dev server reachable behind the preview/proxy on a fixed port.
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
});
