import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    // Each test file opens ~17 connections (4 pools + pg-boss + LISTEN); 4 at a time fits max_connections=100.
    maxWorkers: 4,
    hookTimeout: 60_000,
  },
});
