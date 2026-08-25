import type { CheckTarget } from '../contract.js';

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
}

export interface PingCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** The platform whose flags to use. Anything unrecognised gets the iputils set. */
export function pingPlatform(platform: string): PingPlatform {
  if (platform === 'win32' || platform === 'darwin') return platform;
  return 'linux';
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
      // -w is the overall deadline; -W would be per packet and would not bound the whole run.
      '-w',
      String(seconds),
      '-s',
      String(params.packetSize),
      target.host,
    ],
  };
}

export interface PingOutcome {
  readonly transmitted: number;
  /** Round-trip times, in milliseconds, one per echo reply. Its length is the received count. */
  readonly times: readonly number[];
}

/**
 * `time=0.029 ms`, `time<1ms`, `time=2ms`.
 *
 * Every variant prints one of these per reply, and only for a *reply* — Windows' "Reply from
 * 192.0.2.1: Destination host unreachable." carries no time and is correctly not counted, which
 * is the trap in trusting the words "Reply from".
 */
const REPLY = /\btime\s*[<=]\s*([0-9]+(?:\.[0-9]+)?)\s*ms/gi;

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
 */
export function parsePingOutput(output: string, requested: number): PingOutcome {
  const times: number[] = [];
  for (const match of output.matchAll(REPLY)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) times.push(value);
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
  };
}

export interface PingStatistics {
  readonly lossPercent: number;
  readonly rttMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

/** Throws for an outcome with no replies: there is no round-trip time to report. */
export function summarise(outcome: PingOutcome): PingStatistics {
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
