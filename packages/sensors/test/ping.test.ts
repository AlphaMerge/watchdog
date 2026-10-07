import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { CheckTarget } from '../src/contract.js';
import {
  duplicatesNote,
  jitterOf,
  parsePingOutput,
  PING_OUTPUT_CHARS,
  pingCommand,
  pingPlatform,
  runPing,
  summarise,
  type PingParams,
} from '../src/support/ping.js';

const PARAMS: PingParams = { count: 4, packetSize: 32, timeoutMs: 5_000 };
const target = (host: string, ipVersion: CheckTarget['ipVersion'] = 'auto'): CheckTarget => ({
  host,
  ipVersion,
});

// ── real output, captured from each platform ────────────────────────────────────────────────
// These are the whole reason the parsing is a pure function: three formats, none of which needs
// a network to test, and all of which differ in ways a single regex would get wrong.

const LINUX_OK = `PING 127.0.0.1 (127.0.0.1) 32(60) bytes of data.
40 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.029 ms
40 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.041 ms
40 bytes from 127.0.0.1: icmp_seq=3 ttl=64 time=0.038 ms
40 bytes from 127.0.0.1: icmp_seq=4 ttl=64 time=0.045 ms

--- 127.0.0.1 ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3072ms
rtt min/avg/max/mdev = 0.029/0.038/0.045/0.006 ms
`;

const LINUX_PARTIAL = `PING 192.0.2.1 (192.0.2.1) 32(60) bytes of data.
40 bytes from 192.0.2.1: icmp_seq=1 ttl=63 time=12.4 ms
40 bytes from 192.0.2.1: icmp_seq=3 ttl=63 time=13.6 ms

--- 192.0.2.1 ping statistics ---
4 packets transmitted, 2 received, 50% packet loss, time 3005ms
rtt min/avg/max/mdev = 12.400/13.000/13.600/0.600 ms
`;

const LINUX_UNREACHABLE = `PING 192.0.2.1 (192.0.2.1) 32(60) bytes of data.
From 10.0.0.1 icmp_seq=1 Destination Host Unreachable
From 10.0.0.1 icmp_seq=2 Destination Host Unreachable

--- 192.0.2.1 ping statistics ---
4 packets transmitted, 0 received, +2 errors, 100% packet loss, time 3054ms
`;

const MACOS_OK = `PING 127.0.0.1 (127.0.0.1): 32 data bytes
40 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.052 ms
40 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.100 ms

--- 127.0.0.1 ping statistics ---
2 packets transmitted, 2 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 0.052/0.076/0.100/0.024 ms
`;

const WINDOWS_PARTIAL = `
Pinging 127.0.0.1 with 32 bytes of data:
Reply from 127.0.0.1: bytes=32 time<1ms TTL=128
Reply from 127.0.0.1: bytes=32 time=2ms TTL=128
Request timed out.
Reply from 127.0.0.1: bytes=32 time=1ms TTL=128

Ping statistics for 127.0.0.1:
    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),
Approximate round trip times in milli-seconds:
    Minimum = 0ms, Maximum = 2ms, Average = 1ms
`;

/**
 * Two of four requests answered, each of them twice (`P-282`) — a broadcast address, or a loop.
 * iputils marks the second answer `(DUP!)` and leaves it out of its own received count.
 */
const LINUX_DUPLICATES = `PING 192.0.2.255 (192.0.2.255) 32(60) bytes of data.
40 bytes from 192.0.2.10: icmp_seq=1 ttl=64 time=0.412 ms
40 bytes from 192.0.2.11: icmp_seq=1 ttl=64 time=0.913 ms (DUP!)
40 bytes from 192.0.2.10: icmp_seq=3 ttl=64 time=0.398 ms
40 bytes from 192.0.2.11: icmp_seq=3 ttl=64 time=9.877 ms (DUP!)

--- 192.0.2.255 ping statistics ---
4 packets transmitted, 2 received, +2 duplicates, 50% packet loss, time 3004ms
rtt min/avg/max/mdev = 0.398/2.900/9.877/3.996 ms
`;

/** The same on macOS, where BSD ping marks it the same way and numbers from zero. */
const MACOS_DUPLICATES = `PING 192.0.2.1 (192.0.2.1): 32 data bytes
40 bytes from 192.0.2.1: icmp_seq=0 ttl=64 time=1.204 ms
40 bytes from 192.0.2.1: icmp_seq=0 ttl=64 time=1.391 ms (DUP!)
Request timeout for icmp_seq 1
40 bytes from 192.0.2.1: icmp_seq=2 ttl=64 time=1.188 ms
40 bytes from 192.0.2.1: icmp_seq=2 ttl=64 time=24.950 ms (DUP!)

--- 192.0.2.1 ping statistics ---
4 packets transmitted, 2 packets received, +2 duplicates, 50.0% packet loss
round-trip min/avg/max/stddev = 1.188/7.183/24.950/10.256 ms
`;

/**
 * BusyBox, which a probe in a minimal image may have for `ping`: `seq=`, not `icmp_seq=`, so its
 * own marker is the only thing that says a line is a second answer.
 */
const BUSYBOX_DUPLICATES = `PING 192.0.2.1 (192.0.2.1): 32 data bytes
40 bytes from 192.0.2.1: seq=0 ttl=64 time=0.517 ms
40 bytes from 192.0.2.1: seq=0 ttl=64 time=3.902 ms (DUP!)
40 bytes from 192.0.2.1: seq=1 ttl=64 time=0.533 ms

--- 192.0.2.1 ping statistics ---
2 packets transmitted, 2 packets received, 1 duplicates, 0% packet loss
round-trip min/avg/max = 0.517/1.650/3.902 ms
`;

/** Windows counts an ICMP error as a *received packet*. This is the trap. */
const WINDOWS_UNREACHABLE = `
Pinging 192.0.2.1 with 32 bytes of data:
Reply from 10.0.0.1: Destination host unreachable.
Reply from 10.0.0.1: Destination host unreachable.

Ping statistics for 192.0.2.1:
    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),
`;

describe('ping command construction', () => {
  it('bounds each packet on Linux, so the count means what it says', () => {
    // **This was `-w`, the overall deadline, until `P-07` measured what that does.** `-c` and
    // `-w` interact: with a deadline, ping waits for `count` *replies* and keeps transmitting
    // until it expires — so `-c 4 -w 5` against a host that is down sent **five** packets over
    // five seconds, and at a 0.2 s interval would have sent twenty-five. `-W` bounds the wait for
    // each reply instead, the count is honoured whether or not anything answers, and the run is
    // bounded by `(count - 1) x interval + W` with the check's `AbortSignal` outside that.
    const { command, args } = pingCommand('linux', target('192.0.2.9'), PARAMS);
    assert.equal(command, 'ping');
    assert.deepEqual([...args], ['-n', '-c', '4', '-W', '2', '-s', '32', '192.0.2.9']);
  });

  it('spaces the packets when asked, and never below the floor', () => {
    // 0.2 s is where iputils stops allowing it without `CAP_NET_RAW` and BSD without the
    // superuser, so a smaller number is clamped rather than passed on to fail at the far end.
    const fast = pingCommand('linux', target('h'), { ...PARAMS, intervalSeconds: 0.2 });
    assert.deepEqual([...fast.args].slice(0, 6), ['-n', '-c', '4', '-i', '0.2', '-W']);

    const clamped = pingCommand('linux', target('h'), { ...PARAMS, intervalSeconds: 0.01 });
    assert.equal([...clamped.args][clamped.args.indexOf('-i') + 1], '0.2');
  });

  it('spaces the packets on macOS too, where the flag reads the same and nothing else does', () => {
    // BSD shares `-i` and disagrees about everything around it, so the darwin branch builds its
    // own argument list — which means the interval has to be put into it a second time, and
    // forgetting to would leave every Mac probe on ping's one-second default with no test saying
    // so.
    const { args } = pingCommand('darwin', target('192.0.2.9'), {
      ...PARAMS,
      intervalSeconds: 0.5,
    });
    assert.deepEqual([...args], ['-n', '-c', '4', '-i', '0.5', '-t', '5', '-s', '32', '192.0.2.9']);
  });

  it('lets ping keep its own spacing when the interval is nonsense, rather than inventing one', () => {
    // Zero, negative, NaN and Infinity all mean "no usable interval", and the two wrong answers
    // are both worse than doing nothing: clamping them to the floor invents a tuning nobody
    // asked for, and passing them through produces `-i NaN`, which makes ping print its usage
    // and fail every check on that sensor — a flag bug wearing the costume of an outage.
    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { args } = pingCommand('linux', target('h'), { ...PARAMS, intervalSeconds: interval });
      assert.equal(args.includes('-i'), false, `-i survived an interval of ${String(interval)}`);
    }
  });

  it('passes no interval flag to Windows, which has no such flag', () => {
    // It would print usage and exit, turning a tuning parameter into an outage on every Windows
    // probe — a failure that would look like the network rather than like a flag.
    const { args } = pingCommand('win32', target('h'), { ...PARAMS, intervalSeconds: 0.2 });
    assert.equal(args.includes('-i'), false);
  });

  it('divides the budget per packet on Windows, which has no overall deadline', () => {
    const { args } = pingCommand('win32', target('192.0.2.9'), PARAMS);
    assert.deepEqual([...args], ['-n', '4', '-w', '1250', '-l', '32', '192.0.2.9']);
  });

  it('uses the BSD flags on macOS, where -t and -W mean the opposite of iputils', () => {
    const { args } = pingCommand('darwin', target('192.0.2.9'), PARAMS);
    assert.deepEqual([...args], ['-n', '-c', '4', '-t', '5', '-s', '32', '192.0.2.9']);
  });

  it('never asks ping to resolve names backwards', () => {
    // A reverse lookup inside an ICMP check measures DNS; a slow resolver would read as latency.
    for (const platform of ['linux', 'darwin'] as const) {
      assert.ok(pingCommand(platform, target('192.0.2.9'), PARAMS).args.includes('-n'));
    }
  });

  it('passes the address family only when one was asked for', () => {
    assert.equal(pingCommand('linux', target('h', 'auto'), PARAMS).args.includes('-4'), false);
    assert.equal(pingCommand('linux', target('h', 'v4'), PARAMS).args[0], '-4');
    assert.equal(pingCommand('linux', target('h', 'v6'), PARAMS).args[0], '-6');
    assert.equal(pingCommand('win32', target('h', 'v6'), PARAMS).args[0], '-6');
  });

  it('never lets the per-packet wait round down to zero', () => {
    // A zero there is not "no wait" but "wait forever" on some builds, and a sub-second wait
    // would call a slow link down. One second is the floor.
    const { args } = pingCommand('linux', target('h'), { ...PARAMS, timeoutMs: 100 });
    assert.equal(args[args.indexOf('-W') + 1], '1');

    // The floor is load-bearing at exactly one input and unreachable at every other, which is
    // why it is worth a case of its own: `Math.ceil` already returns 1 for any positive budget,
    // so a timeout of zero is the only thing standing between `-W 1` and `-W 0` — and `-W 0` is
    // the one value that means "wait forever", turning a nonsense timeout into a check that
    // never ends rather than one that ends immediately.
    const untimed = pingCommand('linux', target('h'), { ...PARAMS, timeoutMs: 0 });
    assert.equal(untimed.args[untimed.args.indexOf('-W') + 1], '1');
  });

  it('keeps the per-packet wait finite even when asked for no packets', () => {
    // A count of zero divides the budget by nothing. Unguarded that is `-W Infinity`, which is
    // the same hang as `-W 0` reached by a different route: the schema forbids the input, and
    // this function is exported and does not get to assume the schema ran.
    const { args } = pingCommand('linux', target('h'), { ...PARAMS, count: 0 });
    const wait = Number(args[args.indexOf('-W') + 1]);
    assert.ok(Number.isFinite(wait) && wait >= 1, `implausible per-packet wait: ${String(wait)}`);
  });

  it('treats an unfamiliar platform as iputils', () => {
    assert.equal(pingPlatform('freebsd'), 'linux');
    assert.equal(pingPlatform('win32'), 'win32');
    assert.equal(pingPlatform('darwin'), 'darwin');
  });
});

describe('parsing', () => {
  it('reads a clean Linux run', () => {
    const outcome = parsePingOutput(LINUX_OK, 4);
    assert.equal(outcome.transmitted, 4);
    assert.deepEqual([...outcome.times], [0.029, 0.041, 0.038, 0.045]);
    assert.deepEqual(summarise(outcome), {
      lossPercent: 0,
      rttMs: 0.038,
      minMs: 0.029,
      maxMs: 0.045,
    });
  });

  it('reads partial loss', () => {
    const outcome = parsePingOutput(LINUX_PARTIAL, 4);
    assert.deepEqual([...outcome.times], [12.4, 13.6]);
    assert.equal(summarise(outcome).lossPercent, 50);
    assert.equal(summarise(outcome).rttMs, 13);
  });

  it('reads BSD output, whose summary says "packets received"', () => {
    const outcome = parsePingOutput(MACOS_OK, 2);
    assert.equal(outcome.transmitted, 2);
    assert.deepEqual([...outcome.times], [0.052, 0.1]);
  });

  it('reads Windows output, including "time<1ms"', () => {
    const outcome = parsePingOutput(WINDOWS_PARTIAL, 4);
    assert.equal(outcome.transmitted, 4);
    // `<1ms` is Windows saying "under its own resolution". Recorded as the stated bound rather
    // than as zero, which would be a reading no ICMP echo can actually produce.
    assert.deepEqual([...outcome.times], [1, 2, 1]);
    assert.equal(summarise(outcome).lossPercent, 25);
  });

  it('counts no replies when nothing replied, on either platform', () => {
    for (const [name, output] of [
      ['linux', LINUX_UNREACHABLE],
      ['windows', WINDOWS_UNREACHABLE],
    ] as const) {
      const outcome = parsePingOutput(output, 4);
      assert.deepEqual([...outcome.times], [], `${name} counted a reply that never arrived`);
      assert.throws(() => summarise(outcome), /no replies/);
    }
  });

  it('does not believe Windows when it calls an ICMP error a received packet', () => {
    // "Received = 2, Lost = 0 (0% loss)" for a host that is not there. Trusting that figure
    // would report perfect health for an unreachable target — the single worst thing an ICMP
    // sensor can do.
    const outcome = parsePingOutput(WINDOWS_UNREACHABLE, 2);
    assert.equal(outcome.transmitted, 2);
    assert.equal(outcome.times.length, 0, 'no echo reply was timed, whatever the summary says');
  });

  it('falls back to the requested count when there is no summary at all', () => {
    // A run killed mid-flight prints replies and no statistics block.
    const outcome = parsePingOutput('64 bytes from h: icmp_seq=1 ttl=64 time=1.5 ms\n', 4);
    assert.equal(outcome.transmitted, 4);
    assert.equal(summarise(outcome).lossPercent, 75);
  });

  it('finds nothing in output that contains no replies', () => {
    for (const output of ['', 'ping: unknown host nope.invalid\n', 'garbage']) {
      assert.deepEqual([...parsePingOutput(output, 4).times], []);
    }
  });
});

describe('duplicate replies (`P-282`)', () => {
  it('leaves them out of the replies, the loss and the times on Linux, and counts them', () => {
    // Counted as replies, two answered of four read as four of four: no loss, and a 9.9 ms copy
    // of a 0.4 ms reply in the average.
    const outcome = parsePingOutput(LINUX_DUPLICATES, 4);
    assert.equal(outcome.transmitted, 4);
    assert.deepEqual([...outcome.times], [0.412, 0.398]);
    assert.equal(outcome.duplicates, 2);
    assert.deepEqual(summarise(outcome), {
      lossPercent: 50,
      rttMs: 0.405,
      minMs: 0.398,
      maxMs: 0.412,
    });
  });

  it('does the same with macOS output', () => {
    const outcome = parsePingOutput(MACOS_DUPLICATES, 4);
    assert.equal(outcome.transmitted, 4);
    assert.deepEqual([...outcome.times], [1.204, 1.188]);
    assert.equal(outcome.duplicates, 2);
    assert.equal(summarise(outcome).lossPercent, 50);
    assert.equal(summarise(outcome).maxMs, 1.204, 'the 24.95 ms copy is not the slowest reply');
  });

  it('keeps them out of the jitter, which is a property of the gaps between replies', () => {
    // A late copy between two replies makes two gaps that the link never had.
    for (const [name, output, replies] of [
      ['linux', LINUX_DUPLICATES, [0.412, 0.398]],
      ['macos', MACOS_DUPLICATES, [1.204, 1.188]],
    ] as const) {
      const outcome = parsePingOutput(output, 4);
      assert.equal(jitterOf(outcome.times), jitterOf(replies), `${name} jitter`);
    }
  });

  it('believes the marker where there is no sequence number to go by', () => {
    const outcome = parsePingOutput(BUSYBOX_DUPLICATES, 2);
    assert.equal(outcome.transmitted, 2);
    assert.deepEqual([...outcome.times], [0.517, 0.533]);
    assert.equal(outcome.duplicates, 1);
  });

  it('knows a second answer by its sequence number when the marker is not on the line', () => {
    // The last line of a flood cut off at `PING_OUTPUT_CHARS`, before " (DUP!)" was printed.
    const cut = LINUX_DUPLICATES.split('\n--- ')[0]?.replace(/ \(DUP!\)\n$/, '\n') ?? '';
    assert.match(cut, /time=9\.877 ms\n$/, 'the fixture ends on an unmarked second answer');
    const outcome = parsePingOutput(cut, 4);
    assert.deepEqual([...outcome.times], [0.412, 0.398]);
    assert.equal(outcome.duplicates, 2);
  });

  it('counts each sequence once, so distinct replies are never taken for copies', () => {
    const outcome = parsePingOutput(LINUX_OK, 4);
    assert.equal(outcome.times.length, 4);
    assert.equal(outcome.duplicates, 0);
  });

  it('has none on Windows, whose ping prints neither a sequence nor a marker', () => {
    // Four identical lines are four replies there: nothing in them says otherwise.
    assert.equal(parsePingOutput(WINDOWS_PARTIAL, 4).duplicates, 0);
    assert.equal(parsePingOutput(WINDOWS_PARTIAL, 4).times.length, 3);
  });

  it('says how many were left out, and nothing when there were none', () => {
    assert.equal(duplicatesNote({ duplicates: 0 }), '');
    assert.equal(duplicatesNote({ duplicates: 1 }), ', 1 duplicate not counted');
    assert.equal(duplicatesNote({ duplicates: 2 }), ', 2 duplicates not counted');
  });
});

describe('statistics', () => {
  it('averages the samples rather than trusting the summary line', () => {
    // The summary's label differs on every platform (rtt / round-trip / Minimum-Maximum-Average)
    // and is absent whenever nothing replied. One regex over reply times covers all three.
    const stats = summarise({ transmitted: 3, times: [1, 2, 6] });
    assert.equal(stats.rttMs, 3);
    assert.equal(stats.minMs, 1);
    assert.equal(stats.maxMs, 6);
    assert.equal(stats.lossPercent, 0);
  });

  it('rounds to microseconds, because a loopback ping has noise below that', () => {
    assert.equal(summarise({ transmitted: 1, times: [0.0294449] }).rttMs, 0.029);
  });
});

describe('jitter', () => {
  it('has none to report from fewer than two replies', () => {
    // One reply is a round-trip time. Zero would read as "perfectly stable" about a link that
    // answered once out of twenty, which is the opposite of the truth.
    assert.equal(jitterOf([]), null);
    assert.equal(jitterOf([12.4]), null);
  });

  it('is zero for a link that answers in the same time every packet', () => {
    assert.equal(jitterOf([10, 10, 10, 10]), 0);
  });

  it('follows RFC 3550, not a spread', () => {
    // J = J + (|D(i-1,i)| - J)/16, starting at zero. One gap of 10 ms is 0.625, not 10: the
    // estimator is a smoothed average of *changes*, and a tool that reported the gap itself
    // would disagree with every RTP endpoint on the network.
    assert.equal(jitterOf([10, 20]), 0.625);
  });

  it('separates two runs with identical minimum, maximum and mean', () => {
    // The whole reason this sensor exists. Same three samples, same average latency, and one of
    // these links is usable for voice while the other is not — because jitter is a property of
    // the order the packets arrived in, and no summary statistic of the set can see it.
    assert.equal(jitterOf([10, 10, 30]), 1.25);
    assert.equal(jitterOf([10, 30, 10]), 2.422);
  });
});

describe('running ping (`P-277`)', () => {
  it('keeps a bounded amount of what it prints, and reads the rest to the end', async () => {
    // A reply prints a line, and so does every duplicate of one, which the device answering
    // decides. A program printing 4 MiB on each stream stands in for a device that answers each
    // echo thousands of times; it must finish, so nothing was left blocked on a full pipe.
    const flood =
      "const line = 'x'.repeat(1023) + '\\n';" +
      'for (let i = 0; i < 4096; i += 1) { process.stdout.write(line); process.stderr.write(line); }';
    const run = await runPing(process.execPath, ['-e', flood], AbortSignal.timeout(30_000));
    // stdout, the newline between them, and stderr: each kept to the bound.
    assert.equal(run.output.length, 2 * PING_OUTPUT_CHARS + 1);
    assert.ok(run.detail.length <= PING_OUTPUT_CHARS);
  });
});
