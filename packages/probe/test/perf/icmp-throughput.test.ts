import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { availableParallelism, platform } from 'node:os';
import { parsePingOutput, pingCommand, runPing } from '@ms/sensors/ping';

/**
 * What the ICMP path costs at scale, and whether a raw socket would earn its keep (`P-07`).
 *
 * **The question `ADR-001` left open.** The ADR chose the system `ping` binary as the default —
 * no privileges, correct everywhere — and left "an optional raw-socket fast path" to be justified
 * by a measurement at 1,000 targets. It also did the arithmetic that makes the question urgent:
 * `ping` waits about a second between packets, so the default count of 4 holds a worker for
 * roughly three seconds, and at the v1 target of 5,000 sensors on a one-minute interval that is
 * **15,000 worker-seconds a minute against 60 seconds of wall clock** — which no plausible pool
 * size absorbs. `P-15` met the same wall from the other side and said so.
 *
 * **What is measured, and what deliberately is not.** Targets are loopback aliases (`127.x.y.z`,
 * all local on Linux) and blackholed TEST-NET-1 addresses (`192.0.2.0/24`, RFC 5737). That
 * removes the network entirely, which is the point: what is being compared is *our* cost per
 * check — spawn, wait, parse — not somebody's link. A benchmark against real hosts would measure
 * their latency and call it ours.
 *
 * Skipped off Linux: the flags, the interval floor and the unprivileged-socket rules are all
 * platform-specific, and a number from one platform presented as the answer is worse than none.
 */

const TARGET_COUNT = Number(process.env['MS_PING_TARGETS'] ?? '1000');
const CONCURRENCY = Number(process.env['MS_PING_CONCURRENCY'] ?? '64');

/** 1,000 loopback addresses. Every 127.0.0.0/8 address answers, so these are 1,000 live targets. */
function loopbackTargets(count: number): string[] {
  const out: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    // 127.0.0.0/8 minus the network and broadcast edges, walked as a flat counter.
    const third = Math.floor(n / 254) % 254;
    const fourth = (n % 254) + 1;
    out.push(`127.0.${String(third)}.${String(fourth)}`);
  }
  return out;
}

/** RFC 5737 TEST-NET-1: guaranteed not to be routed, so every packet is lost. */
function blackholeTargets(count: number): string[] {
  return Array.from({ length: count }, (_, n) => `192.0.2.${String((n % 254) + 1)}`);
}

interface Run {
  wallMs: number;
  perTargetMs: number;
  targetsPerSecond: number;
  cpuMs: number;
  received: number;
  transmitted: number;
}

/**
 * Builds the argument list, optionally with an interval the shipped parameters cannot express.
 *
 * The `-i` variant is spelled out here rather than added to `PingParams` first, deliberately: the
 * point of the benchmark is to decide whether that flag is worth shipping, and adding it before
 * measuring would be deciding first and measuring afterwards.
 */
function argsFor(
  host: string,
  params: { count: number; timeoutMs: number; packetSize: number },
  intervalSeconds?: number,
): { command: string; args: string[] } {
  // `intervalSeconds: undefined` is not "what shipped before": the flags changed too, because
  // `-c` and `-w` interact. The old configuration is reconstructed by hand so the comparison is
  // against what an installation actually ran, not against a half-migrated version of it.
  if (intervalSeconds === undefined) {
    return {
      command: 'ping',
      args: [
        '-n',
        '-c',
        String(params.count),
        '-w',
        String(Math.max(1, Math.ceil(params.timeoutMs / 1_000))),
        '-s',
        String(params.packetSize),
        host,
      ],
    };
  }
  const built = pingCommand('linux', { host, ipVersion: 'v4' }, { ...params, intervalSeconds });
  return { command: built.command, args: [...built.args] };
}

/** Fires every target through the pool with a bounded number in flight. */
async function sweep(
  targets: readonly string[],
  params: { count: number; timeoutMs: number; packetSize: number },
  concurrency: number,
  intervalSeconds?: number,
): Promise<Run> {
  let next = 0;
  let received = 0;
  let transmitted = 0;
  const startCpu = process.cpuUsage();
  const startedAt = process.hrtime.bigint();

  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next;
      next += 1;
      const host = targets[at];
      if (host === undefined) return;
      const { command, args } = argsFor(host, params, intervalSeconds);
      const run = await runPing(command, args, new AbortController().signal);
      const outcome = parsePingOutput(run.output, params.count);
      received += outcome.times.length;
      transmitted += outcome.transmitted;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const cpu = process.cpuUsage(startCpu);
  return {
    wallMs,
    perTargetMs: wallMs / targets.length,
    targetsPerSecond: (targets.length / wallMs) * 1_000,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    received,
    transmitted,
  };
}

const report = (label: string, run: Run, targets: number): void => {
  process.stdout.write(
    `    ${label.padEnd(34)} ${run.wallMs.toFixed(0).padStart(6)} ms  ` +
      `${run.targetsPerSecond.toFixed(0).padStart(5)} targets/s  ` +
      `${(run.cpuMs / targets).toFixed(2).padStart(5)} ms CPU each  ` +
      `${String(run.received)}/${String(run.transmitted)} replies\n`,
  );
};

describe('ICMP throughput (P-07)', { skip: platform() === 'linux' ? false : 'linux only' }, () => {
  it('measures what shipped before, which is the number the ADR was worried about', async () => {
    // count 4 at the iputils default of one second between packets. This is what `P-08` ships
    // and what every arithmetic about worker-seconds has been based on.
    const targets = loopbackTargets(TARGET_COUNT);
    const run = await sweep(targets, { count: 4, timeoutMs: 5_000, packetSize: 56 }, CONCURRENCY);
    report(`before P-07 (count 4, -w 5)`, run, targets.length);

    // Every loopback address answers every packet, so anything less is a lost reply on a link
    // that has none — which would mean the measurement is of something other than our cost.
    assert.equal(run.received, run.transmitted, 'loopback lost a packet, so this measures noise');
    assert.ok(run.perTargetMs > 0);
  });

  it('measures what ships now, which needs no privileges and no dependency', async () => {
    // **The finding.** `-i 0.2` is the floor a *non-root* process is allowed on Linux, and it
    // turns a three-second check into a six-hundred-millisecond one without a native module, a
    // capability, or a second code path to maintain.
    const targets = loopbackTargets(TARGET_COUNT);
    const run = await sweep(
      targets,
      { count: 4, timeoutMs: 5_000, packetSize: 56 },
      CONCURRENCY,
      0.2,
    );
    report(`shipped now (count 4, -i 0.2, -W)`, run, targets.length);
    assert.equal(run.received, run.transmitted);
  });

  it('measures a target that answers nothing, both ways', async () => {
    // **The case the pool is actually sized for**, and the one where `-c`/`-w` bites: a live host
    // answers and the check ends early, a dead one runs to whatever bound it was given. Before
    // `P-07` that bound was the whole timeout *and* ping kept transmitting for all of it.
    const targets = blackholeTargets(Math.min(TARGET_COUNT, 200));
    const params = { count: 4, timeoutMs: 5_000, packetSize: 56 };

    const before = await sweep(targets, params, CONCURRENCY);
    report(`blackholed, before P-07`, before, targets.length);
    const now = await sweep(targets, params, CONCURRENCY, 0.2);
    report(`blackholed, ships now`, now, targets.length);

    assert.equal(before.received, 0, 'TEST-NET-1 answered, so this is not measuring a timeout');
    assert.equal(now.received, 0);
    // The count means what the form says now: four packets, live or dead.
    assert.equal(now.transmitted, targets.length * 4);
    assert.ok(
      before.transmitted > now.transmitted,
      `the old flags should send more: ${String(before.transmitted)} vs ${String(now.transmitted)}`,
    );
  });

  it(
    'sweeps concurrency, which is the other lever and the one P-15 reached for',
    { skip: process.env['MS_PING_SWEEP'] === '1' ? false : 'set MS_PING_SWEEP=1' },
    async () => {
      // `P-15` answered the same shortfall by asking for a 250-slot pool. This is the curve that
      // says whether that is necessary or merely one way out: every slot costs a worker and about
      // 6 MB, so a lever that needs none is worth more than one that needs 200 more.
      const targets = loopbackTargets(500);
      for (const inFlight of [16, 32, 64, 128, 256]) {
        const slow = await sweep(targets, { count: 4, timeoutMs: 5_000, packetSize: 56 }, inFlight);
        const fast = await sweep(
          targets,
          { count: 4, timeoutMs: 5_000, packetSize: 56 },
          inFlight,
          0.2,
        );
        process.stdout.write(
          `    ${String(inFlight).padStart(4)} in flight   ` +
            `default ${slow.targetsPerSecond.toFixed(0).padStart(4)}/s   ` +
            `-i 0.2 ${fast.targetsPerSecond.toFixed(0).padStart(4)}/s   ` +
            `(${(fast.targetsPerSecond / slow.targetsPerSecond).toFixed(1)}x)\n`,
        );
      }
      assert.ok(true);
    },
  );

  it('reports the cores it measured on, because the number is meaningless without them', () => {
    process.stdout.write(
      `    measured on ${String(availableParallelism())} cores, ` +
        `${String(TARGET_COUNT)} targets, ${String(CONCURRENCY)} in flight\n`,
    );
    assert.ok(availableParallelism() >= 1);
  });
});
