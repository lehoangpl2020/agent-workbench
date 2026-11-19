import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the pure logic in src/lib (no DOM). Run with `npm test`.
// The vm pool is set on purpose: with the default pools, `vitest` is loaded twice under Git Bash on Windows and
// every test file fails with "Cannot read properties of undefined (reading 'config')". These tests are pure
// and small, so the vm pool costs nothing.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["src/**/*.test.ts"], environment: "node", pool: "vmThreads" },
});
