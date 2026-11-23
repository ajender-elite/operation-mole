import { defineConfig } from 'vitest/config';

/** Network tests against public repositories: `pnpm test:remote`. Never part of `pnpm test`. */
export default defineConfig({
  // Run from the repo root (`pnpm test:remote`), but resolve paths from apps/server.
  root: import.meta.dirname,
  test: {
    name: 'server-remote',
    environment: 'node',
    include: ['test/remote/**/*.remote.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
