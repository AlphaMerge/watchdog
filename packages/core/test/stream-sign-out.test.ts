import { strict as assert } from 'node:assert';
import { after, afterEach, before, beforeEach, describe, it, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ApiServer } from '../src/api/server.js';
import { STREAM_SIGNED_OUT } from '../src/api/routes/stream.js';
import { AccountService } from '../src/auth/accounts.js';
import { AccessService } from '../src/auth/access.js';
import { credentialCheck, type Lapse } from '../src/auth/credentials.js';
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
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

/**
 * An open stream is closed when what authenticated it stops doing so (`A-34`).
 *
 * **Every ordinary request asks again; a WebSocket asked once.** The authentication hook resolves
 * the session or token on every request, so a logout, a revoked token or a disabled account stops
 * the next request dead. The stream's upgrade is one request that lives for days, and until this
 * ticket nothing after it asked: a laptop logged out at the end of a shift went on streaming the
 * installation's state to whoever opened it next.
 *
 * The claims, each against a real socket: every cause closes the socket with `4401` and says
 * which; another account's socket is untouched; nothing committed after the credential lapsed is
 * sent — neither a change nor a snapshot — even before the sweep comes round; a check that cannot
 * answer closes nothing and is counted; an open stream is not activity; and with authentication
 * off there is nothing to check.
 */

const available = await databaseAvailable();

const PASSWORD = 'correct-horse-battery';

describe('a stream whose credential lapses', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let h: Harness;
  let accounts: AccountService;
  let sessions: SessionService;
  let tokens: TokenService;
  let stream: StateBroadcaster;
  let app: FastifyInstance;
  let open: StateBroadcaster;
  let openApp: FastifyInstance;
  /** Sessions with the idle timeout raised to three days, as a wall display's would be (`A-38`). */
  let lasting: StateBroadcaster;
  let lastingApp: FastifyInstance;
  const servers: ApiServer[] = [];
  let sensorId = 0;
  /** The sessions' clock, moved by the expiry test. */
  let clock = Date.now();

  const ids = new Map<string, number>();
  const cookies = new Map<string, string>();

  before(async () => {
    scratch = await createScratchDatabase('streamsignout');
    db = scratch.db;
    h = await buildHarness(db);
    accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
    sessions = new SessionService({ db, logger: silent, now: () => new Date(clock) });
    tokens = new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent });
    const groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });

    const build = async (
      required: boolean,
      broadcaster: StateBroadcaster,
      using: SessionService = sessions,
    ) => {
      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: required,
        },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        stream: broadcaster,
        auth: {
          accounts,
          sessions: using,
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups,
          access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
          tokens,
          totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          required,
        },
      });
      await server.build('9.9.9', h.service);
      servers.push(server);
      return server.app;
    };
    // The sweep's own timer is an hour away: every test here runs the sweep when it means to, so
    // what closed a socket is never a timer that happened to fire.
    stream = new StateBroadcaster({ logger: silent, credentialSweepMs: 3_600_000 });
    app = await build(true, stream);
    open = new StateBroadcaster({ logger: silent, credentialSweepMs: 3_600_000 });
    openApp = await build(false, open);
    lasting = new StateBroadcaster({ logger: silent, credentialSweepMs: 3_600_000 });
    lastingApp = await build(
      true,
      lasting,
      new SessionService({
        db,
        logger: silent,
        idleTimeoutMs: 3 * 24 * 60 * 60_000,
        now: () => new Date(clock),
      }),
    );

    const probe = await h.service.create(testActor, {
      kind: 'probe',
      parentId: h.rootId,
      name: 'probe',
    });
    const device = await h.service.create(testActor, {
      kind: 'device',
      parentId: probe.id,
      name: 'edge-router',
      host: '192.0.2.7',
    });
    sensorId = (
      await h.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
      })
    ).id;

    // Administrators both, so that each sees the whole tree and a change reaches each socket:
    // what is under test is whether it stays open, not what it may see.
    const admins = (await groups.list()).find((group) => group.isAdmin);
    assert.ok(admins);
    for (const login of ['watcher', 'bystander']) {
      const account = await accounts.create(
        { login, password: PASSWORD, role: 'admin' },
        testActor,
      );
      await groups.addMember(admins.id, account.id, testActor);
      ids.set(login, account.id);
    }
  });

  after(async () => {
    for (const server of servers) await server.stop();
    await scratch.drop();
  });

  beforeEach(async () => {
    clock = Date.now();
    await db.query('DELETE FROM user_session');
    await db.query('DELETE FROM api_token');
    await db.query('DELETE FROM login_attempt');
    await db.query('UPDATE user_account SET disabled = false');
    for (const login of ['watcher', 'bystander']) cookies.set(login, await logIn(login));
  });

  /** Every socket a test opened, so a failing one does not leave the next test a socket short. */
  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.terminate();
  });

  async function logIn(login: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password: PASSWORD },
    });
    assert.equal(response.statusCode, 200, `${login} could not log in`);
    const setCookie = response.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
    return header.split(';')[0] ?? '';
  }

  async function logOut(login: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookies.get(login) ?? '' },
    });
    assert.equal(response.statusCode, 204);
  }

  const as = (login: string) => ({ cookie: cookies.get(login) ?? '' });

  /** A socket that has subscribed to everything and been sent its snapshot. */
  async function watching(
    headers: Record<string, string>,
    on: FastifyInstance = app,
  ): Promise<{
    socket: WebSocket;
    frames: Record<string, unknown>[];
    closed: Promise<{ code: number; reason: string }>;
  }> {
    const socket = await on.injectWS('/api/v1/stream', { headers });
    sockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.on('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
    socket.send(JSON.stringify({ subscribe: {} }));
    await until(() => frames.some((frame) => frame['type'] === 'snapshot'), 'a snapshot');
    return { socket, frames, closed };
  }

  /** A change to the one sensor, published as a commit would publish it. */
  async function change(broadcaster: StateBroadcaster = stream): Promise<void> {
    await broadcaster.publish(db, [
      {
        sensorId,
        state: 'down',
        previousState: 'up',
        cause: 'scan',
        message: 'unreachable',
        at: new Date(),
      },
    ]);
  }

  const states = (frames: readonly Record<string, unknown>[]): number =>
    frames.filter((frame) => frame['type'] === 'state').length;

  /** How a socket closed — or a failure naming what was expected, rather than a hang. */
  async function closedWith(
    closed: Promise<{ code: number; reason: string }>,
  ): Promise<{ code: number; reason: string }> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('the socket was never closed'));
      }, 5_000);
    });
    try {
      return await Promise.race([closed, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  const signedOut = (lapse: Lapse): number => stream.stats.signedOut[lapse];

  describe('each cause', () => {
    it('closes a session’s socket on logout, and leaves another account’s streaming', async () => {
      const watcher = await watching(as('watcher'));
      const bystander = await watching(as('bystander'));

      await logOut('watcher');
      await stream.sweep();

      assert.deepEqual(await closedWith(watcher.closed), {
        code: STREAM_SIGNED_OUT,
        reason: 'this session has ended; sign in again',
      });
      assert.equal(signedOut('ended'), 1);
      // The negative case: signed in still, and still sent what changes.
      assert.equal(bystander.socket.readyState, bystander.socket.OPEN);
      await change();
      await until(() => states(bystander.frames) === 1, 'the change on the other socket');
    });

    it('closes a token’s socket when the token is revoked', async () => {
      const watcherId = ids.get('watcher') ?? 0;
      const { token, secret } = await tokens.issue(
        { userId: watcherId, role: 'admin' },
        { name: 'wallboard', scope: 'read' },
        testActor,
      );
      const scripted = await watching({ authorization: `Bearer ${secret}` });
      // The same account's session, which a revoked token has nothing to do with.
      const browser = await watching(as('watcher'));
      const before = signedOut('revoked');

      assert.equal(await tokens.revoke(watcherId, token.id, testActor), true);
      await stream.sweep();

      assert.deepEqual(await closedWith(scripted.closed), {
        code: STREAM_SIGNED_OUT,
        reason: 'this token has been revoked',
      });
      assert.equal(signedOut('revoked'), before + 1);
      assert.equal(browser.socket.readyState, browser.socket.OPEN);
    });

    it('closes every socket an account opened when it is disabled', async () => {
      const watcherId = ids.get('watcher') ?? 0;
      const { secret } = await tokens.issue(
        { userId: watcherId, role: 'admin' },
        { name: 'wallboard', scope: 'read' },
        testActor,
      );
      const scripted = await watching({ authorization: `Bearer ${secret}` });
      const browser = await watching(as('watcher'));
      const secondTab = await watching(as('watcher'));
      const bystander = await watching(as('bystander'));
      const before = signedOut('disabled');

      await accounts.update(watcherId, { disabled: true }, testActor);
      await stream.sweep();

      for (const socket of [scripted, browser, secondTab]) {
        assert.deepEqual(await closedWith(socket.closed), {
          code: STREAM_SIGNED_OUT,
          reason: 'this account can no longer sign in',
        });
      }
      assert.equal(signedOut('disabled'), before + 3);
      assert.equal(bystander.socket.readyState, bystander.socket.OPEN);
    });

    it('closes a session’s socket when it expires, because streaming is not activity', async () => {
      const watcher = await watching(as('watcher'));
      const seen = async (): Promise<string> => {
        const rows = await db.query<{ at: string }>(
          `SELECT s.last_seen_at::text AS at FROM user_session s
           JOIN user_account a ON a.id = s.user_id WHERE a.login = 'watcher'`,
        );
        return rows[0]?.at ?? 'gone';
      };
      const lastSeen = await seen();

      // An hour on: still well inside the twelve-hour idle timeout, and checking it did not
      // touch it — the socket being open is not the operator being there.
      clock += 60 * 60_000;
      const early = signedOut('expired');
      await stream.sweep();
      // The count, not `readyState`, which lags a close the core has just sent.
      assert.equal(signedOut('expired'), early, 'signed out inside the idle timeout');
      assert.equal(await seen(), lastSeen, 'checking the session extended it');

      // Past it, with nothing but the stream open all that time.
      clock += 12 * 60 * 60_000;
      const before = signedOut('expired');
      await stream.sweep();
      assert.deepEqual(await closedWith(watcher.closed), {
        code: STREAM_SIGNED_OUT,
        reason: 'this session has expired; sign in again',
      });
      assert.equal(signedOut('expired'), before + 1);
    });
  });

  describe('with the idle timeout raised (A-38)', () => {
    it('keeps a stream open past twelve hours, and still ends it at the raised one', async () => {
      // A wall display: signed in once, nothing asked of the core but the stream. With the
      // default it is signed out at twelve hours; raised to three days, it is not.
      const response = await lastingApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'watcher', password: PASSWORD },
      });
      assert.equal(response.statusCode, 200);
      const setCookie = response.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')).split(
        ';',
      )[0];
      const display = await watching({ cookie: cookie ?? '' }, lastingApp);

      // The broadcaster's own count, not the client's `readyState`: a close the core sends reaches
      // the client a moment later, so a socket signed out by this sweep still reads open here.
      clock += 13 * 60 * 60_000;
      await lasting.sweep();
      assert.equal(lasting.stats.signedOut.expired, 0, 'signed out at the default');

      clock += 3 * 24 * 60 * 60_000;
      await lasting.sweep();
      assert.deepEqual(await closedWith(display.closed), {
        code: STREAM_SIGNED_OUT,
        reason: 'this session has expired; sign in again',
      });
    });
  });

  describe('before the sweep comes round', () => {
    it('sends no change committed after the logout', async () => {
      const watcher = await watching(as('watcher'));
      const bystander = await watching(as('bystander'));

      // No sweep: the batch itself asks, before it delivers anything.
      await logOut('watcher');
      await change();

      assert.equal((await closedWith(watcher.closed)).code, STREAM_SIGNED_OUT);
      // Arrived on the other socket, so it would have arrived on this one by now too.
      await until(() => states(bystander.frames) === 1, 'the change on the other socket');
      assert.equal(states(watcher.frames), 0, 'the change reached a socket after its logout');
    });

    it('sends no snapshot read across the logout', async (t: TestContext) => {
      const read = stream.snapshot.bind(stream);
      t.mock.method(
        stream,
        'snapshot',
        async (...args: Parameters<StateBroadcaster['snapshot']>) => {
          const rows = await read(...args);
          // Read while signed in; ended before it could be sent.
          await logOut('watcher');
          return rows;
        },
      );
      const socket = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      sockets.push(socket);
      const types: unknown[] = [];
      socket.on('message', (raw: Buffer) => {
        types.push((JSON.parse(raw.toString('utf8')) as Record<string, unknown>)['type']);
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        socket.on('close', (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString('utf8') });
        });
      });
      socket.send(JSON.stringify({ subscribe: {} }));

      assert.equal((await closedWith(closed)).code, STREAM_SIGNED_OUT);
      // `hello` may have gone before the listener was on; a snapshot cannot have.
      assert.equal(
        types.includes('snapshot'),
        false,
        'a snapshot went out after the session ended',
      );
    });
  });

  describe('a check that cannot answer', () => {
    it('closes nothing, counts the failure, and goes on delivering', async (t: TestContext) => {
      const watcher = await watching(as('watcher'));
      const failures = stream.stats.credentialCheckFailures;
      t.mock.method(sessions, 'lapsed', () => Promise.reject(new Error('the database went away')));

      await logOut('watcher');
      await stream.sweep();
      await change();

      assert.equal(stream.stats.credentialCheckFailures, failures + 2, 'the sweep and the batch');
      assert.equal(watcher.socket.readyState, watcher.socket.OPEN);
      await until(() => states(watcher.frames) === 1, 'the change, delivered as before');

      // And the next check that can answer, does.
      t.mock.restoreAll();
      await stream.sweep();
      assert.equal((await closedWith(watcher.closed)).code, STREAM_SIGNED_OUT);
    });
  });

  describe('with authentication off', () => {
    it('checks nothing, since anybody may open the same socket', async () => {
      // A cookie is still presented and still resolves; there is simply nothing it protects.
      const watcher = await watching(as('watcher'), openApp);
      await logOut('watcher');
      await open.sweep();
      await change(open);

      await until(() => states(watcher.frames) === 1, 'the change');
      assert.equal(watcher.socket.readyState, watcher.socket.OPEN);
      assert.deepEqual(open.stats.signedOut, { ended: 0, expired: 0, revoked: 0, disabled: 0 });
    });
  });

  describe('what each service says lapsed', () => {
    it('names why, and leaves out what still authenticates', async () => {
      const watcherId = ids.get('watcher') ?? 0;
      const bystanderId = ids.get('bystander') ?? 0;
      const sessionOf = async (userId: number): Promise<string> => {
        const rows = await db.query<{ id: string }>(
          'SELECT id FROM user_session WHERE user_id = $1',
          [userId],
        );
        return rows[0]?.id ?? '';
      };
      const live = await sessionOf(bystanderId);
      const ended = await sessionOf(watcherId);
      await db.query('DELETE FROM user_session WHERE id = $1', [ended]);

      const issue = async (name: string, expiresAt?: Date) =>
        (
          await tokens.issue(
            { userId: bystanderId, role: 'admin' },
            { name, scope: 'read', ...(expiresAt === undefined ? {} : { expiresAt }) },
            testActor,
          )
        ).token.id;
      const good = await issue('good');
      const revoked = await issue('revoked');
      await tokens.revoke(bystanderId, revoked, testActor);
      const expired = await issue('expired', new Date(Date.now() + 60_000));
      await db.query(
        `UPDATE api_token SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [expired],
      );

      const check = credentialCheck(sessions, tokens);
      const asked = [
        { kind: 'session', id: live, userId: bystanderId },
        { kind: 'session', id: ended, userId: watcherId },
        // A session presented as somebody else's is not theirs to keep open.
        { kind: 'session', id: live, userId: watcherId },
        { kind: 'token', id: good, userId: bystanderId },
        { kind: 'token', id: revoked, userId: bystanderId },
        { kind: 'token', id: expired, userId: bystanderId },
      ] as const;
      // The third is asked on its own: it shares the first's key, which is the point of it.
      assert.deepEqual(
        [...(await check.lapsed(asked.slice(0, 2).concat(asked.slice(3))))].sort(),
        [
          [`session:${ended}`, 'ended'],
          [`token:${String(expired)}`, 'expired'],
          [`token:${String(revoked)}`, 'revoked'],
        ].sort(),
      );
      assert.deepEqual(await sessions.lapsed([asked[2]]), new Map([[live, 'ended']]));

      // Disabled outranks everything the account's credentials would say for themselves — a live
      // session, a good token, a revoked one, and a session that has already ended.
      await accounts.update(bystanderId, { disabled: true }, testActor);
      await accounts.update(watcherId, { disabled: true }, testActor);
      assert.deepEqual(
        [...(await check.lapsed([asked[0], asked[1], asked[3], asked[4]]))].map(
          ([, lapse]) => lapse,
        ),
        ['disabled', 'disabled', 'disabled', 'disabled'],
      );
    });
  });
});

/** Waits for a condition the socket's events will make true, or fails naming it. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
