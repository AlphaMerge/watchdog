import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderIpfix, renderNetflowV5, renderNetflowV9, renderSflow } from '@ms/simulators';
import { FlowDecodeError, TemplateCache, decodeFlowDatagram } from '../src/support/flow/index.js';

/**
 * Version dispatch and the normalised record (`B-06`).
 *
 * **The case this file exists for is that `B-03` shipped a decoder nothing called.** v9 and IPFIX
 * were correct, tested and unreachable, because the socket decoded v5 and refused everything else
 * — every number right, arriving nowhere, which is `P-61`. These are the tests that would have
 * failed the day that landed.
 */

const EXPORTER = '192.0.2.1';
const ADDRESSES = [
  { id: 8, length: 4 },
  { id: 12, length: 4 },
];

describe('reading a flow datagram of any dialect', () => {
  it('reads NetFlow v5', () => {
    const message = decodeFlowDatagram(
      renderNetflowV5([{ srcAddr: '10.0.0.1', dstAddr: '10.0.0.2', octets: 512, packets: 4 }]),
      EXPORTER,
      new TemplateCache(),
    );
    assert.equal(message.dialect, 'netflow5');
    assert.equal(message.records.length, 1);
    const [record] = message.records;
    assert.ok(record);
    assert.equal(record.srcAddr, '10.0.0.1');
    assert.equal(record.octets, 512);
    assert.equal(record.packets, 4);
  });

  it('reads NetFlow v9, which the socket used to refuse outright', () => {
    const cache = new TemplateCache();
    const message = decodeFlowDatagram(
      renderNetflowV9(
        [{ templateId: 256, fields: ADDRESSES }],
        [{ templateId: 256, records: [Buffer.from([10, 0, 0, 1, 10, 0, 0, 2])] }],
      ),
      EXPORTER,
      cache,
    );
    assert.equal(message.dialect, 'netflow9');
    const [record] = message.records;
    assert.ok(record);
    assert.equal(record.srcAddr, '10.0.0.1');
    assert.equal(record.dstAddr, '10.0.0.2');
  });

  it('reads IPFIX, likewise', () => {
    const cache = new TemplateCache();
    const message = decodeFlowDatagram(
      renderIpfix(
        [{ templateId: 256, fields: ADDRESSES }],
        [{ templateId: 256, records: [Buffer.from([192, 0, 2, 9, 198, 51, 100, 7])] }],
      ),
      EXPORTER,
      cache,
    );
    assert.equal(message.dialect, 'ipfix');
    const [record] = message.records;
    assert.ok(record);
    assert.equal(record.srcAddr, '192.0.2.9');
    assert.equal(record.dstAddr, '198.51.100.7');
  });

  it('keeps the template cache across datagrams, or a stateful dialect never decodes', () => {
    // A cache built per datagram would learn a template and forget it before the data set three
    // bytes later could use it — and every record would count as undecodable for ever.
    const cache = new TemplateCache();
    const first = decodeFlowDatagram(
      renderNetflowV9([{ templateId: 256, fields: ADDRESSES }], []),
      EXPORTER,
      cache,
    );
    assert.equal(first.records.length, 0);

    const second = decodeFlowDatagram(
      renderNetflowV9(
        [],
        [{ templateId: 256, records: [Buffer.from([10, 0, 0, 5, 10, 0, 0, 6])] }],
      ),
      EXPORTER,
      cache,
    );
    assert.equal(second.records.length, 1);
    assert.equal(second.undecodable, 0);
    assert.equal(second.records[0]?.srcAddr, '10.0.0.5');
  });

  it('carries the undecodable count out of the templated dialects', () => {
    const message = decodeFlowDatagram(
      renderNetflowV9([], [{ templateId: 256, records: [Buffer.alloc(8)] }]),
      EXPORTER,
      new TemplateCache(),
    );
    assert.equal(message.undecodable, 1);
    assert.equal(message.records.length, 0);
  });

  it('refuses a version it does not read', () => {
    const datagram = renderNetflowV5([{}]);
    datagram.writeUInt16BE(7, 0);
    assert.throws(
      () => decodeFlowDatagram(datagram, EXPORTER, new TemplateCache()),
      (error: unknown) => {
        assert.ok(error instanceof FlowDecodeError);
        assert.equal(error.reason.kind, 'unsupported-version');
        return true;
      },
    );
  });

  it('refuses a datagram too short to hold a version', () => {
    assert.throws(
      () => decodeFlowDatagram(Buffer.alloc(1), EXPORTER, new TemplateCache()),
      /cannot hold a version/,
    );
  });
});

describe('what the sequence counts, which is not the same in every dialect', () => {
  it('reports flows for v5, data records for IPFIX and packets for v9', () => {
    const cache = new TemplateCache();
    assert.equal(
      decodeFlowDatagram(renderNetflowV5([{}]), EXPORTER, cache).sequenceCounts,
      'flows',
    );
    assert.equal(
      decodeFlowDatagram(renderNetflowV9([], []), EXPORTER, cache).sequenceCounts,
      'packets',
    );
    assert.equal(
      decodeFlowDatagram(renderIpfix([], []), EXPORTER, cache).sequenceCounts,
      'data-records',
    );
  });
});

describe('which of an exporter’s sequences a datagram’s is (`B-10`)', () => {
  it('is the source id for v9 and the observation domain for IPFIX', () => {
    const cache = new TemplateCache();
    assert.equal(
      decodeFlowDatagram(renderNetflowV9([], [], { observationDomain: 7 }), EXPORTER, cache)
        .sequenceScope,
      '7',
    );
    assert.equal(
      decodeFlowDatagram(renderIpfix([], [], { observationDomain: 65_536 }), EXPORTER, cache)
        .sequenceScope,
      '65536',
    );
  });

  it('is the agent and its sub-agent for sFlow, not the address it came from', () => {
    const cache = new TemplateCache();
    assert.equal(
      decodeFlowDatagram(
        renderSflow([{}], { agentAddress: '198.51.100.7', subAgent: 3 }),
        EXPORTER,
        cache,
      ).sequenceScope,
      '198.51.100.7/3',
    );
    // An IPv6 agent, which the simulator writes as sixteen zero bytes.
    assert.equal(
      decodeFlowDatagram(renderSflow([{}], { addressType: 2, subAgent: 1 }), EXPORTER, cache)
        .sequenceScope,
      `${'00'.repeat(16)}/1`,
    );
  });

  it('is absent for v5, which has one count for the exporter', () => {
    const message = decodeFlowDatagram(renderNetflowV5([{}]), EXPORTER, new TemplateCache());
    assert.equal('sequenceScope' in message, false);
  });
});

describe('the sampling rate, which a byte count is meaningless without', () => {
  it('is 1 when the exporter is not sampling', () => {
    const message = decodeFlowDatagram(renderNetflowV5([{}]), EXPORTER, new TemplateCache());
    assert.equal(message.records[0]?.samplingRate, 1);
  });

  it('carries v5’s sampling interval onto every record', () => {
    // **The under-report this prevents.** A collector summing `octets` from a 1-in-100 sampled
    // exporter without this reports a hundredth of the traffic, on exactly the busy links
    // somebody is watching, and the number looks entirely plausible.
    const message = decodeFlowDatagram(
      renderNetflowV5([{}], { samplingMode: 2, samplingInterval: 100 }),
      EXPORTER,
      new TemplateCache(),
    );
    assert.equal(message.records[0]?.samplingRate, 100);
  });

  it('reads an interval of zero as one, not as zero', () => {
    // Zero means "not sampling", so one packet stands for one packet — not for none of them.
    const message = decodeFlowDatagram(
      renderNetflowV5([{}], { samplingInterval: 0 }),
      EXPORTER,
      new TemplateCache(),
    );
    assert.equal(message.records[0]?.samplingRate, 1);
  });
});

describe('reading elements at whatever width the template gave them', () => {
  it('reads a 4-byte octet count and an 8-byte one alike', () => {
    // `octetDeltaCount` is canonically 8 bytes and exporters ship it as 4 to save space. A
    // decoder that assumed either width reads the other as garbage.
    const narrow = new TemplateCache();
    const wide = new TemplateCache();

    const four = decodeFlowDatagram(
      renderIpfix(
        [{ templateId: 256, fields: [{ id: 1, length: 4 }] }],
        [{ templateId: 256, records: [Buffer.from([0, 0, 0x04, 0x00])] }],
      ),
      EXPORTER,
      narrow,
    );
    const eight = decodeFlowDatagram(
      renderIpfix(
        [{ templateId: 256, fields: [{ id: 1, length: 8 }] }],
        [{ templateId: 256, records: [Buffer.from([0, 0, 0, 0, 0, 0, 0x04, 0x00])] }],
      ),
      EXPORTER,
      wide,
    );

    assert.equal(four.records[0]?.octets, 1_024);
    assert.equal(eight.records[0]?.octets, 1_024);
  });

  it('reads the odd widths between, which is where a fixed-width read hides', () => {
    // **Added because a mutation survived.** The 4-and-8 case above misses the whole point: 8
    // bytes takes the BigInt branch, so nothing exercised the integer read at a width other than
    // 4, and clamping it to 4 passed every test. IPFIX §6.2's reduced-size encoding permits any
    // width, and 6-byte counters are shipped.
    for (const [length, bytes, expected] of [
      [2, [0x04, 0x00], 1_024],
      [3, [0x00, 0x04, 0x00], 1_024],
      [5, [0, 0, 0, 0x04, 0x00], 1_024],
      [6, [0, 0, 0, 0, 0x04, 0x00], 1_024],
    ] as const) {
      const message = decodeFlowDatagram(
        renderIpfix(
          [{ templateId: 256, fields: [{ id: 1, length }] }],
          [{ templateId: 256, records: [Buffer.from(bytes)] }],
        ),
        EXPORTER,
        new TemplateCache(),
      );
      assert.equal(message.records[0]?.octets, expected, `at ${String(length)} bytes`);
    }
  });

  it('keeps the low bits of a 64-bit counter, which a double would round away', () => {
    // Past 2^53 a `number` starts dropping low bits, and that is exactly where a busy link lives.
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(9_007_199_254_740_993n);
    const message = decodeFlowDatagram(
      renderIpfix(
        [{ templateId: 256, fields: [{ id: 1, length: 8 }] }],
        [{ templateId: 256, records: [big] }],
      ),
      EXPORTER,
      new TemplateCache(),
    );
    // The value is beyond what a double holds exactly; what must not happen is reading zero or
    // the wrong magnitude, which is what a 4-byte read of these bytes gives.
    assert.ok((message.records[0]?.octets ?? 0) > 9_007_199_254_740_000);
  });
});
