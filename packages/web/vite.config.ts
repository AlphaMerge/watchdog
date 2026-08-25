// `vitest/config` re-exports Vite's own defineConfig with the `test` key added, which is
// what keeps the dev server, the build and the test runner reading one file.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Development only. Production is `vite build` into `dist`, which `ms-core` serves from
 * `--web-root` — there is no second web server to install (ADR-001 Decision 8).
 *
 * The proxy is what keeps the app free of a base URL: it calls `/api/...` in both environments,
 * so nothing has to know whether it is being served by Vite or by the core.
 */
const coreUrl = process.env['MS_CORE_URL'] ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 0.0.0.0 because in development this runs in a container; the port is published on
    // loopback only, so it is still not reachable from outside the machine.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: coreUrl, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
