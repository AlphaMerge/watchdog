import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { CheckTarget } from '../src/contract.js';
import {
  jitterOf,
  parsePingOutput,
  pingCommand,
  pingPlatform,
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

/** Windows counts an ICMP error as a *received packet*. This is the trap. */
const WINDOWS_UNREACHABLE = `
Pinging 192.0.2.1 with 32 bytes of data:
Reply from 10.0.0.1: Destination host unreachable.
Reply from 10.0.0.1: Destination host unreachable.

Ping statistics for 192.0.2.1:
    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),
`;

describe('ping command construction', () => {
  it('bounds the whole run on Linux, not each packet', () => {
    const { command, args } = pingCommand('linux', target('192.0.2.9'), PARAMS);
    assert.equal(command, 'ping');
    // -w is the overall deadline. -W would bound each packet and leave the total unbounded,
    // which is the flag most ping wrappers reach for by mistake.
    assert.deepEqual([...args], ['-n', '-c', '4', '-w', '5', '-s', '32', '192.0.2.9']);
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

  it('never lets the deadline round down to zero', () => {
    const { args } = pingCommand('linux', target('h'), { ...PARAMS, timeoutMs: 100 });
    assert.equal(args[args.indexOf('-w') + 1], '1', 'a 0-second deadline means "no deadline"');
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
