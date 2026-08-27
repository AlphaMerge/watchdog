import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isProtocolCompatible,
  MIN_PROTOCOL_VERSION,
  parseCoreToProbe,
  parseProbeToCore,
  PROTOCOL_VERSION,
  ProtocolError,
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
    assert.equal(parseProbeToCore({ type: 'bye', reason: 'shutting down' }).type, 'bye');
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

  it('rejects versions outside it, in both directions', () => {
    assert.equal(isProtocolCompatible(MIN_PROTOCOL_VERSION - 1), false);
    assert.equal(isProtocolCompatible(PROTOCOL_VERSION + 1), false);
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
