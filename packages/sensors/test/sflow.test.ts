import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ethernetFrame, renderNetflowV5, renderSflow } from '@ms/simulators';
import {
  FlowDecodeError,
  TemplateCache,
  decodeFlowDatagram,
  decodeSflow,
  type FlowRecord,
} from '../src/support/flow/index.js';

/**
 * sFlow v5 (`B-05`).
 *
 * The datagrams come from `@ms/simulators`, which writes the XDR out against the sFlow v5 spec
 * rather than by running this decoder backwards — which matters more here than anywhere else in
 * the subsystem, because sFlow's numbers only mean anything if `frame_length` and `sampling_rate`
 * are read the way the specification defines them, and an encoder derived from the decoder would
 * agree with whatever mistake the decoder made.
 */

const EXPORTER = '192.0.2.1';

/**
 * The one record a datagram produced, asserted to exist.
 *
 * Written once rather than `records[0]?.` at every call site: under `noUncheckedIndexedAccess` the
 * first access needs the guard and every one after it is redundant, which is a lint error and a
 * distraction from what the case is about.
 */
function only(message: { records: readonly FlowRecord[] }): FlowRecord {
  assert.equal(message.records.length, 1, 'exactly one record');
  const [record] = message.records;
  assert.ok(record);
  return record;
}

describe('sFlow v5', () => {
  it('reconstructs a flow record from a sampled packet header', () => {
    const message = decodeSflow(
      renderSflow([
        {
          frame: ethernetFrame({
            srcAddr: '10.1.2.3',
            dstAddr: '198.51.100.7',
            srcPort: 51_000,
            dstPort: 443,
            protocol: 6,
            tos: 8,
          }),
        },
      ]),
    );

    assert.equal(message.dialect, 'sflow');
    assert.equal(message.records.length, 1);
    const [record] = message.records;
    assert.ok(record);
    assert.equal(record.srcAddr, '10.1.2.3');
    assert.equal(record.dstAddr, '198.51.100.7');
    assert.equal(record.srcPort, 51_000);
    assert.equal(record.dstPort, 443);
    assert.equal(record.protocol, 6);
    assert.equal(record.tos, 8);
  });

  describe('the two fields that decide whether the numbers are right', () => {
    it('reports the length on the wire, not the length of the copied header', () => {
      // **The order-of-magnitude error this prevents.** A sampled header is typically 128 bytes
      // of a 1,514-byte frame; reporting the copy under-reports by twelve times and the number
      // looks entirely plausible while doing it.
      const message = decodeSflow(renderSflow([{ frameLength: 1_514 }]));
      assert.equal(only(message).octets, 1_514);
      assert.notEqual(only(message).octets, ethernetFrame().length);
    });

    it('carries the sampling rate, without applying it', () => {
      // `B-06`'s contract: the decoder says what arrived and what it stands for, and the consumer
      // decides whether to scale. A record that did not say would be read as an exact count.
      const message = decodeSflow(renderSflow([{ samplingRate: 2_048, frameLength: 1_000 }]));
      assert.equal(only(message).samplingRate, 2_048);
      assert.equal(only(message).octets, 1_000, 'unscaled, deliberately');
    });

    it('reads a rate per sample, because an agent may sample interfaces differently', () => {
      const message = decodeSflow(renderSflow([{ samplingRate: 512 }, { samplingRate: 4_096 }]));
      assert.deepEqual(
        message.records.map((one) => one.samplingRate),
        [512, 4_096],
      );
    });

    it('reads a rate of zero as one, not as zero', () => {
      // Zero would mean the packet stands for none of them.
      assert.equal(only(decodeSflow(renderSflow([{ samplingRate: 0 }]))).samplingRate, 1);
    });

    it('counts one packet per sample, which is what a sample is', () => {
      assert.equal(only(decodeSflow(renderSflow([{}]))).packets, 1);
    });
  });

  describe('reading the frame out of the sample', () => {
    it('sees through a VLAN tag', () => {
      // A reader that stopped at the first ethertype reads the VLAN id as one.
      const message = decodeSflow(
        renderSflow([{ frame: ethernetFrame({ vlanTags: 1, srcAddr: '10.9.9.9' }) }]),
      );
      assert.equal(only(message).srcAddr, '10.9.9.9');
    });

    it('sees through Q-in-Q, which a trunk port sends', () => {
      const message = decodeSflow(
        renderSflow([{ frame: ethernetFrame({ vlanTags: 2, srcAddr: '10.8.8.8' }) }]),
      );
      assert.equal(only(message).srcAddr, '10.8.8.8');
    });

    it('honours the IHL, so options do not get read as the transport header', () => {
      // A fixed 20-byte IPv4 header reads the options as ports on exactly the packets carrying
      // them, and reports two plausible port numbers that are not ports.
      const message = decodeSflow(
        renderSflow([{ frame: ethernetFrame({ optionWords: 2, srcPort: 6_000, dstPort: 7_000 }) }]),
      );
      assert.equal(only(message).srcPort, 6_000);
      assert.equal(only(message).dstPort, 7_000);
    });

    it('reports no ports for a fragment that carries no transport header', () => {
      const message = decodeSflow(renderSflow([{ frame: ethernetFrame({ fragmentOffset: 185 }) }]));
      assert.equal(only(message).srcPort, 0);
      assert.equal(only(message).dstPort, 0);
      assert.equal(only(message).srcAddr, '10.0.0.1', 'the addresses are still readable');
    });

    it('reports no ports for a protocol that has none', () => {
      const message = decodeSflow(renderSflow([{ frame: ethernetFrame({ protocol: 1 }) }]));
      assert.equal(only(message).protocol, 1);
      assert.equal(only(message).srcPort, 0);
    });

    it('skips a link layer it does not read, rather than decoding noise', () => {
      const message = decodeSflow(renderSflow([{ headerProtocol: 11 }]));
      assert.equal(message.records.length, 0);
      assert.equal(message.skipped, 1);
    });

    it('skips a flow record that is not a raw packet header', () => {
      const message = decodeSflow(renderSflow([{ recordFormat: 2 }]));
      assert.equal(message.records.length, 0);
      assert.equal(message.skipped, 1);
    });
  });

  describe('the expanded encoding, which widens three fields', () => {
    it('reads it, and gets the same answer as the compact one', () => {
      const compact = decodeSflow(renderSflow([{ inputIf: 7, outputIf: 9, samplingRate: 64 }]));
      const expanded = decodeSflow(
        renderSflow([{ inputIf: 7, outputIf: 9, samplingRate: 64, expanded: true }]),
      );
      assert.equal(expanded.records.length, 1);
      assert.equal(only(expanded).inputIf, 7);
      assert.equal(only(expanded).outputIf, 9);
      assert.equal(only(expanded).samplingRate, 64);
      assert.deepEqual(only(expanded), only(compact));
    });
  });

  describe('counter samples', () => {
    it('counts them without turning them into flows', () => {
      // **Deliberately no further.** They carry lifetime interface counters, and putting one into
      // a field the rest of this subsystem reads as an interval delta would be wrong in a way
      // nothing downstream could see. `snmp.traffic` already covers that ground.
      const message = decodeSflow(renderSflow([{}], { counterSamples: 2 }));
      assert.equal(message.records.length, 1);
      assert.equal(message.counterSamples, 2);
    });

    it('lets an agent send nothing but counters', () => {
      const message = decodeSflow(renderSflow([], { counterSamples: 3 }));
      assert.equal(message.records.length, 0);
      assert.equal(message.counterSamples, 3);
    });
  });

  describe('what it refuses', () => {
    it('refuses a datagram too short to hold a header', () => {
      assert.throws(() => decodeSflow(Buffer.alloc(12)), FlowDecodeError);
    });

    it('refuses a version that is not 5', () => {
      assert.throws(
        () => decodeSflow(renderSflow([{}], { version: 4 })),
        (error: unknown) => {
          assert.ok(error instanceof FlowDecodeError);
          assert.equal(error.reason.kind, 'unsupported-version');
          return true;
        },
      );
    });

    it('refuses an agent address type it does not know', () => {
      assert.throws(() => decodeSflow(renderSflow([{}], { addressType: 9 })), FlowDecodeError);
    });

    it('reads an IPv6 agent address, which is 16 bytes and not 4', () => {
      // Skipping four would misalign every field after it and decode the rest as noise.
      const message = decodeSflow(renderSflow([{}], { addressType: 2 }));
      assert.equal(message.records.length, 1);
    });

    it('refuses a sample that claims more bytes than the datagram holds', () => {
      const datagram = renderSflow([{}]);
      // The first sample's length word sits after the 28-byte header and the format word.
      datagram.writeUInt32BE(4_000, 32);
      assert.throws(
        () => decodeSflow(datagram),
        (error: unknown) => {
          assert.ok(error instanceof FlowDecodeError);
          assert.equal(error.reason.kind, 'truncated');
          return true;
        },
      );
    });

    it('stops at the samples present when the header over-claims', () => {
      // The count is a claim like NetFlow v5's; the walk is bounded by what is actually left.
      const message = decodeSflow(renderSflow([{}], { claimSamples: 40 }));
      assert.equal(message.records.length, 1);
    });
  });

  describe('reaching the dispatch', () => {
    it('is told apart from NetFlow v5, which also calls itself version 5', () => {
      // **The collision worth stating.** NetFlow's version is 16-bit and sFlow's is 32-bit, so a
      // NetFlow v5 datagram starts 00 05 and an sFlow one starts 00 00 00 05. A collector that
      // guessed on the port would decode one as the other on any site sending both to 2055.
      const cache = new TemplateCache();
      const netflow = renderNetflowV5([{}]);
      const sflow = renderSflow([{}]);
      assert.equal(netflow.readUInt16BE(0), 5);
      assert.equal(sflow.readUInt16BE(0), 0);

      assert.equal(decodeFlowDatagram(netflow, EXPORTER, cache).dialect, 'netflow5');
      assert.equal(decodeFlowDatagram(sflow, EXPORTER, cache).dialect, 'sflow');
    });

    it('reports the agent’s sequence as counting datagrams', () => {
      const message = decodeSflow(renderSflow([{}], { sequence: 77 }));
      assert.equal(message.sequence, 77);
      assert.equal(message.sequenceCounts, 'packets');
    });

    it('carries the packets the agent says it could not sample', () => {
      const message = decodeSflow(renderSflow([{ drops: 19 }]));
      assert.equal(message.agentDrops, 19);
    });
  });
});
