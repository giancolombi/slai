import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { msw } from "msw/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Serves (dev) and emits (build) mockServiceWorker.js; mocking only starts when VITE_MOCK_API=1.
    msw({ mode: "worker-only" }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
  build: {
    target: "es2023",
    sourcemap: true,
    rolldownOptions: {
      output: {
        // Routes are lazy (router.tsx); vendors get stable, separately cached chunks so a
        // deploy that only changes app code doesn't invalidate React or the router.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 40 },
            { name: "tanstack", test: /node_modules[\\/]@tanstack[\\/]/, priority: 30 },
            { name: "zod", test: /node_modules[\\/]zod[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
});
