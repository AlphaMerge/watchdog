import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import { AccountService } from '../src/auth/accounts.js';
import { AccessService } from '../src/auth/access.js';
import { GroupService } from '../src/auth/groups.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { StateBroadcaster } from '../src/state/stream.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, type Harness } from './support/tree.js';

/**
 * The names the core answers to, through the real server (`A-47`).
 *
 * **DNS rebinding.** With authentication off on the default bind, a page at
 * `http://evil.example:8080/` whose name is re-pointed at `127.0.0.1` is same-origin with the core
 * to the browser: it sends `Origin` and `Host` that agree, so every origin check passed it, and it
 * could read the tree, stream it and write configuration. What it cannot make agree is its name
 * with this core's list of its own names.
 *
 * The claims: a rebound page's write, read, scrape and stream are refused with 421 and nothing is
 * written; the same page by address works; a name from any of the three places it can come from is
 * answered; the refusals are counted; and a core with no names says so once at startup.
 */

const available = await databaseAvailable();

describe(
  'the names the core answers to, over HTTP (A-47)',
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let open: ApiServer;
    let named: ApiServer;
    let build: (
      names: { allowedHosts?: string[]; allowedOrigins?: string[]; publicUrl?: string },
      logger?: Logger,
    ) => Promise<ApiServer>;
    const warned: string[] = [];
    const capture = (into: string[]): Logger =>
      pino(
        { level: 'warn' },
        {
          write: (line: string) => {
            into.push((JSON.parse(line) as { msg: string }).msg);
          },
        },
      );

    before(async () => {
      scratch = await createScratchDatabase('hostcheck');
      db = scratch.db;
      h = await buildHarness(db);
      const accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const sessions = new SessionService({ db, logger: silent });

      build = async (names, logger = silent) => {
        const server = new ApiServer({
          config: {
            host: '127.0.0.1',
            port: 0,
            webRoot: '',
            allowedOrigins: names.allowedOrigins ?? [],
            ...(names.allowedHosts === undefined ? {} : { allowedHosts: names.allowedHosts }),
            requireAuthentication: false,
          },
          ...(names.publicUrl === undefined ? {} : { publicUrl: names.publicUrl }),
          logger,
          version: '9.9.9',
          service: h.service,
          history: new HistoryService({ db, logger: silent }),
          db,
          audit: new AuditRepository(),
          catalogue: testCatalogue(),
          stream: new StateBroadcaster({ logger: silent, credentialSweepMs: 3_600_000 }),
          // Registered, and answering 503 as a core still starting does: the check is what is
          // being asked about, not the scrape.
          metrics: () => undefined,
          auth: {
            accounts,
            sessions,
            throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
            groups: new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent }),
            access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
            tokens: new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }),
            totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
            // Off, as on the default install the finding is about: nothing else stands in the way.
            required: false,
          },
        });
        await server.build('9.9.9', h.service);
        return server;
      };

      open = await build({}, capture(warned));
      named = await build({
        allowedHosts: ['Monitoring.Example.com.'],
        allowedOrigins: ['https://ui.example.com'],
        publicUrl: 'https://alerts.example.com/ms/',
      });
    });

    after(async () => {
      await Promise.all([open.app.close(), named.app.close()]);
      await scratch.drop();
    });

    const rebound = { host: 'evil.example:8080', origin: 'http://evil.example:8080' };

    const objectsNamed = async (name: string): Promise<number> =>
      (
        await db.query<{ n: number }>('SELECT count(*)::int AS n FROM object WHERE name = $1', [
          name,
        ])
      )[0]?.n ?? 0;

    const create = (app: FastifyInstance, name: string, headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/objects',
        payload: { kind: 'probe', parentId: h.rootId, name },
        headers,
      });

    /** Opens the stream and closes it again, or rejects with what refused the handshake. */
    const opens = async (app: FastifyInstance, headers: Record<string, string>): Promise<void> => {
      const socket = await app.injectWS('/api/v1/stream', { headers });
      socket.terminate();
    };

    it('refuses a rebound page’s write with 421, and writes nothing', async () => {
      const response = await create(open.app, 'rebound', rebound);
      assert.equal(response.statusCode, 421, response.body);
      const body = response.json<{
        error: { code: string; message: string; context: Record<string, string> };
      }>();
      assert.equal(body.error.code, 'HOST_NOT_ALLOWED');
      assert.match(body.error.message, /api\.allowedHosts/);
      assert.deepEqual(body.error.context, {
        host: 'evil.example:8080',
        setting: 'api.allowedHosts',
      });
      assert.equal(await objectsNamed('rebound'), 0);

      const login = await open.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'ops', password: 'whatever' },
        headers: rebound,
      });
      assert.equal(login.statusCode, 421);
      const attempts = await db.query('SELECT id FROM login_attempt');
      assert.equal(attempts.length, 0, 'not even a login attempt is recorded');
    });

    it('refuses its stream, which is what reads everything live', async () => {
      await assert.rejects(opens(open.app, rebound), /Unexpected server response: 421/);
    });

    it('refuses a plain read and the scrape, whose answers the page could read too', async () => {
      for (const url of ['/api/v1/build', '/api/v1/objects', '/metrics']) {
        const response = await open.app.inject({ method: 'GET', url, headers: rebound });
        assert.equal(response.statusCode, 421, url);
      }
    });

    it('answers the same page by address, the control', async () => {
      const byAddress = { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' };
      const response = await create(open.app, 'by address', byAddress);
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(await objectsNamed('by address'), 1);
      await opens(open.app, byAddress);
      assert.equal(
        (await open.app.inject({ url: '/metrics', headers: { host: '127.0.0.1:8080' } }))
          .statusCode,
        503,
        'and the scrape reaches its route',
      );
    });

    it('refuses a name built to look like an address', async () => {
      const response = await open.app.inject({
        url: '/api/v1/build',
        headers: { host: '127.0.0.1.evil.example:8080' },
      });
      assert.equal(response.statusCode, 421);
    });

    it('answers localhost and an IPv6 address with no names configured', async () => {
      for (const host of ['localhost:8080', 'app.localhost:5173', '[::1]:8080']) {
        const response = await open.app.inject({ url: '/api/v1/build', headers: { host } });
        assert.equal(response.statusCode, 200, host);
      }
    });

    it('answers a name from each place it can be given, in any case, on any port', async () => {
      for (const host of [
        'monitoring.example.com',
        'MONITORING.EXAMPLE.COM.:8080',
        'alerts.example.com:443',
        'ui.example.com:8443',
      ]) {
        const response = await named.app.inject({ url: '/api/v1/build', headers: { host } });
        assert.equal(response.statusCode, 200, host);
      }
      const other = await named.app.inject({
        url: '/api/v1/build',
        headers: { host: 'example.com' },
      });
      assert.equal(other.statusCode, 421);
    });

    it('counts what it refused, for Core Health', async () => {
      const before = named.hostStats().refused;
      await named.app.inject({ url: '/api/v1/build', headers: { host: 'a.example' } });
      await named.app.inject({ url: '/api/v1/build', headers: { host: 'b.example' } });
      await named.app.inject({ url: '/api/v1/build', headers: { host: '10.0.0.1' } });
      assert.equal(named.hostStats().refused, before + 2);
    });

    it('still refuses another port on an answered name, where the guard compares both', async () => {
      // `refusalFor` compares host and port with `Host`, now that `Host` is one of this core's
      // names; it does not take the whole list as origins. With authentication off.
      for (const headers of [
        { origin: 'http://localhost:3000', host: 'localhost:8080' },
        { origin: 'http://10.9.9.9:3000', host: '10.9.9.9:8080' },
      ]) {
        const response = await create(open.app, 'another port', headers);
        assert.equal(response.statusCode, 403, headers.origin);
        assert.equal(response.json<{ error: { code: string } }>().error.code, 'AUTH_FORBIDDEN');
      }
      assert.equal(await objectsNamed('another port'), 0);
    });

    it('says once at startup that it answers only its addresses, naming both settings', () => {
      // The refusals above name `api.allowedHosts` too; only this one names the public URL.
      const about = warned.filter((line) => line.includes('notifications.publicUrl'));
      assert.equal(about.length, 1, warned.join('\n'));
      assert.match(about[0] ?? '', /api\.allowedHosts/);
    });

    it('says nothing at startup once either is set', async () => {
      const quiet: string[] = [];
      const servers = [
        await build({ allowedHosts: ['ms.example.com'] }, capture(quiet)),
        await build({ publicUrl: 'https://ms.example.com/' }, capture(quiet)),
      ];
      try {
        assert.deepEqual(
          quiet.filter((line) => line.includes('notifications.publicUrl')),
          [],
        );
      } finally {
        await Promise.all(servers.map((server) => server.app.close()));
      }
    });
  },
);
