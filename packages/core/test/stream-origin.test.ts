import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
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
import { buildHarness, silent, testActor } from './support/tree.js';

/**
 * The stream's handshake from another origin (`A-36`), against the real upgrade.
 *
 * **The one GET whose answer another origin can read.** The same-origin policy hides an ordinary
 * response from a page on another origin and does not govern a WebSocket, and the session cookie
 * goes with a handshake from any page on the same site — another port on the core's host, a
 * sibling subdomain. So until this ticket a Grafana with an XSS beside the core could subscribe
 * with the operator's cookie and read the state of everything the operator could see, and with
 * authentication off any page the browser could reach the core from could.
 *
 * The claims: another origin is refused with the operator's cookie in hand, and with
 * authentication off; the core's own origin, a configured one (the dev server's proxy) and a
 * client that sends no Origin all open.
 */

const available = await databaseAvailable();

const PASSWORD = 'correct-horse-battery';

describe(
  'the stream, opened from another origin',
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let app: FastifyInstance;
    let dev: FastifyInstance;
    let open: FastifyInstance;
    let cookie = '';

    before(async () => {
      scratch = await createScratchDatabase('streamorigin');
      db = scratch.db;
      const h = await buildHarness(db);
      const accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const sessions = new SessionService({ db, logger: silent });

      const build = async (required: boolean, allowedOrigins: string[] = []) => {
        const server = new ApiServer({
          config: {
            host: '127.0.0.1',
            port: 0,
            webRoot: '',
            allowedOrigins,
            requireAuthentication: required,
          },
          logger: silent,
          version: '9.9.9',
          service: h.service,
          history: new HistoryService({ db, logger: silent }),
          db,
          audit: new AuditRepository(),
          catalogue: testCatalogue(),
          stream: new StateBroadcaster({ logger: silent, credentialSweepMs: 3_600_000 }),
          auth: {
            accounts,
            sessions,
            throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
            groups: new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent }),
            access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
            tokens: new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }),
            totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
            required,
          },
        });
        await server.build('9.9.9', h.service);
        return server.app;
      };
      app = await build(true);
      // Vite's proxy: the browser's origin arrives with the Host it rewrote (`A-19`).
      dev = await build(true, ['http://127.0.0.1:5173']);
      open = await build(false);

      await accounts.create({ login: 'ops', password: PASSWORD, role: 'admin' }, testActor);
      const signedIn = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'ops', password: PASSWORD },
      });
      assert.equal(signedIn.statusCode, 200);
      const setCookie = signedIn.headers['set-cookie'];
      cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
    });

    after(async () => {
      await Promise.all([app.close(), dev.close(), open.close()]);
      await scratch.drop();
    });

    /** Opens the stream and closes it again, or rejects with what refused the handshake. */
    const opens = async (on: FastifyInstance, headers: Record<string, string>): Promise<void> => {
      const socket = await on.injectWS('/api/v1/stream', { headers });
      socket.terminate();
    };

    it('refuses a page on another port of the same host, with the operator’s cookie', async () => {
      await assert.rejects(
        opens(app, { cookie, origin: 'http://10.0.0.5:3000', host: '10.0.0.5:8080' }),
        /Unexpected server response: 403/,
      );
    });

    it('refuses another origin with authentication off, where nothing else would', async () => {
      await assert.rejects(
        opens(open, { origin: 'http://intranet.example.test', host: '10.0.0.5:8080' }),
        /Unexpected server response: 403/,
      );
    });

    it('opens from its own origin', async () => {
      await opens(app, { cookie, origin: 'http://10.0.0.5:8080', host: '10.0.0.5:8080' });
    });

    it('opens from a configured origin, through a proxy that rewrote Host', async () => {
      await opens(dev, { cookie, origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8080' });
      await assert.rejects(
        opens(app, { cookie, origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8080' }),
        /Unexpected server response: 403/,
        'and only where it is configured',
      );
    });

    it('opens for a client that sends no Origin, which is not a browser', async () => {
      await opens(app, { cookie, host: '10.0.0.5:8080' });
      await opens(open, { host: '10.0.0.5:8080' });
    });
  },
);
