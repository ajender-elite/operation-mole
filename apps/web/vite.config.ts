import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The API's port: the same `API_PORT` the server reads (default 5181), so `API_PORT=6000 pnpm dev` moves both.
const apiPort = process.env['API_PORT'] ?? '5181';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 4000 },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
