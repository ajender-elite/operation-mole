import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'scripts'],
    // Each test file spawns git and builds repositories, which is slow on Windows. More than a few
    // files at once make those steps exceed the 30s hook/test timeouts; 3 workers stay reliable.
    maxWorkers: 3,
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}', '**/src/test/**', '**/*.d.ts'],
      // CONTRIBUTING.md §11. `pnpm test:coverage` fails below these.
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
