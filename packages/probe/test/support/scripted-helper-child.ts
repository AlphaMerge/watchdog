import { existsSync, writeFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { systemLookup } from '@ms/sensors/system-lookup';
import {
  runHelperChild,
  type ChildLookup,
  type ChildMessage,
  type HelperAddress,
  type ReadyMessage,
} from '../../src/resolver/lookup-helper-child.js';

/**
 * A lookup helper child whose lookups and liveness a test scripts (`P-432`, U1–U22): the
 * production child's `runHelperChild`, handed a scripted `lookup` and hooks.
 *
 * **Names it answers:**
 * - `delay-<ms>.ok.test`: 192.0.2.1 after `ms` on the child's clock;
 * - `eai-again-<ms>.test`: `EAI_AGAIN` after `ms`;
 * - `enotfound.test`, `enodata.test`: those codes, in Node's words; `nocode.test`: no code at all;
 * - `addresses-<n>.test`: `n` addresses;
 * - `hang.test`: never;
 * - `crash.test`, and any name ending `.crash.test`: a line on stderr, then SIGABRT;
 * - `late-crash-<ms>.test`: the same after `ms`, so that a bound for stuck shorter than `ms`
 *   has the child say it is stuck first, as a crash on a slow reply would;
 * - `crash-unless:<path>`: crashes the first time (making `path`), answers after;
 * - `answer-then-abort.test`: answers, and aborts right after the answer is written;
 * - `fifo:<path>`: makes `<path>.open`, then opens the FIFO `path` for reading, holding a libuv
 *   thread until something writes it; answers 192.0.2.1 once it is written;
 * - `fifo-open:<path>`: answers once the FIFO is opened for writing, in one trip through the pool;
 * - `block-<ms>:<marker>`: makes `marker`, holds the child's main thread for `ms`, then makes
 *   `<marker>.done`;
 * - `test-mute`: answers, then sends nothing at all until SIGUSR2;
 * - `test-rss-high`: answers, and every later beat reports `SCRIPT_RSS_HIGH` bytes;
 * - `test-mute-rss-high`: both at once: muted, and the beats SIGUSR1 lets through report it;
 * - anything else: the system's.
 *
 * **Signals:** SIGUSR1 lets one beat through while muted; SIGUSR2 unmutes, or releases the ready
 * under `SCRIPT_READY=on-signal`.
 *
 * **Environment:** `SCRIPT_READY` (`never`, `on-signal`); `SCRIPT_SELFTEST=fail` (its
 * `127.1` fails); `SCRIPT_BEAT_INFLIGHT` (what its beats say is in flight), on every beat or, with
 * `SCRIPT_BEAT_LIES` (`1` lies, `0` tells the truth, one character per beat from the first, and
 * the truth after), on the beats it names; `SCRIPT_READY_ORDER`,
 * `SCRIPT_READY_NODE`, `SCRIPT_READY_GLIBC` (`null` for none), `SCRIPT_READY_THREADS`: what its
 * ready says; `SCRIPT_RSS`: the resident set its beats report; marker files written synchronously
 * as a thing is sent: `SCRIPT_LISTENING` (its signal handlers are in), `SCRIPT_READY_MARK`,
 * `SCRIPT_ANSWER_MARK` (any answer) and `SCRIPT_BEAT_MARK` (the first beat after SIGUSR1 or
 * SIGUSR2).
 */

const env = process.env;
const MUTE_ACK = '192.0.2.250';
const RSS_ACK = '192.0.2.251';
const MUTE_RSS_ACK = '192.0.2.252';
const ABORT_ACK = '192.0.2.99';
const OK: readonly HelperAddress[] = [{ address: '192.0.2.1', family: 4 }];

let muted = false;
let credit = 0;
let beatArmed = false;
let rss: number | undefined =
  env['SCRIPT_RSS'] === undefined ? undefined : Number(env['SCRIPT_RSS']);
let releaseReady: (() => void) | undefined;
/** SIGUSR2 came under `SCRIPT_READY=on-signal`, perhaps before the ready was waiting for it. */
let readySignalled = false;

function mark(path: string | undefined, text = ''): void {
  if (path !== undefined && path !== '') writeFileSync(path, text);
}

function failure(code: string, host: string): Error {
  return Object.assign(new Error(`getaddrinfo ${code} ${host}`), {
    code,
    syscall: 'getaddrinfo',
    hostname: host,
  });
}

function crash(host: string): never {
  // Synchronous on a pipe: the parent has it before the signal. SIGABRT from outside the runtime,
  // as a crash in getaddrinfo would be, so that Node adds no stack of its own after the line.
  process.stderr.write(`scripted crash: ${host}\n`);
  process.kill(process.pid, 'SIGABRT');
  throw new Error('a SIGABRT that did not end the process');
}

const lookup: ChildLookup = async (host, family) => {
  const delay = /^delay-(\d+)\.ok\.test$/u.exec(host);
  if (delay !== null) {
    await sleep(Number(delay[1]));
    return OK;
  }
  const again = /^eai-again-(\d+)\.test$/u.exec(host);
  if (again !== null) {
    await sleep(Number(again[1]));
    throw failure('EAI_AGAIN', host);
  }
  const many = /^addresses-(\d+)\.test$/u.exec(host);
  if (many !== null) {
    return Array.from({ length: Number(many[1]) }, (_, i) => ({
      address: `198.51.100.${String(i + 1)}`,
      family: 4,
    }));
  }
  if (host === '127.1' && env['SCRIPT_SELFTEST'] === 'fail') throw failure('EAI_NONAME', host);
  if (host === 'enotfound.test') throw failure('ENOTFOUND', host);
  if (host === 'enodata.test') throw failure('ENODATA', host);
  if (host === 'nocode.test') throw new Error('a failure that says no code');
  if (host === 'hang.test') return new Promise<never>(() => {});
  const lateCrash = /^late-crash-(\d+)\.test$/u.exec(host);
  if (lateCrash !== null) {
    await sleep(Number(lateCrash[1]));
    crash(host);
  }
  if (host === 'crash.test' || host.endsWith('.crash.test')) crash(host);
  if (host.startsWith('crash-unless:')) {
    const path = host.slice('crash-unless:'.length);
    if (!existsSync(path)) {
      writeFileSync(path, '');
      crash(host);
    }
    return OK;
  }
  if (host === 'answer-then-abort.test') return [{ address: ABORT_ACK, family: 4 }];
  if (host.startsWith('fifo-open:')) {
    // One trip through libuv's pool: its completion is read in one poll phase.
    const handle = await open(host.slice('fifo-open:'.length), 'r');
    void handle.close();
    return OK;
  }
  const block = /^block-(\d+):(.+)$/u.exec(host);
  if (block !== null) {
    // The child's main thread held, as a stall would hold it: nothing it has is read meanwhile.
    const marker = block[2] ?? '';
    mark(marker);
    const until = Date.now() + Number(block[1]);
    while (Date.now() < until) {
      // Stalled.
    }
    mark(`${marker}.done`);
    return OK;
  }
  if (host.startsWith('fifo:')) {
    const path = host.slice('fifo:'.length);
    mark(`${path}.open`);
    await readFile(path);
    return OK;
  }
  if (host === 'test-mute') return [{ address: MUTE_ACK, family: 4 }];
  if (host === 'test-rss-high') return [{ address: RSS_ACK, family: 4 }];
  if (host === 'test-mute-rss-high') return [{ address: MUTE_RSS_ACK, family: 4 }];
  return systemLookup(host, family);
};

process.on('SIGUSR1', () => {
  credit += 1;
  beatArmed = true;
});
process.on('SIGUSR2', () => {
  if (env['SCRIPT_READY'] === 'on-signal' && !readySignalled) {
    readySignalled = true;
    releaseReady?.();
    return;
  }
  muted = false;
  beatArmed = true;
});
mark(env['SCRIPT_LISTENING']);

/** What the ready says: what the child found, less what the script has it lie about. */
const readyAs = (found: ReadyMessage): ReadyMessage => ({
  ...found,
  ...(env['SCRIPT_READY_ORDER'] === undefined ? {} : { order: env['SCRIPT_READY_ORDER'] }),
  ...(env['SCRIPT_READY_NODE'] === undefined ? {} : { node: env['SCRIPT_READY_NODE'] }),
  ...(env['SCRIPT_READY_GLIBC'] === undefined
    ? {}
    : { glibc: env['SCRIPT_READY_GLIBC'] === 'null' ? null : env['SCRIPT_READY_GLIBC'] }),
  ...(env['SCRIPT_READY_THREADS'] === undefined
    ? {}
    : { threads: Number(env['SCRIPT_READY_THREADS']) }),
});

const firstAddress = (message: ChildMessage): string | undefined =>
  message.t === 'answer' && message.ok ? message.addresses[0]?.address : undefined;

runHelperChild(lookup, {
  sending: (message) => {
    if (!muted) return true;
    if (message.t === 'beat' && credit > 0) {
      credit -= 1;
      return true;
    }
    return false;
  },
  sent: (message) => {
    if (message.t === 'ready') mark(env['SCRIPT_READY_MARK']);
    if (message.t === 'answer') mark(env['SCRIPT_ANSWER_MARK'], String(message.id));
    if (message.t === 'beat' && beatArmed) {
      beatArmed = false;
      mark(env['SCRIPT_BEAT_MARK'], String(message.seq));
    }
    const first = firstAddress(message);
    if (first === MUTE_ACK || first === MUTE_RSS_ACK) muted = true;
    if (first === RSS_ACK || first === MUTE_RSS_ACK) {
      rss = Number(env['SCRIPT_RSS_HIGH'] ?? String(300 * 1024 * 1024));
    }
    if (first === ABORT_ACK) process.kill(process.pid, 'SIGABRT');
  },
  rss: () => rss ?? process.memoryUsage.rss(),
  rewrite: (message) => {
    const lies = env['SCRIPT_BEAT_LIES'];
    const lie = lies === undefined || (message.t === 'beat' && lies[message.seq - 1] === '1');
    if (message.t === 'beat' && env['SCRIPT_BEAT_INFLIGHT'] !== undefined && lie) {
      return { ...message, inFlight: Number(env['SCRIPT_BEAT_INFLIGHT']) };
    }
    return message.t === 'ready' ? readyAs(message) : message;
  },
  beforeReady: () => {
    if (env['SCRIPT_READY'] === 'never') return new Promise<void>(() => {});
    if (env['SCRIPT_READY'] === 'on-signal' && !readySignalled) {
      return new Promise<void>((resolve) => {
        releaseReady = resolve;
      });
    }
    return Promise.resolve();
  },
});
