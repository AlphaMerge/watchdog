import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderNetflowV5 } from '@ms/simulators';
import {
  FlowDecodeError,
  V5_HEADER_BYTES,
  V5_MAX_RECORDS,
  V5_RECORD_BYTES,
  decodeNetflowV5,
  flowWindow,
} from '../src/support/flow/index.js';

/**
 * NetFlow v5 (`B-01`).
 *
 * The datagrams come from `@ms/simulators`, which writes the bytes out against Cisco's layout
 * rather than by running this decoder backwards — otherwise every case here would pass on a
 * decoder and an encoder that agreed with each other and with nothing else.
 */
describe('NetFlow v5', () => {
  it('reads a datagram field by field, at the offsets the format fixes', () => {
    const datagram = renderNetflowV5(
      [
        {
          srcAddr: '192.0.2.10',
          dstAddr: '198.51.100.7',
          nextHop: '203.0.113.1',
          inputIf: 12,
          outputIf: 13,
          packets: 42,
          octets: 5_000,
          firstMs: 1_000,
          lastMs: 2_500,
          srcPort: 51_000,
          dstPort: 443,
          tcpFlags: 0x1b,
          protocol: 6,
          tos: 8,
          srcAs: 64_500,
          dstAs: 64_501,
          srcMask: 24,
          dstMask: 25,
        },
      ],
      { sysUptimeMs: 10_000, unixSecs: 1_700_000_000, flowSequence: 99, engineId: 3 },
    );

    const { header, records } = decodeNetflowV5(datagram);

    assert.equal(header.version, 5);
    assert.equal(header.count, 1);
    assert.equal(header.sysUptimeMs, 10_000);
    assert.equal(header.unixSecs, 1_700_000_000);
    assert.equal(header.flowSequence, 99);
    assert.equal(header.engineId, 3);

    const [flow] = records;
    assert.ok(flow);
    // Addresses are big-endian words on the wire; reading them as anything else is the classic
    // way to get a plausible-looking but reversed quad.
    assert.equal(flow.srcAddr, '192.0.2.10');
    assert.equal(flow.dstAddr, '198.51.100.7');
    assert.equal(flow.nextHop, '203.0.113.1');
    assert.equal(flow.inputIf, 12);
    assert.equal(flow.outputIf, 13);
    assert.equal(flow.packets, 42);
    assert.equal(flow.octets, 5_000);
    assert.equal(flow.srcPort, 51_000);
    assert.equal(flow.dstPort, 443);
    assert.equal(flow.tcpFlags, 0x1b);
    assert.equal(flow.protocol, 6);
    assert.equal(flow.tos, 8);
    assert.equal(flow.srcAs, 64_500);
    assert.equal(flow.dstAs, 64_501);
    assert.equal(flow.srcMask, 24);
    assert.equal(flow.dstMask, 25);
  });

  it('keeps the records in the order the exporter sent them', () => {
    const datagram = renderNetflowV5([{ srcPort: 1 }, { srcPort: 2 }, { srcPort: 3 }]);
    assert.deepEqual(
      decodeNetflowV5(datagram).records.map((one) => one.srcPort),
      [1, 2, 3],
    );
  });

  it('splits the sampling word into its mode and its interval', () => {
    // The top two bits are the mode and the low fourteen the interval; reading the word whole
    // gives an interval of 17,000 for what is actually random 1-in-100.
    const datagram = renderNetflowV5([{}], { samplingMode: 2, samplingInterval: 100 });
    const { header } = decodeNetflowV5(datagram);
    assert.equal(header.samplingMode, 'random');
    assert.equal(header.samplingInterval, 100);
  });

  it('refuses a datagram too short to hold a header', () => {
    assert.throws(
      () => decodeNetflowV5(Buffer.alloc(V5_HEADER_BYTES - 1)),
      (error: unknown) => {
        assert.ok(error instanceof FlowDecodeError);
        assert.equal(error.reason.kind, 'too-short');
        return true;
      },
    );
  });

  it('refuses a version it does not decode, and says which it saw', () => {
    const datagram = renderNetflowV5([{}], { version: 9 });
    assert.throws(
      () => decodeNetflowV5(datagram),
      (error: unknown) => {
        assert.ok(error instanceof FlowDecodeError);
        assert.equal(error.reason.kind, 'unsupported-version');
        assert.equal(error.reason.version, 9);
        // An operator whose exporter is set to v9 needs to read that, not "malformed".
        assert.match(error.message, /version 9/);
        return true;
      },
    );
  });

  it('refuses a count the format does not allow', () => {
    // Thirty records plus the header is one Ethernet datagram, which is why the ceiling exists.
    // A decoder that trusted this would try to read 40 records out of a buffer holding one.
    const datagram = renderNetflowV5([{}], { claimCount: V5_MAX_RECORDS + 10 });
    assert.throws(
      () => decodeNetflowV5(datagram),
      (error: unknown) => {
        assert.ok(error instanceof FlowDecodeError);
        assert.equal(error.reason.kind, 'count-out-of-range');
        return true;
      },
    );
  });

  it('refuses a zero count rather than returning an empty flow table', () => {
    const datagram = renderNetflowV5([], { claimCount: 0 });
    assert.throws(
      () => decodeNetflowV5(datagram),
      (error: unknown) => {
        assert.ok(error instanceof FlowDecodeError);
        assert.equal(error.reason.kind, 'count-out-of-range');
        return true;
      },
    );
  });

  it('refuses a truncated datagram whole, rather than reading the records that survived', () => {
    // **The case that matters most.** v5 rides UDP with no length negotiation, so a path MTU
    // smaller than the exporter assumed clips the datagram silently. Half a flow table is worse
    // than none: the missing half is invisible to everything downstream.
    const full = renderNetflowV5([{ srcPort: 1 }, { srcPort: 2 }, { srcPort: 3 }]);
    const clipped = renderNetflowV5([{ srcPort: 1 }, { srcPort: 2 }, { srcPort: 3 }], {
      truncateTo: V5_HEADER_BYTES + V5_RECORD_BYTES * 2,
    });
    assert.equal(decodeNetflowV5(full).records.length, 3);
    assert.throws(
      () => decodeNetflowV5(clipped),
      (error: unknown) => {
        assert.ok(error instanceof FlowDecodeError);
        assert.equal(error.reason.kind, 'truncated');
        assert.equal(error.reason.claimed, 3);
        assert.equal(error.reason.present, 2);
        return true;
      },
    );
  });

  it('accepts the largest datagram the format allows', () => {
    const flows = Array.from({ length: V5_MAX_RECORDS }, (_, i) => ({ srcPort: i + 1 }));
    const datagram = renderNetflowV5(flows);
    assert.equal(datagram.length, V5_HEADER_BYTES + V5_MAX_RECORDS * V5_RECORD_BYTES);
    assert.equal(decodeNetflowV5(datagram).records.length, V5_MAX_RECORDS);
  });

  it('ignores trailing bytes beyond the records the header claims', () => {
    // Some exporters pad to a convenient size. The claim is the authority for how much to read;
    // it is only a fault when the datagram holds *less* than it claims.
    const datagram = Buffer.concat([renderNetflowV5([{ srcPort: 7 }]), Buffer.alloc(16)]);
    const { records } = decodeNetflowV5(datagram);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.srcPort, 7);
  });

  describe('flowWindow', () => {
    it('converts the uptime clock to wall clock through the header', () => {
      // The exporter booted an hour before it sent this, and the flow ran from 10s to 5s before
      // the datagram left. So the flow ended five seconds before `unixSecs`.
      const datagram = renderNetflowV5([{ firstMs: 3_590_000, lastMs: 3_595_000 }], {
        sysUptimeMs: 3_600_000,
        unixSecs: 1_700_000_000,
        unixNsecs: 0,
      });
      const { header, records } = decodeNetflowV5(datagram);
      const flow = records[0];
      assert.ok(flow);

      const { start, end } = flowWindow(header, flow);
      assert.equal(start.getTime(), 1_700_000_000_000 - 10_000);
      assert.equal(end.getTime(), 1_700_000_000_000 - 5_000);
    });

    it('carries the nanosecond half of the header into the answer', () => {
      const datagram = renderNetflowV5([{ firstMs: 1_000, lastMs: 1_000 }], {
        sysUptimeMs: 1_000,
        unixSecs: 1_700_000_000,
        unixNsecs: 500_000_000,
      });
      const { header, records } = decodeNetflowV5(datagram);
      const flow = records[0];
      assert.ok(flow);
      // first === last === sysUptime, so the flow is stamped at the send time exactly, and the
      // 500 ms of the nanosecond field has to survive to show up.
      assert.equal(flowWindow(header, flow).start.getTime(), 1_700_000_000_500);
    });
  });
});
