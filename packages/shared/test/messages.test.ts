import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  isProtocolCompatible,
  negotiatedVersion,
  MIN_PROTOCOL_VERSION,
  parseCoreToProbe,
  parseProbeToCore,
  PROTOCOL_VERSION,
  ProtocolError,
  rejectionStopsMonitoring,
  type ProbeToCoreMessage,
  type RejectCode,
  type UnusableHealthField,
  type WithdrawnCode,
} from '../src/protocol/messages.js';

const hello = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  gid: '',
  displayName: 'Local probe',
  agentVersion: '0.1.0',
  accessKey: 'secret',
};

describe('protocol message validation', () => {
  it('accepts a well-formed hello', () => {
    assert.deepEqual(parseProbeToCore({ ...hello }), hello);
  });

  it('accepts heartbeat and bye', () => {
    assert.equal(parseProbeToCore({ type: 'heartbeat', seq: 0, sentAt: 'now' }).type, 'heartbeat');
  });

  it('accepts a heartbeat carrying the probe’s own health, and one without', () => {
    // Optional at the schema level, so a probe below protocol 7 still validates (`P-13`). The
    // absence of a field is a gap on that channel, never a zero — which is why the schema does
    // not require any of them.
    const withHealth = parseProbeToCore({
      type: 'heartbeat',
      seq: 3,
      sentAt: 'now',
      health: {
        scheduled: 120,
        schedulerLagMs: { p50: 2, p95: 11, p99: 30, max: 90 },
        poolSize: 48,
        poolBusy: 12,
        deferred: 7,
        refused: 2,
      },
    });
    assert.equal(withHealth.type, 'heartbeat');
    assert.equal(withHealth.health?.deferred, 7);
    // `assert.equal` narrows, so `health` is known present from the line above.
    assert.equal(withHealth.health.spoolPending, undefined, 'a probe with no spool sends none');

    const bare = parseProbeToCore({ type: 'heartbeat', seq: 4, sentAt: 'now' });
    assert.equal(bare.type === 'heartbeat' ? bare.health : 'wrong type', undefined);
  });

  it('refuses a health field the schema does not know', () => {
    // `additionalProperties: false`, so a peer inventing a channel is refused rather than having
    // it silently dropped — the same rule every other message on this wire follows.
    assert.throws(() =>
      parseProbeToCore({
        type: 'heartbeat',
        seq: 5,
        sentAt: 'now',
        health: { madeUp: 1 },
      }),
    );
  });

  it('accepts what the probe’s machine has left, and drops a percentage above a hundred', () => {
    // `P-208`, protocol 17. A percentage over 100 is a bug at the sender, and a channel with a
    // lower limit on it would read it as a machine with more memory than it has. `P-224`: it is a
    // gap, not a refused heartbeat, which cost the link on every heartbeat.
    const health = parseProbeToCore({
      type: 'heartbeat',
      seq: 7,
      sentAt: 'now',
      health: { memoryMb: 210.4, memoryAvailablePercent: 23.4, memoryAvailableMb: 1_860 },
    });
    assert.equal(health.type === 'heartbeat' ? health.health?.memoryAvailablePercent : null, 23.4);
    assert.deepEqual(
      parseProbeToCore({
        type: 'heartbeat',
        seq: 8,
        sentAt: 'now',
        health: { memoryAvailablePercent: 100.5, memoryAvailableMb: 1_860 },
      }),
      { type: 'heartbeat', seq: 8, sentAt: 'now', health: { memoryAvailableMb: 1_860 } },
    );
  });

  it('accepts a working set past its limit, which a throttled probe has', () => {
    // `P-210`. Past `memory.high` the kernel throttles rather than stops, so usage above 100% is a
    // real reading — and the one the error limit exists for — not a sender's bug.
    const health = parseProbeToCore({
      type: 'heartbeat',
      seq: 9,
      sentAt: 'now',
      health: { memoryLimitUsagePercent: 117, memoryLimitMb: 4_096 },
    });
    assert.equal(health.type === 'heartbeat' ? health.health?.memoryLimitUsagePercent : null, 117);
    assert.deepEqual(
      parseProbeToCore({
        type: 'heartbeat',
        seq: 10,
        sentAt: 'now',
        health: { memoryLimitMb: -1 },
      }),
      { type: 'heartbeat', seq: 10, sentAt: 'now', health: {} },
    );
  });

  describe('a health reading the core cannot use (P-224)', () => {
    // The health report is a set of optional readings, each already allowed to be absent, so one
    // out of range is a gap on its channel. Refusing the frame closed the link, and the probe sends
    // its worst reading of thirty seconds on every heartbeat, so it reconnected into the same
    // refusal indefinitely.
    const told: UnusableHealthField[][] = [];
    const parse = (value: unknown): ProbeToCoreMessage =>
      parseProbeToCore(value, {
        onUnusableHealth: (fields) => {
          told.push([...fields]);
        },
      });
    beforeEach(() => {
      told.length = 0;
    });

    it('drops the field, keeps the rest of the heartbeat, and says which and why', () => {
      const message = parse({
        type: 'heartbeat',
        seq: 6,
        sentAt: 'now',
        health: { deferred: -1, scheduled: 12, memoryAvailablePercent: 100.3, cpuPercent: 'high' },
      });
      assert.deepEqual(message, {
        type: 'heartbeat',
        seq: 6,
        sentAt: 'now',
        health: { scheduled: 12 },
      });
      // In the schema's order, which is the order the validator reports them in.
      assert.deepEqual(told, [
        [
          { field: 'deferred', value: -1, reason: '/health/deferred: must be >= 0' },
          // A peer's string is named by its type, not written into the log.
          { field: 'cpuPercent', value: 'string', reason: '/health/cpuPercent: must be number' },
          {
            field: 'memoryAvailablePercent',
            value: 100.3,
            reason: '/health/memoryAvailablePercent: must be <= 100',
          },
        ],
      ]);
    });

    it('drops a percentile bundle whole when one of its numbers is out of range', () => {
      const lag = { p50: 1, p95: 2, p99: -3, max: 4 };
      const message = parse({
        type: 'heartbeat',
        seq: 7,
        sentAt: 'now',
        health: { schedulerLagMs: lag, queueWaitMs: { p50: 1, p95: 2, p99: 3, max: 4 } },
      });
      assert.ok(message.type === 'heartbeat');
      assert.deepEqual(Object.keys(message.health ?? {}), ['queueWaitMs']);
      assert.equal(told[0]?.[0]?.field, 'schedulerLagMs');
    });

    it('still refuses a field the schema does not declare, and anything wrong outside health', () => {
      // A field the core does not know is a skew, which `healthForPeer` prevents; quietly
      // dropping it is how a skew becomes lost data.
      assert.throws(
        () =>
          parse({ type: 'heartbeat', seq: 8, sentAt: 'now', health: { madeUp: 1, deferred: -1 } }),
        ProtocolError,
      );
      assert.throws(
        () => parse({ type: 'heartbeat', seq: -1, sentAt: 'now', health: { deferred: -1 } }),
        /seq: must be >= 0/,
      );
      assert.throws(
        () => parse({ type: 'heartbeat', seq: 9, sentAt: 'now', health: 'fine' }),
        ProtocolError,
      );
      assert.deepEqual(told, [], 'nothing was dropped from a message that was refused');
    });

    it('says nothing about a heartbeat whose health was all usable', () => {
      parse({ type: 'heartbeat', seq: 10, sentAt: 'now', health: { deferred: 0 } });
      parse({ type: 'heartbeat', seq: 11, sentAt: 'now' });
      assert.equal(parseProbeToCore({ type: 'bye', reason: 'shutting down' }).type, 'bye');
      assert.deepEqual(told, []);
    });
  });

  describe('a check the probe refused over its credentials’ targets (A-41c)', () => {
    const result = {
      sensorId: 5,
      at: '2026-10-02T10:00:00.000Z',
      outcome: 'error',
      message: 'Not scanned: sw.dc.test resolves to 192.0.2.77, outside the allowed targets.',
      durationMs: 3,
      channels: [] as { key: string; value: number }[],
      withheld: true,
    };
    const batch = (one: Record<string, unknown>): Record<string, unknown> => ({
      type: 'results',
      batchId: 'b1',
      results: [one],
    });

    it('is accepted as an error with no readings', () => {
      assert.doesNotThrow(() => parseProbeToCore(batch(result)));
      const { withheld: _mark, ...plain } = result;
      assert.doesNotThrow(() => parseProbeToCore(batch(plain)), 'and a result without the mark');
      assert.doesNotThrow(() =>
        parseProbeToCore(
          batch({ ...plain, outcome: 'ok', channels: [{ key: 'rtt', value: 1.2 }] }),
        ),
      );
    });

    it('is refused beside an outcome that is not an error', () => {
      // The mark takes a result out of the batch before the state machine sees it: on a result
      // that measured something it would drop the reading and hold the sensor Unknown.
      assert.throws(() => parseProbeToCore(batch({ ...result, outcome: 'ok' })), ProtocolError);
    });

    it('is refused beside readings', () => {
      assert.throws(
        () => parseProbeToCore(batch({ ...result, channels: [{ key: 'rtt', value: 1.2 }] })),
        ProtocolError,
      );
    });

    it('is refused as anything but true, and in a query’s answer under the same rule', () => {
      assert.throws(() => parseProbeToCore(batch({ ...result, withheld: false })), ProtocolError);
      const answer = (one: Record<string, unknown>): Record<string, unknown> => ({
        type: 'query-result',
        queryId: 'q1',
        result: one,
      });
      assert.doesNotThrow(() => parseProbeToCore(answer(result)));
      assert.throws(() => parseProbeToCore(answer({ ...result, outcome: 'ok' })), ProtocolError);
    });
  });

  it('rejects an unknown message type', () => {
    assert.throws(() => parseProbeToCore({ type: 'exec', command: 'rm -rf /' }), ProtocolError);
  });

  it('rejects a known type with a missing field', () => {
    const { accessKey: _omitted, ...withoutKey } = hello;
    assert.throws(() => parseProbeToCore(withoutKey), ProtocolError);
  });

  it('rejects unexpected extra fields', () => {
    assert.throws(() => parseProbeToCore({ ...hello, extra: true }), ProtocolError);
  });

  it('rejects a non-object payload', () => {
    assert.throws(() => parseProbeToCore('hello'), ProtocolError);
    assert.throws(() => parseProbeToCore(null), ProtocolError);
    assert.throws(() => parseProbeToCore([hello]), ProtocolError);
  });

  it('bounds string lengths so a peer cannot send an unbounded display name', () => {
    assert.throws(
      () => parseProbeToCore({ ...hello, displayName: 'x'.repeat(1000) }),
      ProtocolError,
    );
  });

  it('validates core-to-probe messages too', () => {
    const welcome = {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      coreVersion: '0.1.0',
      gid: 'probe-1',
      heartbeatIntervalMs: 10_000,
    };
    assert.deepEqual(parseCoreToProbe(welcome), welcome);
    assert.throws(
      () => parseCoreToProbe({ type: 'reject', code: 'nope', message: 'x' }),
      ProtocolError,
    );
    assert.equal(
      parseCoreToProbe({ type: 'reject', code: 'bad-access-key', message: 'no' }).type,
      'reject',
    );
  });
});

describe('protocol version negotiation', () => {
  it('accepts versions within the supported window', () => {
    assert.equal(isProtocolCompatible(PROTOCOL_VERSION), true);
    assert.equal(isProtocolCompatible(MIN_PROTOCOL_VERSION), true);
  });

  it('rejects below the floor, and accepts above it', () => {
    // **`P-178` made this one-sided.** It used to refuse both directions, so bumping
    // `PROTOCOL_VERSION` took every un-upgraded peer offline until the fleet caught up. Every
    // feature is capability-gated on the negotiated version now, so a newer peer cannot send an
    // older one a field it would refuse — and the pair speaks the older of the two. Below
    // `MIN_PROTOCOL_VERSION` there is no shared language to negotiate down to, and that is still
    // a refusal.
    assert.equal(isProtocolCompatible(MIN_PROTOCOL_VERSION - 1), false);
    assert.equal(isProtocolCompatible(PROTOCOL_VERSION + 1), true);
    assert.equal(negotiatedVersion(PROTOCOL_VERSION + 1), PROTOCOL_VERSION, 'spoken at ours');
  });

  it('rejects nonsense rather than coercing it', () => {
    assert.equal(isProtocolCompatible(Number.NaN), false);
    assert.equal(isProtocolCompatible(1.5), false);
  });
});

/**
 * The configuration push (R-04). A peer is a boundary even when it is our own code, so the
 * assignment shape is validated on the way in like everything else.
 */
describe('configuration messages', () => {
  const assignment = {
    sensorId: 1,
    sensorType: 'icmp.ping',
    params: { count: 4 },
    target: { host: '192.0.2.1', ipVersion: 'auto' },
    intervalSeconds: 60,
    timeoutMs: 30_000,
  };

  it('accepts a snapshot, a delta and a confirmation', () => {
    assert.equal(
      parseCoreToProbe({ type: 'config-set', version: 'v1', sensors: [assignment] }).type,
      'config-set',
    );
    assert.equal(
      parseCoreToProbe({ type: 'config-delta', version: 'v2', upserted: [], removed: [3] }).type,
      'config-delta',
    );
    assert.equal(
      parseCoreToProbe({ type: 'config-unchanged', version: 'v1' }).type,
      'config-unchanged',
    );
  });

  it('accepts the acknowledgement the probe sends back', () => {
    assert.equal(
      parseProbeToCore({ type: 'config-ack', version: 'v1', scheduled: 12 }).type,
      'config-ack',
    );
  });

  it('takes a hello with or without a configuration fingerprint', () => {
    // Optional on purpose: a version-2 probe does not send one, and its handshake must still be
    // accepted rather than refused for speaking the version it advertised.
    assert.equal(parseProbeToCore({ ...hello }).type, 'hello');
    assert.equal(parseProbeToCore({ ...hello, configVersion: 'abc' }).type, 'hello');
  });

  it('refuses an assignment that is missing what a check needs', () => {
    for (const key of ['sensorId', 'sensorType', 'target', 'intervalSeconds', 'timeoutMs']) {
      const broken: Record<string, unknown> = { ...assignment };
      Reflect.deleteProperty(broken, key);
      assert.throws(
        () => parseCoreToProbe({ type: 'config-set', version: 'v', sensors: [broken] }),
        ProtocolError,
        `a sensor with no ${key} was accepted`,
      );
    }
  });

  it('refuses a target with an address family that is not one', () => {
    assert.throws(
      () =>
        parseCoreToProbe({
          type: 'config-set',
          version: 'v',
          sensors: [{ ...assignment, target: { host: 'h', ipVersion: 'v5' } }],
        }),
      ProtocolError,
    );
  });

  it('refuses an interval of zero, which would be a busy loop', () => {
    assert.throws(
      () =>
        parseCoreToProbe({
          type: 'config-set',
          version: 'v',
          sensors: [{ ...assignment, intervalSeconds: 0 }],
        }),
      ProtocolError,
    );
  });

  it('leaves sensor parameters alone, because the catalogue is what validates them', () => {
    const message = parseCoreToProbe({
      type: 'config-set',
      version: 'v',
      sensors: [{ ...assignment, params: { anything: { nested: [1, 2, 3] } } }],
    });
    assert.ok(message.type === 'config-set');
    assert.deepEqual(message.sensors[0]?.params, { anything: { nested: [1, 2, 3] } });
  });
});

/**
 * Every field these two types carry has to be in the schema beside them.
 *
 * The failure this exists for, found in a live run rather than by a test: `A-05` added
 * `credentials` to `SensorAssignment` and not to `sensorAssignmentSchema`, so the moment a
 * sensor actually had a credential the probe rejected the whole configuration with
 * `must NOT have additional properties`, disconnected, reconnected and did it again — a
 * reconnect loop in which nothing was ever scanned. Nothing else caught it: the core's tests
 * built assignments directly and never sent one, and `additionalProperties: false` means a field
 * added to the interface is silently unsendable until somebody runs the pair together.
 */
describe('the wire carries every field the types declare', () => {
  const assignment = {
    sensorId: 1,
    sensorType: 'snmp.traffic',
    params: { ifIndex: 2 },
    target: { host: '192.0.2.1', ipVersion: 'v4' as const },
    intervalSeconds: 60,
    timeoutMs: 30_000,
  };

  it('accepts an assignment carrying decrypted credentials (`A-05`)', () => {
    const message = {
      type: 'config-set',
      version: 'v1',
      sensors: [{ ...assignment, credentials: { snmp: { version: 'v2c', community: 'public' } } }],
    };
    const parsed = parseCoreToProbe(message);
    assert.ok(parsed.type === 'config-set');
    assert.deepEqual(parsed.sensors[0]?.credentials, {
      snmp: { version: 'v2c', community: 'public' },
    });
  });

  it('accepts an assignment with no credentials, which most sensors have', () => {
    const parsed = parseCoreToProbe({ type: 'config-set', version: 'v1', sensors: [assignment] });
    assert.equal(parsed.type, 'config-set');
  });

  it('accepts a reading carrying an exact counter and its width (`T-02`)', () => {
    const parsed = parseProbeToCore({
      type: 'results',
      batchId: 'b1',
      results: [
        {
          sensorId: 1,
          at: '2026-08-27T10:00:00.000Z',
          outcome: 'ok',
          message: '',
          durationMs: 1,
          channels: [
            { key: 'in', value: 1.8014398509482e16, counter: '18014398509482000', counterBits: 64 },
          ],
        },
      ],
    });
    assert.ok(parsed.type === 'results');
    assert.equal(parsed.results[0]?.channels[0]?.counter, '18014398509482000');
  });

  it('refuses a counter that is not an unsigned integer', () => {
    const withCounter = (counter: string) => () =>
      parseProbeToCore({
        type: 'results',
        batchId: 'b1',
        results: [
          {
            sensorId: 1,
            at: '2026-08-27T10:00:00.000Z',
            outcome: 'ok',
            message: '',
            durationMs: 1,
            channels: [{ key: 'in', value: 1, counter }],
          },
        ],
      });
    assert.throws(withCounter('-1'), ProtocolError);
    assert.throws(withCounter('1.5'), ProtocolError);
    assert.throws(withCounter('123456789012345678901'), ProtocolError);
  });

  it('refuses a counter width the core does not understand', () => {
    assert.throws(
      () =>
        parseProbeToCore({
          type: 'results',
          batchId: 'b1',
          results: [
            {
              sensorId: 1,
              at: '2026-08-27T10:00:00.000Z',
              outcome: 'ok',
              message: '',
              durationMs: 1,
              channels: [{ key: 'in', value: 1, counter: '1', counterBits: 16 }],
            },
          ],
        }),
      ProtocolError,
    );
  });
});

/**
 * The discovery sweep messages (`D-01`).
 *
 * **Both directions, and that is the point of this block.** These four members were written into
 * the wrong union and nothing caught it: the core sent a `sweep-start` the probe's own schema had
 * never heard of, the probe closed the connection on a protocol violation, and the pair sat in a
 * reconnect loop. Every message is asserted from the side that receives it *and* refused from the
 * side that must not — which is the assertion that was missing.
 */
describe('discovery sweep messages', () => {
  const job = {
    runId: 7,
    range: '10.0.0.0/24',
    cursor: 0,
    timeoutMs: 1_000,
    concurrency: 32,
    ratePerSecond: 0,
  };

  it('carries a sweep from core to probe', () => {
    const message = parseCoreToProbe({ type: 'sweep-start', job });
    assert.equal(message.type, 'sweep-start');
    assert.deepEqual(parseCoreToProbe({ type: 'sweep-cancel', runId: 7 }), {
      type: 'sweep-cancel',
      runId: 7,
    });
  });

  it('carries progress and an ending from probe to core', () => {
    const progress = parseProbeToCore({
      type: 'sweep-progress',
      runId: 7,
      cursor: 40,
      found: [{ address: '10.0.0.5', rttMs: 0.4 }],
      failed: 1,
    });
    assert.equal(progress.type, 'sweep-progress');
    assert.deepEqual(
      parseProbeToCore({
        type: 'sweep-finished',
        runId: 7,
        ending: 'done',
        cursor: 254,
        message: '',
      }),
      { type: 'sweep-finished', runId: 7, ending: 'done', cursor: 254, message: '' },
    );
  });

  it('refuses each of them from the wrong direction', () => {
    // The assertion that was missing. A member in the wrong union parses on the sending side
    // and is rejected on the receiving one, which shows up as a reconnect loop rather than as
    // anything naming the message.
    assert.throws(() => parseProbeToCore({ type: 'sweep-start', job }), ProtocolError);
    assert.throws(() => parseProbeToCore({ type: 'sweep-cancel', runId: 7 }), ProtocolError);
    assert.throws(
      () =>
        parseCoreToProbe({
          type: 'sweep-finished',
          runId: 7,
          ending: 'done',
          cursor: 1,
          message: '',
        }),
      ProtocolError,
    );
    assert.throws(
      () => parseCoreToProbe({ type: 'sweep-progress', runId: 7, cursor: 1, found: [], failed: 0 }),
      ProtocolError,
    );
  });

  it('refuses a job with a bound the sweep would not survive', () => {
    assert.throws(
      () => parseCoreToProbe({ type: 'sweep-start', job: { ...job, concurrency: 100_000 } }),
      ProtocolError,
    );
    assert.throws(
      () => parseCoreToProbe({ type: 'sweep-start', job: { ...job, timeoutMs: 0 } }),
      ProtocolError,
    );
    assert.throws(
      () => parseCoreToProbe({ type: 'sweep-start', job: { ...job, cursor: -1 } }),
      ProtocolError,
    );
  });

  it('refuses an ending it does not know', () => {
    assert.throws(
      () =>
        parseProbeToCore({
          type: 'sweep-finished',
          runId: 7,
          ending: 'paused',
          cursor: 1,
          message: '',
        }),
      ProtocolError,
    );
  });
});

/**
 * The identification messages (`D-02`).
 *
 * Same block as the sweep's and for the same reason: `D-01` shipped with four members in the
 * wrong union, and the assertion that would have caught it is the one that refuses each message
 * from the side that must not accept it.
 */
describe('identification messages', () => {
  const job = {
    runId: 7,
    addresses: ['10.0.0.5', '10.0.0.9'],
    cursor: 0,
    timeoutMs: 1_000,
    concurrency: 8,
    community: 'public',
  };

  it('carries a pass from core to probe', () => {
    assert.equal(parseCoreToProbe({ type: 'identify-start', job }).type, 'identify-start');
    assert.deepEqual(parseCoreToProbe({ type: 'identify-cancel', runId: 7 }), {
      type: 'identify-cancel',
      runId: 7,
    });
  });

  it('carries fingerprints and an ending from probe to core', () => {
    const progress = parseProbeToCore({
      type: 'identify-progress',
      runId: 7,
      cursor: 2,
      found: [{ address: '10.0.0.5', kind: 'linux', confidence: 45, ports: [], evidence: [] }],
    });
    assert.equal(progress.type, 'identify-progress');
    assert.equal(
      parseProbeToCore({
        type: 'identify-finished',
        runId: 7,
        ending: 'done',
        cursor: 2,
        message: '',
      }).type,
      'identify-finished',
    );
  });

  it('lets a fingerprint carry a field this build has never heard of', () => {
    // The wire schema deliberately does not enumerate them: the shape grows, and a schema that
    // refused a newer probe's perfectly good answer would defeat the version negotiation. The
    // *core* validates the shape, where the meaning is known.
    const message = parseProbeToCore({
      type: 'identify-progress',
      runId: 7,
      cursor: 1,
      found: [{ address: '10.0.0.5', kind: 'linux', somethingNewer: { model: 'X99' } }],
    });
    assert.equal(message.type, 'identify-progress');
  });

  it('refuses each of them from the wrong direction', () => {
    assert.throws(() => parseProbeToCore({ type: 'identify-start', job }), ProtocolError);
    assert.throws(() => parseProbeToCore({ type: 'identify-cancel', runId: 7 }), ProtocolError);
    assert.throws(
      () => parseCoreToProbe({ type: 'identify-progress', runId: 7, cursor: 1, found: [] }),
      ProtocolError,
    );
    assert.throws(
      () =>
        parseCoreToProbe({
          type: 'identify-finished',
          runId: 7,
          ending: 'done',
          cursor: 1,
          message: '',
        }),
      ProtocolError,
    );
  });

  it('bounds the concurrency far below the sweep’s', () => {
    // Each host opens a dozen TCP connections, a UDP socket and a resolver query, so the sweep's
    // 512 would be six thousand file descriptors and a burst that looks like a port scan.
    assert.throws(
      () => parseCoreToProbe({ type: 'identify-start', job: { ...job, concurrency: 256 } }),
      ProtocolError,
    );
    assert.equal(
      parseCoreToProbe({ type: 'identify-start', job: { ...job, concurrency: 128 } }).type,
      'identify-start',
    );
  });
});

describe('the protocol version and its own history', () => {
  it('is the highest version its doc comment claims', async () => {
    // **A field added to the health report without a bump is rejected by the far end, silently.**
    // `PROBE_HEALTH_SCHEMA` is `additionalProperties: false`, so a newer probe sending a field an
    // older core has never heard of has *every heartbeat* refused by validation, with nothing in
    // the message to say why. The bump is the whole defence, and it is the easy half to forget:
    // `P-61` added seven fields, wrote the history line for version 11, and shipped the constant
    // still reading 10 — because both ends of every test are the same build, so nothing noticed.
    //
    // The history in that comment is the contract as written down. This pins the constant to it,
    // in whichever direction they are allowed to drift apart.
    const source = await readFile(
      join(import.meta.dirname, '..', '..', 'src', 'protocol', 'messages.ts'),
      'utf8',
    );
    const declared = [...source.matchAll(/[Vv]ersion (\d+) (?:adds|added)/g)].map((m) =>
      Number(m[1]),
    );
    assert.ok(declared.length > 0, 'the comment must record what each version added');
    assert.equal(
      Math.max(...declared),
      PROTOCOL_VERSION,
      'PROTOCOL_VERSION and the version history in its comment disagree — one of them was ' +
        'not updated, and a health-report field added without a bump is refused by the far end',
    );
  });
});

describe('what a rejection means for a probe that is running', () => {
  // **The probe cannot tell "the core went away" from "the core sent me away" by the socket
  // alone**, and it must, because it answers the two oppositely: it survives the first by
  // scanning on and spooling to disk, and that same behaviour applied to the second leaves a
  // revoked machine probing somebody's network for as long as its process lives. `P-189` closes
  // the connection to make a decision land, so a bare close is exactly what a blip looks like.

  /** Every code the union has. A code added there and forgotten here fails the last test. */
  const every: RejectCode[] = [
    'protocol-version',
    'bad-access-key',
    'not-approved',
    'revoked',
    'source-not-allowed',
    'internal-error',
  ];

  it('stops a probe the core knows and will not have', () => {
    for (const code of ['revoked', 'not-approved', 'source-not-allowed'] satisfies RejectCode[]) {
      assert.equal(rejectionStopsMonitoring(code), true, code);
    }
  });

  it('keeps one scanning when the two ends merely cannot agree', () => {
    // A version skew, a key out of step, a registry that is briefly unreachable: nobody has said
    // this machine must stop, and an operator fixes one end. The spool is exactly right here —
    // the checks keep running and drain when the two ends can talk, so an upgrade costs minutes
    // of graphs rather than a hole in them.
    for (const code of [
      'protocol-version',
      'bad-access-key',
      'internal-error',
    ] satisfies RejectCode[]) {
      assert.equal(rejectionStopsMonitoring(code), false, code);
    }
  });

  it('agrees exactly with the codes that mean trust was withdrawn', () => {
    // `WithdrawnCode` names the same set from the other side — what the core may say when it
    // closes a live link — and the two drifting apart is how a probe ends up withdrawn with a
    // code it then decides to keep scanning through.
    const withdrawn: WithdrawnCode[] = ['revoked', 'not-approved', 'source-not-allowed'];
    for (const code of withdrawn) {
      assert.equal(rejectionStopsMonitoring(code), true, code);
    }
    assert.deepEqual(
      [...every.filter((code) => rejectionStopsMonitoring(code))].sort(),
      [...withdrawn].sort(),
      'a code stops monitoring without being a withdrawal, or the other way about',
    );
  });

  it('has an answer for every code there is', () => {
    // The switch has no `default`, so a new code is a type error rather than a silent assignment
    // to whichever side happened to be the fallback. This is the runtime half of that.
    for (const code of every) {
      assert.equal(typeof rejectionStopsMonitoring(code), 'boolean', code);
    }
  });
});
