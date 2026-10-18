import { createHash } from 'node:crypto';
import { getDefaultResultOrder, setDefaultResultOrder } from 'node:dns';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { systemLookup } from '@ms/sensors/system-lookup';

/**
 * The probe's lookup helper, its child side (`P-432`, design §1.11): a long-lived process the probe
 * starts, which runs `getaddrinfo` for the names the probe will not ask on its own lookup lanes.
 *
 * **Why a process.** `getaddrinfo` cannot be cancelled, and one that never returns holds a libuv
 * thread for good. ADR-001's rule is that whatever can hang runs in a child process: a name that
 * hangs here holds this process's threads, never the probe's, and a name that crashes
 * `getaddrinfo` crashes this process, never the probe.
 *
 * **It makes exactly `systemResolve`'s call** (`systemLookup`), with hints 0 and the probe's
 * address order (`--order`), so an answer from here is the answer the probe would have had.
 *
 * **It imports only `node:*` and `@ms/sensors/system-lookup`**, never the probe or the sensors'
 * root, which pulls in the catalogue (`P-258`: 0.45–14.8 s to import under load). The parent
 * imports this module for the protocol's types and constants; nothing here runs unless this file
 * is the process's entry (`runs` below).
 *
 * **The child keeps the clock that decides "stuck"** (D4). `STUCK_MS` after it called
 * `getaddrinfo` it says `stuck` for a lookup still running, decided after polls, so an answer
 * already completed is sent first and no `stuck` follows it. The probe never times a helper lookup
 * itself: a probe stalled for 3 s would otherwise call stuck a lookup that answered in 1.5.
 *
 * **It beats every `--beat-ms`** with its resident set, its lookups in flight (and the last ask it
 * had read when it counted them) and its event loop's worst delay. The probe judges it alive by counting its own ticks with nothing read
 * (`lookup-helper.ts`), not by a deadline.
 *
 * **It never writes stderr on its normal path**: a pipe write is synchronous on Linux, and a
 * probe slow to read it would stall the lookups. Only a fatal error writes there, before it dies.
 *
 * **On `disconnect` it kills itself with SIGKILL.** `process.exit()` is believed to join libuv's
 * threads, and so to wait for every `getaddrinfo` still running, which a hung one never ends (U13
 * pins it). This covers a probe that was itself SIGKILLed or OOM-killed; `KillMode=mixed` is the
 * second backstop.
 */

/** The protocol this child speaks. The parent passes the one it speaks (`--protocol`). */
export const HELPER_PROTOCOL = 1;
/** What `ps` shows for it. */
export const HELPER_TITLE = 'ms-probe: lookups';
/** What a read-once file's digest is when the file is absent. */
export const DIGEST_ABSENT = 'absent';

export type HelperFamily = 0 | 4 | 6;
export type ResultOrder = 'ipv4first' | 'ipv6first' | 'verbatim';

/** One address `getaddrinfo` answered with. */
export interface HelperAddress {
  readonly address: string;
  readonly family: number;
}

/** What the child asks the system: `systemLookup` in production, a script in tests. */
export type ChildLookup = (host: string, family: HelperFamily) => Promise<readonly HelperAddress[]>;

/** parent → child. Sent only while the helper is up, and only under a token. */
export interface AskMessage {
  readonly t: 'ask';
  /** From one parent-wide counter, never reused across children. */
  readonly id: number;
  readonly host: string;
  readonly family: HelperFamily;
  /** The most addresses the probe uses for one name: the child sends at most one more. */
  readonly max: number;
}

/** child → parent, once, after its self-test: what it is, for the parent to check against itself. */
export interface ReadyMessage {
  readonly t: 'ready';
  readonly protocol: number;
  readonly order: string;
  /** libuv's threads, as libuv reads `UV_THREADPOOL_SIZE`. */
  readonly threads: number;
  readonly pid: number;
  /** `getaddrinfo` answered `127.1` with 127.0.0.1: an `inet_aton` form glibc parses before NSS. */
  readonly selfTest: boolean;
  /** `process.version`. */
  readonly node: string;
  /** glibc's runtime version, or null off glibc. */
  readonly glibc: string | null;
  /** Its own reading of each read-once file the parent named (D28). */
  readonly digests: Readonly<Record<string, string>>;
}

export interface AnswerMessage {
  readonly t: 'answer';
  readonly id: number;
  readonly ok: true;
  /** How many addresses `getaddrinfo` gave: the cap is judged on this (O-OS-9). */
  readonly total: number;
  /** The first `max + 1` of them, in `getaddrinfo`'s order. */
  readonly addresses: readonly HelperAddress[];
  /** How long the lookup ran, on the child's clock. */
  readonly ranMs: number;
}

export interface FailedMessage {
  readonly t: 'answer';
  readonly id: number;
  readonly ok: false;
  /** `getaddrinfo`'s code (`ENOTFOUND`, `EAI_AGAIN`…), or null when the error had none. */
  readonly code: string | null;
  readonly message: string;
  readonly ranMs: number;
}

export interface StuckMessage {
  readonly t: 'stuck';
  readonly id: number;
  readonly ranMs: number;
}

export interface BeatMessage {
  readonly t: 'beat';
  readonly seq: number;
  /** Resident set, bytes. */
  readonly rss: number;
  readonly inFlight: number;
  /**
   * The highest ask id it had read when it counted `inFlight`: asks with higher ids were still in
   * the pipe, and the probe leaves them out of its side of the count.
   */
  readonly asked: number;
  /** The event loop's worst delay since the last beat. */
  readonly lagMaxMs: number;
}

export interface FatalMessage {
  readonly t: 'fatal';
  readonly message: string;
}

export type ChildMessage =
  ReadyMessage | AnswerMessage | FailedMessage | StuckMessage | BeatMessage | FatalMessage;

/** What the parent starts the child with. */
export interface HelperChildArgs {
  readonly protocol: number;
  readonly order: string;
  readonly stuckMs: number;
  readonly beatMs: number;
  /** The read-once files whose digests `ready` echoes (D28). */
  readonly digests: readonly string[];
}

/** The child's argv, from what the parent wants. The one place both ends agree on. */
export function helperChildArgs(args: HelperChildArgs): string[] {
  return [
    `--protocol=${String(args.protocol)}`,
    `--order=${args.order}`,
    `--stuck-ms=${String(args.stuckMs)}`,
    `--beat-ms=${String(args.beatMs)}`,
    ...args.digests.map((file) => `--digest=${file}`),
  ];
}

/** The parent's argv read back, or what was wrong with it. */
export function parseHelperChildArgs(argv: readonly string[]): HelperChildArgs | string {
  let protocol: number | undefined;
  let order: string | undefined;
  let stuckMs: number | undefined;
  let beatMs: number | undefined;
  const digests: string[] = [];
  const count = (value: string): number | undefined => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? '' : arg.slice(eq + 1);
    if (name === '--protocol') protocol = count(value);
    else if (name === '--order') order = value;
    else if (name === '--stuck-ms') stuckMs = count(value);
    else if (name === '--beat-ms') beatMs = count(value);
    else if (name === '--digest' && value !== '') digests.push(value);
  }
  if (protocol === undefined) return 'it was started without a protocol';
  if (order === undefined) return 'it was started without an address order';
  if (stuckMs === undefined || stuckMs === 0) return 'it was started without a bound for stuck';
  if (beatMs === undefined || beatMs === 0) return 'it was started without a beat';
  return { protocol, order, stuckMs, beatMs, digests };
}

/**
 * A read-once file's digest (D28): sha256 of its bytes, `absent` when it does not exist, and
 * `unreadable:<code>` otherwise. The policy records the probe's at start, and the child its own:
 * the two must agree, or the two processes read different files.
 */
export async function readOnceDigest(file: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return DIGEST_ABSENT;
    return `unreadable:${typeof code === 'string' ? code : 'unknown'}`;
  }
}

/** glibc's runtime version, as Node's diagnostic report gives it, or null off glibc. */
export function glibcRuntime(): string | null {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
  const version = report.header?.glibcVersionRuntime;
  return typeof version === 'string' ? version : null;
}

/**
 * libuv's threads, as libuv reads `UV_THREADPOOL_SIZE` when its pool starts: 4 unset, at least 1,
 * at most 1,024. The probe's `threadpoolSize`, repeated here so the child imports nothing of the
 * probe.
 */
export function threadpoolThreads(setting: string | undefined): number {
  if (setting === undefined) return 4;
  const parsed = Number.parseInt(setting, 10);
  if (Number.isNaN(parsed) || parsed === 0) return 1;
  if (parsed < 0 || parsed > 1_024) return 1_024;
  return parsed;
}

/** `verdict-timer.ts`'s `afterPolls`, repeated here so the child imports nothing of the probe. */
function afterPolls(fn: () => void): void {
  setImmediate(() => {
    setImmediate(fn);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOrder(value: string): value is ResultOrder {
  return value === 'ipv4first' || value === 'ipv6first' || value === 'verbatim';
}

/** The parent's message, if it is an ask this child can run. */
export function readAsk(raw: unknown): AskMessage | undefined {
  if (!isRecord(raw) || raw['t'] !== 'ask') return undefined;
  const { id, host, family, max } = raw;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return undefined;
  if (typeof host !== 'string' || host.length > 1_024) return undefined;
  if (family !== 0 && family !== 4 && family !== 6) return undefined;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 0) return undefined;
  return { t: 'ask', id, host, family, max };
}

/** How a scripted child (tests) changes what this one does. Production passes none. */
export interface HelperChildOptions {
  /** Every message passes here before it is sent: false drops it (a scripted child's mute). */
  readonly sending?: (message: ChildMessage) => boolean;
  /** Called once a message has been handed to the channel (a scripted child's crash after it). */
  readonly sent?: (message: ChildMessage) => void;
  /** The resident set the beat reports. `process.memoryUsage.rss()` unless a script says. */
  readonly rss?: () => number;
  /** What a message says, given what the child found (a scripted child's lie about itself). */
  readonly rewrite?: (message: ChildMessage) => ChildMessage;
  /** Waited for before `ready` is sent (a scripted child's late start). */
  readonly beforeReady?: () => Promise<void>;
}

/**
 * Runs this process as the lookup helper: answers the parent's asks with `lookup`, says `stuck`
 * on its own clock, and beats. Returns at once; the process lives while its channel does.
 */
export function runHelperChild(lookup: ChildLookup, options: HelperChildOptions = {}): void {
  process.title = HELPER_TITLE;
  const die = (): void => {
    process.kill(process.pid, 'SIGKILL');
  };
  // The parent gone: nothing is left to answer, and a lookup that never returns must not hold
  // this process. SIGKILL, not `process.exit()`, which waits for libuv's threads.
  process.on('disconnect', die);

  if (process.send === undefined) {
    process.stderr.write('the lookup helper is started by ms-probe: it has no channel to it\n');
    process.exitCode = 2;
    return;
  }

  const send = (found: ChildMessage, then?: () => void): void => {
    const message = options.rewrite?.(found) ?? found;
    if (options.sending?.(message) === false) return;
    try {
      // A callback on every send: a channel already closed is an error handed to it, never an
      // 'error' event, and 'disconnect' ends this process anyway.
      process.send?.(message, undefined, {}, () => then?.());
      options.sent?.(message);
    } catch {
      // The channel is gone: 'disconnect' ends this process.
    }
  };

  let fatalSaid = false;
  const fatal = (why: string): void => {
    if (fatalSaid) return;
    fatalSaid = true;
    // The one write to stderr: the parent keeps its tail for the line it logs about the loss.
    try {
      process.stderr.write(`ms-probe lookup helper: ${why}\n`);
    } catch {
      // Nothing more to say it with.
    }
    send({ t: 'fatal', message: why }, die);
    // Whether or not the parent took it.
    setTimeout(die, 200).unref();
  };
  process.on('uncaughtException', (error: unknown) => {
    fatal(`an uncaught exception: ${error instanceof Error ? error.message : String(error)}`);
  });
  process.on('unhandledRejection', (error: unknown) => {
    fatal(`an unhandled rejection: ${error instanceof Error ? error.message : String(error)}`);
  });

  const args = parseHelperChildArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    fatal(args);
    return;
  }
  if (args.protocol !== HELPER_PROTOCOL) {
    fatal(
      `this lookup helper speaks protocol ${String(HELPER_PROTOCOL)}, and the probe that started ` +
        `it speaks ${String(args.protocol)}: restart ms-probe after an upgrade`,
    );
    return;
  }
  if (!isOrder(args.order)) {
    fatal(`it cannot set the address order ${args.order}`);
    return;
  }
  try {
    setDefaultResultOrder(args.order);
  } catch (error: unknown) {
    fatal(
      `it cannot set the address order ${args.order}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  /** The highest ask id read: ids only grow, and the channel keeps their order. */
  let lastAsk = 0;
  /** Lookups asked and not yet answered, by id. */
  const inFlight = new Map<
    number,
    { readonly startedAt: number; readonly stuck: NodeJS.Timeout }
  >();

  const run = (ask: AskMessage): void => {
    if (inFlight.has(ask.id)) {
      fatal(`the probe asked lookup ${String(ask.id)} twice`);
      return;
    }
    const startedAt = performance.now();
    const ranMs = (): number => Math.round(performance.now() - startedAt);
    // The child's clock decides stuck (D4), after polls, so an answer already in hand goes first.
    const stuck = setTimeout(() => {
      afterPolls(() => {
        if (inFlight.get(ask.id) === entry) send({ t: 'stuck', id: ask.id, ranMs: ranMs() });
      });
    }, args.stuckMs);
    stuck.unref();
    const entry = { startedAt, stuck };
    inFlight.set(ask.id, entry);
    const done = (): boolean => {
      if (inFlight.get(ask.id) !== entry) return false;
      inFlight.delete(ask.id);
      clearTimeout(stuck);
      return true;
    };
    let asked: Promise<readonly HelperAddress[]>;
    try {
      asked = lookup(ask.host, ask.family);
    } catch (error: unknown) {
      asked = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    asked.then(
      (found) => {
        if (!done()) return;
        const addresses = found.map(({ address, family }) => ({ address, family }));
        send({
          t: 'answer',
          id: ask.id,
          ok: true,
          total: addresses.length,
          addresses: addresses.slice(0, ask.max + 1),
          ranMs: ranMs(),
        });
      },
      (error: unknown) => {
        if (!done()) return;
        const code = (error as { code?: unknown } | null)?.code;
        send({
          t: 'answer',
          id: ask.id,
          ok: false,
          code: typeof code === 'string' && code !== '' ? code : null,
          message: error instanceof Error ? error.message : String(error),
          ranMs: ranMs(),
        });
      },
    );
  };

  process.on('message', (raw: unknown) => {
    const ask = readAsk(raw);
    if (ask === undefined) {
      fatal('the probe sent a message it cannot read');
      return;
    }
    lastAsk = Math.max(lastAsk, ask.id);
    run(ask);
  });

  const start = async (): Promise<void> => {
    // `127.1` is an `inet_aton` form glibc parses before NSS and nscd: it needs no network and no
    // NSS, so it proves the thread pool and `getaddrinfo` answer here at all.
    const selfTest = await lookup('127.1', 4).then(
      (found) => {
        const only = found.length === 1 ? found[0] : undefined;
        return only?.address === '127.0.0.1' && only.family === 4;
      },
      () => false,
    );
    const digests: Record<string, string> = {};
    for (const file of args.digests) digests[file] = await readOnceDigest(file);
    await options.beforeReady?.();
    const found: ReadyMessage = {
      t: 'ready',
      protocol: HELPER_PROTOCOL,
      order: getDefaultResultOrder(),
      threads: threadpoolThreads(process.env['UV_THREADPOOL_SIZE']),
      pid: process.pid,
      selfTest,
      node: process.version,
      glibc: glibcRuntime(),
      digests,
    };
    send(found);

    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    let seq = 0;
    const beat = setInterval(() => {
      afterPolls(() => {
        seq += 1;
        const lagMaxMs = Math.round(delay.max / 1e6);
        delay.reset();
        send({
          t: 'beat',
          seq,
          rss: options.rss?.() ?? process.memoryUsage.rss(),
          inFlight: inFlight.size,
          asked: lastAsk,
          lagMaxMs,
        });
      });
    }, args.beatMs);
    beat.unref();
  };
  start().catch((error: unknown) => {
    fatal(`it could not start: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Whether this module is the process's entry: its own path, symlinks resolved on both sides. */
function runs(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (runs(import.meta.url)) runHelperChild(systemLookup);
