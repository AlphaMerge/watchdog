import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AccountService } from '../src/auth/accounts.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { GroupService } from '../src/auth/groups.js';
import { AccessService } from '../src/auth/access.js';
import { TokenService } from '../src/auth/tokens.js';
import { AuditRepository } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * Logging in over HTTP (`A-01`).
 *
 * **The claims here are about the wire, not the service.** That the session arrives as a cookie
 * a script cannot read; that the cookie is what authenticates the next request; that every login
 * failure looks identical from outside whatever went wrong inside; and that the guard, when it
 * is on, cannot be walked around by asking for a route it was not thinking about.
 */

const available = await databaseAvailable();

describe('authentication over HTTP', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let accounts: AccountService;
  let app: FastifyInstance;
  let guarded: FastifyInstance;

  before(async () => {
    scratch = await createScratchDatabase('authapi');
    db = scratch.db;
    const harness = await buildHarness(db);
    accounts = new AccountService({ db, logger: silent });
    const sessions = new SessionService({ db, logger: silent });
    const throttle = new LoginThrottle({
      db,
      logger: silent,
      // The delay is real and is asserted in the service's own tests; making a route test wait
      // it out would be measuring `setTimeout`.
      sleep: () => Promise.resolve(),
    });

    const build = async (required: boolean): Promise<FastifyInstance> => {
      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '' },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        auth: { accounts, sessions, throttle, groups: new GroupService({ db, logger: silent }),
          access: new AccessService({ db, logger: silent }),
          tokens: new TokenService({ db, logger: silent }), required },
      });
      await server.build('9.9.9', harness.service);
      return server.app;
    };

    app = await build(false);
    guarded = await build(true);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM user_session');
    await db.query('DELETE FROM login_attempt');
    await db.query('DELETE FROM user_account');
    await accounts.create({ login: 'ops', password: 'correct-horse-battery', role: 'readwrite' });
  });

  const login = async (
    instance: FastifyInstance,
    body: { login: string; password: string },
    headers: Record<string, string> = {},
  ) => instance.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body, headers });

  /** The `ms_session=…` pair from a Set-Cookie, ready to send back as a Cookie header. */
  const cookieFrom = (setCookie: string | string[] | undefined): string => {
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
    return header.split(';')[0] ?? '';
  };

  describe('logging in', () => {
    it('answers with the principal and sets a session cookie', async () => {
      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json<{ login: string }>().login, 'ops');
      assert.equal(response.json<{ role: string }>().role, 'readwrite');

      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
      assert.match(header, /^ms_session=/);
    });

    it('marks the cookie HttpOnly, so an injected script cannot read the session', async () => {
      // The whole of what an XSS is worth is what it can read. A token in localStorage is
      // readable by any script that gets onto the page; this one is not readable at all.
      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
      assert.match(header, /HttpOnly/);
      assert.match(header, /SameSite=Lax/, 'and another site cannot post as this operator');
      assert.match(header, /Path=\//);
    });

    it('does not set Secure over plain HTTP, or the cookie would never come back', async () => {
      // Decided per request rather than configured: `Secure` on a cookie issued over HTTP means
      // the browser never returns it, and the operator cannot log in at all.
      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
      assert.equal(/Secure/.test(header), false);
    });

    it('never sends the session token anywhere but the cookie', async () => {
      // A token echoed in a JSON body is a token in an access log, a browser history entry and
      // every error reporter the page has installed.
      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
      const token = decodeURIComponent(header.split(';')[0]?.split('=')[1] ?? '');
      assert.ok(token.length > 20);
      assert.equal(response.body.includes(token), false, 'not in the response body');
    });

    it('answers the same way for a wrong password as for an account that does not exist', async () => {
      // The response is the enumerator. Both must be identical down to the code and sentence.
      const wrong = await login(app, { login: 'ops', password: 'not-the-password' });
      const absent = await login(app, { login: 'nobody-at-all', password: 'not-the-password' });

      assert.equal(wrong.statusCode, 401);
      assert.equal(absent.statusCode, 401);
      assert.equal(
        wrong.json<{ error: { code: string } }>().error.code,
        absent.json<{ error: { code: string } }>().error.code,
      );
      assert.equal(
        wrong.json<{ error: { message: string } }>().error.message,
        absent.json<{ error: { message: string } }>().error.message,
      );
    });

    it('sets no cookie at all when it refuses', async () => {
      const response = await login(app, { login: 'ops', password: 'not-the-password' });
      assert.equal(response.headers['set-cookie'], undefined);
    });

    it('refuses a disabled account without saying that is why', async () => {
      const account = await accounts.byLogin('ops');
      await accounts.update(account?.id ?? 0, { disabled: true });
      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'AUTH_REJECTED');
      assert.equal(/disabled/i.test(response.body), false, 'and the body does not say so');
    });

    it('refuses an address that keeps failing, with a Retry-After', async () => {
      const throttled = new LoginThrottle({
        db,
        logger: silent,
        config: { maxPerAddress: 3 },
        sleep: () => Promise.resolve(),
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await throttled.record('ops', '127.0.0.1', false);
      }
      // The shared app uses the default limit, so drive the same rows past it.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await throttled.record('ops', '127.0.0.1', false);
      }

      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      assert.equal(response.statusCode, 429);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'AUTH_THROTTLED');
      assert.ok(response.headers['retry-after'] !== undefined, 'and says when to come back');
    });
  });

  describe('using a session', () => {
    it('recognises the cookie it issued', async () => {
      const session = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: cookieFrom(session.headers['set-cookie']) },
      });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json<{ login: string }>().login, 'ops');
    });

    it('refuses a cookie it never issued', async () => {
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: 'ms_session=made-up' },
      });
      assert.equal(me.statusCode, 401);
    });

    it('stops recognising it after a logout', async () => {
      const session = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      const cookie = cookieFrom(session.headers['set-cookie']);

      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie },
      });
      assert.equal(out.statusCode, 204);

      const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
      assert.equal(me.statusCode, 401);
    });

    it('lets a logout succeed with no session at all', async () => {
      // A client holding an expired cookie has to be able to clear it. Answering 401 here would
      // leave it stuck: it cannot log out, so it cannot log in.
      const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
      assert.equal(out.statusCode, 204);
    });

    it('ends the other sessions when a password changes, and keeps this one', async () => {
      const keep = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      await login(app, { login: 'ops', password: 'correct-horse-battery' });
      const other = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      const cookie = cookieFrom(keep.headers['set-cookie']);

      const changed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        headers: { cookie },
        payload: { currentPassword: 'correct-horse-battery', newPassword: 'a-whole-new-secret' },
      });
      assert.equal(changed.statusCode, 200);
      assert.equal(changed.json<{ endedSessions: number }>().endedSessions, 2);

      const stillMe = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie },
      });
      assert.equal(stillMe.statusCode, 200, 'changing your password does not log you out');

      const otherNow = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: cookieFrom(other.headers['set-cookie']) },
      });
      assert.equal(otherNow.statusCode, 401, 'but every other session is gone');
    });

    it('refuses a password change that names the wrong current password', async () => {
      const session = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        headers: { cookie: cookieFrom(session.headers['set-cookie']) },
        payload: { currentPassword: 'wrong', newPassword: 'a-whole-new-secret' },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.json<{ error: { code: string } }>().error.code,
        'ACCOUNT_PASSWORD_WRONG',
      );
    });
  });

  describe('the guard, when it is on', () => {
    it('lets an authenticated request through', async () => {
      const session = await login(guarded, { login: 'ops', password: 'correct-horse-battery' });
      const response = await guarded.inject({
        method: 'GET',
        url: '/api/v1/objects/root',
        headers: { cookie: cookieFrom(session.headers['set-cookie']) },
      });
      assert.equal(response.statusCode, 200);
    });

    it('refuses one without a session', async () => {
      const response = await guarded.inject({ method: 'GET', url: '/api/v1/objects/root' });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'AUTH_REQUIRED');
    });

    it('still allows logging in, or nobody could ever start', async () => {
      const response = await login(guarded, { login: 'ops', password: 'correct-horse-battery' });
      assert.equal(response.statusCode, 200);
    });

    it('guards every API route, not a list somebody has to remember to extend', async () => {
      // The failure this is about: a guard written as an allow-list of protected paths protects
      // the paths whoever wrote it thought of. This one refuses everything under /api/ that is
      // not explicitly public, so a route added tomorrow is guarded by default.
      for (const url of [
        '/api/v1/objects/root',
        '/api/v1/sensor-types',
        '/api/v1/audit',
        '/api/v1/openapi.json',
      ]) {
        const response = await guarded.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 401, `${url} answered ${String(response.statusCode)}`);
      }
    });

    it('leaves it off entirely when authentication is not required', async () => {
      // The upgrade path: an installation that upgrades into A-01 must not find its API shut off
      // before anybody has an account.
      const response = await app.inject({ method: 'GET', url: '/api/v1/objects/root' });
      assert.equal(response.statusCode, 200);
    });
  });
});
