import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { ApiServer } from '../src/api/server.js';
import { ALWAYS_PUBLIC } from '../src/api/authentication.js';
import { AccountService } from '../src/auth/accounts.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { GroupService } from '../src/auth/groups.js';
import { AccessService } from '../src/auth/access.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';
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
  /** The servers behind those apps, for the one assertion that reads the route table. */
  const built: ApiServer[] = [];
  let proxied: FastifyInstance;

  before(async () => {
    scratch = await createScratchDatabase('authapi');
    db = scratch.db;
    const harness = await buildHarness(db);
    accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
    const sessions = new SessionService({ db, logger: silent });
    const throttle = new LoginThrottle({
      db,
      logger: silent,
      // The delay is real and is asserted in the service's own tests; making a route test wait
      // it out would be measuring `setTimeout`.
      sleep: () => Promise.resolve(),
    });

    const build = async (
      required: boolean,
      allowedOrigins: string[] = [],
    ): Promise<FastifyInstance> => {
      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins,
          requireAuthentication: true,
        },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        auth: {
          accounts,
          sessions,
          throttle,
          groups: new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
          tokens: new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          required,
        },
      });
      await server.build('9.9.9', harness.service);
      built.push(server);
      return server.app;
    };

    app = await build(false);
    guarded = await build(true);
    proxied = await build(false, ['http://ui.test']);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM user_session');
    await db.query('DELETE FROM login_attempt');
    await db.query('DELETE FROM user_recovery_code');
    await db.query('DELETE FROM user_totp');
    await db.query('DELETE FROM user_group_member');
    await db.query('DELETE FROM user_group WHERE NOT is_builtin');
    await db.query('UPDATE user_group SET requires_mfa = false');
    await db.query('DELETE FROM user_account');
    await accounts.create(
      { login: 'ops', password: 'correct-horse-battery', role: 'readwrite' },
      testActor,
    );
  });

  const login = async (
    instance: FastifyInstance,
    body: { login: string; password: string; code?: string },
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
      await accounts.update(account?.id ?? 0, { disabled: true }, testActor);
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
        // A route every account may call: `ops` holds no grant, and the root now needs one
        // (`A-12`) — which is the authorisation hook answering, not this guard.
        url: '/api/v1/objects/tops',
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
        // The exact commit says which advisories apply; that is not for an anonymous caller.
        '/api/v1/build',
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

  /**
   * The one route a browser can ask before it has anything to ask with (`U-17`).
   *
   * **`GET /auth/me` cannot answer this, and that is why this route exists.** It refuses an
   * anonymous caller with 401, and that 401 means two different things: with the guard on, "log
   * in"; with the guard off, "you did not need to, and the rest of the API will serve you
   * anyway". A client that cannot tell them apart has to choose between demanding a login the
   * core does not want and rendering an application whose every request will be refused.
   */
  describe('asking what this installation needs', () => {
    it('answers an anonymous caller rather than refusing one, with the guard on', async () => {
      // The route declaring itself public is not enough on its own: the authentication hook
      // runs before any route and refuses from its own list. Both have to say so.
      const response = await guarded.inject({ method: 'GET', url: '/api/v1/auth/session' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { requireAuthentication: true, authenticated: false });
    });

    it('says a login is optional when the guard is off', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { requireAuthentication: false, authenticated: false });
    });

    it('names the principal when the caller has one', async () => {
      const session = await login(guarded, { login: 'ops', password: 'correct-horse-battery' });
      const response = await guarded.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        headers: { cookie: cookieFrom(session.headers['set-cookie']) },
      });

      assert.equal(response.statusCode, 200);
      const body = response.json<{
        authenticated: boolean;
        principal: { login: string; role: string; mustChangePassword: boolean };
      }>();
      assert.equal(body.authenticated, true);
      assert.equal(body.principal.login, 'ops');
      assert.equal(body.principal.role, 'readwrite');
      assert.equal(body.principal.mustChangePassword, false);
    });

    it('reports the password flag the core itself never enforces', async () => {
      // Nothing on the core refuses a request because `must_change_password` is set. If the
      // client does not act on it, the generated password stays live for the life of the
      // installation — so this route is the only place that flag is ever heard.
      await accounts.create(
        {
          login: 'fresh',
          password: 'generated-for-them',
          role: 'readwrite',
          mustChangePassword: true,
        },
        testActor,
      );
      const session = await login(guarded, { login: 'fresh', password: 'generated-for-them' });
      const response = await guarded.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        headers: { cookie: cookieFrom(session.headers['set-cookie']) },
      });

      assert.equal(
        response.json<{ principal: { mustChangePassword: boolean } }>().principal
          .mustChangePassword,
        true,
      );
    });

    it('never carries a session token, only what is in it', async () => {
      const session = await login(guarded, { login: 'ops', password: 'correct-horse-battery' });
      const cookie = cookieFrom(session.headers['set-cookie']);
      const token = decodeURIComponent(cookie.split('=')[1] ?? '');
      const response = await guarded.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        headers: { cookie },
      });

      assert.ok(token.length > 20);
      assert.equal(response.body.includes(token), false);
    });
  });

  it('exempts only paths that are actually routes', () => {
    // **`ALWAYS_PUBLIC` carried `/api/v1/health` for months and there has never been such a
    // route.** It exempted nothing, so nothing failed — and a dead entry in the list of paths
    // that skip authentication reads, to the next person, as evidence that an unauthenticated
    // liveness endpoint exists. The failure mode of this list is silence in both directions: an
    // entry that matches nothing is invisible, and so is a missing entry until somebody cannot
    // log in.
    const server = built[0];
    assert.ok(server !== undefined);
    const registered = new Set(server.routes.map((route) => route.url));
    for (const path of ALWAYS_PUBLIC) {
      assert.ok(registered.has(path), `${path} is exempted from authentication and is not a route`);
    }
  });

  /**
   * The shape of a refusal, as a browser reads it (`U-17`).
   *
   * **The envelope has two namespaces and they are not interchangeable.** `toHttpError` gives an
   * `AuthError` its values as `context` and leaves `details` empty, while `ObjectError` and the
   * schema errors fill `details` with `problems` and `usedBy`. Reading the wrong one is not a
   * type error and not a crash: the lookup is `undefined`, the branch it guards is never taken,
   * and the client is quietly wrong for ever.
   *
   * It shipped that way once. `packages/web` read `enrolled` from `details`, so every account
   * with a second factor was shown "an administrator has to enrol this account" and a disabled
   * button — and the web tests passed, because they built the fixture in the shape the client
   * expected rather than the shape the core emits. **No test in that package can see this**,
   * which is why the assertions are here.
   */
  describe('the refusal envelope a client parses', () => {
    /** The code an authenticator app would be showing right now. */
    const codeFor = (secret: string): string =>
      new OTPAuth.TOTP({
        issuer: 'MonitoringSystem',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret),
      }).generate();

    /** Puts `ops` in a group that demands a second factor. */
    const demandMfa = async (): Promise<number> => {
      const account = await accounts.byLogin('ops');
      const id = account?.id ?? 0;
      const groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const secure = await groups.create({ name: 'Change managers' }, testActor);
      await db.query(`UPDATE user_group SET requires_mfa = true WHERE id = $1`, [secure.id]);
      await groups.addMember(secure.id, id, testActor);
      return id;
    };

    it('carries an MFA refusal in context, and says the account is not enrolled', async () => {
      await demandMfa();
      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });

      assert.equal(response.statusCode, 401);
      const body = response.json<{
        error: { code: string; context: Record<string, unknown>; details: Record<string, unknown> };
      }>();
      assert.equal(body.error.code, 'MFA_REQUIRED');
      assert.equal(body.error.context['enrolled'], 'false');
      // And not in the other namespace. A client reading `details` here sees nothing at all,
      // which is indistinguishable from "this account is enrolled" unless it is looking.
      assert.deepEqual(body.error.details, {});
    });

    it('says the account IS enrolled, which is what tells a client to ask for a code', async () => {
      const id = await demandMfa();
      const totp = new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const { secret } = await totp.beginEnrolment(id, 'ops');
      await totp.confirmEnrolment(id, codeFor(secret), testActor);

      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });

      assert.equal(response.statusCode, 401);
      const body = response.json<{
        error: { code: string; context: Record<string, unknown>; details: Record<string, unknown> };
      }>();
      assert.equal(body.error.code, 'MFA_REQUIRED');
      assert.equal(body.error.context['enrolled'], 'true');
      assert.deepEqual(body.error.details, {});
    });

    it('lets that account in when it presents a second factor', async () => {
      // The other half of the same claim: `enrolled: 'true'` is a step, not a refusal, and the
      // step completes. Without this the two cases above would both be satisfied by a core that
      // never accepts a second factor at all.
      //
      // A recovery code rather than a fresh TOTP code, and for a reason worth stating: enrolment
      // consumes the current 30-second step, and the service refuses a code from a step it has
      // already seen — correctly, because that is replay protection. Generating another code in
      // the same window would be testing the replay guard by accident.
      const id = await demandMfa();
      const totp = new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const { secret } = await totp.beginEnrolment(id, 'ops');
      const { recoveryCodes } = await totp.confirmEnrolment(id, codeFor(secret), testActor);

      const response = await login(app, {
        login: 'ops',
        password: 'correct-horse-battery',
        code: recoveryCodes[0] ?? '',
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json<{ login: string }>().login, 'ops');
    });

    it('carries the throttle delay in context, as a number', async () => {
      const throttled = new LoginThrottle({
        db,
        logger: silent,
        config: { maxPerAddress: 3 },
        sleep: () => Promise.resolve(),
      });
      for (let attempt = 0; attempt < 23; attempt += 1) {
        await throttled.record('ops', '127.0.0.1', false);
      }

      const response = await login(app, { login: 'ops', password: 'correct-horse-battery' });
      assert.equal(response.statusCode, 429);
      const body = response.json<{
        error: { code: string; context: Record<string, unknown>; details: Record<string, unknown> };
      }>();
      assert.equal(body.error.code, 'AUTH_THROTTLED');
      assert.equal(typeof body.error.context['retryAfterSeconds'], 'number');
      assert.ok((body.error.context['retryAfterSeconds'] as number) > 0);
      assert.deepEqual(body.error.details, {});
    });
  });

  /**
   * That the configured origins reach the guard (`A-19`).
   *
   * `hardening.test.ts` proves what the guard does with a list; what it cannot prove is that
   * anything hands it one — which is the bug `A-19` was. The wiring is a single field on a
   * single call, and the failure it had was that nobody wrote it.
   */
  describe('the configured origin allowlist', () => {
    const headers = { origin: 'http://ui.test', host: 'core.test' };

    it('reaches the guard, so a listed origin may write', async () => {
      // 401, not 403: the CSRF guard let it past and the login handler answered on its merits.
      // A route that needed no credentials could not tell those two refusals apart.
      const response = await proxied.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'ops', password: 'wrong-password-entirely' },
        headers,
      });
      assert.equal(response.statusCode, 401);
    });

    it('and an installation that configured none still refuses the same request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'ops', password: 'correct-horse-battery' },
        headers,
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'AUTH_FORBIDDEN');
    });
  });
});
