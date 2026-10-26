import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests share one embedded MongoDB and one HTTP server per file, so files
    // must not run in parallel against the same database.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    setupFiles: ['tests/support/setup.ts'],
    reporters: ['default'],
  },
});
