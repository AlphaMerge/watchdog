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
