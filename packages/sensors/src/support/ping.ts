import type { CheckTarget } from '../contract.js';
import { PhasedError } from './phased-error.js';

/**
 * Where a ping failed (`P-406`): the echoes, which the device did not answer (`echo`); the
 * lookup of the device's name, which `ping` makes itself and its resolver did not know
 * (`resolve`); or the `ping` program, which this probe could not run or could not ping from
 * (`exec`, with no host: the device was never asked).
 */
export type PingPhase = 'resolve' | 'echo' | 'exec';

export class PingError extends PhasedError {
  override readonly phase: PingPhase;

  constructor(message: string, where: { phase: PingPhase; host?: string | undefined }) {
    super(message, where);
    this.name = 'PingError';
    this.phase = where.phase;
  }
}

/**
 * Building and reading `ping`, kept separate from running it.
 *
 * ADR-001 makes the system `ping` binary the default ICMP path. What it costs us is three
 * output formats and three sets of flags, and that is exactly why this file is pure: every
 * platform's real output is a fixture in the tests, and none of it needs a network to check.
 *
 * ADR-001 also suggests the `ping` npm wrapper. We do not use it: it exposes no `AbortSignal`
 * (verified against 1.0.0 — the package contains no reference to one), and CLAUDE.md requires
 * every check to honour `ctx.signal`. A check that cannot be cancelled gets its worker
 * terminated on every timeout, which costs more than the wrapper saves.
 */
export type PingPlatform = 'linux' | 'darwin' | 'win32';

export interface PingParams {
  readonly count: number;
  readonly packetSize: number;
  readonly timeoutMs: number;
  /**
   * Seconds between echo requests (`P-07`).
   *
   * **Measured, and the measurement is why this exists.** `ping` waits one second between packets
   * by default, so a count of 4 holds a worker for roughly three seconds — and at 5,000 sensors on
   * a one-minute interval that is more worker-seconds than any plausible pool has. At `-i 0.2` the
   * same check takes about 0.6 s and the same 64 workers move **99 targets a second instead of
   * 20**, with identical reply counts: 4.9x for no privileges, no dependency and no second code
   * path (`docs/findings/2026-08-29-icmp-throughput.md`).
   *
   * **0.2 is the floor, and not an arbitrary one.** iputils documents 200 ms as the lowest a
   * process without `CAP_NET_RAW` may use, and BSD refuses below 0.1 s to anyone but the
   * superuser. Below 0.2 the behaviour depends on how `ping` was installed on the operator's
   * machine, which is not something a default may assume.
   *
   * Absent, or on Windows, no interval flag is passed at all: Windows' `ping` has none, and
   * passing an unknown flag makes it print usage and fail every check.
   */
  readonly intervalSeconds?: number;
}

/**
 * The lowest interval that is safe on every platform without extra privileges (`P-07`).
 *
 * Not a preference — a documented boundary. See `PingParams.intervalSeconds`.
 */
export const MIN_PING_INTERVAL_SECONDS = 0.2;

export interface PingCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** The platform whose flags to use. Anything unrecognised gets the iputils set. */
export function pingPlatform(platform: string): PingPlatform {
  if (platform === 'win32' || platform === 'darwin') return platform;
  return 'linux';
}

/**
 * `-i <seconds>`, or nothing.
 *
 * Shared by the two platforms that have the flag. **Windows does not**, and never gets it: its
 * `ping` would print usage and exit, turning a tuning parameter into an outage on every Windows
 * probe.
 */
function intervalFlag(params: PingParams): string[] {
  const interval = params.intervalSeconds;
  if (interval === undefined || !Number.isFinite(interval) || interval <= 0) return [];
  return ['-i', String(Math.max(MIN_PING_INTERVAL_SECONDS, interval))];
}

/**
 * How long to wait for one reply, in seconds.
 *
 * The operator's overall timeout divided by the packets they asked for, floored at a second: a
 * budget of five seconds over four packets is a wait of two, and a sub-second per-packet wait
 * would call a slow link down.
 */
function perPacketSeconds(params: PingParams): number {
  return Math.max(1, Math.ceil(params.timeoutMs / 1_000 / Math.max(1, params.count)));
}

export function pingCommand(
  platform: PingPlatform,
  target: CheckTarget,
  params: PingParams,
): PingCommand {
  const seconds = Math.max(1, Math.ceil(params.timeoutMs / 1000));
  const family = target.ipVersion === 'v4' ? '-4' : target.ipVersion === 'v6' ? '-6' : null;

  if (platform === 'win32') {
    // Windows has no overall deadline, only a per-reply wait. Dividing the budget by the count
    // keeps the worst case inside the timeout the scheduler is holding a worker for.
    const perPacket = Math.max(100, Math.floor(params.timeoutMs / params.count));
    return {
      command: 'ping',
      args: [
        ...(family === null ? [] : [family]),
        '-n',
        String(params.count),
        '-w',
        String(perPacket),
        '-l',
        String(params.packetSize),
        target.host,
      ],
    };
  }

  if (platform === 'darwin') {
    // BSD ping: -t is the overall deadline in seconds, and -W is per-packet in milliseconds —
    // the opposite of iputils, which is the kind of detail that makes a shared flag list wrong.
    return {
      command: 'ping',
      args: [
        ...(family === null ? [] : [family]),
        '-n',
        '-c',
        String(params.count),
        ...intervalFlag(params),
        '-t',
        String(seconds),
        '-s',
        String(params.packetSize),
        target.host,
      ],
    };
  }

  return {
    command: 'ping',
    args: [
      ...(family === null ? [] : [family]),
      // -n: never reverse-resolve. A DNS lookup inside an ICMP check measures DNS, and a slow
      // resolver would show up as latency to the target.
      '-n',
      '-c',
      String(params.count),
      ...intervalFlag(params),
      // **`-W` per packet, not `-w` overall, and this is `P-07`'s other finding.**
      //
      // `-c` and `-w` interact in a way the iputils manual states and nothing else does: *with a
      // deadline, ping waits for `count` **replies** and keeps transmitting until the deadline
      // expires.* So `-c 4 -w 5` against a host that is down sends five packets over five
      // seconds, not four — measured — and `-c 4 -i 0.2 -w 5` would have sent twenty-five.
      // Lowering the interval without this would have multiplied the traffic aimed at exactly
      // the hosts already in trouble.
      //
      // With `-W` the count means what the form says: **four packets, live or dead**. The run is
      // bounded by `(count - 1) x interval + W` rather than by ping's own deadline, and the
      // check's `AbortSignal` — which `CLAUDE.md` requires anyway — is the outer bound. Measured
      // against a dead host: 1.6 s here against 5.0 s before, and four packets instead of five.
      '-W',
      String(perPacketSeconds(params)),
      '-s',
      String(params.packetSize),
      target.host,
    ],
  };
}

export interface PingOutcome {
  readonly transmitted: number;
  /**
   * Round-trip times, in milliseconds, one per echo reply. Its length is the received count.
   *
   * **First answers only** (`P-282`): a duplicate is not another reply, so it is in neither this
   * nor anything worked out from it — loss, the averages, jitter.
   */
  readonly times: readonly number[];
  /** Answers to an echo request that had already been answered, left out of `times`. */
  readonly duplicates: number;
}

/**
 * `time=0.029 ms`, `time<1ms`, `time=2ms`.
 *
 * Every variant prints one of these per reply, and only for a *reply* — Windows' "Reply from
 * 192.0.2.1: Destination host unreachable." carries no time and is correctly not counted, which
 * is the trap in trusting the words "Reply from".
 */
const REPLY = /\btime\s*[<=]\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i;

/** iputils, BSD and BusyBox all mark a second answer to the same request so (`P-282`). */
const DUPLICATE = /\(DUP!\)/;

/**
 * iputils and BSD: `icmp_seq=3`. Windows prints no sequence and reports no duplicates; BusyBox
 * prints `seq=3`, which this leaves alone, so there the marker is the whole of it.
 */
const SEQUENCE = /\bicmp_seq=(\d+)/;

/** iputils: `4 packets transmitted, 4 received`. BSD: `4 packets transmitted, 4 packets received`. */
const UNIX_SUMMARY = /(\d+)\s+packets transmitted,\s*(\d+)\s+(?:packets\s+)?received/i;

/** Windows: `Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),`. */
const WINDOWS_SUMMARY = /Sent\s*=\s*(\d+),\s*Received\s*=\s*(\d+)/i;

/**
 * What actually happened, from ping's own words.
 *
 * The reply times are counted rather than taken from the summary's min/avg/max, because that
 * line is absent whenever nothing came back and its label differs on every platform
 * (`rtt`, `round-trip`, `Minimum/Maximum/Average`). Counting replies needs one regex for all
 * three, and gives the individual samples rather than a pre-averaged number.
 *
 * `transmitted` comes from the summary when there is one: ping can stop early, and using the
 * requested count as the denominator would report loss that never happened.
 *
 * **A duplicate is not a reply** (`P-282`). A device, a loop or a broadcast address can answer
 * one request more than once, and ping prints every answer with a time. Counted, four requests
 * with two lost and two answered twice read as no loss at all, and the second answers went into
 * the averages and the jitter. A line ping marks `(DUP!)` is counted on its own instead; so is a
 * timed line for a sequence already answered, which is the same fact without the marker — and
 * what the last line of a flood looks like when `PING_OUTPUT_CHARS` cuts it before the marker.
 */
export function parsePingOutput(output: string, requested: number): PingOutcome {
  const times: number[] = [];
  const answered = new Set<string>();
  let duplicates = 0;
  for (const line of output.split(/\r?\n/)) {
    const reply = REPLY.exec(line);
    if (reply === null) continue;
    const value = Number(reply[1]);
    if (!Number.isFinite(value)) continue;
    const sequence = SEQUENCE.exec(line)?.[1];
    if (DUPLICATE.test(line) || (sequence !== undefined && answered.has(sequence))) {
      duplicates += 1;
      continue;
    }
    if (sequence !== undefined) answered.add(sequence);
    times.push(value);
  }

  const summary = UNIX_SUMMARY.exec(output) ?? WINDOWS_SUMMARY.exec(output);
  const transmitted = summary === null ? requested : Number(summary[1]);

  // Only `transmitted` is taken from the summary. The received count is the number of *timed
  // echo replies*, deliberately not the summary's own figure: Windows counts an ICMP
  // "Destination host unreachable" as a received packet, so an unreachable host reports
  // "Received = 2, Lost = 0 (0% loss)" while nothing actually answered the echo. Believing that
  // would report perfect health for a host that is not there.
  return {
    transmitted: Number.isFinite(transmitted) && transmitted > 0 ? transmitted : requested,
    times,
    duplicates,
  };
}

/**
 * Every resolver's words for a name it does not know: iputils (`Name or service not known`,
 * `Temporary failure in name resolution`, `No address associated with hostname`), BSD and macOS
 * (`cannot resolve … Unknown host`), Windows (`could not find host`) and BusyBox (`bad address`).
 */
const UNRESOLVED =
  /Name or service not known|Temporary failure in name resolution|No address associated with hostname|cannot resolve|Unknown host|could not find host|bad address/i;

/**
 * Why a ping that got no reply got none, when it sent nothing (`P-406`). Ping prints its
 * statistics once it has sent echoes, and only then, so without them none went: its resolver
 * did not know the name (`resolve`, on the device's name), or it could not ping from this probe
 * at all, as with a socket it may not open or a route it has not got (`exec`, and no host).
 * Null when it did send them and the device did not answer, which the caller says as `echo`.
 */
export function sentNone(run: PingRun, host: string): PingError | null {
  if (UNIX_SUMMARY.test(run.output) || WINDOWS_SUMMARY.test(run.output)) return null;
  const said = run.detail === '' ? '' : `: ${run.detail}`;
  if (UNRESOLVED.test(run.output)) {
    return new PingError(`ping could not resolve ${host}, so no echo was sent${said}`, {
      phase: 'resolve',
      host,
    });
  }
  return new PingError(`ping sent no echo to ${host}${said}`, { phase: 'exec' });
}

/**
 * What a check's message adds about duplicates: nothing when there were none (`P-282`).
 *
 * Said rather than dropped silently, because a device answering twice is worth knowing in itself
 * — a routing loop or a shared address looks like this — and the message is where a check
 * already gives its counts. Not a channel: no limit set on it would mean anything.
 */
export function duplicatesNote(outcome: Pick<PingOutcome, 'duplicates'>): string {
  if (outcome.duplicates <= 0) return '';
  const noun = outcome.duplicates === 1 ? 'duplicate' : 'duplicates';
  return `, ${String(outcome.duplicates)} ${noun} not counted`;
}

export interface PingStatistics {
  readonly lossPercent: number;
  readonly rttMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

/** Throws for an outcome with no replies: there is no round-trip time to report. */
export function summarise(outcome: Pick<PingOutcome, 'transmitted' | 'times'>): PingStatistics {
  if (outcome.times.length === 0) {
    throw new Error('no replies to summarise');
  }
  const total = outcome.times.reduce((sum, value) => sum + value, 0);
  const lost = Math.max(0, outcome.transmitted - outcome.times.length);
  return {
    lossPercent: outcome.transmitted === 0 ? 0 : round((lost / outcome.transmitted) * 100),
    rttMs: round(total / outcome.times.length),
    minMs: round(Math.min(...outcome.times)),
    maxMs: round(Math.max(...outcome.times)),
  };
}

/** Three decimals: sub-microsecond precision on a loopback ping is noise, not signal. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Jitter, by RFC 3550's estimator (`T-22`).
 *
 * **The standard one rather than a simpler mean deviation, because the people who care about
 * jitter already have a number in their heads.** RFC 3550 §6.4.1 is what RTP reports, what a
 * VoIP engineer quotes, and what every other tool on the network prints; a sensor whose figure
 * disagreed with all of them would be argued with rather than acted on, however defensible the
 * arithmetic.
 *
 * `J = J + (|D(i-1,i)| - J) / 16`, where D is the difference between consecutive round-trip
 * times. The smoothing means a single late packet nudges the figure rather than spiking it,
 * which is the point — one slow reply is not a jittery link.
 *
 * Null when fewer than two replies came back: jitter is a property of the *gaps* between
 * samples, so one sample has none, and reporting zero would say "perfectly stable" about a link
 * that answered once.
 */
export function jitterOf(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  let jitter = 0;
  for (let at = 1; at < times.length; at += 1) {
    const difference = Math.abs((times[at] ?? 0) - (times[at - 1] ?? 0));
    jitter += (difference - jitter) / 16;
  }
  return round(jitter);
}

/** How much of each of ping's streams is kept (`P-277`). */
export const PING_OUTPUT_CHARS = 64 * 1024;

export interface PingRun {
  readonly output: string;
  /** Something worth adding to a failure message: stderr, or why the process ended. */
  readonly detail: string;
}

/**
 * Spawns `ping` and collects what it said.
 *
 * Here rather than in `icmp-ping.ts` since `T-22` added a second caller: `icmp.jitter` needs the
 * identical spawn semantics — the abort handling, the ENOENT message naming the binary, and the
 * rule that a non-zero exit is a result rather than an error — and a second copy of those would
 * be a second set of failure messages for the same failures.
 *
 * A non-zero exit is not an error here: ping exits 1 when nothing replied, which is a perfectly
 * ordinary result that the caller reads out of the output. Only being unable to *run* it is.
 */
export async function runPing(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  /** The device pinged, which a check cancelled while it was pinging names (`P-406`). */
  host?: string,
): Promise<PingRun> {
  // Imported here rather than at the top of the module: the core loads this catalogue for
  // schemas and channel declarations and never calls execute, so it should not pay for the
  // module graph behind it (docs/adding-a-sensor-type.md).
  const { spawn } = await import('node:child_process');

  return new Promise<PingRun>((resolve, reject) => {
    // Node kills the process when the signal aborts, which is how this check honours
    // `ctx.signal` without a race of its own.
    const child = spawn(command, [...args], { signal, windowsHide: true });

    // **Kept to a bound, read to the end** (`P-277`). A reply prints a line, and so does every
    // duplicate of one, which the device answering decides: one that answers each echo
    // thousands of times grew these strings for as long as the check ran. Sixty replies and a
    // summary are a few kilobytes; past the bound the rest is read and not kept, so ping never
    // blocks on a full pipe.
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < PING_OUTPUT_CHARS)
        stdout += chunk.slice(0, PING_OUTPUT_CHARS - stdout.length);
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < PING_OUTPUT_CHARS)
        stderr += chunk.slice(0, PING_OUTPUT_CHARS - stderr.length);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (signal.aborted) {
        reject(
          new PingError(`the check was cancelled before ${command} finished`, {
            phase: 'echo',
            host,
          }),
        );
        return;
      }
      if (error.code === 'ENOENT') {
        // A probe running in a minimal container is the usual cause, and it fails identically
        // on every check until someone installs the binary — so say which binary.
        reject(
          new PingError(`the "${command}" binary is not available on this probe`, {
            phase: 'exec',
          }),
        );
        return;
      }
      reject(new PingError(`could not run ${command}: ${error.message}`, { phase: 'exec' }));
    });

    child.on('close', (code, killSignal) => {
      const detail =
        stderr.trim().split('\n')[0] ??
        (killSignal === null ? `exit ${String(code ?? 'unknown')}` : `killed by ${killSignal}`);
      resolve({ output: `${stdout}\n${stderr}`, detail: stderr.trim() === '' ? '' : detail });
    });
  });
}
