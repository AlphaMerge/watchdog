import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { CheckContext, ReceivedBatch, ReceivedNotification } from '../src/contract.js';
import { flowCollector, inCidr, matchesFlow, readCustomChannels } from '../src/types/flow.js';

/**
 * The flow sensor type (`B-04`).
 *
 * Everything here runs against a fabricated batch with no socket anywhere, which is the split
 * `T-06` established: the listener decodes and remembers a cursor, and every decision the sensor
 * makes is testable without a port.
 */

const EXPORTER = '192.0.2.1';
/**
 * A pinned ten-second window, so every rate below is a round number.
 *
 * **Fixed rather than derived from the clock, and that is the point of `until` existing.** The
 * first version of this file stamped `since` at `Date.now() - 10_000` and let the sensor measure
 * to its own `Date.now()`; every rate came out at 998.9 instead of 1,000, because the window had
 * silently grown by however long the test took to get there. On a probe that gap is the wait for
 * a free worker, and it would have made a busy probe report less traffic than a quiet one.
 */
const SINCE = '2026-09-09T12:00:00.000Z';
const UNTIL = '2026-09-09T12:00:10.000Z';

function flow(detail: Record<string, unknown>): ReceivedNotification {
  return {
    at: new Date().toISOString(),
    source: EXPORTER,
    text: 'flow',
    detail: {
      srcAddr: '10.0.0.1',
      dstAddr: '10.0.0.2',
      srcPort: 1234,
      dstPort: 443,
      protocol: 6,
      packets: 1,
      octets: 1_000,
      ...detail,
    },
  };
}

function batch(items: ReceivedNotification[], dropped = 0): ReceivedBatch {
  return { listener: 'flow', items, dropped, since: SINCE, until: UNTIL };
}

function context(
  received: ReceivedBatch | undefined,
  params: Record<string, unknown> = {},
): CheckContext {
  return {
    sensorId: 1,
    params,
    target: { host: EXPORTER },
    signal: new AbortController().signal,
    ...(received === undefined ? {} : { received }),
  } as unknown as CheckContext;
}

const read = async (ctx: CheckContext) => (await flowCollector.execute(ctx)).channels;
const valueOf = (channels: { key: string; value: number }[], key: string) =>
  channels.find((one) => one.key === key)?.value;

describe('the flow sensor', () => {
  describe('what it refuses to call zero', () => {
    it('fails when the collector is not running on this probe', async () => {
      // A receiver nobody switched on must not look like a link carrying no traffic.
      await assert.rejects(() => flowCollector.execute(context(undefined)), /not running/);
    });

    it('fails when a different listener fed it', async () => {
      const wrong = { listener: 'syslog', items: [], dropped: 0, since: SINCE, until: UNTIL };
      await assert.rejects(() => flowCollector.execute(context(wrong)), /not running/);
    });

    it('fails when the buffer overwrote flows before this sensor read them', async () => {
      // A count known to be short is a number nobody should act on.
      await assert.rejects(
        () => flowCollector.execute(context(batch([flow({})], 12))),
        /12 flows reached this probe/,
      );
    });

    it('reports anyway when the operator has accepted a short count', async () => {
      const channels = await read(context(batch([flow({})], 12), { warnOnDropped: false }));
      assert.equal(valueOf(channels, 'flows'), 0.1);
    });

    describe('silence, which is the decision this type exists to make', () => {
      it('fails on an interval with no flows, because there is no heartbeat to read', async () => {
        // A flow exporter with nothing to report sends nothing at all, so silence is either an
        // idle link or a stopped exporter and nothing in what arrived can tell them apart.
        await assert.rejects(
          () => flowCollector.execute(context(batch([]))),
          /either an idle link or an exporter that has stopped/,
        );
      });

      it('reports zero when the operator has said the link is quiet by nature', async () => {
        const channels = await read(context(batch([]), { silenceIsIdle: true }));
        assert.equal(valueOf(channels, 'bytes'), 0);
        assert.equal(valueOf(channels, 'hosts'), 0);
      });

      it('fails when every flow came from a different exporter', async () => {
        // The sensor sits under one device; another router's flows are not this link's traffic,
        // and counting them would be worse than reporting nothing.
        const other = { ...flow({}), source: '198.51.100.9' };
        await assert.rejects(() => flowCollector.execute(context(batch([other]))), /no flows/);
      });
    });
  });

  describe('rates rather than totals', () => {
    it('divides by the window, so the reading does not move with the scan interval', async () => {
      // Ten flows of 1,000 bytes over a ten-second window is 1,000 B/s. The same link at a
      // twenty-second interval must still read 1,000, or every limit needs rewriting when
      // somebody changes the schedule.
      const channels = await read(context(batch(Array.from({ length: 10 }, () => flow({})))));
      assert.equal(valueOf(channels, 'bytes'), 1_000);
      assert.equal(valueOf(channels, 'flows'), 1);
      assert.equal(valueOf(channels, 'packets'), 1);
    });

    it('counts distinct sources', async () => {
      const channels = await read(
        context(
          batch([
            flow({ srcAddr: '10.0.0.1' }),
            flow({ srcAddr: '10.0.0.2' }),
            flow({ srcAddr: '10.0.0.1' }),
          ]),
        ),
      );
      assert.equal(valueOf(channels, 'hosts'), 2);
    });
  });

  describe('sampling, which sFlow makes unavoidable', () => {
    it('scales by what each record stands for', async () => {
      // **The three-orders-of-magnitude error this prevents.** sFlow at 1-in-2,048 sends one
      // packet and means two thousand; summing the raw octets reports a two-thousandth of the
      // traffic, and the number looks entirely plausible.
      const channels = await read(
        context(batch([flow({ octets: 1_000, packets: 1, samplingRate: 2_048 })])),
      );
      assert.equal(valueOf(channels, 'bytes'), (1_000 * 2_048) / 10);
      assert.equal(valueOf(channels, 'packets'), 2_048 / 10);
    });

    it('leaves an unsampled record alone', async () => {
      const channels = await read(context(batch([flow({ octets: 1_000, samplingRate: 1 })])));
      assert.equal(valueOf(channels, 'bytes'), 100);
    });

    it('treats a missing or zero rate as one, never as zero', async () => {
      const missing = await read(context(batch([flow({ octets: 1_000 })])));
      const zero = await read(context(batch([flow({ octets: 1_000, samplingRate: 0 })])));
      assert.equal(valueOf(missing, 'bytes'), 100);
      assert.equal(valueOf(zero, 'bytes'), 100);
    });

    it('scales the per-protocol and custom channels the same way', async () => {
      const channels = await read(
        context(batch([flow({ octets: 1_000, protocol: 6, dstPort: 443, samplingRate: 100 })]), {
          channels: [{ key: 'https', match: [{ field: 'dstPort', equals: '443' }] }],
        }),
      );
      assert.equal(valueOf(channels, 'tcp'), 10_000);
      assert.equal(valueOf(channels, 'https'), 10_000);
    });

    it('says the number is an estimate when anything was sampled', async () => {
      const execution = await flowCollector.execute(context(batch([flow({ samplingRate: 512 })])));
      assert.match(execution.message ?? '', /estimated from 1 sampled/);
    });

    it('says nothing about estimates when nothing was sampled', async () => {
      const execution = await flowCollector.execute(context(batch([flow({})])));
      assert.doesNotMatch(execution.message ?? '', /estimated/);
    });
  });

  describe('per protocol', () => {
    it('splits the bytes by IANA protocol number', async () => {
      const channels = await read(
        context(
          batch([
            flow({ protocol: 6, octets: 6_000 }),
            flow({ protocol: 17, octets: 1_700 }),
            flow({ protocol: 1, octets: 100 }),
            flow({ protocol: 47, octets: 470 }),
          ]),
        ),
      );
      assert.equal(valueOf(channels, 'tcp'), 600);
      assert.equal(valueOf(channels, 'udp'), 170);
      assert.equal(valueOf(channels, 'icmp'), 10);
      // Everything that is not one of the three named ones, computed as the remainder so a
      // protocol nobody thought of still lands somewhere rather than vanishing.
      assert.equal(valueOf(channels, 'other'), 47);
    });

    it('sums to the total, whatever protocols turned up', async () => {
      const channels = await read(
        context(batch([flow({ protocol: 132, octets: 500 }), flow({ protocol: 6, octets: 500 })])),
      );
      const parts = ['tcp', 'udp', 'icmp', 'other'].map((key) => valueOf(channels, key) ?? 0);
      assert.equal(
        parts.reduce((a, b) => a + b, 0),
        valueOf(channels, 'bytes'),
      );
    });
  });

  describe('custom channels — CAPABILITIES.MD’s "custom flow variants"', () => {
    const withChannel = (match: Record<string, string>[]) => ({
      channels: [{ key: 'https', name: 'HTTPS', match }],
    });

    it('declares one channel per definition, beside the built-ins', () => {
      const defs = flowCollector.channels(withChannel([{ field: 'dstPort', equals: '443' }]));
      assert.ok(
        defs.some((one) => one.key === 'bytes'),
        'the built-ins are still there',
      );
      assert.ok(defs.some((one) => one.key === 'https' && one.name === 'HTTPS'));
    });

    it('counts only the traffic its rules match', async () => {
      const channels = await read(
        context(
          batch([flow({ dstPort: 443, octets: 4_000 }), flow({ dstPort: 80, octets: 6_000 })]),
          withChannel([{ field: 'dstPort', equals: '443' }]),
        ),
      );
      assert.equal(valueOf(channels, 'https'), 400);
      assert.equal(valueOf(channels, 'bytes'), 1_000, 'and the total is unaffected');
    });

    it('requires all rules, because "any" would widen a channel as rules are added', async () => {
      const channels = await read(
        context(
          batch([
            flow({ dstPort: 443, protocol: 6, octets: 1_000 }),
            flow({ dstPort: 443, protocol: 17, octets: 9_000 }),
          ]),
          withChannel([
            { field: 'dstPort', equals: '443' },
            { field: 'protocol', equals: '6' },
          ]),
        ),
      );
      assert.equal(valueOf(channels, 'https'), 100);
    });

    it('counts everything when a channel has no rules', async () => {
      const channels = await read(context(batch([flow({ octets: 5_000 })]), withChannel([])));
      assert.equal(valueOf(channels, 'https'), 500);
    });

    it('refuses a key that would shadow a built-in channel', () => {
      // Otherwise the custom reading replaces the built-in one in the array and the sensor
      // silently reports the wrong thing under a familiar name.
      assert.deepEqual(readCustomChannels({ channels: [{ key: 'bytes', name: 'Mine' }] }), []);
    });

    it('refuses a duplicate key', () => {
      const defs = readCustomChannels({
        channels: [{ key: 'a' }, { key: 'a' }, { key: 'b' }],
      });
      assert.deepEqual(
        defs.map((one) => one.key),
        ['a', 'b'],
      );
    });

    it('falls back to the key when no name was given', () => {
      assert.equal(readCustomChannels({ channels: [{ key: 'vpn' }] })[0]?.name, 'vpn');
    });
  });

  describe('CIDR matching, which is why "contains" is not enough', () => {
    it('matches an address inside the block', () => {
      assert.equal(inCidr('10.4.5.6', '10.0.0.0/8'), true);
      assert.equal(inCidr('192.168.1.9', '192.168.1.0/24'), true);
    });

    it('rejects an address outside it', () => {
      assert.equal(inCidr('11.0.0.1', '10.0.0.0/8'), false);
      assert.equal(inCidr('192.168.2.9', '192.168.1.0/24'), false);
    });

    it('does not match the way a "contains" rule would get it wrong', () => {
      // **The trap this replaces.** `contains: "10.0."` matches 110.0.4.1, and the operator who
      // wrote it never notices because the channel keeps reporting a plausible number.
      assert.equal('110.0.4.1'.includes('10.0.'), true, 'the substring really does match');
      assert.equal(inCidr('110.0.4.1', '10.0.0.0/8'), false, 'and the CIDR rule does not');
    });

    it('handles the edges', () => {
      assert.equal(inCidr('1.2.3.4', '0.0.0.0/0'), true, '/0 is everything');
      assert.equal(inCidr('1.2.3.4', '1.2.3.4/32'), true, '/32 is one address');
      assert.equal(inCidr('1.2.3.5', '1.2.3.4/32'), false);
    });

    it('refuses malformed input rather than matching it', () => {
      assert.equal(inCidr('10.0.0.1', '10.0.0.0'), false, 'no prefix length');
      assert.equal(inCidr('10.0.0.1', '10.0.0.0/33'), false);
      assert.equal(inCidr('not-an-address', '10.0.0.0/8'), false);
      assert.equal(inCidr('10.0.0.999', '10.0.0.0/8'), false);
    });

    it('drives a channel through the rules', async () => {
      const channels = await read(
        context(
          batch([
            flow({ dstAddr: '10.1.2.3', octets: 3_000 }),
            flow({ dstAddr: '110.1.2.3', octets: 7_000 }),
          ]),
          { channels: [{ key: 'internal', match: [{ field: 'dstAddr', cidr: '10.0.0.0/8' }] }] },
        ),
      );
      assert.equal(valueOf(channels, 'internal'), 300);
    });
  });

  it('matches on the exporter address, which is not in the flow record', () => {
    assert.equal(
      matchesFlow(flow({}), [{ field: 'exporter', equals: EXPORTER, contains: '', cidr: '' }]),
      true,
    );
    assert.equal(
      matchesFlow(flow({}), [
        { field: 'exporter', equals: '198.51.100.9', contains: '', cidr: '' },
      ]),
      false,
    );
  });
});
