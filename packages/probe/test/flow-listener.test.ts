import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import type { FlowReceiverOptions, ReceivedFlow } from '@ms/sensors/flow';
import { FlowListener } from '../src/listeners/flow-listener.js';

/**
 * The ring, the cursors and the sequence arithmetic, with no socket anywhere (`B-02`).
 *
 * The injected opener is what makes that possible, and it is the same arrangement `T-06` and
 * `T-20` use: everything in this class is about what a *probe* does with what arrived — bounding
 * memory, giving each sensor what it has not seen, counting what it could not keep, and reading
 * the exporter's own running count to see what UDP lost. None of it should need a port. The
 * protocol half is tested against real bytes in `@ms/sensors`, where the bytes are the point.
 */

const silent = pino({ level: 'silent' });

let deliver: (flow: ReceivedFlow) => void;
let reportMalformed: FlowReceiverOptions['onMalformed'];
let closed = 0;

function fakeReceiver(options: FlowReceiverOptions) {
  deliver = options.onFlow;
  reportMalformed = options.onMalformed;
  return {
    close: (): Promise<void> => {
      closed += 1;
      return Promise.resolve();
    },
  };
}

let clock = 0;

async function listener(bufferSize = 8, exporters: string[] = []): Promise<FlowListener> {
  const instance = new FlowListener({
    logger: silent,
    port: 0,
    address: '127.0.0.1',
    ipVersion: 'udp4',
    exporters,
    bufferSize,
    now: () => new Date(1_800_000_000_000 + clock++ * 1_000),
    open: fakeReceiver,
  });
  await instance.start();
  return instance;
}

/** A datagram of `count` flows from `source`, starting at `flowSequence`. */
function datagram(source: string, flowSequence: number, count: number): ReceivedFlow {
  return {
    source,
    datagram: {
      header: {
        version: 5,
        count,
        sysUptimeMs: 3_600_000,
        unixSecs: 1_700_000_000,
        unixNsecs: 0,
        flowSequence,
        engineType: 0,
        engineId: 0,
        samplingMode: 'none',
        samplingInterval: 0,
      },
      records: Array.from({ length: count }, (_, i) => ({
        srcAddr: '10.0.0.1',
        dstAddr: '10.0.0.2',
        nextHop: '0.0.0.0',
        inputIf: 1,
        outputIf: 2,
        packets: 1,
        octets: 64,
        firstMs: 0,
        lastMs: 0,
        srcPort: 1_000 + i,
        dstPort: 443,
        tcpFlags: 0,
        protocol: 6,
        tos: 0,
        srcAs: 0,
        dstAs: 0,
        srcMask: 24,
        dstMask: 24,
      })),
    },
  };
}

beforeEach(() => {
  clock = 0;
  closed = 0;
});

describe('the flow listener', () => {
  it('buffers one notification per flow record, not per datagram', async () => {
    // A datagram holds one to thirty flows depending on how busy the exporter was. Buffering by
    // datagram would make the ring's capacity mean thirty different things.
    const flow = await listener();
    deliver(datagram('192.0.2.1', 0, 3));

    assert.equal(flow.stats().received, 3);
    assert.equal(flow.stats().buffered, 3);
    assert.equal(flow.drain(1).items.length, 0, 'a first drain registers the cursor');
    deliver(datagram('192.0.2.1', 3, 2));
    assert.equal(flow.drain(1).items.length, 2);
  });

  it('gives each sensor what it has not seen, independently', async () => {
    const flow = await listener();
    flow.drain(1);
    flow.drain(2);

    deliver(datagram('192.0.2.1', 0, 2));
    assert.equal(flow.drain(1).items.length, 2);
    assert.equal(flow.drain(1).items.length, 0, 'and nothing twice');
    assert.equal(flow.drain(2).items.length, 2, 'the other cursor is untouched');
  });

  it('counts what the ring overwrote rather than quietly shortening the list', async () => {
    // CLAUDE.md: backpressure is visible, never silent.
    const flow = await listener(4);
    flow.drain(1);
    deliver(datagram('192.0.2.1', 0, 10));

    const batch = flow.drain(1);
    assert.equal(batch.items.length, 4, 'the ring holds four');
    assert.equal(batch.dropped, 6, 'and says so about the other six');
  });

  it('turns away an exporter that is not on the list, and counts it', async () => {
    const flow = await listener(8, ['192.0.2.1']);
    deliver(datagram('192.0.2.1', 0, 1));
    deliver(datagram('198.51.100.9', 0, 5));

    assert.equal(flow.stats().received, 1);
    assert.equal(flow.stats().rejected, 1, 'one datagram, not five flows');
    assert.equal(flow.stats().buffered, 1);
  });

  it('accepts every exporter when the list is empty', async () => {
    const flow = await listener(8, []);
    deliver(datagram('192.0.2.1', 0, 1));
    deliver(datagram('198.51.100.9', 0, 1));
    assert.equal(flow.stats().received, 2);
    assert.equal(flow.stats().rejected, 0);
  });

  describe('flows the exporter says it sent and we never saw', () => {
    it('reads the gap out of the running count', async () => {
      // The only way to see UDP loss at all: the transport drops silently, so the exporter's own
      // sequence is the sole evidence.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 2)); // sequences 0..1, next should be 2
      assert.equal(flow.stats().missed, 0);

      deliver(datagram('192.0.2.1', 5, 1)); // three flows never arrived
      assert.equal(flow.stats().missed, 3);
    });

    it('counts nothing when the sequence runs on unbroken', async () => {
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 3));
      deliver(datagram('192.0.2.1', 3, 3));
      deliver(datagram('192.0.2.1', 6, 3));
      assert.equal(flow.stats().missed, 0);
    });

    it('keeps a sequence per exporter, because they are unrelated', async () => {
      // **The bug this is here to prevent.** One shared "expected next" reports a loss on every
      // alternate datagram when two devices export to one collector — a number that looks like a
      // failing network and is arithmetic.
      //
      // **The two exporters must be at different points in their own sequences**, or this test
      // proves nothing: with both at 0, 5, 10 a single shared counter happens to see no forward
      // gap either, and the case passes against the bug it exists to catch. Found by the mutation
      // surviving.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 5)); // A: 0..4
      deliver(datagram('198.51.100.9', 900, 5)); // B: 900..904, far ahead of A
      deliver(datagram('192.0.2.1', 5, 5)); // A: 5..9, unbroken for A
      deliver(datagram('198.51.100.9', 905, 5)); // B: 905..909, unbroken for B
      assert.equal(flow.stats().missed, 0);
    });

    it('resyncs on a sequence that goes backwards, rather than reporting billions lost', async () => {
      // An exporter that reboots begins again at a low number. Counting the difference would
      // report the whole counter as missing flows.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 4_000_000_000, 1));
      deliver(datagram('192.0.2.1', 0, 1));
      assert.equal(flow.stats().missed, 0);
    });
  });

  it('counts a malformed datagram without letting it reach the ring', async () => {
    const flow = await listener();
    reportMalformed('a v5 datagram claims 3 records and carries 2', {
      kind: 'truncated',
      claimed: 3,
      present: 2,
    });
    assert.equal(flow.stats().malformed, 1);
    assert.equal(flow.stats().buffered, 0);
  });

  it('forgets the cursors of sensors that no longer exist', async () => {
    const flow = await listener();
    flow.drain(1);
    flow.drain(2);
    assert.equal(flow.stats().cursors, 2);
    flow.retain([1]);
    assert.equal(flow.stats().cursors, 1);
  });

  it('closes the socket once, and reports itself stopped', async () => {
    const flow = await listener();
    assert.equal(flow.running, true);
    await flow.stop();
    await flow.stop();
    assert.equal(closed, 1);
    assert.equal(flow.running, false);
  });

  it('carries the header onto every record, so a sensor can date a flow from one notification', async () => {
    const flow = await listener();
    flow.drain(1);
    deliver(datagram('192.0.2.1', 0, 1));

    const [item] = flow.drain(1).items;
    assert.ok(item);
    // `first`/`last` are uptime milliseconds and mean nothing without the header's two clocks.
    assert.equal(item.detail['sysUptimeMs'], 3_600_000);
    assert.equal(item.detail['unixSecs'], 1_700_000_000);
    assert.equal(item.detail['protocol'], 6);
    assert.equal(item.source, '192.0.2.1');
  });
});
