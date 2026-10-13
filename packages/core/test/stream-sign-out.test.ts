import { strict as assert } from 'node:assert';
import { after, afterEach, before, beforeEach, describe, it, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { WebSocket } from 'ws';
import { ApiServer } from '../src/api/server.js';
import { STREAM_LIMITS, STREAM_SIGNED_OUT, STREAM_UNSURE } from '../src/api/routes/stream.js';
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
import { StateBroadcaster, type StreamPool } from '../src/state/stream.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { pollWithin, within } from './support/within.js';

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
 *
 * **And when it is closed says nothing about what changed** (`U-25`). A change published after a
 * sign-out stops the socket being sent anything and does not close it; the sweep does, on its own
 * timer, or the socket's own next frame does. Closed where the change was published, an account
 * that had just been signed out or disabled was told the instant some sensor changed state or
 * some probe's link moved — one it may never have been allowed to see.
 *
 * **Nor does how it is treated while the check cannot be made** (`U-26`): a frame sent then is
 * not acted on and the socket is closed to reconnect, the same for a socket a change silenced,
 * one that lapsed with nothing published since, and one still signed in.
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
  /**
   * A broadcaster whose sockets' answers are aged by `answerClock`, which a test moves (`U-27`):
   * how a socket heard from an hour ago is made without waiting an hour.
   */
  let unvetted: StateBroadcaster;
  let unvettedApp: FastifyInstance;
  let answerClock = 0;
  const servers: ApiServer[] = [];
  let sensorId = 0;
  let probeId = 0;
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
    unvetted = new StateBroadcaster({
      logger: silent,
      credentialSweepMs: 3_600_000,
      credentialWaitMs: 200,
      clock: () => answerClock,
    });
    unvettedApp = await build(true, unvetted);
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
    probeId = probe.id;
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

  interface Watching {
    socket: WebSocket;
    frames: Record<string, unknown>[];
    closed: Promise<{ code: number; reason: string }>;
    /** How it closed, if it has: read now, where `closed` would have to be waited for. */
    ended: { code?: number };
  }

  /** A socket that has subscribed — to everything, or to one probe — and been answered. */
  async function watching(
    headers: Record<string, string>,
    on: FastifyInstance = app,
    probe?: number,
  ): Promise<Watching> {
    const socket = await on.injectWS('/api/v1/stream', { headers });
    sockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    });
    const ended: { code?: number } = {};
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.on('close', (code: number, reason: Buffer) => {
        ended.code = code;
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
    socket.send(JSON.stringify({ subscribe: probe === undefined ? {} : { probeId: probe } }));
    const answer = probe === undefined ? 'snapshot' : 'watching';
    await until(() => frames.some((frame) => frame['type'] === answer), `a ${answer} frame`);
    return { socket, frames, closed, ended };
  }

  /**
   * One round trip on this socket, bounded. A socket is FIFO, so whatever the core sent it
   * before the pong — a frame, or a close — has arrived by the time this returns: the wait that
   * makes "it was sent nothing, and it is open" a claim about now rather than about a moment
   * too early to tell.
   */
  async function roundTrip(socket: WebSocket): Promise<void> {
    let ponged = false;
    socket.once('pong', () => {
      ponged = true;
    });
    socket.ping();
    await until(() => ponged, 'a pong: the socket is not open');
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
  const probes = (frames: readonly Record<string, unknown>[]): number =>
    frames.filter((frame) => frame['type'] === 'probe').length;

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
    // Until `U-25` this case pinned "closed by the batch that found it". What it was for is
    // unchanged — nothing committed after the logout arrives — and the close moved to the sweep.
    it('sends nothing committed after the logout, and closes nothing until the sweep', async () => {
      // Two tabs on one session, a tree and a form watching the probe; and the same two for an
      // account that stays signed in, which is how the edges are shown to have happened.
      const watcher = await watching(as('watcher'));
      const form = await watching(as('watcher'), app, probeId);
      const bystander = await watching(as('bystander'));
      const other = await watching(as('bystander'), app, probeId);
      const had = [watcher.frames.length, form.frames.length];
      const before = signedOut('ended');
      // These four and no other: sockets an earlier case left behind have finished closing.
      await until(() => stream.stats.subscribers === 4, 'four subscriptions');

      // No sweep: each batch itself asks, before it delivers anything.
      await logOut('watcher');
      for (let batch = 1; batch <= 3; batch += 1) {
        await change();
        await until(() => states(bystander.frames) === batch, `state change ${String(batch)}`);
      }
      for (let edge = 1; edge <= 3; edge += 1) {
        await stream.publishProbe(db, probeId);
        await until(() => probes(other.frames) === edge, `probe edge ${String(edge)}`);
      }

      // Six edges, each of which reached a socket still signed in. The signed-out ones were sent
      // nothing at any of them — no change, no `probe`, no `overflow` — and are still open.
      for (const lapsed of [watcher, form]) await roundTrip(lapsed.socket);
      assert.deepEqual(
        [watcher.frames.slice(had[0]), form.frames.slice(had[1])],
        [[], []],
        'something reached a socket after its logout',
      );
      assert.deepEqual(
        [watcher.ended, form.ended],
        [{}, {}],
        'a socket was closed where a change was published',
      );
      // Detached, not merely muted: nothing is fanned out to a subscription nobody will be sent.
      assert.equal(stream.stats.subscribers, 2, 'a silenced socket is still subscribed');
      // Found there, and counted there: both of the session's sockets, by the first batch.
      assert.equal(signedOut('ended'), before + 2);

      // The sweep's tick, run by hand, is the close.
      await stream.sweep();
      for (const lapsed of [watcher, form]) {
        assert.deepEqual(await closedWith(lapsed.closed), {
          code: STREAM_SIGNED_OUT,
          reason: 'this session has ended; sign in again',
        });
      }
      assert.equal(watcher.frames.length, had[0]);
      assert.equal(form.frames.length, had[1]);
      assert.equal(signedOut('ended'), before + 2, 'counted again at the close');
      // And the account that stayed signed in was never disturbed.
      assert.deepEqual([bystander.ended, other.ended], [{}, {}]);
    });

    it('closes a silenced socket at its own next frame, without answering it', async () => {
      const watcher = await watching(as('watcher'));
      const form = await watching(as('watcher'), app, probeId);
      const bystander = await watching(as('bystander'));
      await logOut('watcher');
      await change();
      await until(() => states(bystander.frames) === 1, 'the change on the other socket');
      for (const lapsed of [watcher, form]) await roundTrip(lapsed.socket);
      const had = [watcher.frames.length, form.frames.length];

      // Subscribing again is the client's own doing, so the instant says nothing: closed there,
      // with no sweep, and with no snapshot — it may not subscribe in the window.
      watcher.socket.send(JSON.stringify({ subscribe: {} }));
      assert.deepEqual(await closedWith(watcher.closed), {
        code: STREAM_SIGNED_OUT,
        reason: 'this session has ended; sign in again',
      });
      assert.deepEqual(watcher.frames.slice(had[0]), [], 'a silenced socket was answered');
      // Its own socket and no other: the session's second tab is still the sweep's to close.
      await roundTrip(form.socket);
      assert.deepEqual(form.ended, {});

      // A watch is refused the same way: no `watching`.
      form.socket.send(JSON.stringify({ subscribe: { probeId } }));
      assert.equal((await closedWith(form.closed)).code, STREAM_SIGNED_OUT);
      assert.deepEqual(form.frames.slice(had[1]), [], 'a silenced socket was allowed a watch');
      assert.deepEqual(bystander.ended, {});
    });

    it('closes a lapsed socket nothing was published to at its own frame, just the same', async () => {
      // **The same answer whether or not anything changed since the sign-out.** Were a silenced
      // socket closed by its frame and an unsilenced one answered, one frame of junk would tell
      // a signed-out client whether anything had changed state since.
      const watcher = await watching(as('watcher'));
      const bystander = await watching(as('bystander'));
      await logOut('watcher');
      const had = watcher.frames.length;

      watcher.socket.send('not a subscription');
      assert.deepEqual(await closedWith(watcher.closed), {
        code: STREAM_SIGNED_OUT,
        reason: 'this session has ended; sign in again',
      });
      assert.deepEqual(watcher.frames.slice(had), [], 'a signed-out socket was answered');

      // Signed in, the same frame is answered and the socket stays.
      const at = bystander.frames.length;
      bystander.socket.send('not a subscription');
      await until(() => bystander.frames.length > at, 'an answer');
      assert.equal(bystander.frames[at]?.['type'], 'problem');
      await roundTrip(bystander.socket);
      assert.deepEqual(bystander.ended, {});
    });

    it('closes a socket that sends frames faster than its credential can be asked about', async (t: TestContext) => {
      const watcher = await watching(as('watcher'));
      const severed = stream.stats.severed;
      // The database is slow: every question about a session waits here.
      let release = (): void => undefined;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ask = sessions.lapsed.bind(sessions);
      t.mock.method(sessions, 'lapsed', async (...args: Parameters<SessionService['lapsed']>) => {
        await slow;
        return ask(...args);
      });
      try {
        const had = watcher.frames.length;
        // As many as may wait, each held behind the first one's question; and one more.
        for (let n = 0; n < STREAM_LIMITS.unread; n += 1) watcher.socket.send('5');
        await roundTrip(watcher.socket);
        assert.deepEqual(watcher.ended, {}, 'closed inside the bound');
        watcher.socket.send('5');
        assert.deepEqual(await closedWith(watcher.closed), {
          code: 1008,
          reason: 'it sent frames faster than they could be read',
        });
        assert.equal(stream.stats.severed, severed + 1);
        assert.deepEqual(watcher.frames.slice(had), [], 'a frame was read before it was asked');
      } finally {
        release();
      }
    });

    it('closes a subscription in flight when a change silenced it, as it would have unsilenced', async (t: TestContext) => {
      // The socket's own subscribe is on its way when the session ends *and* a change is
      // published. The change silences it; the subscription still asks before it answers, and
      // that closes the socket — as the case below does with nothing published. No sweep.
      const bystander = await watching(as('bystander'));
      const read = stream.snapshot.bind(stream);
      let crossed = false;
      t.mock.method(
        stream,
        'snapshot',
        async (...args: Parameters<StateBroadcaster['snapshot']>) => {
          const rows = await read(...args);
          if (!crossed) {
            crossed = true;
            await logOut('watcher');
            await change();
          }
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
      await until(() => states(bystander.frames) === 1, 'the change on the other socket');
      // `hello` may have gone before the listener was on; nothing else can have.
      assert.deepEqual(
        types.filter((type) => type !== 'hello'),
        [],
        'a silenced socket was sent something',
      );
    });

    it('answers a silenced socket’s subscription in flight with nothing at all', async (t: TestContext) => {
      // A subscription that would be refused — `problem` — had the socket not been silenced
      // while the refusal was being decided. It is sent no frame; the sweep closes it.
      const bystander = await watching(as('bystander'));
      const watcher = await watching(as('watcher'));
      const had = watcher.frames.length;
      t.mock.method(stream, 'canSee', async () => {
        await logOut('watcher');
        await change();
        return false;
      });
      watcher.socket.send(JSON.stringify({ subscribe: { objectId: sensorId } }));
      await until(() => states(bystander.frames) === 1, 'the change on the other socket');
      await roundTrip(watcher.socket);
      // A second round trip: the refusal, had it been sent, follows the change by a turn or two.
      await roundTrip(watcher.socket);
      assert.deepEqual(watcher.frames.slice(had), [], 'a silenced socket was answered');
      assert.deepEqual(watcher.ended, {});

      await stream.sweep();
      assert.equal((await closedWith(watcher.closed)).code, STREAM_SIGNED_OUT);
      assert.deepEqual(watcher.frames.slice(had), []);
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

  describe('a change whose check cannot be made (U-27)', () => {
    it('reaches a socket heard from this interval, holds the rest back saying nothing, and sends them back on the sweep', async (t: TestContext) => {
      const HOUR = 3_600_000;
      answerClock = 0;
      // Heard from an hour and more ago: one signed in, one about to be signed out, and one
      // that has subscribed to nothing and so has nothing to miss.
      const quiet = await watching(as('watcher'), unvettedApp);
      const lapsed = await watching(as('bystander'), unvettedApp);
      const idle = await unvettedApp.injectWS('/api/v1/stream', { headers: as('watcher') });
      sockets.push(idle);
      const idleFrames: Record<string, unknown>[] = [];
      idle.on('message', (raw: Buffer) => {
        idleFrames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
      });
      // `hello` may have come before the listener: what counts is that nothing comes after this.
      await roundTrip(idle);
      const idleHad = idleFrames.length;
      answerClock = 2 * HOUR;
      // Heard from just now.
      const recent = await watching(as('watcher'), unvettedApp);
      await logOut('bystander');
      const had = [quiet, lapsed].map((each) => each.frames.length);
      const before = unvetted.stats;

      t.mock.method(sessions, 'lapsed', () => Promise.reject(new Error('the database went away')));
      await within(2_000, 'the change', change(unvetted));
      await until(() => states(recent.frames) === 1, 'the change on the socket heard from now');
      for (const each of [quiet.socket, lapsed.socket, idle]) await roundTrip(each);
      // **Nothing at the edge, to a signed-in socket and a signed-out one alike**, and neither
      // is closed: which of the two a socket is cannot be read from this instant.
      assert.deepEqual(
        [quiet, lapsed].map((each, index) => each.frames.slice(had[index])),
        [[], []],
        'something was sent at the edge to a socket nobody could vouch for',
      );
      assert.deepEqual([quiet.ended, lapsed.ended], [{}, {}]);
      assert.equal(idleFrames.length, idleHad);
      const after = unvetted.stats;
      assert.equal(after.edgesUnvetted, before.edgesUnvetted + 1);
      // Two subscriptions held back; the socket with none had nothing to hold.
      assert.equal(after.withheld, before.withheld + 2);
      assert.equal(after.credentialCheckFailures, before.credentialCheckFailures + 1);

      // A sweep that cannot ask either says nothing to anybody.
      await within(2_000, 'a sweep that cannot ask', unvetted.sweep());
      for (const each of [quiet.socket, lapsed.socket, idle]) await roundTrip(each);
      assert.deepEqual(
        [quiet, lapsed].map((each, index) => each.frames.slice(had[index])),
        [[], []],
      );

      // The one that can: the signed-in socket is sent back to subscribe, on the sweep's clock;
      // the signed-out one is closed, having been sent nothing; the idle one is told nothing.
      t.mock.restoreAll();
      await within(2_000, 'the sweep', unvetted.sweep());
      await until(
        () => quiet.frames.some((frame) => frame['type'] === 'overflow'),
        'overflow on the socket held back',
      );
      assert.deepEqual(quiet.frames.slice(had[0]), [
        {
          type: 'overflow',
          reason: 'could not confirm this session for a moment; subscribe again',
        },
      ]);
      assert.equal((await closedWith(lapsed.closed)).code, STREAM_SIGNED_OUT);
      assert.deepEqual(
        lapsed.frames.slice(had[1]),
        [],
        'something was sent to a signed-out socket',
      );
      await roundTrip(idle);
      assert.equal(idleFrames.length, idleHad, 'a socket that missed nothing was sent something');

      // It subscribes again, and is served as before.
      quiet.socket.send(JSON.stringify({ subscribe: {} }));
      await until(
        () => quiet.frames.filter((frame) => frame['type'] === 'snapshot').length === 2,
        'a second snapshot',
      );
      await within(2_000, 'the next change', change(unvetted));
      await until(() => states(quiet.frames) === 1, 'the next change on the socket sent back');
      await until(() => states(recent.frames) === 2, 'the next change on the other');
    });
  });

  describe('a socket held back that subscribes again by itself (U-27)', () => {
    it('is served its own snapshot, and not sent back again by the sweep', async (t: TestContext) => {
      answerClock = 0;
      const quiet = await watching(as('watcher'), unvettedApp);
      answerClock = 2 * 3_600_000;
      const recent = await watching(as('watcher'), unvettedApp);
      const had = quiet.frames.length;
      t.mock.method(sessions, 'lapsed', () => Promise.reject(new Error('the database went away')));
      await within(2_000, 'the change', change(unvetted));
      await until(() => states(recent.frames) === 1, 'the change on the socket heard from now');
      await roundTrip(quiet.socket);
      assert.deepEqual(quiet.frames.slice(had), []);

      // The page subscribes again before the core can ask — a navigation, say — and is answered
      // once it can. Its snapshot covers what it missed, so the sweep has nothing to tell it.
      t.mock.restoreAll();
      quiet.socket.send(JSON.stringify({ subscribe: {} }));
      await until(
        () => quiet.frames.filter((frame) => frame['type'] === 'snapshot').length === 2,
        'the snapshot it asked for',
      );
      await within(2_000, 'the sweep', unvetted.sweep());
      await roundTrip(quiet.socket);
      assert.deepEqual(
        quiet.frames.slice(had).map((frame) => frame['type']),
        ['snapshot'],
        'sent back to subscribe after it had',
      );
      await within(2_000, 'the next change', change(unvetted));
      await until(() => states(quiet.frames) === 1, 'the next change on it');
    });
  });

  describe('a frame sent while the check cannot be made (U-26)', () => {
    const UNSURE = { code: STREAM_UNSURE, reason: 'could not confirm this session; reconnect' };

    it('is not acted on, and closes a silenced socket, a lapsed one and a signed-in one alike', async (t: TestContext) => {
      // Until this, the silenced socket was closed with 4401 and the other two were answered:
      // one frame during a database outage said whether anything had changed since a sign-out.
      const silenced = await watching(as('watcher'));
      const unfound = await watching(as('bystander'));
      await logOut('watcher');
      await change();
      // The edge happened, and it silenced the one socket whose session had ended.
      await until(() => states(unfound.frames) === 1, 'the change on the other socket');
      await roundTrip(silenced.socket);
      assert.deepEqual(silenced.ended, {});
      // Lapsed after it, and found by nothing.
      await logOut('bystander');
      // And one that is signed in throughout.
      cookies.set('watcher', await logIn('watcher'));
      const signedIn = await watching(as('watcher'));
      const all = [silenced, unfound, signedIn];
      const had = all.map((each) => each.frames.length);
      const before = { ...stream.stats.signedOut };
      const failures = stream.stats.credentialCheckFailures;
      const unsure = stream.stats.unsure;
      // The frame is asked about before it is read at all, so none of the three reads a
      // snapshot it will not be sent.
      const snapshots = t.mock.method(stream, 'snapshot');

      t.mock.method(sessions, 'lapsed', () => Promise.reject(new Error('the database went away')));
      for (const each of all) each.socket.send(JSON.stringify({ subscribe: {} }));
      for (const each of all) assert.deepEqual(await closedWith(each.closed), UNSURE);
      assert.deepEqual(
        all.map((each, index) => each.frames.slice(had[index])),
        [[], [], []],
        'a frame was answered though its socket could not be vouched for',
      );
      // Nobody was signed out by a question that had no answer, and each was counted.
      assert.deepEqual(stream.stats.signedOut, before);
      assert.equal(stream.stats.credentialCheckFailures, failures + 3);
      // Counted as what they were, for Core Health: closed to reconnect, not cut off.
      assert.equal(stream.stats.unsure, unsure + 3);
      assert.equal(snapshots.mock.callCount(), 0, 'a snapshot was read for a frame not acted on');
    });

    it('serves a database that answers in three seconds late and once, and a lapsed socket nothing', async (t: TestContext) => {
      // The scenario the bound on a frame's check broke. Every credential question takes three
      // seconds, a second longer than the sweep waits. Held to the sweep's wait, each of these
      // subscriptions was closed with 1013 two seconds in, and a browser came back half a
      // second later to read a snapshot and be closed again, for as long as the database was
      // slow. Before `U-26` they got a late snapshot, and they do again.
      const open = async (login: string) => {
        const socket = await app.injectWS('/api/v1/stream', { headers: as(login) });
        sockets.push(socket);
        const frames: Record<string, unknown>[] = [];
        socket.on('message', (raw: Buffer) => {
          frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
        });
        const ended: { code?: number } = {};
        socket.on('close', (code: number) => {
          ended.code = code;
        });
        return { socket, frames, ended };
      };
      const tabs = [await open('watcher'), await open('watcher'), await open('watcher')];
      // Opened while signed in, and signed out before it asks for anything.
      const lapsed = await open('bystander');
      await logOut('bystander');

      const ask = sessions.lapsed.bind(sessions);
      t.mock.method(sessions, 'lapsed', async (...args: Parameters<SessionService['lapsed']>) => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return ask(...args);
      });
      const read = stream.snapshot.bind(stream);
      const snapshots = t.mock.method(
        stream,
        'snapshot',
        (...args: Parameters<StateBroadcaster['snapshot']>) => read(...args),
      );
      const before = {
        unsure: stream.stats.unsure,
        failures: stream.stats.credentialCheckFailures,
      };
      const signedOutBefore = signedOut('ended');

      for (const each of [...tabs, lapsed]) each.socket.send(JSON.stringify({ subscribe: {} }));
      // The sweep's tick falls in the middle of it: it waits its two seconds, counts a check
      // that could not be made, and closes nobody — not the signed-out socket either.
      await stream.sweep();
      assert.equal(stream.stats.credentialCheckFailures, before.failures + 1);
      assert.deepEqual(
        [...tabs, lapsed].map((each) => each.ended),
        [{}, {}, {}, {}],
      );

      const snapshotsOf = (frames: readonly Record<string, unknown>[]): number =>
        frames.filter((frame) => frame['type'] === 'snapshot').length;
      // Two questions a subscription, three seconds each: the snapshot is six seconds late.
      await until(
        () => tabs.every((tab) => snapshotsOf(tab.frames) === 1),
        'three snapshots',
        12_000,
      );
      await until(() => lapsed.ended.code !== undefined, 'the lapsed socket to close', 12_000);
      for (const tab of tabs) await roundTrip(tab.socket);

      // Served once each, on the socket they opened: nothing was closed, so nothing reconnects.
      assert.deepEqual(
        tabs.map((tab) => tab.ended),
        [{}, {}, {}],
        'a signed-in socket was closed',
      );
      assert.deepEqual(
        tabs.map((tab) => snapshotsOf(tab.frames)),
        [1, 1, 1],
      );
      assert.equal(snapshots.mock.callCount(), 3, 'a snapshot was read for nobody, or twice');
      assert.equal(stream.stats.unsure, before.unsure, 'a slow check closed a socket to reconnect');
      // And the one whose session had ended was told so by its own frame, having been sent
      // nothing and having cost no snapshot.
      assert.equal(lapsed.ended.code, STREAM_SIGNED_OUT);
      assert.deepEqual(
        lapsed.frames.filter((frame) => frame['type'] !== 'hello'),
        [],
        'something was sent to a signed-out socket',
      );
      assert.equal(signedOut('ended'), signedOutBefore + 1);
    });

    it('sends no snapshot and no `watching` to a socket it could not vouch for, and closes it the same way', async (t: TestContext) => {
      // The frame's own check answers; the one before the answer goes cannot be made.
      const ask = sessions.lapsed.bind(sessions);
      let calls = 0;
      t.mock.method(sessions, 'lapsed', (...args: Parameters<SessionService['lapsed']>) => {
        calls += 1;
        return calls === 1 ? ask(...args) : Promise.reject(new Error('the database went away'));
      });
      for (const subscribe of [{}, { probeId }]) {
        const what = JSON.stringify(subscribe);
        calls = 0;
        const socket = await app.injectWS('/api/v1/stream', { headers: as('bystander') });
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
        socket.send(JSON.stringify({ subscribe }));

        assert.deepEqual(await closedWith(closed), UNSURE, what);
        assert.equal(calls, 2, `${what}: the answer was not asked about`);
        assert.deepEqual(
          types.filter((type) => type !== 'hello'),
          [],
          `${what}: something was sent to a socket nobody could vouch for`,
        );
      }
    });

    it('asks nothing for a frame still waiting when its socket was severed', async (t: TestContext) => {
      const watcher = await watching(as('watcher'));
      // **Nothing here waits on the database or on the socket once the gate opens**, which is
      // what makes the count mean something. The first frame's question is held at a gate and
      // answers from memory; severing the socket opens the gate; and from there the queue
      // drains in promise turns alone, before any I/O can run — so before the close handshake
      // can finish and release the socket. Were the first answer a real query, the socket
      // could be released by the time the queue moved on, and a frame that asked would find it
      // gone and ask nothing: the count would be 1 with or without the guard.
      let open = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let asked = 0;
      t.mock.method(sessions, 'lapsed', async () => {
        asked += 1;
        await gate;
        return new Map<string, Lapse>();
      });
      // Whether the socket had been released when the queue had drained.
      let releases = 0;
      const admit = stream.admit.bind(stream);
      t.mock.method(stream, 'admit', (...args: Parameters<StateBroadcaster['admit']>) => {
        const admission = admit(...args);
        return {
          confirm: () => admission.confirm(),
          release: () => {
            releases += 1;
            admission.release();
          },
        };
      });
      const late = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      sockets.push(late);
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        late.on('close', (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString('utf8') });
        });
      });
      const drained: { releases?: number; asked?: number } = {};
      const count = stream.severed.bind(stream);
      t.mock.method(stream, 'severed', () => {
        count();
        open();
        // A thousand promise turns: more than the queue needs, and not one of them I/O.
        void (async () => {
          for (let turn = 0; turn < 1_000; turn += 1) await Promise.resolve();
          drained.releases = releases;
          drained.asked = asked;
        })();
      });
      try {
        // As many as may wait: the first is being asked about, the rest are queued behind it.
        for (let n = 0; n < STREAM_LIMITS.unread; n += 1) late.send('5');
        await roundTrip(late);
        assert.equal(asked, 1);
        // One more severs the socket, which lets the first question go.
        late.send('5');
        assert.equal((await closedWith(closed)).code, 1008);
        assert.equal(drained.releases, 0, 'the socket was released before the queue drained');
        assert.equal(
          drained.asked,
          1,
          'a frame behind the check asked about a socket already severed',
        );
        assert.equal(asked, 1);
      } finally {
        open();
      }
      assert.deepEqual(watcher.ended, {});
    });
  });

  describe('a watch that has not been judged yet (U-26)', () => {
    /** `db`, counting what is asked of it. */
    const counting = (): { q: StreamPool; asked: () => number } => {
      let asked = 0;
      return {
        asked: () => asked,
        q: {
          query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
            asked += 1;
            return db.query<T>(text, values);
          },
          tx: db.tx.bind(db),
        },
      };
    };

    /** Holds `canWatchProbe` until `release`, and then answers `visible` or as the core would. */
    const judging = (t: TestContext, visible: boolean | 'ask') => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached = false;
      const real = stream.canWatchProbe.bind(stream);
      t.mock.method(
        stream,
        'canWatchProbe',
        async (...args: Parameters<StateBroadcaster['canWatchProbe']>) => {
          reached = true;
          await gate;
          return visible === 'ask' ? real(...args) : { visible, epoch: null };
        },
      );
      return {
        release: (): void => {
          release();
        },
        reached: (): boolean => reached,
      };
    };

    it('costs an edge no read while it is being refused, and is told nothing', async (t: TestContext) => {
      await until(() => stream.stats.subscribers === 0, 'the earlier cases’ sockets to go');
      const held = judging(t, false);
      const socket = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      sockets.push(socket);
      const frames: Record<string, unknown>[] = [];
      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
      });
      try {
        socket.send(JSON.stringify({ subscribe: { probeId } }));
        await until(held.reached, 'the watch to be judged');
        // Attached, and judged by nobody: three edges in the window read nothing for it.
        assert.equal(stream.stats.subscribers, 1);
        const counted = counting();
        for (let edge = 0; edge < 3; edge += 1) {
          assert.equal(await stream.publishProbe(counted.q, probeId), 0);
        }
        assert.equal(counted.asked(), 0, 'a watch being refused bought a read at an edge');
      } finally {
        held.release();
      }
      await until(() => frames.some((frame) => frame['type'] === 'problem'), 'the refusal');
      await roundTrip(socket);
      assert.deepEqual(
        frames.map((frame) => frame['type']).filter((type) => type !== 'hello'),
        ['problem'],
      );
      assert.equal(stream.stats.subscribers, 0);
    });

    it('hears a change that fell while it was judged, after `watching` and once', async (t: TestContext) => {
      await until(() => stream.stats.subscribers === 0, 'the earlier cases’ sockets to go');
      const held = judging(t, 'ask');
      const socket = await app.injectWS('/api/v1/stream', { headers: as('watcher') });
      sockets.push(socket);
      const frames: Record<string, unknown>[] = [];
      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
      });
      const counted = counting();
      try {
        socket.send(JSON.stringify({ subscribe: { probeId } }));
        await until(held.reached, 'the watch to be judged');
        await stream.publishProbe(counted.q, probeId);
        await stream.publishProbe(counted.q, probeId);
        assert.equal(counted.asked(), 0);
      } finally {
        held.release();
      }
      await until(() => probes(frames) === 1, 'the change held for it');
      await roundTrip(socket);
      assert.deepEqual(
        frames.map((frame) => frame['type']).filter((type) => type !== 'hello'),
        ['watching', 'probe'],
        'the change was lost, repeated, or sent before the watch was answered',
      );
      // And from there an edge is read for it, and told.
      await stream.publishProbe(counted.q, probeId);
      await until(() => probes(frames) === 2, 'the next change');
      assert.equal(counted.asked(), 1);
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
function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  return pollWithin(ms, what, condition, 10);
}
