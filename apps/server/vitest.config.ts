import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Network tests run only via `pnpm test:remote` (vitest.remote.config.ts).
    exclude: [...configDefaults.exclude, 'test/remote/**'],
    // These tests spawn real git processes, which is several times slower on Windows
    // (and on loaded CI machines) than on Linux. The 5s default is too tight there.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
