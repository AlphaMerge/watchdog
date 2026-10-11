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
      // `ws` because `/api/v1/stream` upgrades (`U-02`). Without it the socket 400s here and
      // works in production, which is the worst way round: the feature would look broken only
      // to the people building it.
      //
      // **The browser's own `Host`, not the core's name** (`P-399`). `changeOrigin` rewrote it to
      // `ms-server:8080`, which the core's host check refuses (421, `api.allowedHosts`), and which
      // its Origin check would set against the browser's `127.0.0.1:5173` and refuse every write.
      // Kept as the browser sent it, both see `127.0.0.1:5173`: an address, and the same origin.
      '/api': { target: coreUrl, changeOrigin: false, ws: true },
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
