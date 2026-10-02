import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import {
  decodeFlowDatagram,
  TemplateCache,
  type FlowDialect,
  type FlowReceiverOptions,
  type ReceivedFlow,
} from '@ms/sensors/flow';
import { renderIpfix, renderNetflowV5, renderNetflowV9, renderSflow } from '@ms/simulators';
import { FlowListener, MAX_SEQUENCES } from '../src/listeners/flow-listener.js';

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
    templates: () => ({ held: 0, redefined: 0, expired: 0, evicted: 0 }),
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

/**
 * A message of `count` flows from `source`, starting at `sequence`.
 *
 * Normalised (`B-06`), so this fixture says nothing about which dialect it arrived in — which is
 * the point of the shape: the listener no longer knows either. `counts` is what the exporter's
 * sequence advances by, and it differs between dialects.
 */
function datagram(
  source: string,
  sequence: number,
  count: number,
  counts: 'packets' | 'data-records' | 'flows' = 'flows',
  dialect: FlowDialect = 'netflow5',
  scope?: string,
): ReceivedFlow {
  return {
    source,
    message: {
      dialect,
      sequence,
      sequenceCounts: counts,
      ...(scope === undefined ? {} : { sequenceScope: scope }),
      undecodable: 0,
      sysUptimeMs: 3_600_000,
      unixSecs: 1_700_000_000,
      records: Array.from({ length: count }, (_, i) => ({
        srcAddr: '10.0.0.1',
        dstAddr: '10.0.0.2',
        srcPort: 1_000 + i,
        dstPort: 443,
        protocol: 6,
        packets: 1,
        octets: 64,
        inputIf: 1,
        outputIf: 2,
        samplingRate: 1,
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

  describe('what the buffer overwrote before a sensor read it (`B-11`)', () => {
    it('counts each such record once, and it is what the sensor behind is told', async () => {
      const flow = await listener(4);
      flow.drain(1);
      deliver(datagram('192.0.2.1', 0, 10));

      assert.equal(flow.stats().overwrittenUnread, 6);
      assert.equal(flow.drain(1).dropped, 6, 'the same six, from the other side');
    });

    it('counts nothing for records every sensor had read, which a full buffer gives up all day', async () => {
      // **Why this is not `overwritten`.** A buffer that has filled once overwrites on every
      // push for ever, and nearly all of it is records already read. A channel of that would
      // climb at the rate flows arrive on a probe losing nothing.
      const flow = await listener(4);
      flow.drain(1);
      deliver(datagram('192.0.2.1', 0, 4));
      assert.equal(flow.drain(1).items.length, 4);
      deliver(datagram('192.0.2.1', 4, 4));

      assert.equal(flow.stats().overwritten, 4, 'four did leave the buffer');
      assert.equal(flow.stats().overwrittenUnread, 0, 'and all four had been read');
      assert.equal(flow.drain(1).dropped, 0);
    });

    it('counts a record once however many sensors were behind it, and by the slowest', async () => {
      const flow = await listener(4);
      flow.drain(1);
      flow.drain(2);
      flow.drain(3);
      deliver(datagram('192.0.2.1', 0, 3));
      assert.equal(flow.drain(1).items.length, 3, 'sensor 1 keeps up; 2 and 3 do not scan');
      deliver(datagram('192.0.2.1', 3, 4));

      // Seven records through a buffer of four: the first three are gone, and two sensors had
      // not read them. Three records were lost, not six.
      assert.equal(flow.stats().overwrittenUnread, 3);
      assert.equal(flow.drain(1).dropped, 0);
      assert.equal(flow.drain(2).dropped, 3);
      assert.equal(flow.drain(3).dropped, 3);
    });

    it('counts nothing while no sensor reads the buffer', async () => {
      // A collector with no flow sensor assigned yet loses nothing anybody was waiting for.
      const flow = await listener(4);
      deliver(datagram('192.0.2.1', 0, 10));
      assert.equal(flow.stats().overwritten, 6);
      assert.equal(flow.stats().overwrittenUnread, 0);
    });

    it('counts from a sensor’s first scan, and from exactly the record it is waiting at', async () => {
      const flow = await listener(4);
      deliver(datagram('192.0.2.1', 0, 10)); // sequences 0..9, before any sensor
      flow.drain(1); // waiting at 10
      deliver(datagram('192.0.2.1', 10, 4)); // 10..13 overwrite 6..9, which it never asked for
      assert.equal(flow.stats().overwrittenUnread, 0);

      deliver(datagram('192.0.2.1', 14, 1)); // 14 overwrites 10: the first it was waiting for
      assert.equal(flow.stats().overwrittenUnread, 1);
      assert.equal(flow.drain(1).dropped, 1);
    });

    it('stops counting for a sensor that was removed', async () => {
      const flow = await listener(4);
      flow.drain(1);
      flow.drain(2);
      deliver(datagram('192.0.2.1', 0, 4));
      flow.drain(1);
      // Sensor 2 is deleted without ever reading; only sensor 1, which is up to date, remains.
      flow.retain([1]);
      deliver(datagram('192.0.2.1', 4, 4));
      assert.equal(flow.stats().overwrittenUnread, 0);
    });

    it('keeps counting after the sensor behind catches up and falls behind again', async () => {
      // A running total since the collector started, as every counter here is.
      const flow = await listener(4);
      flow.drain(1);
      deliver(datagram('192.0.2.1', 0, 6));
      assert.equal(flow.drain(1).dropped, 2);
      deliver(datagram('192.0.2.1', 6, 4));
      assert.equal(flow.stats().overwrittenUnread, 2, 'four read records left; nothing new lost');
      deliver(datagram('192.0.2.1', 10, 3));
      assert.equal(flow.stats().overwrittenUnread, 5);
    });
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

    it('advances by one per datagram for v9, whose sequence counts packets', async () => {
      // **The arithmetic that differs by dialect** (`B-03`, wired by `B-06`). v9's sequence
      // counts exported *packets* — one per datagram — where v5 counts flows and IPFIX counts
      // data records. One arithmetic for all three reports a healthy v9 exporter as losing every
      // flow but one, every datagram, for ever.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 5, 'packets'));
      deliver(datagram('192.0.2.1', 1, 5, 'packets'));
      deliver(datagram('192.0.2.1', 2, 5, 'packets'));
      assert.equal(flow.stats().missed, 0);
    });

    it('keeps v9 and IPFIX sequences apart even from the same address', async () => {
      // An exporter can send both; their counters are unrelated and interleaving them would
      // invent losses in whichever arrived second.
      const flow = await listener();
      // Each named as the dialect it is: the key is the dialect since `B-10`, and what a
      // sequence counts follows from it.
      deliver(datagram('192.0.2.1', 0, 2, 'packets', 'netflow9'));
      deliver(datagram('192.0.2.1', 500, 2, 'data-records', 'ipfix'));
      deliver(datagram('192.0.2.1', 1, 2, 'packets', 'netflow9'));
      deliver(datagram('192.0.2.1', 502, 2, 'data-records', 'ipfix'));
      assert.equal(flow.stats().missed, 0);
    });

    it('keeps NetFlow v9 and sFlow apart from one address, though both count packets (`B-10`)', async () => {
      // A switch exporting both to one collector. Each sequence advances by one a datagram, so
      // "what the sequence counts" cannot tell them apart, and read against each other every
      // sFlow datagram is four hundred ahead of v9's and every v9 one is a restart.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 2, 'packets', 'netflow9'));
      deliver(datagram('192.0.2.1', 400, 2, 'packets', 'sflow'));
      deliver(datagram('192.0.2.1', 1, 2, 'packets', 'netflow9'));
      deliver(datagram('192.0.2.1', 401, 2, 'packets', 'sflow'));
      assert.equal(flow.stats().missed, 0);
    });

    it('keeps a sequence per v9 source id and per IPFIX observation domain (`B-10`)', async () => {
      // Two line cards behind one address. The second is far ahead of the first, as in the
      // per-exporter case above and for its reason.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 2, 'packets', 'netflow9', '1'));
      deliver(datagram('192.0.2.1', 700, 2, 'packets', 'netflow9', '2'));
      deliver(datagram('192.0.2.1', 1, 2, 'packets', 'netflow9', '1'));
      deliver(datagram('192.0.2.1', 701, 2, 'packets', 'netflow9', '2'));
      assert.equal(flow.stats().missed, 0);

      deliver(datagram('192.0.2.1', 0, 2, 'data-records', 'ipfix', '1'));
      deliver(datagram('192.0.2.1', 300, 2, 'data-records', 'ipfix', '2'));
      deliver(datagram('192.0.2.1', 2, 2, 'data-records', 'ipfix', '1'));
      deliver(datagram('192.0.2.1', 302, 2, 'data-records', 'ipfix', '2'));
      assert.equal(flow.stats().missed, 0);
    });

    it('still reads a gap inside one source id while another runs unbroken (`B-10`)', async () => {
      // Keyed apart is not the same as not compared at all.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 2, 'packets', 'netflow9', '1'));
      deliver(datagram('192.0.2.1', 700, 2, 'packets', 'netflow9', '2'));
      deliver(datagram('192.0.2.1', 4, 2, 'packets', 'netflow9', '1')); // 1, 2 and 3 never came
      deliver(datagram('192.0.2.1', 701, 2, 'packets', 'netflow9', '2'));
      assert.equal(flow.stats().missed, 3);
    });

    it('keeps a sequence per sFlow agent and per sub-agent (`B-10`)', async () => {
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 1, 'packets', 'sflow', '10.1.1.1/0'));
      deliver(datagram('192.0.2.1', 250, 1, 'packets', 'sflow', '10.1.1.1/1'));
      deliver(datagram('192.0.2.1', 900, 1, 'packets', 'sflow', '10.2.2.2/0'));
      deliver(datagram('192.0.2.1', 1, 1, 'packets', 'sflow', '10.1.1.1/0'));
      deliver(datagram('192.0.2.1', 251, 1, 'packets', 'sflow', '10.1.1.1/1'));
      deliver(datagram('192.0.2.1', 901, 1, 'packets', 'sflow', '10.2.2.2/0'));
      assert.equal(flow.stats().missed, 0);
    });

    it('keeps one scope from two addresses apart (`B-10`)', async () => {
      // Source id 0 is what most exporters send. The address is still part of the key.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 1, 'packets', 'netflow9', '0'));
      deliver(datagram('198.51.100.9', 600, 1, 'packets', 'netflow9', '0'));
      deliver(datagram('192.0.2.1', 1, 1, 'packets', 'netflow9', '0'));
      deliver(datagram('198.51.100.9', 601, 1, 'packets', 'netflow9', '0'));
      assert.equal(flow.stats().missed, 0);
    });

    it('reads real datagrams of three dialects from one address, each in its own sequence (`B-10`)', async () => {
      // The bytes, through the decoder the socket uses: what names the sequence is read out of
      // each header, and a fixture that passed a scope in would not show a decoder leaving it out.
      const flow = await listener();
      const cache = new TemplateCache();
      const from = (bytes: Buffer): void => {
        deliver({
          source: '192.0.2.1',
          message: decodeFlowDatagram(bytes, '192.0.2.1', cache),
        });
      };
      for (const step of [0, 1, 2]) {
        from(renderNetflowV9([], [], { sequence: step, observationDomain: 1 }));
        from(renderNetflowV9([], [], { sequence: 5_000 + step, observationDomain: 2 }));
        from(renderIpfix([], [], { sequence: 90, observationDomain: 1 }));
        from(renderSflow([{}], { sequence: 300 + step }));
        from(renderSflow([{}], { sequence: 7_000 + step, subAgent: 1 }));
        from(renderSflow([{}], { sequence: 40 + step, agentAddress: '10.9.9.9' }));
      }
      assert.equal(flow.stats().missed, 0);

      // And a datagram that did go missing, on one of the six: 3 was next from sub-agent 1's.
      from(renderSflow([{}], { sequence: 7_005, subAgent: 1 }));
      assert.equal(flow.stats().missed, 2);
    });

    it('keeps a sequence per NetFlow v5 engine at one address (`B-13`)', async () => {
      // A chassis exporting from two engines: each header names its engine type and id, and each
      // engine counts its own flows. The bytes, through the decoder the socket uses, because
      // the engine is read out of the header and a fixture handing a scope in would not show a
      // decoder leaving it out. The second engine is far ahead of the first, as in the
      // per-exporter case above and for its reason.
      const flow = await listener(64);
      const cache = new TemplateCache();
      const from = (
        flowSequence: number,
        engineType: number,
        engineId: number,
        flows = 5,
      ): void => {
        const bytes = renderNetflowV5(
          Array.from({ length: flows }, () => ({})),
          { flowSequence, engineType, engineId },
        );
        deliver({ source: '192.0.2.1', message: decodeFlowDatagram(bytes, '192.0.2.1', cache) });
      };
      from(0, 0, 0); // engine 0/0: flows 0..4
      from(900, 0, 1); // engine 0/1: flows 900..904
      from(5, 0, 0);
      from(905, 0, 1);
      assert.equal(flow.stats().missed, 0, 'one engine’s count was read against the other’s');

      // The type is part of what names an engine: the same id on another type is a third count.
      from(40_000, 1, 1);
      from(10, 0, 0);
      from(910, 0, 1);
      from(40_005, 1, 1);
      assert.equal(flow.stats().missed, 0, 'two engine types with one id shared a sequence');

      // Keyed apart is not the same as not compared: engine 0/1 was at 915, and 915..917 are lost.
      from(918, 0, 1);
      from(15, 0, 0);
      assert.equal(flow.stats().missed, 3);
      assert.equal(flow.stats().received, 50);
    });

    it('follows a bounded number of sequences, and forgets the one silent longest (`B-10`)', async () => {
      // The scope is read out of the datagram, so a device can name as many as it likes.
      const flow = await listener();
      deliver(datagram('192.0.2.1', 0, 1, 'packets', 'netflow9', 'first'));
      deliver(datagram('192.0.2.1', 0, 1, 'packets', 'netflow9', 'second'));
      // Heard again, so `second` is now the one silent longest.
      deliver(datagram('192.0.2.1', 1, 1, 'packets', 'netflow9', 'first'));
      for (let domain = 0; domain < MAX_SEQUENCES - 1; domain += 1) {
        deliver(datagram('192.0.2.1', 0, 1, 'packets', 'netflow9', String(domain)));
      }
      assert.equal(flow.stats().missed, 0);

      // `first` was kept, because it had spoken since: a gap in it is still a gap.
      deliver(datagram('192.0.2.1', 12, 1, 'packets', 'netflow9', 'first'));
      assert.equal(flow.stats().missed, 10, 'the sequence heard more recently was forgotten');
      // `second` was forgotten: its next datagram is a first, and no loss is read into it.
      deliver(datagram('192.0.2.1', 50, 1, 'packets', 'netflow9', 'second'));
      assert.equal(flow.stats().missed, 10, 'a forgotten sequence was compared');
    });

    it('counts records this collector had no template for', async () => {
      const flow = await listener();
      const message = datagram('192.0.2.1', 0, 1);
      deliver({ ...message, message: { ...message.message, undecodable: 3 } });
      assert.equal(flow.stats().undecodable, 3);
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
