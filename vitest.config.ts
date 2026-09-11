import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The database tests write real files into per-test temporary directories,
    // and the shell-integration tests spawn external interpreters. Neither is
    // CPU-bound, but both are happier without a dozen concurrent workers.
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json"],
    },
  },
});
