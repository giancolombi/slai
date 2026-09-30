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
      // API_PROXY_TARGET lets a second checkout run its API on another port.
      "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:8787", changeOrigin: false },
    },
  },
  build: {
    target: "es2023",
    sourcemap: true,
  },
});
