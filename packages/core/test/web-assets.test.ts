import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * The core serves the web UI itself (ADR-001 Decision 8) — there is no second web server to
 * install. That makes the file-serving path part of the API surface, and it has two properties
 * worth pinning: it must not shadow the API, and it must not become a hole in the
 * response-schema guard that protects every JSON route.
 */
describe(
  'web assets',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let root: string;

    before(async () => {
      scratch = await createScratchDatabase('webassets');
      db = scratch.db;
      h = await buildHarness(db);

      root = await mkdtemp(join(tmpdir(), 'ms-web-'));
      await writeFile(join(root, 'index.html'), '<!doctype html><title>ms</title><div id="root">');
      await mkdir(join(root, 'assets'), { recursive: true });
      await writeFile(join(root, 'assets', 'index-abc123.js'), 'export const x = 1;\n');
    });

    after(async () => {
      await rm(root, { recursive: true, force: true });
      await scratch.drop();
    });

    async function serverWith(webRoot: string): Promise<ApiServer> {
      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot,
          allowedOrigins: [],
          requireAuthentication: true,
        },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      return server;
    }

    it('serves nothing at all when no web root is configured', async () => {
      // A headless install, and a development run against the Vite dev server, both want this.
      const server = await serverWith('');
      const response = await server.app.inject({ method: 'GET', url: '/' });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'ROUTE_NOT_FOUND');
    });

    it('serves the app shell at the root', async () => {
      const server = await serverWith(root);
      const response = await server.app.inject({ method: 'GET', url: '/' });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] ?? '', /text\/html/);
      assert.match(response.body, /id="root"/);
    });

    it('serves a deep link with the app shell, because that route lives in the browser', async () => {
      const server = await serverWith(root);
      const response = await server.app.inject({ method: 'GET', url: '/objects/42' });
      assert.equal(response.statusCode, 200, 'a 404 here would break every bookmark');
      assert.match(response.body, /id="root"/);
    });

    it('still answers an unknown API route with JSON, not with the app shell', async () => {
      // The failure this prevents: a client parsing HTML as JSON and reporting a syntax error
      // instead of "no such route".
      const server = await serverWith(root);
      const response = await server.app.inject({ method: 'GET', url: '/api/v1/nonsense' });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'ROUTE_NOT_FOUND');
    });

    it('does not let a file shadow an API route', async () => {
      const server = await serverWith(root);
      const response = await server.app.inject({ method: 'GET', url: '/api/v1/sensor-types' });
      assert.equal(response.statusCode, 200);
      // The test catalogue's types, whatever they are — the point is that JSON came back rather
      // than the single-page app's index.html.
      assert.ok(response.json<{ items: unknown[] }>().items.length > 0);
      assert.match(response.headers['content-type'] as string, /application\/json/);
    });

    it('caches hashed assets hard and the shell not at all', async () => {
      const server = await serverWith(root);

      const asset = await server.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
      assert.equal(asset.statusCode, 200);
      // Content-addressed filenames can be cached for ever; index.html cannot, or an upgraded
      // core would keep serving last week's app.
      assert.match(asset.headers['cache-control'] ?? '', /immutable/);

      const shell = await server.app.inject({ method: 'GET', url: '/' });
      assert.match(shell.headers['cache-control'] ?? '', /no-cache/);
    });

    it('refuses to walk out of the web root', async () => {
      const server = await serverWith(root);
      // A 200 is fine and expected — an unmatched path is a deep link and gets the app shell.
      // What must never happen is the *contents* of a file outside the root coming back, so
      // that is what this asserts rather than the status code.
      for (const url of ['/../package.json', '/..%2fpackage.json', '/assets/../../package.json']) {
        const response = await server.app.inject({ method: 'GET', url });
        assert.ok(
          !response.body.includes('"monitoring-system"'),
          `${url} returned a file from outside the web root`,
        );
      }
    });

    it('exempts only the asset routes from the response-schema guard', async () => {
      // The guard is the structural half of the credential defence. Serving files needs an
      // exemption; an exemption nobody can enumerate is one nobody reviews, so it is asserted.
      const server = await serverWith(root);
      // One wildcard, registered by @fastify/static, covering HEAD and GET. Anything else
      // appearing in this list is a JSON route that lost its response schema.
      assert.deepEqual(server.unfilteredRoutes, ['HEAD,GET /*']);
    });
  },
);
