import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: Vite runs on :5173 and proxies /api and /health to FastAPI on :8668.
// Prod: `npm run build` → dist/ → FastAPI serves it from the same origin.
const backend = process.env.VITE_BACKEND_URL ?? "http://localhost:8668";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/health": { target: backend, changeOrigin: true },
    },
  },
});
