import { EventEmitter } from 'node:events';
import type { ResolvedAddress } from '@ms/sensors';
import {
  glibcRuntime,
  parseHelperChildArgs,
  readOnceDigest,
  type AskMessage,
  type ChildMessage,
} from '../../src/resolver/lookup-helper-child.js';
import {
  REAL_TIMERS,
  type ForkHelper,
  type HelperProcess,
  type HelperTimer,
  type HelperTimers,
} from '../../src/resolver/lookup-helper.js';

/**
 * The lookup helper's child as the outage scenarios play it (`P-432` S3, `M-17`): the real
 * `LookupHelper` forks this in place of a process, and it speaks the child's protocol as the
 * production child does: a `ready` with its own reading of the read-once files, an answer or
 * `EAI_AGAIN` for each ask, `stuck` past the parent's bound for stuck, a beat when the scenario
 * ticks, and an exit when it is killed or a name crashes it. What each name does is the zones'.
 *
 * A child can be starved (`hold`, `P-463` fix round 1), as on a host whose CPU is taken: from then
 * it says nothing, its beats lost and its answers kept until `release` says them, so the helper
 * finds it quiet with its lookups in flight.
 *
 * And the helper's clock and timers on the scenario's clock: a timeout shorter than a minute is
 * the process's (the backoff, the start's bounds, the stop's), so the helper respawns at once as
 * it would; a longer one (a rest) fires when the scenario's clock passes it; the liveness tick
 * fires when the scenario ticks it, after a beat.
 */

/**
 * What one name does in the child: answers, is silent (`EAI_AGAIN` after `hangMs`), or crashes it,
 * at once or `afterMs` into its lookup (a crash on a slow reply, after the child said it was stuck).
 */
export type ZoneAnswer =
  | { readonly kind: 'answer'; readonly addresses: readonly ResolvedAddress[] }
  | { readonly kind: 'silent' }
  | { readonly kind: 'crash'; readonly afterMs?: number };

export interface ZoneScript {
  answer(host: string): ZoneAnswer;
  /** How long a silent name runs before `EAI_AGAIN`: never, unless set. */
  readonly hangMs?: number | undefined;
  /** Told of each ask the child takes, and of each as it ends, however it ends. */
  readonly began?: (host: string) => void;
  readonly ended?: (host: string, how: 'answered' | 'failed' | 'lost') => void;
}

interface Flight {
  readonly host: string;
  readonly timers: NodeJS.Timeout[];
}

export class ZoneChild extends EventEmitter implements HelperProcess {
  readonly stderr = null;
  readonly channel = { unref: (): void => {} };
  #alive = true;
  #seq = 0;
  #asked = 0;
  readonly #flights = new Map<number, Flight>();
  readonly #stuckMs: number;
  /** Starved: what it would have said, in order, kept for `release`. */
  #held: ChildMessage[] | undefined;

  constructor(
    readonly pid: number,
    args: readonly string[],
    readonly script: ZoneScript,
  ) {
    super();
    const parsed = parseHelperChildArgs(args);
    if (typeof parsed === 'string') throw new Error(`the zone child’s arguments: ${parsed}`);
    this.#stuckMs = parsed.stuckMs;
    void (async () => {
      // Read on a later turn, as from the pipe: never before the helper listens, files or none.
      await new Promise((resolve) => setImmediate(resolve));
      const digests: Record<string, string> = {};
      for (const file of parsed.digests) digests[file] = await readOnceDigest(file);
      this.#say({
        t: 'ready',
        protocol: parsed.protocol,
        order: parsed.order,
        threads: 32,
        pid,
        selfTest: true,
        node: process.version,
        glibc: glibcRuntime(),
        digests,
      });
    })();
  }

  get alive(): boolean {
    return this.#alive;
  }

  /** Its lookups running now. */
  inFlight(): number {
    return this.#flights.size;
  }

  send(message: AskMessage, callback: (error: Error | null) => void): boolean {
    if (!this.#alive) {
      queueMicrotask(() => {
        callback(new Error('the channel is closed'));
      });
      return false;
    }
    queueMicrotask(() => {
      callback(null);
    });
    // Read on a later turn, as from the pipe.
    setImmediate(() => {
      this.#ask(message);
    });
    return true;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.#alive) {
      setImmediate(() => {
        this.die(signal);
      });
    }
    return true;
  }

  unref(): void {}

  /** Starved from now: no beat, and every answer kept until `release`. */
  hold(): void {
    this.#held ??= [];
  }

  /** No longer starved: what it kept is said now, in the order it would have been. */
  release(): void {
    const held = this.#held ?? [];
    this.#held = undefined;
    for (const message of held) this.#say(message);
  }

  /** One beat, with what it is running, as the child sends every `--beat-ms`; none if starved. */
  beat(): void {
    if (this.#held !== undefined) return;
    this.#seq += 1;
    this.#say({
      t: 'beat',
      seq: this.#seq,
      rss: 32 * 1024 * 1024,
      inFlight: this.#flights.size,
      asked: this.#asked,
      lagMaxMs: 0,
    });
  }

  /** Ended by a signal: every lookup in it gone with it, then its channel. */
  die(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (!this.#alive) return;
    this.#alive = false;
    for (const [id, flight] of this.#flights) {
      for (const timer of flight.timers) clearTimeout(timer);
      this.#flights.delete(id);
      this.script.ended?.(flight.host, 'lost');
    }
    this.emit('exit', null, signal);
    setImmediate(() => {
      this.emit('disconnect');
      this.emit('close');
    });
  }

  #say(message: ChildMessage): void {
    if (!this.#alive) return;
    if (this.#held !== undefined) {
      this.#held.push(message);
      return;
    }
    this.emit('message', message);
  }

  #ask(ask: AskMessage): void {
    if (!this.#alive) return;
    this.#asked = Math.max(this.#asked, ask.id);
    const said = this.script.answer(ask.host);
    if (said.kind === 'crash' && said.afterMs === undefined) {
      this.die('SIGSEGV');
      return;
    }
    const started = performance.now();
    const ranMs = (): number => Math.round(performance.now() - started);
    const flight: Flight = { host: ask.host, timers: [] };
    this.#flights.set(ask.id, flight);
    this.script.began?.(ask.host);
    const end = (message: ChildMessage, how: 'answered' | 'failed'): void => {
      if (this.#flights.get(ask.id) !== flight) return;
      for (const timer of flight.timers) clearTimeout(timer);
      this.#flights.delete(ask.id);
      this.script.ended?.(ask.host, how);
      this.#say(message);
    };
    if (said.kind === 'answer') {
      setImmediate(() => {
        end(
          {
            t: 'answer',
            id: ask.id,
            ok: true,
            total: said.addresses.length,
            addresses: said.addresses.slice(0, ask.max + 1),
            ranMs: ranMs(),
          },
          'answered',
        );
      });
      return;
    }
    flight.timers.push(
      setTimeout(() => {
        if (this.#flights.get(ask.id) === flight) {
          this.#say({ t: 'stuck', id: ask.id, ranMs: ranMs() });
        }
      }, this.#stuckMs),
    );
    if (said.kind === 'crash') {
      flight.timers.push(
        setTimeout(() => {
          this.die('SIGSEGV');
        }, said.afterMs),
      );
      return;
    }
    const hangMs = this.script.hangMs;
    if (hangMs !== undefined) {
      flight.timers.push(
        setTimeout(() => {
          end(
            {
              t: 'answer',
              id: ask.id,
              ok: false,
              code: 'EAI_AGAIN',
              message: `getaddrinfo EAI_AGAIN ${ask.host}`,
              ranMs: ranMs(),
            },
            'failed',
          );
        }, hangMs),
      );
    }
  }
}

/** A `fork` that makes zone children, each kept, newest last. */
export function zoneFork(script: ZoneScript): {
  readonly fork: ForkHelper;
  readonly children: ZoneChild[];
} {
  const children: ZoneChild[] = [];
  return {
    children,
    fork: (_module, args) => {
      const child = new ZoneChild(70_000 + children.length, args, script);
      children.push(child);
      return child;
    },
  };
}

interface Virtual {
  readonly fn: () => void;
  readonly due: number;
}

/** A timeout this long or longer is the scenario clock's; a shorter one is the process's. */
const LONG_MS = 60_000;

export class ScenarioTimers implements HelperTimers {
  readonly #virtual = new Set<Virtual>();
  readonly #ticks = new Set<{ readonly fn: () => void }>();

  constructor(readonly clock: { readonly now: number }) {}

  now(): number {
    return this.clock.now;
  }

  setTimeout(fn: () => void, ms: number, keepAlive?: boolean): HelperTimer {
    if (ms < LONG_MS) return REAL_TIMERS.setTimeout(fn, ms, keepAlive);
    const timer: Virtual = { fn, due: this.clock.now + ms };
    this.#virtual.add(timer);
    return timer;
  }

  clearTimeout(timer: HelperTimer | undefined): void {
    if (timer === undefined) return;
    if (this.#virtual.delete(timer as Virtual)) return;
    REAL_TIMERS.clearTimeout(timer);
  }

  setInterval(fn: () => void): HelperTimer {
    const tick = { fn };
    this.#ticks.add(tick);
    return tick;
  }

  clearInterval(timer: HelperTimer | undefined): void {
    if (timer !== undefined) this.#ticks.delete(timer as { readonly fn: () => void });
  }

  /** Fires every long timeout the clock has passed, oldest first; how many it fired. */
  fireDue(): number {
    const due = [...this.#virtual]
      .filter((timer) => timer.due <= this.clock.now)
      .sort((a, b) => a.due - b.due);
    for (const timer of due) {
      this.#virtual.delete(timer);
      timer.fn();
    }
    return due.length;
  }

  /** One liveness tick, as Node would call it. */
  tick(): void {
    for (const tick of [...this.#ticks]) tick.fn();
  }
}
