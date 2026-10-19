import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { getDefaultResultOrder } from 'node:dns';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, type TestContext } from 'node:test';
import { pino, type Logger } from 'pino';
import {
  helperEnv,
  helperSelf,
  HELPER_ISOLATION_MAX_MS,
  HELPER_LOST,
  HELPER_THREADS,
  HELPER_RSS_MAX,
  HelperLookupError,
  HelperLostError,
  LookupHelper,
  mayRequeue,
  REAL_TIMERS,
  type HelperAnswer,
  type HelperChange,
  type HelperForkOptions,
  type HelperLimits,
  type HelperProcess,
  type HelperSelf,
  type HelperSnapshot,
  type HelperTimer,
  type HelperTimers,
  type LateOutcome,
  type LookupHelperOptions,
  type LossReason,
} from '../src/resolver/lookup-helper.js';
import {
  digestOf as childDigestOf,
  digestOfError as childDigestOfError,
  glibcRuntime,
  readOnceDigest,
  type AskMessage,
} from '../src/resolver/lookup-helper-child.js';
import * as systemNames from '../src/resolver/system-names.js';
import { pollWithin, within } from './support/within.js';

/**
 * The lookup helper (`P-432`, S2), against real child processes running the production child's
 * code with scripted lookups (`support/scripted-helper-child.ts`), and against a scripted fake
 * process where an exact interleaving is the point.
 *
 * **Nothing here races the wall clock.** A verdict the helper takes on a timer is driven by a timer
 * the test fires (`Timers`), or by a real interval whose lateness is the point (U5, U7, U8), with
 * the precondition that makes the case mean something asserted first: a marker file the child
 * writes synchronously as it sends, read while the parent is blocked. Every wait on the far end of
 * a process is bounded (`within`, `pollWithin`), and the bounds only matter on a failure.
 */

const CHILD = join(import.meta.dirname, 'support', 'scripted-helper-child.js');
const PARENT = join(import.meta.dirname, 'support', 'helper-parent.js');
const WAIT = 30_000;
const onLinux = process.platform === 'linux';
const dir = mkdtempSync(join(tmpdir(), 'ms-lookup-helper-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});
let files = 0;
/** A fresh path in the test's directory. */
const path = (name: string): string => {
  files += 1;
  return join(dir, `${String(files)}-${name}`);
};

/** Three `setImmediate` hops: past an `afterPolls` scheduled before it. */
async function polls(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The parent's main thread held until `met`, as a stall holds it. Throws past `ms`. */
function blockUntil(ms: number, what: string, met: () => boolean): void {
  const started = Date.now();
  while (!met()) {
    if (Date.now() - started > ms)
      throw new Error(`blocked ${String(ms)} ms and ${what} never came`);
  }
}

function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // The parent is stalled, as P-243's 15 s stall stalled it.
  }
}

/** A process's state letter from /proc, or undefined once it is gone. */
function procState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  } catch {
    return undefined;
  }
}

/**
 * A process that has exited, every thread of it: its group leader a zombie and no other thread
 * left. Only then are its files closed, since its threads share them; the leader reads `Z` while
 * the rest are still exiting.
 */
function goneButUnreaped(pid: number): boolean {
  if (procState(pid) !== 'Z') return false;
  try {
    return readdirSync(`/proc/${String(pid)}/task`).length === 1;
  } catch {
    return false;
  }
}

const dead = (pid: number): boolean => {
  const state = procState(pid);
  return state === undefined || state === 'Z' || state === 'X';
};

function mkfifo(name: string): string {
  const fifo = path(name);
  const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0, `mkfifo ${fifo}: ${String(made.stderr)}`);
  return fifo;
}

interface Timer {
  readonly fn: () => void;
  readonly ms: number;
  readonly interval: boolean;
}

/**
 * The helper's clock and timers, each either the process's or the test's: a fake clock the test
 * moves, timeouts the test fires, and an interval (the liveness tick) the test ticks.
 */
class Timers implements HelperTimers {
  clock = 0;
  readonly pending = new Set<Timer>();
  readonly asked: number[] = [];
  /** Called after each real tick has been judged: three hops, past the helper's two. */
  sampler: (() => void) | undefined;
  /** Real ticks fired, and how many of them the sampler has been called for. */
  fired = 0;
  sampled = 0;

  constructor(
    readonly shape: {
      readonly clock: 'real' | 'fake';
      readonly timeouts: 'real' | 'fake';
      readonly ticks: 'real' | 'fake';
    },
  ) {}

  now(): number {
    return this.shape.clock === 'real' ? REAL_TIMERS.now() : this.clock;
  }

  setTimeout(fn: () => void, ms: number, keepAlive?: boolean): HelperTimer {
    this.asked.push(ms);
    if (this.shape.timeouts === 'real') return REAL_TIMERS.setTimeout(fn, ms, keepAlive);
    const timer: Timer = { fn, ms, interval: false };
    this.pending.add(timer);
    return timer;
  }

  clearTimeout(timer: HelperTimer | undefined): void {
    if (timer === undefined) return;
    if (this.pending.delete(timer as Timer)) return;
    REAL_TIMERS.clearTimeout(timer);
  }

  setInterval(fn: () => void, ms: number): HelperTimer {
    if (this.shape.ticks === 'real') {
      return REAL_TIMERS.setInterval(() => {
        this.fired += 1;
        fn();
        setImmediate(() =>
          setImmediate(() =>
            setImmediate(() => {
              this.sampled += 1;
              this.sampler?.();
            }),
          ),
        );
      }, ms);
    }
    const timer: Timer = { fn, ms, interval: true };
    this.pending.add(timer);
    return timer;
  }

  clearInterval(timer: HelperTimer | undefined): void {
    if (timer === undefined) return;
    if (this.pending.delete(timer as Timer)) return;
    REAL_TIMERS.clearInterval(timer);
  }

  /** Whether a timeout of `ms` is waiting. */
  has(ms: number): boolean {
    return [...this.pending].some((timer) => !timer.interval && timer.ms === ms);
  }

  /** Fires the waiting timeout of `ms`, which must be there. */
  fire(ms: number): void {
    const timer = [...this.pending].find((one) => !one.interval && one.ms === ms);
    assert.ok(timer !== undefined, `a timeout of ${String(ms)} ms is waiting`);
    this.pending.delete(timer);
    timer.fn();
  }

  /** One liveness tick: the interval's callback, as Node would call it. */
  tick(): void {
    const ticks = [...this.pending].filter((timer) => timer.interval);
    assert.ok(ticks.length > 0, 'the helper has a tick');
    for (const timer of ticks) timer.fn();
  }
}

/** Every bound short or out of the way: a test sets the one it is about. */
const QUICK: Partial<HelperLimits> = {
  beatMs: 25,
  tickMs: 100,
  startMs: 60_001,
  startWaitMs: 60_002,
  stuckMs: 60_000,
  lossSayMs: 7_100,
};

interface Made {
  readonly helper: LookupHelper;
  readonly timers: Timers;
  readonly changes: HelperChange[];
  /** The quiet ticks counted as each change was handed on. */
  readonly quietAt: number[];
  readonly lines: Record<string, unknown>[];
  readonly late: { readonly ref: object; readonly outcome: LateOutcome }[];
}

function logged(): { readonly logger: Logger; readonly lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
}

function make(
  options: {
    readonly env?: Record<string, string>;
    readonly limits?: Partial<HelperLimits>;
    readonly timers?: Timers;
    readonly fork?: LookupHelperOptions['fork'];
    readonly self?: HelperSelf;
    readonly signal?: AbortSignal;
    readonly execPath?: string;
    /** Every change and every late answer, in the order the resolver would see them. */
    readonly log?: string[];
  } = {},
): Made {
  const { logger, lines } = logged();
  const changes: HelperChange[] = [];
  const quietAt: number[] = [];
  const late: { ref: object; outcome: LateOutcome }[] = [];
  const timers = options.timers ?? new Timers({ clock: 'real', timeouts: 'real', ticks: 'fake' });
  const helper = new LookupHelper({
    logger,
    childModule: CHILD,
    env: { ...process.env, ...options.env },
    timers,
    limits: { ...QUICK, ...options.limits },
    onChange: (change) => {
      changes.push(change);
      quietAt.push(helper.stats().quietTicks);
      options.log?.push(`change:${change.state}:${change.route}`);
    },
    onLateAnswer: (ref, outcome) => {
      late.push({ ref, outcome });
      options.log?.push('late');
    },
    ...(options.fork === undefined ? {} : { fork: options.fork }),
    ...(options.self === undefined ? {} : { self: options.self }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
  });
  return { helper, timers, changes, quietAt, lines, late };
}

async function up(made: Made, what = 'the helper up'): Promise<void> {
  await pollWithin(WAIT, what, () => made.helper.state === 'up');
}

/** The helper's ask, settled into what it was: never a rejection the test forgets. */
function settled(
  promise: Promise<HelperAnswer>,
): Promise<{ readonly answer?: HelperAnswer; readonly error?: unknown }> {
  return promise.then(
    (answer) => ({ answer }),
    (error: unknown) => ({ error }),
  );
}

function lostError(error: unknown): HelperLostError {
  assert.ok(error instanceof HelperLostError, `a HelperLostError, not ${String(error)}`);
  assert.equal(error.code, HELPER_LOST);
  return error;
}

async function lossOf(made: Made, count = 1): Promise<void> {
  await pollWithin(WAIT, `${String(count)} losses`, () => made.helper.stats().losses >= count);
}

/** The last loss once its child's exit status and stderr are in: every loss's line said. */
async function lossSaid(
  made: Made,
): Promise<NonNullable<ReturnType<LookupHelper['stats']>['lastLoss']>> {
  await pollWithin(
    WAIT,
    'every loss said',
    () =>
      made.lines.filter((line) => line['msg'] === 'the lookup helper was lost').length >=
      made.helper.stats().losses,
  );
  const loss = made.helper.stats().lastLoss;
  assert.ok(loss !== undefined);
  return loss;
}

/** The loss numbered `count` taken, its backoff fired, and the next child up. */
async function nextChild(made: Made, count: number): Promise<void> {
  await lossOf(made, count);
  await polls();
  made.timers.fire(made.changes.at(-1)?.delayMs ?? -1);
  await up(made);
}

/**
 * Two crashes, each with a lookup to ask again: isolating (D27). Needs fake timeouts and a helper
 * up with no loss yet.
 */
async function isolate(made: Made): Promise<void> {
  for (let count = 1; count <= 2; count += 1) {
    const requeued = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64 }));
    await within(
      WAIT,
      `crash ${String(count)}`,
      settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 })),
    );
    await within(WAIT, `requeued ${String(count)}`, requeued);
    await nextChild(made, count);
  }
  assert.equal(made.helper.isolating(), true);
}

function signal(made: Made, name: NodeJS.Signals): void {
  const pid = made.helper.pid();
  assert.ok(pid !== undefined, 'the helper has a child');
  process.kill(pid, name);
}

async function stop(made: Made): Promise<void> {
  await within(WAIT, 'the helper stopped', made.helper.stop());
}

/** One fake tick, judged. */
async function tick(made: Made): Promise<void> {
  made.timers.tick();
  await polls();
}

/** Fake ticks until `met`, at most `most` of them. */
async function tickUntil(
  made: Made,
  most: number,
  what: string,
  met: () => boolean,
): Promise<void> {
  for (let i = 0; i < most && !met(); i += 1) await tick(made);
  assert.ok(met(), `${what} within ${String(most)} ticks`);
}

/** A muted child lets one beat through on SIGUSR1: sent, and read, before the next tick. */
async function oneBeat(made: Made): Promise<void> {
  const read = made.helper.stats().messages;
  signal(made, 'SIGUSR1');
  await pollWithin(WAIT, 'one beat read', () => made.helper.stats().messages > read);
}

const MISMATCH =
  'the lookup helper and the probe disagree on its lookups in flight, three beats in a row';

describe('the lookup helper’s child environment', () => {
  it('U1 (part): drops systemd’s, the probe’s and every Node variable, and sets 32 threads', () => {
    const env = helperEnv({
      PATH: '/usr/bin',
      LOCALDOMAIN: 'example.test',
      RES_OPTIONS: 'ndots:2',
      NOTIFY_SOCKET: '/run/systemd/notify',
      WATCHDOG_USEC: '1000',
      WATCHDOG_PID: '1',
      MS_PROBE_CONFIG: '/etc/ms/probe.json',
      NODE_OPTIONS: '--require /nonexistent',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      UV_THREADPOOL_SIZE: '16',
    });
    assert.deepEqual(env, {
      PATH: '/usr/bin',
      LOCALDOMAIN: 'example.test',
      RES_OPTIONS: 'ndots:2',
      UV_THREADPOOL_SIZE: String(HELPER_THREADS),
    });
  });

  it('keeps what changes what glibc resolves to: the child resolves as the probe’s lanes do (P-432 S3)', () => {
    // Decided 2026-10-19 by Claude, under the user's delegation: the child inherits the dynamic
    // linker's and the resolver's settings as they are, and never resolves otherwise than the
    // probe would. When LD_PRELOAD or LD_AUDIT is set, the name policy turns the check off.
    const base = {
      LD_PRELOAD: '/usr/lib/libshim.so',
      LD_AUDIT: '/usr/lib/libaudit-shim.so',
      LD_LIBRARY_PATH: '/opt/lib',
      LOCALDOMAIN: 'example.test',
      RES_OPTIONS: 'ndots:2',
      HOSTALIASES: '/etc/host.aliases',
    };
    assert.deepEqual(helperEnv(base), { ...base, UV_THREADPOOL_SIZE: String(HELPER_THREADS) });
  });

  it('U1 (part): on Windows a name in any case is the same name, and is dropped all the same', () => {
    const base = {
      Path: 'C:\\Windows',
      Node_Options: '--require C:\\probe-diag.js',
      node_options: '--inspect',
      Ms_Config_File: 'C:\\ms\\probe.json',
      Notify_Socket: '/run/systemd/notify',
      Uv_Threadpool_Size: '4',
    };
    assert.deepEqual(helperEnv(base, 'win32'), {
      Path: 'C:\\Windows',
      UV_THREADPOOL_SIZE: String(HELPER_THREADS),
    });
    // Elsewhere names are what they say: Node reads `NODE_OPTIONS`, never `Node_Options`.
    assert.deepEqual(helperEnv(base, 'linux'), {
      ...base,
      UV_THREADPOOL_SIZE: String(HELPER_THREADS),
    });
  });
});

describe('the lookup helper: ready', () => {
  it('U1: comes up with 32 threads and the probe’s order, under a NODE_OPTIONS that would stop it', async () => {
    const made = make({ env: { NODE_OPTIONS: '--require /nonexistent/preload.js' } });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      assert.equal(made.helper.state, 'up');
      assert.equal(made.helper.routeState(), 'up');
      const ready = made.lines.find((line) => line['msg'] === 'the lookup helper is ready');
      assert.ok(ready !== undefined);
      assert.equal(ready['threads'], 32);
      assert.equal(ready['order'], getDefaultResultOrder());
      assert.equal(made.helper.stats().losses, 0);
      // And it answers.
      const answer = await within(
        WAIT,
        'an answer',
        made.helper.ask({ host: 'delay-0.ok.test', family: 4, max: 64 }),
      );
      assert.deepEqual(answer.addresses, [{ address: '192.0.2.1', family: 4 }]);
    } finally {
      await stop(made);
    }
  });

  it('U1: a ready giving another address order is a start loss', async () => {
    const order = getDefaultResultOrder() === 'verbatim' ? 'ipv4first' : 'verbatim';
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ env: { SCRIPT_READY_ORDER: order }, timers });
    try {
      void made.helper.start();
      await lossOf(made);
      const loss = made.helper.stats().lastLoss;
      assert.equal(loss?.reason, 'start');
      assert.match(loss.why, /address order/u);
      assert.equal(made.helper.state, 'backoff');
    } finally {
      await stop(made);
    }
  });

  for (const [name, env, said] of [
    ['too few threads', { SCRIPT_READY_THREADS: '8' }, /8 libuv threads/u],
    ['a failed self-test', { SCRIPT_SELFTEST: 'fail' }, /did not answer 127\.1/u],
  ] as const) {
    it(`U1: a ready with ${name} is a start loss`, async () => {
      const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
      const made = make({ env, timers });
      try {
        void made.helper.start();
        await lossOf(made);
        assert.equal(made.helper.stats().lastLoss?.reason, 'start');
        assert.match(made.helper.stats().lastLoss?.why ?? '', said);
      } finally {
        await stop(made);
      }
    });
  }
});

describe('the lookup helper: answers', () => {
  it('U2: codes and words as getaddrinfo gave them, and 70 addresses as 65 with their total', async () => {
    const made = make();
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      for (const [host, code] of [
        ['enotfound.test', 'ENOTFOUND'],
        ['eai-again-0.test', 'EAI_AGAIN'],
        ['enodata.test', 'ENODATA'],
      ] as const) {
        const { error } = await within(
          WAIT,
          host,
          settled(made.helper.ask({ host, family: 4, max: 64 })),
        );
        assert.ok(error instanceof HelperLookupError, `${host}: ${String(error)}`);
        assert.equal(error.code, code);
        assert.equal(error.message, `getaddrinfo ${code} ${host}`);
        assert.ok(error.ranMs >= 0);
      }
      const { error } = await within(
        WAIT,
        'nocode',
        settled(made.helper.ask({ host: 'nocode.test', family: 0, max: 64 })),
      );
      assert.ok(error instanceof HelperLookupError);
      assert.equal(error.code, undefined);
      assert.equal(error.message, 'a failure that says no code');

      const many = await within(
        WAIT,
        '70',
        made.helper.ask({ host: 'addresses-70.test', family: 4, max: 64 }),
      );
      assert.equal(many.total, 70);
      assert.equal(many.addresses.length, 65);
      assert.deepEqual(many.addresses[0], { address: '198.51.100.1', family: 4 });
      assert.deepEqual(many.addresses[64], { address: '198.51.100.65', family: 4 });
    } finally {
      await stop(made);
    }
  });

  it(
    'U3: a lookup past the child’s bound: onStuck once, then the answer',
    { skip: !onLinux },
    async () => {
      const fifo = mkfifo('u3');
      const made = make({ limits: { stuckMs: 100 } });
      const events: string[] = [];
      try {
        assert.equal(await within(WAIT, 'start', made.helper.start()), true);
        const asked = made.helper
          .ask({ host: `fifo:${fifo}`, family: 4, max: 64, onStuck: () => events.push('stuck') })
          .then((answer) => {
            events.push('answer');
            return answer;
          });
        await pollWithin(WAIT, 'stuck', () => events.includes('stuck'));
        writeFileSync(fifo, 'go');
        const answer = await within(WAIT, 'the answer', asked);
        assert.deepEqual(answer.addresses, [{ address: '192.0.2.1', family: 4 }]);
        assert.ok(answer.ranMs >= 100);
        await polls();
        assert.deepEqual(events, ['stuck', 'answer']);
      } finally {
        await stop(made);
      }
    },
  );

  it('U4: the parent blocked 3 s while a 1,500 ms lookup answers: answered, never stuck', async () => {
    const answered = path('u4-answered');
    const made = make({ env: { SCRIPT_ANSWER_MARK: answered }, limits: { stuckMs: 2_000 } });
    let stuck = 0;
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      const asked = made.helper.ask({
        host: 'delay-1500.ok.test',
        family: 4,
        max: 64,
        onStuck: () => {
          stuck += 1;
        },
      });
      // Blocked past the bound for stuck, with the answer already sent: what a parent-side timer
      // for stuck would misjudge.
      const started = Date.now();
      blockUntil(WAIT, 'the child’s answer', () => existsSync(answered));
      blockFor(Math.max(0, 3_000 - (Date.now() - started)));
      const answer = await within(WAIT, 'the answer', asked);
      assert.deepEqual(answer.addresses, [{ address: '192.0.2.1', family: 4 }]);
      await polls();
      assert.equal(stuck, 0);
    } finally {
      await stop(made);
    }
  });

  it(
    'U4b: the child blocked past its bound while a lookup completes: answered, never stuck',
    { skip: !onLinux },
    async () => {
      const fifo = mkfifo('u4b');
      const blocked = path('u4b-blocked');
      const made = make({ limits: { stuckMs: 300 } });
      let stuck = 0;
      try {
        assert.equal(await within(WAIT, 'start', made.helper.start()), true);
        const asked = made.helper.ask({
          host: `fifo-open:${fifo}`,
          family: 4,
          max: 64,
          onStuck: () => {
            stuck += 1;
          },
        });
        const block = settled(
          made.helper.ask({ host: `block-3000:${blocked}`, family: 4, max: 64 }),
        );
        await pollWithin(WAIT, 'the child blocked', () => existsSync(blocked));
        // Completed while the child's main thread is held: the completion waits in its poll queue
        // while its timer for stuck comes due.
        writeFileSync(fifo, '');
        assert.equal(
          existsSync(`${blocked}.done`),
          false,
          'the lookup completed while the child was blocked',
        );
        const answer = await within(WAIT, 'the answer', asked);
        assert.deepEqual(answer.addresses, [{ address: '192.0.2.1', family: 4 }]);
        await within(WAIT, 'the block', block);
        await polls();
        assert.equal(stuck, 0);
      } finally {
        await stop(made);
      }
    },
  );
});

describe('the lookup helper: liveness', () => {
  it('U5: the parent blocked 5 s while the child beats: no loss', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'real', ticks: 'real' });
    const made = make({ timers, limits: { tickMs: 100, hungTicks: 20, beatMs: 25 } });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      blockFor(5_000);
      const ticks = made.helper.stats().ticks;
      await pollWithin(WAIT, 'three more ticks', () => made.helper.stats().ticks >= ticks + 3);
      assert.equal(made.helper.stats().losses, 0);
    } finally {
      await stop(made);
    }
  });

  it('U6: 19 quiet ticks, then a beat sent while the parent is blocked: read before the 20th is judged', async () => {
    const beat = path('u6-beat');
    const made = make({
      env: { SCRIPT_BEAT_MARK: beat },
      limits: { hungTicks: 20, unresponsiveTicks: 3 },
    });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await within(WAIT, 'muted', made.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      // The first tick hears what came before the mute.
      made.timers.tick();
      await polls();
      assert.equal(made.helper.stats().quietTicks, 0);
      for (let i = 0; i < 19; i += 1) {
        made.timers.tick();
        await polls();
      }
      assert.equal(made.helper.stats().quietTicks, 19);
      assert.equal(made.helper.state, 'unresponsive');
      signal(made, 'SIGUSR2');
      // The precondition: the beat is in the pipe before the 20th tick fires.
      blockUntil(WAIT, 'a beat after the unmute', () => existsSync(beat));
      made.timers.tick();
      await polls();
      assert.equal(made.helper.stats().losses, 0);
      // Heard, not yet back: the quiet ticks since it last answered still stand.
      assert.equal(made.helper.stats().heardTicks, 1);
      assert.equal(made.helper.stats().quietTicks, 19);
      assert.equal(made.helper.state, 'unresponsive');
      const read = made.helper.stats().messages;
      await pollWithin(WAIT, 'another beat', () => made.helper.stats().messages > read);
      made.timers.tick();
      await polls();
      assert.equal(made.helper.state, 'up');
      assert.equal(made.helper.stats().quietTicks, 0);
    } finally {
      await stop(made);
    }
  });

  it('U7: muted, the parent blocked 3 s (30 intervals), then unmuted: no loss', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'real', ticks: 'real' });
    const made = make({ timers, limits: { tickMs: 100, hungTicks: 20, beatMs: 25 } });
    const samples: number[] = [];
    timers.sampler = () => samples.push(made.helper.stats().quietTicks);
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await within(WAIT, 'muted', made.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      // The precondition, from the sampler itself: two ticks judged since the mute's answer was
      // read (the first hears it, the second is quiet), and every tick fired so far judged and
      // sampled, so no sample of a tick before the block is still to come (R2-2). Read and blocked
      // in the same turn: nothing runs between them.
      const ticked = made.helper.stats().ticks;
      await pollWithin(
        WAIT,
        'two ticks judged and sampled since the answer',
        () => made.helper.stats().ticks >= ticked + 2 && timers.sampled === timers.fired,
      );
      const before = made.helper.stats().quietTicks;
      assert.ok(before >= 1, 'a quiet tick was judged before the block');
      assert.equal(samples.at(-1), before, 'the last sample is the count now');
      const sampled = samples.length;
      blockFor(3_000);
      await pollWithin(WAIT, 'a tick judged after the block', () => samples.length > sampled);
      assert.equal(samples[sampled], before + 1, 'the late tick counted once, as one quiet tick');
      assert.equal(made.helper.stats().losses, 0);
      signal(made, 'SIGUSR2');
      await up(made, 'up again after the unmute');
      assert.equal(made.helper.stats().losses, 0);
    } finally {
      await stop(made);
    }
  });

  it('U8: muted for good: unresponsive at 3, detached, hung at 20, a new child at once', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'real', ticks: 'real' });
    const made = make({ timers, limits: { tickMs: 100, hungTicks: 20, unresponsiveTicks: 3 } });
    const ref = {};
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      const first = made.helper.pid();
      const held = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64, ref }));
      await within(WAIT, 'muted', made.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      const { error } = await within(WAIT, 'the hung loss', held);
      const lost = lostError(error);
      assert.equal(lost.reason, 'hung');
      assert.equal(lost.detached, true);
      assert.equal(lost.requeue, false);
      assert.equal(lost.stuck, false);
      await up(made, 'a new child up');
      assert.notEqual(made.helper.pid(), first);
      assert.equal(made.helper.stats().losses, 1);
      assert.equal(made.helper.stats().lossesByReason.hung, 1);
      assert.match(
        made.helper.stats().lastLoss?.why ?? '',
        /^it was quiet for 20 ticks of 100 ms since it last answered, and heard on 0 ticks/u,
      );
      const states = made.changes.map((change) => change.state);
      const unresponsive = states.indexOf('unresponsive');
      const backoff = states.indexOf('backoff');
      assert.ok(unresponsive >= 0 && backoff > unresponsive, states.join(' '));
      assert.equal(made.quietAt[unresponsive], 3);
      assert.equal(made.quietAt[backoff], 20);
      const detaching = made.changes[unresponsive];
      assert.ok(detaching?.detached?.includes(ref), 'the lookup in flight was detached');
      assert.equal(detaching?.route, 'down');
      assert.equal(made.changes[backoff]?.loss, 'hung');
      assert.equal(made.changes[backoff].delayMs, 0);
      // The child never writes stderr on its normal path.
      assert.equal((await lossSaid(made)).stderr, '');
    } finally {
      await stop(made);
    }
  });

  it('U8 (part): only an exit or a memory loss of a lookup neither stuck, detached nor charged is asked again', () => {
    const reasons: readonly LossReason[] = ['start', 'skew', 'exit', 'hung', 'memory'];
    for (const reason of reasons) {
      for (const stuck of [false, true]) {
        for (const detached of [false, true]) {
          for (const charged of [false, true]) {
            for (const ends of [false, true]) {
              // A crash that rests the helper or comes while the probe stops: nowhere to ask it.
              const expected =
                (reason === 'memory' || (reason === 'exit' && !ends)) &&
                !stuck &&
                !detached &&
                !charged;
              assert.equal(
                mayRequeue(reason, { stuck, detached, charged }, ends),
                expected,
                `${reason} stuck=${String(stuck)} detached=${String(detached)} charged=${String(charged)} ends=${String(ends)}`,
              );
            }
          }
        }
      }
    }
  });

  it('U19: muted 4 ticks, one heard tick, muted again: stays unresponsive; two heard ticks give up', async () => {
    const made = make({ limits: { unresponsiveTicks: 3, rejoinTicks: 2 } });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await within(WAIT, 'muted', made.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      for (let i = 0; i < 4; i += 1) await tick(made);
      assert.equal(made.helper.state, 'unresponsive');
      // Quiet: routed elsewhere, and nothing is sent to it.
      assert.equal(made.helper.routeState(), 'down');
      const said = made.changes.length;
      const refused = lostError(
        (
          await within(
            WAIT,
            'an ask refused at once',
            settled(made.helper.ask({ host: 'delay-0.ok.test', family: 4, max: 64 })),
          )
        ).error,
      );
      // Told apart from a loss by its reason: never sent, so kept and routed again, not faulted.
      assert.equal(refused.reason, 'unavailable');
      assert.equal(refused.started, false);
      assert.equal(refused.requeue, false);
      assert.equal(made.helper.stats().losses, 0);
      await polls();
      assert.equal(made.changes.length, said, 'a refusal is no change');
      await oneBeat(made);
      await tick(made);
      assert.equal(made.helper.stats().heardTicks, 1);
      assert.equal(made.helper.state, 'unresponsive');
      await tick(made);
      await tick(made);
      assert.equal(made.helper.stats().heardTicks, 0);
      assert.equal(made.helper.state, 'unresponsive');
      await oneBeat(made);
      await tick(made);
      assert.equal(made.helper.state, 'unresponsive');
      await oneBeat(made);
      await tick(made);
      assert.equal(made.helper.state, 'up');
      assert.equal(made.helper.routeState(), 'up');
      assert.equal(made.changes.at(-1)?.route, 'up');
      const ups = made.changes.filter((change) => change.state === 'up');
      assert.equal(ups.length, 2, 'up at the start, and once after two heard ticks in a row');
      assert.equal(made.helper.stats().losses, 0);
    } finally {
      await stop(made);
    }
  });
});

describe('the lookup helper: losses', () => {
  it('U9: a crash is an exit loss with its signal and stderr; a stuck lookup is held, the other requeued', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers, limits: { stuckMs: 100 } });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      let stuckSaid = false;
      const hung = settled(
        made.helper.ask({
          host: 'hang.test',
          family: 4,
          max: 64,
          onStuck: () => (stuckSaid = true),
        }),
      );
      await pollWithin(WAIT, 'hang.test stuck', () => stuckSaid);
      const crashed = settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 }));
      const held = lostError((await within(WAIT, 'hang.test lost', hung)).error);
      const lost = lostError((await within(WAIT, 'crash.test lost', crashed)).error);
      assert.equal(held.reason, 'exit');
      assert.equal(held.stuck, true);
      assert.equal(held.requeue, false);
      assert.equal(lost.reason, 'exit');
      assert.equal(lost.stuck, false);
      assert.equal(lost.requeue, true);
      assert.equal(lost.charged, false);
      assert.equal(lost.started, true);
      const loss = await lossSaid(made);
      assert.equal(loss.reason, 'exit');
      assert.equal(loss.signal, 'SIGABRT');
      assert.match(loss.stderr, /scripted crash: crash\.test/u);
      assert.equal(loss.held, 1);
      assert.equal(loss.requeued, 1);
      assert.equal(made.helper.state, 'backoff');
    } finally {
      await stop(made);
    }
  });

  it('U9b: an answer written as the child aborts settles its lookup once', async (t: TestContext) => {
    const timers = new Timers({ clock: 'real', timeouts: 'real', ticks: 'fake' });
    const made = make({ timers });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      const ref = {};
      let settles = 0;
      let requeued = false;
      const outcome = await within(
        WAIT,
        'the ask',
        settled(made.helper.ask({ host: 'answer-then-abort.test', family: 4, max: 64, ref })),
      );
      if (outcome.answer !== undefined) settles += 1;
      else requeued = lostError(outcome.error).requeue;
      await lossOf(made);
      const loss = await lossSaid(made);
      await polls();
      for (const one of made.late) if (one.ref === ref) settles += 1;
      if (outcome.answer !== undefined) {
        // Which interleaving ran is said, not assumed: the FakeChild cases below pin the other.
        t.diagnostic('U9b ran answer-first: the answer was read before the exit');
        assert.equal(loss.requeued, 0);
        assert.equal(loss.held, 0);
        assert.equal(loss.faulted, 0);
      } else {
        t.diagnostic('U9b ran exit-first: the lookup was requeued, and its answer came late');
        assert.equal(requeued, true);
      }
      assert.equal(
        settles,
        1,
        `answered ${String(outcome.answer !== undefined)}, late ${String(made.late.length)}`,
      );
      assert.ok(made.late.length <= 1);
    } finally {
      await stop(made);
    }
  });

  it('U12: a beat past the memory ceiling is a memory loss, its lookups requeued', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers, env: { SCRIPT_RSS: String(300 * 1024 * 1024) } });
    try {
      void made.helper.start();
      await lossOf(made);
      assert.equal(made.helper.stats().lastLoss?.reason, 'memory');
      assert.equal(made.helper.stats().lossesByReason.memory, 1);
      assert.ok(made.helper.stats().rssPeak >= 300 * 1024 * 1024);
      assert.equal(made.helper.state, 'backoff');
      assert.equal((await lossSaid(made)).stderr, '');
    } finally {
      await stop(made);
    }
  });

  it('U12: a lookup in flight at a memory loss is requeued, and the loss is not an exit', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      const held = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64 }));
      await within(
        WAIT,
        'rss high',
        made.helper.ask({ host: 'test-rss-high', family: 4, max: 64 }),
      );
      const lost = lostError((await within(WAIT, 'the memory loss', held)).error);
      assert.equal(lost.reason, 'memory');
      assert.equal(lost.requeue, true);
      assert.equal(lost.suspect, false);
      assert.equal(made.helper.isolating(), false);
    } finally {
      await stop(made);
    }
  });

  it('U10: five losses wait 0, 250, 500 and 1,000 ms, then rest 10 minutes; a loss soon after the rest rests 20', async () => {
    const timers = new Timers({ clock: 'fake', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers, limits: { startWaitMs: 7_001, startMs: 7_002 } });
    const crash = async (count: number): Promise<HelperChange> => {
      await up(made);
      const lost = settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 }));
      await within(WAIT, 'the crash', lost);
      await lossOf(made, count);
      await polls();
      const change = made.changes.at(-1);
      assert.ok(change !== undefined);
      return change;
    };
    try {
      void made.helper.start();
      const waits: (number | undefined)[] = [];
      for (let count = 1; count <= 4; count += 1) {
        const change = await crash(count);
        assert.equal(change.state, 'backoff');
        waits.push(change.delayMs);
        timers.fire(change.delayMs ?? -1);
      }
      assert.deepEqual(waits, [0, 250, 500, 1_000]);
      const rest = await crash(5);
      assert.equal(rest.state, 'resting');
      assert.equal(rest.delayMs, 600_000);
      assert.equal(made.helper.routeState(), 'resting');
      timers.clock += 600_000;
      timers.fire(600_000);
      timers.clock += 60_000;
      const again = await crash(6);
      assert.equal(again.state, 'resting');
      assert.equal(again.delayMs, 1_200_000);
    } finally {
      await stop(made);
    }
  });

  it('U11: no ready by the start bound is a start loss; a ready sent while the parent is blocked across it is kept', async () => {
    const never = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const silent = make({
      timers: never,
      env: { SCRIPT_READY: 'never' },
      limits: { startMs: 7_003 },
    });
    try {
      void silent.helper.start();
      await pollWithin(WAIT, 'a child', () => silent.helper.pid() !== undefined);
      never.fire(7_003);
      await lossOf(silent);
      assert.equal(silent.helper.stats().lastLoss?.reason, 'start');
      assert.match(silent.helper.stats().lastLoss?.why ?? '', /ready after 7003 ms/u);
    } finally {
      await stop(silent);
    }

    const listening = path('u11-listening');
    const readied = path('u11-ready');
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({
      timers,
      env: { SCRIPT_READY: 'on-signal', SCRIPT_LISTENING: listening, SCRIPT_READY_MARK: readied },
      limits: { startMs: 7_004 },
    });
    try {
      void made.helper.start();
      await pollWithin(WAIT, 'the child listening', () => existsSync(listening));
      signal(made, 'SIGUSR2');
      blockUntil(WAIT, 'the ready sent', () => existsSync(readied));
      // The bound fires with the ready unread in the pipe.
      timers.fire(7_004);
      await polls();
      await up(made);
      assert.equal(made.helper.stats().losses, 0);
    } finally {
      await stop(made);
    }
  });

  it('U11: the start gives up waiting after its bound, and the helper comes up behind it', async () => {
    const listening = path('u11b-listening');
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({
      timers,
      env: { SCRIPT_READY: 'on-signal', SCRIPT_LISTENING: listening },
      limits: { startWaitMs: 7_006, startMs: 7_007 },
    });
    try {
      const starting = made.helper.start();
      await pollWithin(WAIT, 'the child listening', () => existsSync(listening));
      timers.fire(7_006);
      assert.equal(await within(WAIT, 'the start to give up', starting), false);
      assert.equal(made.helper.state, 'starting');
      assert.equal(made.helper.routeState(), 'down');
      signal(made, 'SIGUSR2');
      await up(made);
      assert.equal(made.helper.stats().losses, 0);
    } finally {
      await stop(made);
    }
  });

  it('U23: after a loss the route is rejoining for its window, then down until a child is up', async () => {
    const timers = new Timers({ clock: 'fake', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers, limits: { rejoinMs: 7_008 } });
    try {
      void made.helper.start();
      await up(made);
      await within(
        WAIT,
        'the crash',
        settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 })),
      );
      await lossOf(made);
      await polls();
      assert.equal(made.helper.state, 'backoff');
      assert.equal(made.helper.routeState(), 'rejoining');
      assert.equal(made.changes.at(-1)?.route, 'rejoining');
      // The timer closes the window, whatever the clock says: a timer fires up to a millisecond
      // or two before its time.
      timers.clock += 7_008 - 0.5;
      timers.fire(7_008);
      await polls();
      assert.equal(made.helper.routeState(), 'down');
      const said = made.changes.at(-1);
      assert.equal(said?.route, 'down');
      assert.equal(said.state, 'backoff');
      timers.fire(0);
      await up(made);
      assert.equal(made.helper.routeState(), 'up');
      assert.equal(made.changes.at(-1)?.route, 'up');
    } finally {
      await stop(made);
    }
  });

  it('U24: the child and the probe disagreeing on what is in flight three beats running is an error, once', async () => {
    // Two lies, the truth; two lies, the truth; four truths; three lies, then the truth for good.
    const lies = '1101100000111';
    const made = make({ env: { SCRIPT_BEAT_INFLIGHT: '7', SCRIPT_BEAT_LIES: lies } });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await pollWithin(WAIT, 'the error', () =>
        made.lines.some((line) => line['msg'] === MISMATCH),
      );
      const beats = made.helper.stats().messages;
      await pollWithin(WAIT, 'more beats', () => made.helper.stats().messages > beats + 5);
      const said = made.lines.filter((line) => line['msg'] === MISMATCH);
      assert.equal(said.length, 1, 'one line, for the one run of three');
      const line = said[0];
      assert.ok(line !== undefined);
      assert.equal(line['seq'], lies.length, 'said at the third lie in a row');
      assert.equal(line['childInFlight'], 7);
      assert.equal(line['level'], 50);
    } finally {
      await stop(made);
    }
  });

  it('U24: asks still in the pipe when the child beats are no disagreement', async () => {
    const beat = path('u24-beat');
    const made = make({ env: { SCRIPT_BEAT_MARK: beat } });
    const held: Promise<unknown>[] = [];
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await within(WAIT, 'muted', made.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      for (let i = 0; i < 4; i += 1) {
        rmSync(beat, { force: true });
        const read = made.helper.stats().messages;
        signal(made, 'SIGUSR1');
        // The beat is written, and an ask goes out behind it before the probe reads it: the
        // child could not have counted that ask.
        blockUntil(WAIT, 'a beat written', () => existsSync(beat));
        held.push(settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64 })));
        await pollWithin(WAIT, 'the beat read', () => made.helper.stats().messages > read);
      }
      assert.equal(made.helper.stats().inFlight, 4);
      assert.deepEqual(
        made.lines.filter((line) => line['msg'] === MISMATCH),
        [],
      );
    } finally {
      await stop(made);
    }
    await within(WAIT, 'the held lookups', Promise.all(held));
  });

  it('U16: a child started for another protocol ends itself, a start loss; five rest the helper', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers, limits: { protocol: 2 } });
    try {
      void made.helper.start();
      for (let count = 1; count <= 4; count += 1) {
        await lossOf(made, count);
        await polls();
        const change = made.changes.at(-1);
        assert.equal(change?.state, 'backoff');
        assert.equal(change.loss, 'start');
        timers.fire(change.delayMs ?? -1);
      }
      await lossOf(made, 5);
      await polls();
      assert.equal(made.helper.state, 'resting');
      assert.equal(made.helper.stats().lossesByReason.start, 5);
      const loss = await lossSaid(made);
      assert.match(
        `${loss.fatal ?? ''} ${loss.stderr}`,
        /protocol 1, and the probe that started it speaks 2/u,
      );
    } finally {
      await stop(made);
    }
  });

  it('U17: a ready from another Node, another glibc or other read-once files rests until restart', async () => {
    const file = path('gai.conf');
    writeFileSync(file, 'precedence ::ffff:0:0/96 100\n');
    const snapshot: HelperSnapshot = { digests: { [file]: await readOnceDigest(file) } };
    const cases: readonly {
      readonly name: string;
      readonly env: Record<string, string>;
      readonly snapshot: HelperSnapshot;
    }[] = [
      { name: 'node', env: { SCRIPT_READY_NODE: 'v0.0.1' }, snapshot },
      { name: 'glibc', env: { SCRIPT_READY_GLIBC: '0.1' }, snapshot },
      { name: 'digests', env: {}, snapshot: { digests: { [file]: 'not-what-it-read' } } },
    ];
    for (const one of cases) {
      const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
      const made = make({ timers, env: one.env });
      try {
        assert.equal(
          await within(WAIT, `start (${one.name})`, made.helper.start(one.snapshot)),
          false,
        );
        assert.equal(made.helper.state, 'resting', one.name);
        assert.equal(made.helper.routeState(), 'resting');
        assert.equal(made.helper.stats().lastLoss?.reason, 'skew', one.name);
        assert.equal(made.helper.stats().restMs, undefined, 'until restart');
        assert.equal(timers.has(600_000), false, `${one.name}: no rest timer`);
      } finally {
        await stop(made);
      }
    }
    // The same files read the same: up.
    const made = make();
    try {
      assert.equal(await within(WAIT, 'start (same)', made.helper.start(snapshot)), true);
    } finally {
      await stop(made);
    }
  });

  it('U17: a read-once file changed under a running child: kept, and its next loss rests until restart', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      made.helper.markSkewed('/etc/gai.conf');
      assert.equal(made.helper.state, 'up');
      assert.ok(
        made.lines.some(
          (line) => line['msg'] === '/etc/gai.conf changed: restart ms-probe to apply it',
        ),
      );
      await within(
        WAIT,
        'the crash',
        settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 })),
      );
      await lossOf(made);
      assert.equal(made.helper.state, 'resting');
      assert.equal(made.helper.stats().restMs, undefined);
    } finally {
      await stop(made);
    }
  });

  it(
    'U18: an ask written after the child died raises nothing and is an exit loss',
    { skip: !onLinux },
    async () => {
      const uncaught: unknown[] = [];
      const record = (error: unknown): void => {
        uncaught.push(error);
      };
      process.on('uncaughtException', record);
      const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
      const made = make({ timers });
      try {
        assert.equal(await within(WAIT, 'start', made.helper.start()), true);
        const pid = made.helper.pid();
        assert.ok(pid !== undefined);
        process.kill(pid, 'SIGKILL');
        // Dead, its channel's end closed, and not yet reaped: the probe has not seen it go.
        blockUntil(WAIT, 'the child dead', () => goneButUnreaped(pid));
        assert.equal(made.helper.state, 'up');
        const asked = settled(made.helper.ask({ host: 'delay-0.ok.test', family: 4, max: 64 }));
        const lost = lostError((await within(WAIT, 'the ask lost', asked)).error);
        assert.equal(lost.reason, 'exit');
        assert.equal(lost.started, true);
        await lossOf(made);
        assert.equal(made.helper.stats().lastLoss?.reason, 'exit');
        // The send's own callback took the loss, before the probe read the exit: not an 'error'
        // event, and not the channel closing.
        assert.match(made.helper.stats().lastLoss?.why ?? '', /an ask could not be written/u);
        assert.ok(
          !made.lines.some(
            (line) => line['msg'] === 'the lookup helper’s process reported an error',
          ),
        );
        await polls();
        assert.deepEqual(uncaught, []);
      } finally {
        process.off('uncaughtException', record);
        await stop(made);
      }
    },
  );

  it('U18: a Node that cannot be started is a start loss, never an uncaught error', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers, execPath: join(dir, 'no-such-node') });
    try {
      void made.helper.start();
      await lossOf(made);
      assert.equal(made.helper.stats().lastLoss?.reason, 'start');
      assert.equal(made.helper.state, 'backoff');
    } finally {
      await stop(made);
    }
  });
});

describe('the lookup helper: isolation and poison', () => {
  it('U20: a memory loss is not counted for isolation; the second exit loss makes the requeued suspects', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers });
    const next = async (count: number): Promise<void> => {
      await lossOf(made, count);
      await polls();
      timers.fire(made.changes.at(-1)?.delayMs ?? -1);
      await up(made);
    };
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      // A memory loss…
      const first = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64 }));
      await within(
        WAIT,
        'rss high',
        made.helper.ask({ host: 'test-rss-high', family: 4, max: 64 }),
      );
      assert.equal(lostError((await within(WAIT, 'memory', first)).error).suspect, false);
      await next(1);
      // …then an exit loss: one exit, no isolation.
      const second = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64 }));
      await within(
        WAIT,
        'crash 1',
        settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 })),
      );
      const once = lostError((await within(WAIT, 'exit 1', second)).error);
      assert.equal(once.requeue, true);
      assert.equal(once.suspect, false);
      assert.equal(made.helper.isolating(), false);
      await next(2);
      // The second exit loss: isolating, and what is requeued is a suspect, charged with nothing.
      const third = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64 }));
      const crash = await within(
        WAIT,
        'crash 2',
        settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 })),
      );
      const twice = lostError((await within(WAIT, 'exit 2', third)).error);
      assert.equal(made.helper.isolating(), true);
      await polls();
      assert.equal(made.changes.at(-1)?.isolating, true, 'the change says it is isolating');
      assert.equal(twice.requeue, true);
      assert.equal(twice.suspect, true);
      assert.equal(twice.charged, false);
      assert.equal(lostError(crash.error).charged, false);
      assert.equal(made.helper.stats().poisoned, 0);
    } finally {
      await stop(made);
    }
  });

  it('U21: while isolating, a crash with two suspects in flight is charged to neither, nor one beside a bystander; alone, the culprit is charged and only it', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await isolate(made);
      // Two suspects in flight: the crash does not say which, so no one is charged (case C).
      const before = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64 }));
      const other = settled(
        made.helper.ask({ host: 'hang.test', family: 6, max: 64, suspect: true }),
      );
      const both = settled(
        made.helper.ask({ host: 'crash.test', family: 4, max: 64, suspect: true }),
      );
      for (const [what, lookup] of [
        ['the other suspect', other],
        ['the culprit, unnamed', both],
        ['a lookup that is no suspect', before],
      ] as const) {
        const lost = lostError((await within(WAIT, what, lookup)).error);
        assert.equal(lost.charged, false, what);
        assert.equal(lost.requeue, true, what);
        assert.equal(lost.suspect, true, `${what}: asked again alone`);
      }
      assert.equal(made.helper.stats().poisoned, 0);
      assert.equal((await lossSaid(made)).chargedTo, undefined);
      assert.equal(made.helper.avoidsSystem('hang.test', 6), true);
      assert.equal(made.helper.avoidsSystem('crash.test', 4), true);
      await nextChild(made, 3);
      // A suspect beside a lookup that is none: not alone, so charged to no one, and both are
      // kept off the probe's lanes (one rule for every crash, decided 2026-10-19).
      const innocent = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64 }));
      const beside = settled(
        made.helper.ask({ host: 'crash.test', family: 4, max: 64, suspect: true }),
      );
      const unnamed = lostError((await within(WAIT, 'the culprit, beside', beside)).error);
      const bystander = lostError((await within(WAIT, 'the innocent', innocent)).error);
      assert.equal(unnamed.charged, false);
      assert.equal(bystander.charged, false);
      assert.equal(bystander.requeue, true);
      assert.equal(made.helper.stats().poisoned, 0);
      assert.equal(made.helper.avoidsSystem('hang.test', 4), true, 'the bystander');
      assert.equal(made.helper.avoidsSystem('crash.test', 4), true);
      await nextChild(made, 4);
      // Alone, as a suspect: charged, and only it.
      const culprit = settled(
        made.helper.ask({ host: 'crash.test', family: 4, max: 64, suspect: true }),
      );
      assert.equal(made.helper.isolating(), true, 'the fourth crash isolated again');
      const charged = lostError((await within(WAIT, 'the culprit', culprit)).error);
      assert.equal(charged.charged, true);
      assert.equal(charged.requeue, false);
      assert.equal(made.helper.stats().poisoned, 1);
      assert.ok(made.helper.poison('crash.test', 4) !== undefined);
      assert.equal(made.helper.poison('hang.test', 6), undefined);
      const loss = await lossSaid(made);
      assert.equal(loss.chargedTo, 'crash.test');
      assert.equal(loss.charged, 'new');
      assert.equal(made.helper.poison('crash.test', 4)?.signal, 'SIGABRT');
      const said = made.lines.filter(
        (line) => line['level'] === 50 && line['host'] === 'crash.test',
      );
      assert.equal(said.length, 1);
    } finally {
      await stop(made);
    }
  });

  it('U22: a poison name is asked again after an hour: an answer clears it, a crash is charged to it again', async () => {
    const timers = new Timers({ clock: 'fake', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers, limits: { poisonRetryMs: 3_600_000 } });
    const once = path('u22-crashed');
    const host = `crash-unless:${once}`;
    try {
      void made.helper.start();
      await up(made);
      await isolate(made);
      // Two names charged while isolating: both poison, and neither counted toward a rest.
      let losses = 2;
      for (const [name, family] of [
        ['crash.test', 4],
        [host, 0],
      ] as const) {
        const crashed = lostError(
          (
            await within(
              WAIT,
              name,
              settled(made.helper.ask({ host: name, family, max: 64, suspect: true })),
            )
          ).error,
        );
        assert.equal(crashed.charged, true, name);
        assert.equal(crashed.requeue, false, name);
        losses += 1;
        await nextChild(made, losses);
      }
      assert.equal(made.helper.stats().poisoned, 2);
      assert.deepEqual(made.helper.poisonDue(), []);
      // Isolation over: the hourly ask is charged on its mark alone.
      made.helper.endIsolation();
      timers.clock += 3_600_000;
      assert.deepEqual(
        made.helper.poisonDue().map((mark) => mark.host),
        ['crash.test', host],
      );
      const answer = await within(
        WAIT,
        'the hourly ask',
        made.helper.ask({ host, family: 0, max: 64 }),
      );
      assert.deepEqual(answer.addresses, [{ address: '192.0.2.1', family: 4 }]);
      assert.equal(made.helper.poison(host, 0), undefined);
      const hourly = settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 }));
      assert.deepEqual(made.helper.poisonDue(), [], 'not due while its hourly ask runs');
      const again = lostError((await within(WAIT, 'the hourly crash', hourly)).error);
      assert.equal(again.charged, true);
      assert.equal(again.requeue, false);
      assert.equal(made.helper.stats().lastLoss?.charged, 'again');
      const mark = made.helper.poison('crash.test', 4);
      assert.ok(mark !== undefined, 'the mark is kept');
      assert.equal(mark.nextAskAt, timers.clock + 7_200_000, 'asked again after twice as long');
      assert.equal(made.helper.isolating(), false);
    } finally {
      await stop(made);
    }
  });

  it('U31: a name that crashes the child after it is said stuck is found: kept off the probe’s lanes, a suspect at the second crash, charged alone', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers, limits: { stuckMs: 100 } });
    // Said stuck at 100 ms on the child's clock, crashing at 400: a crash on a slow reply.
    const host = 'late-crash-400.test';
    const crash = async (count: number, suspect: boolean): Promise<HelperLostError> => {
      let saidStuck = false;
      const asked = settled(
        made.helper.ask({
          host,
          family: 4,
          max: 64,
          suspect,
          onStuck: () => (saidStuck = true),
        }),
      );
      const lost = lostError((await within(WAIT, `crash ${String(count)}`, asked)).error);
      assert.ok(saidStuck, `said stuck before crash ${String(count)}`);
      assert.equal(lost.reason, 'exit');
      assert.equal(lost.stuck, true);
      assert.equal(lost.requeue, false, 'held, as any lookup said stuck');
      return lost;
    };
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      // The first crash: no isolation yet, and the name stays off the probe's lanes.
      const first = await crash(1, false);
      assert.equal(first.suspect, false);
      assert.equal(made.helper.isolating(), false);
      assert.equal(made.helper.avoidsSystem(host, 4), true);
      await nextChild(made, 1);
      // Asked again once its hold ends: the second crash isolates, with nothing requeued but it a
      // candidate, to be asked again alone.
      const second = await crash(2, false);
      assert.equal(made.helper.isolating(), true);
      assert.equal(second.suspect, true);
      assert.equal(second.charged, false);
      await nextChild(made, 2);
      // Alone, as a suspect: the crash is charged to it, and the helper does not rest.
      const third = await crash(3, true);
      assert.equal(third.charged, true);
      assert.ok(made.helper.poison(host, 4) !== undefined);
      await lossOf(made, 3);
      await polls();
      assert.equal(made.helper.state, 'backoff');
      assert.equal(made.changes.at(-1)?.charged, 'new');
      assert.equal(made.helper.avoidsSystem(host, 0), true);
    } finally {
      await stop(made);
    }
  });

  it('U21: a suspect is one only if asked while isolating, and stays one until it settles; beside a fresh lookup it is not charged, and both are avoided', async () => {
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ timers });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      // Flagged a suspect with no isolation on: a crash is charged to no one.
      const early = lostError(
        (
          await within(
            WAIT,
            'a crash outside isolation',
            settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64, suspect: true })),
          )
        ).error,
      );
      assert.equal(early.charged, false);
      assert.equal(early.requeue, true);
      assert.equal(made.helper.stats().poisoned, 0);
      await nextChild(made, 1);
      // Isolating; a suspect left running when the resolver ends isolation stays one until it
      // settles. A crash with a fresh lookup beside it is not its alone: charged to no one, and
      // both names are kept off the probe's lanes (decided 2026-10-19).
      const requeued = settled(made.helper.ask({ host: 'hang.test', family: 6, max: 64 }));
      await within(
        WAIT,
        'crash 2',
        settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 })),
      );
      await within(WAIT, 'requeued', requeued);
      await nextChild(made, 2);
      assert.equal(made.helper.isolating(), true);
      const leftOver = settled(
        made.helper.ask({ host: 'hang.test', family: 4, max: 64, suspect: true }),
      );
      made.helper.endIsolation();
      assert.equal(made.helper.isolating(), false);
      await within(
        WAIT,
        'crash 3',
        settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 })),
      );
      const left = lostError((await within(WAIT, 'the suspect left over', leftOver)).error);
      assert.equal(left.charged, false);
      assert.equal(made.helper.stats().poisoned, 0);
      // Its suspects aside: what stays is each name's crash.
      made.helper.endIsolation();
      assert.equal(made.helper.avoidsSystem('hang.test', 4), true, 'the suspect left over');
      assert.equal(made.helper.avoidsSystem('crash.test', 4), true, 'the fresh lookup');
    } finally {
      await stop(made);
    }
  });
});

describe('the lookup helper: a quiet child, judged as it serves', () => {
  it('U19: a quiet child heard only on every other tick is still killed as hung', async () => {
    const made = make({ limits: { unresponsiveTicks: 3, rejoinTicks: 2, hungTicks: 6 } });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await within(WAIT, 'muted', made.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      await tickUntil(made, 10, 'unresponsive', () => made.helper.state === 'unresponsive');
      assert.equal(made.helper.stats().quietTicks, 3);
      for (let round = 0; round < 3; round += 1) {
        await oneBeat(made);
        await tick(made);
        assert.equal(made.helper.stats().heardTicks, 1);
        await tick(made);
      }
      // 3 quiet, then heard and quiet three times: 6 quiet ticks since it last answered.
      assert.equal(made.helper.stats().lossesByReason.hung, 1);
      // Said as what it is: quiet ticks with heard ones between them, not a silent child (R2-3).
      assert.match(
        made.helper.stats().lastLoss?.why ?? '',
        /^it was quiet for 6 ticks of 100 ms since it last answered, and heard on 3 ticks between them, never 2 in a row$/u,
      );
      await polls();
      const states = made.changes.map((change) => change.state);
      const quiet = states.indexOf('unresponsive');
      const lost = states.indexOf('backoff');
      assert.ok(quiet >= 0 && lost > quiet, states.join(' '));
      assert.ok(
        !states.slice(quiet, lost).includes('up'),
        `it never came back up before it was killed: ${states.join(' ')}`,
      );
    } finally {
      await stop(made);
    }
  });

  it('U12: a beat past the memory ceiling from a quiet child is a memory loss too', async () => {
    const made = make({ limits: { unresponsiveTicks: 3 } });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await within(
        WAIT,
        'muted, its memory high',
        made.helper.ask({ host: 'test-mute-rss-high', family: 4, max: 64 }),
      );
      await tickUntil(made, 10, 'unresponsive', () => made.helper.state === 'unresponsive');
      await oneBeat(made);
      assert.equal(made.helper.stats().lossesByReason.memory, 1);
    } finally {
      await stop(made);
    }
  });

  it('U14: an abort while the child is quiet keeps the route down; heard again, it serves the drain', async () => {
    const abort = new AbortController();
    const made = make({ signal: abort.signal, limits: { unresponsiveTicks: 3, rejoinTicks: 2 } });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      await within(WAIT, 'muted', made.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      await tickUntil(made, 10, 'unresponsive', () => made.helper.state === 'unresponsive');
      abort.abort();
      assert.equal(made.helper.state, 'stopping');
      assert.equal(made.helper.routeState(), 'down');
      await polls();
      const stopping = made.changes.at(-1);
      assert.equal(stopping?.state, 'stopping');
      assert.equal(stopping.previous, 'unresponsive');
      assert.equal(stopping.route, 'down');
      const refused = lostError(
        (
          await within(
            WAIT,
            'an ask refused at once',
            settled(made.helper.ask({ host: 'delay-0.ok.test', family: 4, max: 64 })),
          )
        ).error,
      );
      assert.equal(refused.reason, 'unavailable');
      signal(made, 'SIGUSR2');
      for (let i = 0; i < 2; i += 1) {
        const read = made.helper.stats().messages;
        await pollWithin(WAIT, 'a beat', () => made.helper.stats().messages > read);
        await tick(made);
      }
      assert.equal(made.helper.routeState(), 'up');
      const back = made.changes.at(-1);
      assert.equal(back?.state, 'stopping');
      assert.equal(back.route, 'up');
      const answer = await within(
        WAIT,
        'an answer in the drain',
        made.helper.ask({ host: 'delay-0.ok.test', family: 4, max: 64 }),
      );
      assert.equal(answer.total, 1);
    } finally {
      await stop(made);
    }
  });

  it('U14: a child that goes quiet after the abort routes down, and is killed as hung, not replaced', async () => {
    const abort = new AbortController();
    const made = make({ signal: abort.signal, limits: { unresponsiveTicks: 3, hungTicks: 6 } });
    const ref = {};
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      abort.abort();
      assert.equal(made.helper.routeState(), 'up');
      const held = settled(made.helper.ask({ host: 'hang.test', family: 4, max: 64, ref }));
      await within(WAIT, 'muted', made.helper.ask({ host: 'test-mute', family: 4, max: 64 }));
      await tickUntil(made, 10, 'routed down', () => made.helper.routeState() === 'down');
      assert.equal(made.helper.state, 'stopping');
      await polls();
      const quiet = made.changes.at(-1);
      assert.equal(quiet?.route, 'down');
      assert.ok(quiet.detached?.includes(ref), 'the lookup in flight was detached');
      await tickUntil(made, 10, 'a hung loss', () => made.helper.stats().losses === 1);
      assert.equal(made.helper.stats().lastLoss?.reason, 'hung');
      const lost = lostError((await within(WAIT, 'the held lookup', held)).error);
      assert.equal(lost.reason, 'hung');
      assert.equal(lost.detached, true);
      assert.equal(lost.requeue, false);
      await polls();
      assert.equal(made.helper.state, 'stopping');
      assert.equal(made.helper.pid(), undefined);
      assert.ok(made.changes.every((change) => change.state !== 'backoff'));
    } finally {
      await stop(made);
    }
  });
});

describe('the lookup helper’s production child', () => {
  it(
    'U25: the child module itself, forked as the probe forks it, answers localhost from its files',
    { skip: !onLinux },
    async () => {
      const { logger, lines } = logged();
      const helper = new LookupHelper({ logger, limits: { startWaitMs: WAIT } });
      try {
        assert.equal(
          await within(WAIT, 'start', helper.start()),
          true,
          JSON.stringify(lines.filter((line) => Number(line['level']) >= 40)),
        );
        const answer = await within(
          WAIT,
          'localhost',
          helper.ask({ host: 'localhost', family: 4, max: 64 }),
        );
        assert.ok(
          answer.addresses.some((one) => one.address === '127.0.0.1'),
          JSON.stringify(answer),
        );
        assert.equal(helper.stats().losses, 0);
      } finally {
        await within(WAIT, 'stopped', helper.stop());
      }
    },
  );
});

describe('the lookup helper’s reading of itself (P-432 S3)', () => {
  it('reads glibc’s version with the report’s network section left out, and puts it back', (t) => {
    const reporter = process.report as NodeJS.ProcessReport & {
      excludeNetwork?: boolean | undefined;
    };
    const before = reporter.excludeNetwork;
    const seen: unknown[] = [];
    const header: Record<string, unknown> = { glibcVersionRuntime: '2.39' };
    t.mock.method(reporter, 'getReport', () => {
      seen.push(reporter.excludeNetwork);
      return { header };
    });
    assert.equal(glibcRuntime(), '2.39');
    assert.deepEqual(seen, [true], 'no reverse lookup of the open sockets, which waits on DNS');
    assert.equal(reporter.excludeNetwork, before, 'put back as it was');
    delete header['glibcVersionRuntime'];
    assert.equal(glibcRuntime(), null, 'off glibc: null, not undefined');
    assert.equal(reporter.excludeNetwork, before);
  });

  it('puts the report’s setting back when the report throws', (t) => {
    const reporter = process.report as NodeJS.ProcessReport & {
      excludeNetwork?: boolean | undefined;
    };
    const before = reporter.excludeNetwork;
    t.mock.method(reporter, 'getReport', () => {
      throw new Error('no report');
    });
    assert.throws(() => glibcRuntime(), /no report/);
    assert.equal(reporter.excludeNetwork, before);
  });

  it('has one digest: the policy’s is the child’s, the very function', () => {
    assert.equal(systemNames.digestOf, childDigestOf);
    assert.equal(systemNames.digestOfError, childDigestOfError);
    assert.equal(childDigestOfError(Object.assign(new Error('x'), { code: 'ENOENT' })), 'absent');
    assert.equal(
      childDigestOfError(Object.assign(new Error('x'), { code: 'EACCES' })),
      'unreadable:EACCES',
    );
    assert.equal(childDigestOfError(new Error('no code')), 'unreadable:unknown');
  });
});

/** A child process the test plays, for the interleavings a real child cannot be made to give. */
class FakeChild extends EventEmitter implements HelperProcess {
  readonly stderr = null;
  readonly channel = { unref: (): void => {} };
  readonly asks: AskMessage[] = [];
  readonly killed: NodeJS.Signals[] = [];
  /** A process in D state: SIGKILL reaches it and it does not go. */
  holdOnKill = false;

  constructor(readonly pid: number) {
    super();
  }

  send(message: AskMessage, callback: (error: Error | null) => void): boolean {
    this.asks.push(message);
    queueMicrotask(() => {
      callback(null);
    });
    return true;
  }

  kill(signalName: NodeJS.Signals): boolean {
    this.killed.push(signalName);
    if (!this.holdOnKill) {
      setImmediate(() => {
        this.emit('exit', null, signalName);
        this.closeChannel();
      });
    }
    return true;
  }

  unref(): void {}

  ready(self: HelperSelf, overrides: Record<string, unknown> = {}): void {
    this.emit('message', {
      t: 'ready',
      protocol: 1,
      order: self.order,
      threads: 32,
      pid: this.pid,
      selfTest: true,
      node: self.node,
      glibc: self.glibc,
      digests: {},
      ...overrides,
    });
  }

  /** Anything at all, as read from the pipe. */
  say(message: unknown): void {
    this.emit('message', message);
  }

  #seq = 0;

  beat(fields: {
    readonly rss?: number;
    readonly inFlight?: number;
    readonly asked?: number;
  }): void {
    this.#seq += 1;
    this.emit('message', {
      t: 'beat',
      seq: this.#seq,
      rss: fields.rss ?? 1,
      inFlight: fields.inFlight ?? 0,
      asked: fields.asked ?? 0,
      lagMaxMs: 0,
    });
  }

  answer(id: number): void {
    this.emit('message', {
      t: 'answer',
      id,
      ok: true,
      total: 1,
      addresses: [{ address: '192.0.2.7', family: 4 }],
      ranMs: 1,
    });
  }

  die(): void {
    this.emit('exit', null, 'SIGSEGV');
  }

  closeChannel(): void {
    this.emit('disconnect');
    this.emit('close');
  }
}

function fakeFork(): {
  readonly fork: NonNullable<LookupHelperOptions['fork']>;
  readonly children: FakeChild[];
} {
  const children: FakeChild[] = [];
  return {
    children,
    fork: () => {
      const child = new FakeChild(90_000 + children.length);
      children.push(child);
      return child;
    },
  };
}

describe('the lookup helper: late answers from a lost child (scripted process)', () => {
  const self: HelperSelf = {
    node: process.version,
    glibc: helperSelf().glibc,
    order: getDefaultResultOrder(),
  };

  it('U9b: a late answer for a lookup requeued and still queued is handed on once', async () => {
    const { fork, children } = fakeFork();
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ fork, self, timers });
    const starting = made.helper.start();
    children[0]?.ready(self);
    assert.equal(await within(WAIT, 'start', starting), true);
    const ref = {};
    const asked = settled(made.helper.ask({ host: 'dev-1.example.test', family: 4, max: 64, ref }));
    const first = children[0];
    assert.ok(first !== undefined);
    const id = first.asks[0]?.id ?? -1;
    first.die();
    assert.equal(lostError((await asked).error).requeue, true);
    // Read after the exit, before the channel closed: still the old child's to answer.
    first.answer(id);
    first.answer(id);
    await polls();
    assert.equal(made.late.length, 1);
    assert.equal(made.late[0]?.ref, ref);
    assert.equal(made.late[0].outcome.ok, true);
    first.closeChannel();
    first.answer(id);
    await polls();
    assert.equal(made.late.length, 1);
    await stop(made);
  });

  it('U9b: a late answer for a lookup already asked of the new child is dropped; the new answer settles it', async () => {
    const { fork, children } = fakeFork();
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ fork, self, timers });
    const starting = made.helper.start();
    children[0]?.ready(self);
    assert.equal(await within(WAIT, 'start', starting), true);
    const ref = {};
    const first = children[0];
    assert.ok(first !== undefined);
    const lost = settled(made.helper.ask({ host: 'dev-2.example.test', family: 4, max: 64, ref }));
    const oldId = first.asks[0]?.id ?? -1;
    first.die();
    assert.equal(lostError((await lost).error).requeue, true);
    timers.fire(0);
    const second = children[1];
    assert.ok(second !== undefined);
    second.ready(self);
    assert.equal(made.helper.state, 'up');
    const again = settled(made.helper.ask({ host: 'dev-2.example.test', family: 4, max: 64, ref }));
    const newId = second.asks[0]?.id ?? -1;
    assert.ok(newId > oldId, 'ids are never reused across children');
    first.answer(oldId);
    await polls();
    assert.equal(made.late.length, 0);
    second.answer(newId);
    const settledAgain = await again;
    assert.deepEqual(settledAgain.answer?.addresses, [{ address: '192.0.2.7', family: 4 }]);
    await stop(made);
  });

  it('U14: stop() kills, waits at most its bound for an exit that never comes, and fails what was in flight', async () => {
    const { fork, children } = fakeFork();
    const timers = new Timers({ clock: 'real', timeouts: 'fake', ticks: 'fake' });
    const made = make({ fork, self, timers, limits: { stopMs: 7_005 } });
    const starting = made.helper.start();
    const only = children[0];
    assert.ok(only !== undefined);
    only.holdOnKill = true;
    only.ready(self);
    assert.equal(await within(WAIT, 'start', starting), true);
    const asked = settled(made.helper.ask({ host: 'dev-3.example.test', family: 4, max: 64 }));
    let stopped = false;
    const stopping = made.helper.stop().then(() => {
      stopped = true;
    });
    assert.equal(lostError((await asked).error).reason, 'stop');
    assert.deepEqual(children[0]?.killed, ['SIGKILL']);
    await polls();
    assert.equal(stopped, false);
    timers.fire(7_005);
    await within(WAIT, 'stopped', stopping);
    assert.equal(made.helper.state, 'stopped');
  });
});

describe('the lookup helper: the probe stopping', () => {
  it('U14: once the signal aborts, the child serves while connected and is never replaced', async () => {
    const abort = new AbortController();
    const made = make({ signal: abort.signal });
    try {
      assert.equal(await within(WAIT, 'start', made.helper.start()), true);
      abort.abort();
      assert.equal(made.helper.state, 'stopping');
      assert.equal(made.helper.routeState(), 'up');
      const answer = await within(
        WAIT,
        'an answer while stopping',
        made.helper.ask({ host: 'delay-0.ok.test', family: 4, max: 64 }),
      );
      assert.equal(answer.total, 1);
      await within(
        WAIT,
        'the crash',
        settled(made.helper.ask({ host: 'crash.test', family: 4, max: 64 })),
      );
      await lossOf(made);
      await lossSaid(made);
      await polls();
      assert.equal(made.helper.state, 'stopping');
      assert.equal(made.helper.routeState(), 'down');
      assert.equal(made.helper.pid(), undefined);
      const index = made.changes.findIndex((change) => change.state === 'stopping');
      assert.ok(index >= 0, 'the abort was said');
      assert.equal(made.changes[index]?.previous, 'up');
      assert.equal(made.changes[index].route, 'up', 'it serves the drain');
      const after = made.changes.slice(index);
      assert.ok(after.every((change) => change.state !== 'starting' && change.state !== 'backoff'));
      const unavailable = lostError(
        (
          await within(
            WAIT,
            'an ask refused at once',
            settled(made.helper.ask({ host: 'delay-0.ok.test', family: 4, max: 64 })),
          )
        ).error,
      );
      assert.equal(unavailable.reason, 'unavailable');
      assert.equal(unavailable.started, false);
    } finally {
      await stop(made);
    }
    assert.equal(made.helper.state, 'stopped');
  });
});

describe('the lookup helper’s process', () => {
  it(
    'U13: the probe killed while lookups hold the child’s threads: the child is gone at once',
    { skip: !onLinux },
    async () => {
      const fifos = [mkfifo('u13-a'), mkfifo('u13-b'), mkfifo('u13-c')];
      const parent = spawn(process.execPath, [PARENT, 'hold', ...fifos], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let pid: number | undefined;
      try {
        let out = '';
        parent.stdout.setEncoding('utf8');
        parent.stdout.on('data', (chunk: string) => {
          out += chunk;
        });
        await pollWithin(WAIT, 'the child’s pid', () => /^\d+\n/u.test(out));
        pid = Number(out.trim());
        await pollWithin(WAIT, 'every FIFO held', () =>
          fifos.every((fifo) => existsSync(`${fifo}.open`)),
        );
        parent.kill('SIGKILL');
        const child = pid;
        await pollWithin(5_000, 'the child gone after its parent', () => dead(child));
      } finally {
        parent.kill('SIGKILL');
        if (pid !== undefined && !dead(pid)) process.kill(pid, 'SIGKILL');
      }
    },
  );

  it('U15: a process that starts a helper and returns exits by itself', async () => {
    const parent = spawn(process.execPath, [PARENT, 'start-and-return'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    parent.stdout.setEncoding('utf8');
    parent.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    try {
      const code = await within(
        WAIT,
        'the process to exit by itself',
        new Promise<number | null>((resolve) => {
          parent.on('exit', (exitCode) => {
            resolve(exitCode);
          });
        }),
      );
      assert.equal(code, 0);
      assert.equal(out, 'up\n');
    } finally {
      parent.kill('SIGKILL');
    }
  });
});

const SELF: HelperSelf = {
  node: process.version,
  glibc: helperSelf().glibc,
  order: getDefaultResultOrder(),
};

interface FakeMade extends Made {
  readonly children: FakeChild[];
}

/** A helper on scripted processes, its clock and every timer the test's. */
function fakeMade(
  options: {
    readonly limits?: Partial<HelperLimits>;
    readonly signal?: AbortSignal;
    readonly log?: string[];
  } = {},
): FakeMade {
  const { fork, children } = fakeFork();
  const timers = new Timers({ clock: 'fake', timeouts: 'fake', ticks: 'fake' });
  return { ...make({ fork, self: SELF, timers, ...options }), children };
}

/** The newest child, which must be there. */
function newest(made: FakeMade): FakeChild {
  const child = made.children.at(-1);
  assert.ok(child !== undefined, 'a child');
  return child;
}

async function fakeUp(made: FakeMade): Promise<FakeChild> {
  const child = newest(made);
  child.ready(SELF);
  await polls();
  assert.equal(made.helper.state, 'up');
  return child;
}

/** The newest child crashes and its channel closes: the change that follows. */
async function fakeCrash(made: FakeMade): Promise<HelperChange> {
  const child = newest(made);
  child.die();
  child.closeChannel();
  await polls();
  const change = made.changes.at(-1);
  assert.ok(change !== undefined);
  return change;
}

/** `count` crashes, each of a child brought up first, firing every backoff but the last's. */
async function crashes(made: FakeMade, count: number): Promise<HelperChange> {
  let change: HelperChange | undefined;
  for (let i = 0; i < count; i += 1) {
    if (made.helper.state !== 'up') await fakeUp(made);
    change = await fakeCrash(made);
    if (change.state === 'backoff' && i < count - 1) made.timers.fire(change.delayMs ?? -1);
  }
  assert.ok(change !== undefined);
  return change;
}

/** A crash with a lookup in flight, which is asked again: the change that follows. */
async function crashAsking(made: FakeMade, host = 'dev.example.test'): Promise<HelperChange> {
  if (made.helper.state !== 'up') await fakeUp(made);
  const lost = settled(made.helper.ask({ host, family: 4, max: 64 }));
  const change = await fakeCrash(made);
  assert.equal(lostError((await lost).error).requeue, true);
  return change;
}

describe('the lookup helper’s fork (scripted process)', () => {
  it('U1 (part): forks with a hidden window, its own heap, no stdin or stdout, and JSON', async () => {
    const seen: { options?: HelperForkOptions } = {};
    const made = make({
      self: SELF,
      timers: new Timers({ clock: 'fake', timeouts: 'fake', ticks: 'fake' }),
      fork: (_module, _args, options) => {
        seen.options = options;
        return new FakeChild(91_000);
      },
    });
    void made.helper.start();
    try {
      const options = seen.options;
      assert.ok(options !== undefined);
      // On Windows its own hidden console: the Ctrl+C WinSW sends the probe never reaches it.
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe', 'ipc']);
      assert.equal(options.serialization, 'json');
      assert.deepEqual(options.execArgv, ['--max-old-space-size=64']);
    } finally {
      await stop(made);
    }
  });
});

describe('the lookup helper: what the child says is checked as it is read (scripted process)', () => {
  const unreadable: readonly (readonly [string, Record<string, unknown>])[] = [
    [
      'a beat whose resident set is not a number',
      { t: 'beat', seq: 1, rss: '1', inFlight: 0, asked: 0, lagMaxMs: 0 },
    ],
    [
      'an answer carrying more addresses than its total',
      {
        t: 'answer',
        id: 1,
        ok: true,
        total: 0,
        addresses: [{ address: '192.0.2.7', family: 4 }],
        ranMs: 1,
      },
    ],
    ['a message of no kind it has', { t: 'hello' }],
  ];
  for (const [name, message] of unreadable) {
    it(`U29: ${name} is a loss`, async () => {
      const made = fakeMade();
      void made.helper.start();
      try {
        const child = await fakeUp(made);
        child.say(message);
        await polls();
        const loss = made.helper.stats().lastLoss;
        assert.equal(loss?.reason, 'exit');
        assert.equal(loss.why, 'it sent a message the probe cannot read');
      } finally {
        await stop(made);
      }
    });
  }

  it('U29: a ready giving another pid is a start loss', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      newest(made).ready(SELF, { pid: 4_242 });
      await polls();
      const loss = made.helper.stats().lastLoss;
      assert.equal(loss?.reason, 'start');
      assert.match(loss.why, /its pid is 4242/u);
    } finally {
      await stop(made);
    }
  });

  it('U29: a second ready is a loss', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      const child = await fakeUp(made);
      child.ready(SELF);
      await polls();
      const loss = made.helper.stats().lastLoss;
      assert.equal(loss?.reason, 'exit');
      assert.match(loss.why, /ready twice/u);
    } finally {
      await stop(made);
    }
  });

  it('U29: more addresses than max + 1 is a loss', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      const child = await fakeUp(made);
      const lost = settled(made.helper.ask({ host: 'dev-8.example.test', family: 4, max: 1 }));
      const id = child.asks.at(-1)?.id ?? -1;
      child.say({
        t: 'answer',
        id,
        ok: true,
        total: 3,
        addresses: [1, 2, 3].map((n) => ({ address: `192.0.2.${String(n)}`, family: 4 })),
        ranMs: 1,
      });
      assert.equal(lostError((await lost).error).reason, 'exit');
      assert.match(made.helper.stats().lastLoss?.why ?? '', /it sent 3 addresses/u);
    } finally {
      await stop(made);
    }
  });

  it('U29: an ask the child could not read is refused before it is sent, and the child stays up', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      const child = await fakeUp(made);
      for (const ask of [
        { host: 'x'.repeat(1_025), family: 4, max: 64 },
        { host: 'dev.example.test', family: 4, max: -1 },
        { host: 'dev.example.test', family: 4, max: 1.5 },
      ] as const) {
        const outcome = await Promise.race([
          settled(made.helper.ask(ask)),
          polls().then(() => undefined),
        ]);
        assert.ok(
          outcome?.error instanceof HelperLookupError,
          `refused at once: ${String(ask.max)}`,
        );
      }
      assert.deepEqual(child.asks, []);
      assert.equal(made.helper.state, 'up');
      assert.equal(made.helper.stats().losses, 0);
    } finally {
      await stop(made);
    }
  });
});

describe('the lookup helper: the order the resolver hears things in (scripted process)', () => {
  it('U26: every lookup of a lost child is rejected before the change that follows reaches the resolver', async () => {
    const log: string[] = [];
    const made = fakeMade({ log });
    void made.helper.start();
    try {
      await fakeUp(made);
      log.length = 0;
      for (const name of ['a', 'b']) {
        void made.helper
          .ask({ host: `${name}.example.test`, family: 4, max: 64 })
          .then(undefined, () => {
            log.push(`rejected:${name}`);
          });
      }
      newest(made).die();
      await polls();
      assert.deepEqual(log, ['rejected:a', 'rejected:b', 'change:backoff:rejoining']);
    } finally {
      await stop(made);
    }
  });

  it('U12: says no resident set while there is no child, from a loss or a stop to the next child’s first beat', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      const child = await fakeUp(made);
      child.beat({ rss: 5_000 });
      await polls();
      assert.equal(made.helper.stats().rss, 5_000);
      await fakeCrash(made);
      assert.equal(made.helper.stats().rss, undefined, 'lost: no child, no resident set');
      assert.equal(made.helper.stats().rssPeak, 5_000, 'the most seen is kept');
      made.timers.fire(made.changes.at(-1)?.delayMs ?? -1);
      await polls();
      const next = await fakeUp(made);
      assert.equal(made.helper.stats().rss, undefined, 'up, before its first beat');
      next.beat({ rss: 6_000 });
      await polls();
      assert.equal(made.helper.stats().rss, 6_000);
    } finally {
      await stop(made);
    }
    assert.equal(made.helper.stats().rss, undefined, 'stopped');
  });

  it('U9b: a late answer read in the same chunk as the loss reaches the resolver after the lookup’s rejection', async () => {
    const log: string[] = [];
    const made = fakeMade({ log });
    void made.helper.start();
    try {
      const child = await fakeUp(made);
      const ref = {};
      void made.helper
        .ask({ host: 'dev-7.example.test', family: 4, max: 64, ref })
        .then(undefined, (error: unknown) => {
          log.push(`rejected:${String(error instanceof HelperLostError && error.requeue)}`);
        });
      const id = child.asks.at(-1)?.id ?? -1;
      log.length = 0;
      // One read from the pipe: Node emits each of its messages on its own nextTick, and that
      // queue drains before any promise reaction runs.
      process.nextTick(() => {
        child.beat({ rss: HELPER_RSS_MAX + 1 });
      });
      process.nextTick(() => {
        child.answer(id);
      });
      await polls();
      assert.deepEqual(
        log.filter((entry) => !entry.startsWith('change:')),
        ['rejected:true', 'late'],
      );
      assert.equal(made.late[0]?.ref, ref);
    } finally {
      await stop(made);
    }
  });
});

describe('the lookup helper: its windows (scripted process, the test’s clock)', () => {
  it('U10: ten minutes up resets the doubling', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      const first = await crashes(made, 5);
      assert.equal(first.state, 'resting');
      assert.equal(first.delayMs, 600_000);
      made.timers.clock += 600_000;
      made.timers.fire(600_000);
      await fakeUp(made);
      made.timers.clock += 600_000;
      const again = await crashes(made, 5);
      assert.equal(again.state, 'resting');
      assert.equal(again.delayMs, 600_000, 'back to ten minutes');
    } finally {
      await stop(made);
    }
  });

  it('U10: rests double, to an hour at most', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      let change = await crashes(made, 5);
      const rests = [change.delayMs];
      for (let i = 0; i < 3; i += 1) {
        made.timers.clock += change.delayMs ?? 0;
        made.timers.fire(change.delayMs ?? -1);
        change = await crashes(made, 1);
        assert.equal(change.state, 'resting');
        rests.push(change.delayMs);
      }
      assert.deepEqual(rests, [600_000, 1_200_000, 2_400_000, 3_600_000]);
    } finally {
      await stop(made);
    }
  });

  it('U10: a loss more than ten minutes after a rest ended backs off', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      await crashes(made, 5);
      made.timers.clock += 600_000;
      made.timers.fire(600_000);
      await fakeUp(made);
      made.timers.clock += 600_001;
      const change = await crashes(made, 1);
      assert.equal(change.state, 'backoff');
      assert.equal(change.delayMs, 0);
    } finally {
      await stop(made);
    }
  });

  it('U10: five losses spread over more than ten minutes do not rest it', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      const states: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        if (i > 0) made.timers.clock += 150_000;
        const change = await crashes(made, 1);
        states.push(change.state);
        if (change.state === 'backoff') made.timers.fire(change.delayMs ?? -1);
      }
      assert.deepEqual(states, ['backoff', 'backoff', 'backoff', 'backoff', 'backoff']);
    } finally {
      await stop(made);
    }
  });

  it('U20: two crashes ten minutes apart do not isolate; two inside ten minutes do', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      let change = await crashAsking(made);
      made.timers.fire(change.delayMs ?? -1);
      made.timers.clock += 600_000;
      change = await crashAsking(made);
      assert.equal(made.helper.isolating(), false);
      assert.equal(change.isolating, false);
      made.timers.fire(change.delayMs ?? -1);
      change = await crashAsking(made);
      assert.equal(made.helper.isolating(), true);
      assert.equal(change.isolating, true);
    } finally {
      await stop(made);
    }
  });

  it('U20: a crash that leaves nothing to ask again starts no isolation', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      let change = await crashes(made, 2);
      assert.equal(made.helper.isolating(), false);
      assert.equal(change.isolating, false);
      made.timers.fire(change.delayMs ?? -1);
      await fakeUp(made);
      const lost = settled(made.helper.ask({ host: 'dev.example.test', family: 4, max: 64 }));
      change = await fakeCrash(made);
      assert.equal(made.helper.isolating(), true);
      assert.equal(change.isolating, true);
      assert.equal(lostError((await lost).error).suspect, true);
    } finally {
      await stop(made);
    }
  });

  it('U20: isolation ends 8 s after its last crash, after the polls, a suspect in flight or not', async () => {
    assert.equal(HELPER_ISOLATION_MAX_MS, 8_000, '8 suspects, each at most 1 s before it is stuck');
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      assert.equal(made.helper.isolating(), true);
      const child = await fakeUp(made);
      // A suspect whose getaddrinfo never returns: it must not keep isolation on.
      const suspect = settled(
        made.helper.ask({ host: 'dev-9.example.test', family: 4, max: 64, suspect: true }),
      );
      made.timers.fire(HELPER_ISOLATION_MAX_MS);
      assert.equal(made.helper.isolating(), true, 'judged after the polls');
      await polls();
      assert.equal(made.helper.isolating(), false, 'its suspect still in flight');
      const said = made.changes.at(-1);
      assert.equal(said?.isolating, false);
      assert.equal(said.state, 'up');
      assert.equal(said.previous, 'up');
      // Still a suspect until it settles (D27, 1(i)): a crash on its slow reply is charged to it.
      child.die();
      child.closeChannel();
      assert.equal(lostError((await within(WAIT, 'the suspect', suspect)).error).charged, true);
    } finally {
      await stop(made);
    }
  });

  it('U20: a crash during isolation runs its lapse again from that crash', async () => {
    const made = fakeMade();
    void made.helper.start();
    const lapses = (): object[] =>
      [...made.timers.pending].filter(
        (timer) => !timer.interval && timer.ms === HELPER_ISOLATION_MAX_MS,
      );
    try {
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      const second = await crashAsking(made);
      const [first] = lapses();
      assert.ok(first !== undefined, 'armed at the crash that began it');
      made.timers.fire(second.delayMs ?? -1);
      await crashAsking(made, 'dev-2.example.test');
      assert.equal(made.helper.isolating(), true);
      assert.equal(lapses().length, 1);
      assert.equal(lapses().includes(first), false, 'the first lapse cleared, a new one armed');
      made.helper.endIsolation();
      assert.equal(lapses().length, 0, 'and cleared when isolation ends');
    } finally {
      await stop(made);
    }
  });

  it('U20: a lapse whose callback still waits for the polls when a later crash arms another ends nothing', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      const child = await fakeUp(made);
      assert.equal(made.helper.isolating(), true);
      made.timers.fire(HELPER_ISOLATION_MAX_MS);
      // Before the polls: a crash during isolation arms its lapse again.
      child.die();
      child.closeChannel();
      assert.equal(made.timers.has(HELPER_ISOLATION_MAX_MS), true, 'a fresh lapse');
      await polls();
      assert.equal(made.helper.isolating(), true, 'the old one ended nothing');
      assert.equal(made.timers.has(HELPER_ISOLATION_MAX_MS), true, 'nor cleared the fresh one');
    } finally {
      await stop(made);
    }
  });

  it('U20: a suspect held keeps isolation on until its hold has ended and the child could say it is stuck', async () => {
    const made = fakeMade({ limits: { stuckMs: 1_000 } });
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      const second = await crashAsking(made);
      assert.equal(made.helper.isolating(), true);
      // Asked again within the lapse: it stays where it was.
      made.helper.suspectHeld(5_000);
      assert.equal(made.timers.has(HELPER_ISOLATION_MAX_MS), true);
      assert.equal(made.timers.has(6_000), false);
      // Past it: the lapse waits for the hold and the child's bound for stuck.
      made.helper.suspectHeld(10_000);
      assert.equal(made.timers.has(11_000), true);
      assert.equal(made.timers.has(HELPER_ISOLATION_MAX_MS), false);
      // A crash meanwhile, 8 s before the hold's end: the lapse stays the hold's.
      made.timers.fire(second.delayMs ?? -1);
      const third = await crashAsking(made, 'dev-2.example.test');
      assert.equal(made.helper.isolating(), true);
      assert.equal(made.timers.has(11_000), true);
      assert.equal(made.timers.has(HELPER_ISOLATION_MAX_MS), false);
      made.timers.fire(11_000);
      await polls();
      assert.equal(made.helper.isolating(), false);
      // Not isolating: a hold arms nothing.
      made.helper.suspectHeld(50_000);
      assert.equal(made.timers.has(51_000), false);
      // The next isolation's lapse is its own, 8 s from its crash.
      made.timers.fire(third.delayMs ?? -1);
      await crashAsking(made, 'dev-3.example.test');
      assert.equal(made.helper.isolating(), true);
      assert.equal(made.timers.has(HELPER_ISOLATION_MAX_MS), true);
      assert.equal(made.timers.has(11_000), false);
    } finally {
      await stop(made);
    }
  });

  it('a poison name’s re-ask beside another lookup: a crash is charged to no one and both are avoided; alone, it is charged (D27)', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      await fakeUp(made);
      const host = 'bad.example.test';
      const first = settled(made.helper.ask({ host, family: 4, max: 64, suspect: true }));
      let change = await fakeCrash(made);
      assert.equal(lostError((await first).error).charged, true);
      made.helper.endIsolation();
      const mark = made.helper.poison(host, 4);
      assert.ok(mark !== undefined);
      const retryMs = mark.retryMs;
      made.timers.fire(change.delayMs ?? -1);
      await fakeUp(made);
      const again = settled(made.helper.ask({ host, family: 4, max: 64 }));
      const beside = settled(made.helper.ask({ host: 'dev-5.example.test', family: 4, max: 64 }));
      change = await fakeCrash(made);
      assert.equal(lostError((await again).error).charged, false);
      assert.equal(lostError((await beside).error).charged, false);
      assert.equal(mark.retryMs, retryMs, 'its mark not doubled');
      assert.equal(made.helper.stats().lastLoss?.chargedTo, undefined);
      assert.equal(made.helper.avoidsSystem('dev-5.example.test', 4), true, 'kept off the lanes');
      made.timers.fire(change.delayMs ?? -1);
      await fakeUp(made);
      const alone = settled(made.helper.ask({ host, family: 4, max: 64 }));
      await fakeCrash(made);
      assert.equal(lostError((await alone).error).charged, true);
      assert.equal(made.helper.stats().lastLoss?.charged, 'again');
    } finally {
      await stop(made);
    }
  });

  it('U20: a stop leaves no lapse of isolation armed', async () => {
    const made = fakeMade();
    void made.helper.start();
    const lapses = (): object[] =>
      [...made.timers.pending].filter(
        (timer) => !timer.interval && timer.ms === HELPER_ISOLATION_MAX_MS,
      );
    made.timers.fire((await crashAsking(made)).delayMs ?? -1);
    await crashAsking(made);
    assert.equal(made.helper.isolating(), true);
    assert.equal(lapses().length, 1);
    await stop(made);
    assert.equal(lapses().length, 0);
  });

  it('a poison name whose re-ask finds no moment for a whole period waits for its next (D27)', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      await fakeUp(made);
      const host = 'bad.example.test';
      const first = settled(made.helper.ask({ host, family: 4, max: 64, suspect: true }));
      await fakeCrash(made);
      assert.equal(lostError((await first).error).charged, true);
      made.helper.endIsolation();
      const mark = made.helper.poison(host, 4);
      assert.ok(mark !== undefined);
      const due = mark.nextAskAt;
      made.timers.clock = due + mark.retryMs - 1;
      assert.deepEqual(
        made.helper.poisonDue().map((one) => one.host),
        [host],
        'due all its period',
      );
      made.timers.clock = due + mark.retryMs;
      assert.deepEqual(made.helper.poisonDue(), [], 'a whole period with no moment to ask it');
      assert.equal(mark.nextAskAt, made.timers.clock + mark.retryMs, 'its next');
      made.timers.clock = mark.nextAskAt;
      assert.deepEqual(
        made.helper.poisonDue().map((one) => one.host),
        [host],
      );
    } finally {
      await stop(made);
    }
  });

  it('U27: crashes charged to a name are not counted toward a rest: four names that crash are each found', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      assert.equal(made.helper.isolating(), true);
      const states: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        await fakeUp(made);
        const name = `bad-${String(i)}.example.test`;
        const lost = settled(made.helper.ask({ host: name, family: 4, max: 64, suspect: true }));
        const change = await fakeCrash(made);
        assert.equal(lostError((await lost).error).charged, true, name);
        states.push(change.state);
        if (change.state === 'backoff') made.timers.fire(change.delayMs ?? -1);
      }
      assert.deepEqual(states, ['backoff', 'backoff', 'backoff', 'backoff']);
      assert.equal(made.helper.stats().poisoned, 4);
    } finally {
      await stop(made);
    }
  });

  it('U27: a crash charged to a name soon after a rest backs off: it found what crashed the child', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      const rest = await crashes(made, 3);
      assert.equal(rest.state, 'resting');
      made.timers.clock += rest.delayMs ?? 0;
      made.timers.fire(rest.delayMs ?? -1);
      await fakeUp(made);
      assert.equal(made.helper.isolating(), true);
      const lost = settled(
        made.helper.ask({ host: 'bad.example.test', family: 4, max: 64, suspect: true }),
      );
      const change = await fakeCrash(made);
      assert.equal(lostError((await lost).error).charged, true);
      assert.equal(change.state, 'backoff');
    } finally {
      await stop(made);
    }
  });

  it('U28: a crash that rests the helper asks none of its lookups again; a memory loss that rests does', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashes(made, 4)).delayMs ?? -1);
      await fakeUp(made);
      const lost = settled(made.helper.ask({ host: 'dev-5.example.test', family: 4, max: 64 }));
      const rest = await fakeCrash(made);
      assert.equal(rest.state, 'resting');
      const error = lostError((await lost).error);
      assert.equal(error.reason, 'exit');
      assert.equal(error.requeue, false);
      assert.equal(error.charged, false);
      assert.equal(made.helper.stats().lastLoss?.faulted, 1);
    } finally {
      await stop(made);
    }
    const memory = fakeMade();
    void memory.helper.start();
    try {
      memory.timers.fire((await crashes(memory, 4)).delayMs ?? -1);
      const child = await fakeUp(memory);
      const lost = settled(memory.helper.ask({ host: 'dev-6.example.test', family: 4, max: 64 }));
      child.beat({ rss: HELPER_RSS_MAX + 1 });
      await polls();
      assert.equal(memory.helper.state, 'resting');
      const error = lostError((await lost).error);
      assert.equal(error.reason, 'memory');
      assert.equal(error.requeue, true);
    } finally {
      await stop(memory);
    }
  });

  it('U28: a crash while the probe stops asks none of its lookups again', async () => {
    const abort = new AbortController();
    const made = fakeMade({ signal: abort.signal });
    void made.helper.start();
    try {
      await fakeUp(made);
      abort.abort();
      const lost = settled(made.helper.ask({ host: 'dev-4.example.test', family: 4, max: 64 }));
      await fakeCrash(made);
      const error = lostError((await lost).error);
      assert.equal(error.reason, 'exit');
      assert.equal(error.requeue, false);
      assert.equal(made.helper.state, 'stopping');
    } finally {
      await stop(made);
    }
  });

  it('U23: a rejoin window is closed by its own timer only: a loss read just after an older one fired keeps its window', async () => {
    const made = fakeMade({ limits: { rejoinMs: 2_000 } });
    void made.helper.start();
    try {
      const first = await crashes(made, 1);
      assert.equal(first.route, 'rejoining');
      made.timers.fire(first.delayMs ?? -1);
      const child = await fakeUp(made);
      // The first loss's window timer fires, as after a stall; its callback waits for the polls,
      // and the second child's crash is read before they run.
      made.timers.fire(2_000);
      const before = made.changes.length;
      child.die();
      child.closeChannel();
      await polls();
      assert.equal(made.helper.routeState(), 'rejoining');
      const routes = made.changes.slice(before).map((change) => change.route);
      assert.deepEqual(routes, ['rejoining'], 'no down before its own timer');
      assert.ok(made.timers.has(2_000), 'the second loss’s window timer is waiting');
      made.timers.fire(2_000);
      await polls();
      assert.equal(made.helper.routeState(), 'down');
      assert.equal(made.changes.at(-1)?.route, 'down');
    } finally {
      await stop(made);
    }
  });
});

/** An ask the fake child says is stuck: settled into what it was. */
function stuckAsk(
  made: FakeMade,
  host: string,
): Promise<{ readonly answer?: HelperAnswer; readonly error?: unknown }> {
  const child = newest(made);
  const asked = settled(made.helper.ask({ host, family: 4, max: 64 }));
  child.say({ t: 'stuck', id: child.asks.at(-1)?.id ?? -1, ranMs: 5_000 });
  return asked;
}

describe('the lookup helper: names kept off the probe’s lanes (scripted process, the test’s clock)', () => {
  it('U30: a name in flight at a crash charged to no one is avoided for ten minutes, in each family a lookup of it asks for', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made, 'dev-1.example.test')).delayMs ?? -1);
      made.timers.clock += 1_000;
      await fakeUp(made);
      const both = settled(made.helper.ask({ host: 'dev-0.example.test', family: 0, max: 64 }));
      const crashed = await fakeCrash(made);
      await both;
      // Its suspects aside: what stays is each name's crash.
      made.helper.endIsolation();
      assert.equal(made.helper.avoidsSystem('dev-1.example.test', 4), true);
      assert.equal(made.helper.avoidsSystem('dev-1.example.test', 0), true, 'asked for with 6');
      assert.equal(made.helper.avoidsSystem('dev-1.example.test', 6), false);
      assert.equal(made.helper.avoidsSystem('dev-0.example.test', 6), true, 'asked with 0');
      assert.equal(made.helper.avoidsSystem('dev-2.example.test', 4), false);
      // dev-1 crashed at 0 on the test's clock, and the helper was next up at 1 s: its ten minutes
      // run from then. dev-0 crashed at 1 s, and the helper has not been up since.
      made.timers.clock = 601_000 - 1;
      assert.equal(made.helper.avoidsSystem('dev-1.example.test', 4), true);
      made.timers.clock = 601_000;
      assert.equal(made.helper.avoidsSystem('dev-1.example.test', 4), false, 'ten minutes up');
      made.timers.clock = 5_000_000;
      assert.equal(made.helper.avoidsSystem('dev-0.example.test', 6), true, 'not up since');
      made.timers.fire(crashed.delayMs ?? -1);
      await fakeUp(made);
      assert.equal(made.helper.avoidsSystem('dev-1.example.test', 4), false, 'its ten minutes ran');
      made.timers.clock = 5_600_000 - 1;
      assert.equal(made.helper.avoidsSystem('dev-0.example.test', 6), true);
      made.timers.clock = 5_600_000;
      assert.equal(made.helper.avoidsSystem('dev-0.example.test', 6), false, 'ten minutes up');
    } finally {
      await stop(made);
    }
  });

  it('U30: at a crash that rests the helper every name in flight is avoided while it rests, the stuck one too, and none is a suspect', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashes(made, 4)).delayMs ?? -1);
      await fakeUp(made);
      const stuck = stuckAsk(made, 'slow.example.test');
      const other = settled(made.helper.ask({ host: 'dev-3.example.test', family: 6, max: 64 }));
      const rest = await fakeCrash(made);
      assert.equal(rest.state, 'resting');
      assert.equal(made.helper.routeState(), 'resting');
      const held = lostError((await stuck).error);
      assert.equal(held.stuck, true);
      assert.equal(held.suspect, false, 'no child to ask it again in');
      assert.equal(lostError((await other).error).requeue, false);
      assert.equal(made.helper.isolating(), false, 'a crash that rests starts no isolation');
      assert.equal(made.helper.avoidsSystem('slow.example.test', 4), true);
      assert.equal(made.helper.avoidsSystem('dev-3.example.test', 6), true);
      assert.equal(made.helper.avoidsSystem('dev-9.example.test', 4), false);
    } finally {
      await stop(made);
    }
  });

  it('U30: a name crashed is avoided through a rest, while the next child starts, and ten minutes after it is up', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashes(made, 4)).delayMs ?? -1);
      await fakeUp(made);
      const stuck = stuckAsk(made, 'slow.example.test');
      const rest = await fakeCrash(made);
      assert.equal(rest.state, 'resting');
      await stuck;
      // A rest as long as the ten minutes: they have not run while no child was up.
      made.timers.clock += rest.delayMs ?? -1;
      assert.equal(made.helper.avoidsSystem('slow.example.test', 4), true, 'the rest over');
      made.timers.fire(rest.delayMs ?? -1);
      assert.equal(made.helper.state, 'starting');
      made.timers.clock += 30_000;
      assert.equal(made.helper.avoidsSystem('slow.example.test', 4), true, 'not up yet');
      await fakeUp(made);
      const upAt = made.timers.clock;
      made.timers.clock = upAt + 600_000 - 1;
      assert.equal(made.helper.avoidsSystem('slow.example.test', 4), true);
      made.timers.clock = upAt + 600_000;
      assert.equal(made.helper.avoidsSystem('slow.example.test', 4), false, 'ten minutes up');
    } finally {
      await stop(made);
    }
  });

  it('U30: a suspect and a bystander in flight at a crash that rests the helper: no one charged, and the bystander avoided through the rest', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made, 'dev-1.example.test')).delayMs ?? -1);
      made.timers.fire((await crashAsking(made, 'dev-2.example.test')).delayMs ?? -1);
      assert.equal(made.helper.isolating(), true);
      // Two more losses with nothing in flight: four in ten minutes.
      for (let loss = 0; loss < 2; loss += 1) {
        await fakeUp(made);
        made.timers.fire((await fakeCrash(made)).delayMs ?? -1);
      }
      await fakeUp(made);
      const suspect = settled(
        made.helper.ask({ host: 'bad.example.test', family: 4, max: 64, suspect: true }),
      );
      const beside = settled(made.helper.ask({ host: 'dev-7.example.test', family: 4, max: 64 }));
      const rest = await fakeCrash(made);
      assert.equal(rest.state, 'resting');
      assert.equal(lostError((await suspect).error).charged, false, 'not alone');
      const bystander = lostError((await beside).error);
      assert.equal(bystander.charged, false);
      assert.equal(bystander.suspect, false, 'no child to ask it again in');
      made.timers.clock += rest.delayMs ?? -1;
      assert.equal(made.helper.avoidsSystem('dev-7.example.test', 4), true, 'the rest over');
      made.timers.fire(rest.delayMs ?? -1);
      assert.equal(made.helper.avoidsSystem('dev-7.example.test', 4), true, 'starting');
      await fakeUp(made);
      const upAt = made.timers.clock;
      made.timers.clock = upAt + 600_000 - 1;
      assert.equal(made.helper.avoidsSystem('dev-7.example.test', 4), true);
      made.timers.clock = upAt + 600_000;
      assert.equal(made.helper.avoidsSystem('dev-7.example.test', 4), false, 'ten minutes up');
    } finally {
      await stop(made);
    }
  });

  it('U30: every name in flight at a crash is avoided, suspects too, whether they answer or isolation ends, for ten minutes up', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made, 'dev-1.example.test')).delayMs ?? -1);
      made.timers.fire((await crashAsking(made, 'dev-2.example.test')).delayMs ?? -1);
      assert.equal(made.helper.isolating(), true);
      // Past those crashes' ten minutes: what is avoided now is what follows.
      made.timers.clock += 600_000;
      await fakeUp(made);
      const a = settled(made.helper.ask({ host: 'a.example.test', family: 4, max: 64 }));
      const b = settled(made.helper.ask({ host: 'b.example.test', family: 4, max: 64 }));
      const culprit = settled(
        made.helper.ask({ host: 'bad.example.test', family: 4, max: 64, suspect: true }),
      );
      const change = await fakeCrash(made);
      // Three in flight: the crash is no one's alone, so no one is charged, and each is avoided.
      assert.equal(lostError((await culprit).error).charged, false);
      assert.equal(lostError((await a).error).suspect, true);
      assert.equal(lostError((await b).error).suspect, true);
      assert.equal(made.helper.stats().poisoned, 0);
      for (const host of ['a', 'b', 'bad']) {
        assert.equal(made.helper.avoidsSystem(`${host}.example.test`, 4), true, host);
      }
      made.timers.fire(change.delayMs ?? -1);
      const child = await fakeUp(made);
      const upAt = made.timers.clock;
      const asked = made.helper.ask({ host: 'a.example.test', family: 4, max: 64, suspect: true });
      child.answer(child.asks.at(-1)?.id ?? -1);
      await within(WAIT, 'the suspect answered', asked);
      assert.equal(made.helper.avoidsSystem('a.example.test', 4), true, 'in flight at the crash');
      made.helper.endIsolation();
      assert.equal(made.helper.avoidsSystem('b.example.test', 4), true, 'no suspect, still so');
      made.timers.clock = upAt + 600_000 - 1;
      assert.equal(made.helper.avoidsSystem('a.example.test', 4), true);
      made.timers.clock = upAt + 600_000;
      for (const host of ['a', 'b', 'bad']) {
        assert.equal(
          made.helper.avoidsSystem(`${host}.example.test`, 4),
          false,
          `${host}: ten minutes up`,
        );
      }
    } finally {
      await stop(made);
    }
  });

  it('U21: a stuck suspect and a later suspect in flight at a crash: neither charged, both avoided and asked again alone, and the next crash names the culprit', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      made.timers.fire((await crashAsking(made, 'dev-1.example.test')).delayMs ?? -1);
      made.timers.fire((await crashAsking(made, 'dev-2.example.test')).delayMs ?? -1);
      assert.equal(made.helper.isolating(), true);
      made.timers.clock += 600_000;
      let child = await fakeUp(made);
      const x = settled(
        made.helper.ask({ host: 'x.example.test', family: 4, max: 64, suspect: true }),
      );
      child.say({ t: 'stuck', id: child.asks.at(-1)?.id ?? -1, ranMs: 5_000 });
      // X said stuck, so the resolver sends the next suspect; then the child crashes (case C).
      const y = settled(
        made.helper.ask({ host: 'y.example.test', family: 4, max: 64, suspect: true }),
      );
      let change = await fakeCrash(made);
      const xLost = lostError((await x).error);
      const yLost = lostError((await y).error);
      assert.equal(xLost.charged, false);
      assert.equal(yLost.charged, false, 'a working name is not poison for another’s crash');
      assert.equal(made.helper.stats().poisoned, 0);
      assert.equal('charged' in change, false);
      assert.equal(xLost.stuck, true);
      assert.equal(xLost.suspect, true, 'asked again alone once its hold ends');
      assert.equal(yLost.requeue, true);
      assert.equal(yLost.suspect, true);
      assert.equal(made.helper.avoidsSystem('x.example.test', 4), true);
      assert.equal(made.helper.avoidsSystem('y.example.test', 4), true);
      // Each asked again alone: Y answers; X crashes, and is charged.
      made.timers.fire(change.delayMs ?? -1);
      child = await fakeUp(made);
      const yAlone = made.helper.ask({ host: 'y.example.test', family: 4, max: 64, suspect: true });
      child.answer(child.asks.at(-1)?.id ?? -1);
      await within(WAIT, 'Y alone', yAlone);
      const xAlone = settled(
        made.helper.ask({ host: 'x.example.test', family: 4, max: 64, suspect: true }),
      );
      child.say({ t: 'stuck', id: child.asks.at(-1)?.id ?? -1, ranMs: 5_000 });
      change = await fakeCrash(made);
      assert.equal(lostError((await xAlone).error).charged, true);
      assert.equal(change.charged, 'new');
      assert.ok(made.helper.poison('x.example.test', 4) !== undefined);
      assert.equal(made.helper.poison('y.example.test', 4), undefined);
      // A lookup said stuck counts as a suspect too: beside one, the crash is charged to neither.
      made.timers.fire(change.delayMs ?? -1);
      await fakeUp(made);
      const slow = stuckAsk(made, 'z.example.test');
      const lone = settled(
        made.helper.ask({ host: 's.example.test', family: 4, max: 64, suspect: true }),
      );
      await fakeCrash(made);
      assert.equal(lostError((await lone).error).charged, false);
      assert.equal(lostError((await slow).error).suspect, true);
      assert.equal(made.helper.stats().poisoned, 1);
    } finally {
      await stop(made);
    }
  });

  it('U31: a lookup stuck at a crash is a candidate: it isolates, and is asked again alone; one detached first is not', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      // Two crashes with only a stuck lookup each: the second isolates.
      await fakeUp(made);
      const first = stuckAsk(made, 'slow.example.test');
      made.timers.fire((await fakeCrash(made)).delayMs ?? -1);
      assert.equal(lostError((await first).error).suspect, false);
      assert.equal(made.helper.isolating(), false);
      await fakeUp(made);
      const second = stuckAsk(made, 'slow.example.test');
      const change = await fakeCrash(made);
      const candidate = lostError((await second).error);
      assert.equal(made.helper.isolating(), true);
      assert.equal(change.isolating, true);
      assert.equal(candidate.requeue, false);
      assert.equal(candidate.suspect, true);
      assert.equal(made.helper.avoidsSystem('slow.example.test', 4), true);
      // Stuck, then detached when the child went quiet: never asked again (D26), so no suspect.
      made.timers.fire(change.delayMs ?? -1);
      await fakeUp(made);
      const detached = stuckAsk(made, 'quiet.example.test');
      await tickUntil(made, 10, 'unresponsive', () => made.helper.state === 'unresponsive');
      await fakeCrash(made);
      const gone = lostError((await detached).error);
      assert.equal(gone.stuck, true);
      assert.equal(gone.detached, true);
      assert.equal(gone.suspect, false);
    } finally {
      await stop(made);
    }
  });

  it('U32: a poison name crashing again at its re-ask is charged again, not new, and asked half as often, a day apart at most', async () => {
    const made = fakeMade();
    void made.helper.start();
    try {
      const plain = await crashAsking(made);
      assert.equal('charged' in plain, false, 'a loss charged to no one says nothing of it');
      made.timers.fire(plain.delayMs ?? -1);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      await fakeUp(made);
      const host = 'bad.example.test';
      const first = settled(made.helper.ask({ host, family: 4, max: 64, suspect: true }));
      let change = await fakeCrash(made);
      assert.equal(lostError((await first).error).charged, true);
      assert.equal(change.charged, 'new');
      assert.equal(made.helper.stats().lastLoss?.charged, 'new');
      assert.equal(made.helper.stats().lastLoss?.chargedTo, host);
      made.helper.endIsolation();
      const waits: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const mark = made.helper.poison(host, 4);
        assert.ok(mark !== undefined);
        waits.push(mark.retryMs);
        made.timers.fire(change.delayMs ?? -1);
        made.timers.clock = mark.nextAskAt;
        await fakeUp(made);
        assert.deepEqual(
          made.helper.poisonDue().map((due) => due.host),
          [host],
        );
        const again = settled(made.helper.ask({ host, family: 4, max: 64 }));
        assert.equal(mark.nextAskAt, made.timers.clock + mark.retryMs, 'not due while it runs');
        change = await fakeCrash(made);
        assert.equal(lostError((await again).error).charged, true);
        assert.equal(change.charged, 'again');
        assert.equal(change.state, 'backoff');
        assert.equal(made.helper.stats().lastLoss?.charged, 'again');
      }
      waits.push(made.helper.poison(host, 4)?.retryMs ?? -1);
      const hour = 3_600_000;
      assert.deepEqual(waits, [
        hour,
        2 * hour,
        4 * hour,
        8 * hour,
        16 * hour,
        24 * hour,
        24 * hour,
      ]);
      // It answers: the mark goes, and the next charge starts from an hour again.
      made.timers.fire(change.delayMs ?? -1);
      made.timers.clock += 24 * hour;
      const child = await fakeUp(made);
      const answered = made.helper.ask({ host, family: 4, max: 64 });
      child.answer(child.asks.at(-1)?.id ?? -1);
      await within(WAIT, 'the re-ask answered', answered);
      assert.equal(made.helper.poison(host, 4), undefined);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      made.timers.fire((await crashAsking(made)).delayMs ?? -1);
      assert.equal(made.helper.isolating(), true);
      await fakeUp(made);
      const relapse = settled(made.helper.ask({ host, family: 4, max: 64, suspect: true }));
      change = await fakeCrash(made);
      assert.equal(lostError((await relapse).error).charged, true);
      assert.equal(change.charged, 'new');
      assert.equal(made.helper.poison(host, 4)?.retryMs, hour);
    } finally {
      await stop(made);
    }
  });
});
