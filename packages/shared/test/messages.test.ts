import { strict as assert } from 'node:assert';
import { Ajv, type ValidateFunction } from 'ajv';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { isIPv4 } from 'node:net';
import { addressAt, parseIpRange, toText } from '../src/net/ip-range.js';
import {
  IPV4_ADDRESS_PATTERN,
  isProtocolCompatible,
  negotiatedVersion,
  MIN_PROTOCOL_VERSION,
  parseCoreToProbe,
  parseProbeToCore,
  PROTOCOL_SCHEMAS,
  protocolAjv,
  PROTOCOL_VERSION,
  ProtocolError,
  rejectionStopsMonitoring,
  type CheckResult,
  type ProbeToCoreMessage,
  type RejectCode,
  type UnfitResults,
  type UnusableHealthField,
  type WithdrawnCode,
} from '../src/protocol/messages.js';
import { RESULT_LIMITS } from '../src/protocol/result-fit.js';
import {
  PATTERN_MESSAGE,
  patternMessageKeyword,
  unsaidPatterns,
} from '../src/schema/pattern-message.js';

/** What a counter the pattern refuses is told (`P-376`). */
const COUNTER_SAID = 'must be an unsigned integer written in 1 to 20 decimal digits';

const hello = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  gid: '',
  displayName: 'Local probe',
  agentVersion: '0.1.0',
  accessKey: 'secret',
};

/**
 * What the core keeps of a `results` batch, and what it said it refused or fitted (`P-281`).
 * Throws, as `parseProbeToCore` does, for a batch it refuses whole.
 */
function taken(results: readonly unknown[]): {
  kept: CheckResult[];
  unfit: UnfitResults | undefined;
} {
  let unfit: UnfitResults | undefined;
  const parsed = parseProbeToCore(
    { type: 'results', batchId: 'b1', results },
    { onUnfitResults: (told) => (unfit = told) },
  );
  assert.ok(parsed.type === 'results');
  return { kept: parsed.results, unfit };
}

/**
 * What the core keeps of a `query-result` carrying this result, and what it said it refused or
 * fitted (`P-289`). Throws, as `parseProbeToCore` does, for an answer it refuses whole.
 */
function answered(
  result: unknown,
  rest: Record<string, unknown> = {},
): { message: ProbeToCoreMessage; unfit: UnfitResults | undefined } {
  let unfit: UnfitResults | undefined;
  const message = parseProbeToCore(
    { type: 'query-result', queryId: 'q1', ...rest, result },
    { onUnfitResults: (told) => (unfit = told) },
  );
  return { message, unfit };
}

/** Asserts the core refuses this one result alone, and returns why it said it did. */
function refusedAlone(result: unknown): string {
  const { kept, unfit } = taken([result]);
  assert.deepEqual(kept, [], 'the result was kept');
  assert.equal(unfit?.refused.length, 1, `not refused: ${JSON.stringify(unfit)}`);
  return unfit.refused[0]?.reason ?? '';
}

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
    it('is accepted as an error with no readings', () => {
      // As sent, and nothing said (`P-281` review): not throwing no longer means taken.
      const { withheld: _mark, ...plain } = result;
      for (const sent of [
        result,
        plain,
        { ...plain, outcome: 'ok', channels: [{ key: 'rtt', value: 1.2 }] },
      ]) {
        const { kept, unfit } = taken([sent]);
        assert.deepEqual(kept, [sent]);
        assert.equal(unfit, undefined, JSON.stringify(unfit));
      }
    });

    // Refused alone since `P-281`, the rest of its batch kept: it used to refuse the batch.
    it('is refused beside an outcome that is not an error', () => {
      // The mark takes a result out of the batch before the state machine sees it: on a result
      // that measured something it would drop the reading and hold the sensor Unknown.
      assert.match(refusedAlone({ ...result, outcome: 'ok' }), /\(result\): must match "then"/);
    });

    it('is refused beside readings, which fitting does not take out', () => {
      assert.match(
        refusedAlone({ ...result, channels: [{ key: 'rtt', value: 1.2 }] }),
        /\/channels: must NOT have more than 0 items/,
      );
    });

    it('is refused as anything but true, and in a query’s answer under the same rule', () => {
      assert.match(refusedAlone({ ...result, withheld: false }), /\/withheld: must be equal to/);
      const kept = answered(result);
      assert.deepEqual(kept.message, { type: 'query-result', queryId: 'q1', result });
      assert.equal(kept.unfit, undefined);
      // Refused alone since `P-289`, the answer kept without it: it used to close the link.
      const refused = answered({ ...result, outcome: 'ok' });
      assert.deepEqual(refused.message, { type: 'query-result', queryId: 'q1' });
      assert.match(refused.unfit?.refused[0]?.reason ?? '', /\(result\): must match "then"/);
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

  it('carries one device’s exception to the target policy in its target, bounded (A-64)', () => {
    const excepted = {
      ...assignment,
      target: { host: 'h', ipVersion: 'auto', policyException: ['169.254.10.5', 'fe80::1'] },
    };
    const message = parseCoreToProbe({ type: 'config-set', version: 'v', sensors: [excepted] });
    assert.ok(message.type === 'config-set');
    assert.deepEqual(message.sensors[0]?.target.policyException, ['169.254.10.5', 'fe80::1']);
    // And refused as any target is, where it is not a short list of short strings.
    for (const policyException of [
      [],
      Array.from({ length: 17 }, (_, at) => `169.254.10.${String(at)}`),
      ['x'.repeat(65)],
      [5],
      '169.254.10.5',
    ]) {
      assert.throws(
        () =>
          parseCoreToProbe({
            type: 'config-set',
            version: 'v',
            sensors: [{ ...assignment, target: { host: 'h', ipVersion: 'auto', policyException } }],
          }),
        ProtocolError,
        JSON.stringify(policyException),
      );
    }
    // **Why it is gated** (`targetPolicyException`, 28): `target` is closed, so a field it does
    // not name refuses the whole message. A probe whose schema predates the field refuses it so.
    assert.throws(
      () =>
        parseCoreToProbe({
          type: 'config-set',
          version: 'v',
          sensors: [{ ...assignment, target: { host: 'h', ipVersion: 'auto', exception: [] } }],
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

  // **Left off, the reading kept** (`P-281`): the core fits a result as the probe does
  // (`fitResult`, `P-277`). It used to refuse the whole batch over one counter.
  const withCounter = (channel: Record<string, unknown>) =>
    taken([
      {
        sensorId: 1,
        at: '2026-08-27T10:00:00.000Z',
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: [{ key: 'in', value: 1, ...channel }],
      },
    ]);

  it('leaves off a counter that is not an unsigned integer, and keeps the reading', () => {
    for (const counter of ['-1', '1.5', '123456789012345678901']) {
      const { kept, unfit } = withCounter({ counter });
      assert.deepEqual(kept[0]?.channels, [{ key: 'in', value: 1 }], counter);
      // The pattern's sentence (`P-376`), not its expression, and never the value sent.
      const reason = unfit?.fitted[0]?.reason ?? '';
      assert.equal(reason, `/channels/0/counter: ${COUNTER_SAID}`, counter);
      assert.ok(!reason.includes(counter), counter);
      assert.deepEqual(unfit?.fitted[0]?.problems, [
        `channel "in"'s counter is not decimal text and was left off`,
      ]);
      assert.equal(unfit.fitted[0].droppedChannels, 0);
    }
  });

  it('leaves off a counter width the core does not understand', () => {
    const { kept, unfit } = withCounter({ counter: '1', counterBits: 16 });
    assert.deepEqual(kept[0]?.channels, [{ key: 'in', value: 1, counter: '1' }]);
    assert.equal(unfit?.refused.length, 0);
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

  describe('the addresses of a pass are dotted-quad IPv4 (A-69)', () => {
    // The schema held an address to seven to fifteen characters, which a name and an IPv6
    // address both fit. No protocol number: nothing a core sends stopped being valid, since it
    // reads them from an `inet` column that a sweep of an IPv4 range filled.
    const pass = (addresses: unknown[]) => () =>
      parseCoreToProbe({ type: 'identify-start', job: { ...job, addresses } });

    const TAKEN = ['0.0.0.0', '10.0.0.5', '169.254.169.254', '192.168.100.200', '255.255.255.255'];
    const REFUSED: readonly (readonly [string, string])[] = [
      ['an IPv6 address', 'fe80::1'],
      ['an IPv6 address of fifteen characters', '2001:db8::1:2:3'],
      ['an IPv4-mapped address', '::ffff:10.0.0.5'],
      ['a name', 'web01.lan'],
      ['a name of digits and dots', '10.0.0.example'],
      ['a trailing dot', '10.0.0.5.'],
      ['three octets', '100.200.30'],
      ['five octets', '1.2.3.4.5'],
      ['an octet over 255', '10.0.0.256'],
      ['an octet of three hundred', '300.1.1.1'],
      ['a leading zero', '010.0.0.5'],
      ['a mask', '10.0.0.0/24'],
      ['a space before', ' 10.0.0.5'],
      ['a line break after', '10.0.0.5\n'],
      ['a second address on a second line', '1.1.1.1\n2.2.2'],
      ['a port', '10.0.0.5:22'],
      ['hexadecimal', '0x0a.0.0.5'],
      ['seven characters that are not one', 'a.b.c.d'],
    ];

    it('takes every dotted quad', () => {
      assert.deepEqual(
        parseCoreToProbe({ type: 'identify-start', job: { ...job, addresses: TAKEN } }),
        {
          type: 'identify-start',
          job: { ...job, addresses: TAKEN },
        },
      );
    });

    for (const [what, address] of REFUSED) {
      it(`refuses ${what}`, () => {
        assert.throws(pass([address]), ProtocolError);
        // Wherever it is in the list.
        assert.throws(pass(['10.0.0.5', address, '10.0.0.9']), ProtocolError);
      });
    }

    it('agrees with `isIPv4` and with what a range renders, so no address a sweep found is refused', () => {
      const pattern = new RegExp(IPV4_ADDRESS_PATTERN);
      for (const [, address] of REFUSED) {
        assert.equal(pattern.test(address), false, address);
        assert.equal(isIPv4(address), false, address);
      }
      for (const address of TAKEN) assert.equal(isIPv4(address) && pattern.test(address), true);
      // Every value an octet can take, in every position, as `toText` writes it.
      for (let octet = 0; octet <= 255; octet += 1) {
        const value = (((octet << 24) >>> 0) + (octet << 16) + (octet << 8) + octet) >>> 0;
        assert.match(toText(value), pattern);
        assert.match(toText(octet), pattern);
        assert.match(toText((octet << 24) >>> 0), pattern);
      }
      const range = parseIpRange('10.20.0.0/22, 192.168.255.250-192.168.255.255');
      for (let at = 0; ; at += 1) {
        const address = addressAt(range, at);
        if (address === null) break;
        assert.match(toText(address), pattern);
      }
    });

    describe('and so are the addresses a sweep reports (A-73)', () => {
      // The other direction, held to the same pattern: `sweep-progress` took any seven to
      // fifteen characters, which the core cast to `inet`.
      const progress = (addresses: readonly string[]) => () =>
        parseProbeToCore({
          type: 'sweep-progress',
          runId: 7,
          cursor: addresses.length,
          found: addresses.map((address) => ({ address, rttMs: 0.4 })),
          failed: 0,
        });

      it('takes every dotted quad', () => {
        const message = progress(TAKEN)();
        assert.ok(message.type === 'sweep-progress');
        assert.deepEqual(
          message.found.map((host) => host.address),
          TAKEN,
        );
      });

      for (const [what, address] of REFUSED) {
        it(`refuses ${what}`, () => {
          assert.throws(progress([address]), ProtocolError);
          // Wherever it is in the batch: one bad address is a frame the core does not take.
          assert.throws(progress(['10.0.0.5', address, '10.0.0.9']), ProtocolError);
        });
      }

      it('still takes a batch that found nothing', () => {
        assert.doesNotThrow(progress([]));
      });
    });

    it('still takes a pass with no addresses, and a sweep’s report of a dotted quad', () => {
      assert.doesNotThrow(pass([]));
      assert.equal(
        parseProbeToCore({
          type: 'sweep-progress',
          runId: 7,
          cursor: 1,
          found: [{ address: '10.0.0.5', rttMs: 1 }],
          failed: 0,
        }).type,
        'sweep-progress',
      );
    });
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
    'certificate-not-bound',
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
      // A certificate out of step with the binding is the probe's own, renewed, far more often
      // than anybody else's (`P-326`): an administrator moves the binding and it is back.
      'certificate-not-bound',
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

/**
 * A `results` batch from a peer that does not fit its results (`P-281`).
 *
 * The core validated a batch whole, so one result its schema refused closed the connection, and
 * the probe sent the same batch again on reconnecting, for ever. Now each result is fitted by
 * `fitResult`, as a current probe fits it, and one that fitting cannot mend is refused alone.
 */
describe('a results batch holding a result that does not fit (`P-281`)', () => {
  const good = (sensorId: number): CheckResult => ({
    sensorId,
    at: '2026-10-07T09:00:00.000Z',
    outcome: 'ok',
    message: `reading ${String(sensorId)}`,
    durationMs: 4,
    channels: [{ key: 'rtt', value: sensorId, name: 'Round trip', unit: 'ms' }],
  });

  it('takes a batch that fits as it was sent, and says nothing', () => {
    const sent: CheckResult[] = [
      good(1),
      good(2),
      { ...good(3), outcome: 'error', channels: [], withheld: true },
    ];
    const { kept, unfit } = taken(sent);
    assert.deepEqual(kept, sent);
    assert.equal(unfit, undefined);
  });

  const unmendable: readonly [string, Record<string, unknown> | string, RegExp, number | null][] = [
    ['an outcome that is not one', { outcome: 'maybe' }, /^\/outcome: must be equal to/, 2],
    ['a sensor id that is not one', { sensorId: 0 }, /^\/sensorId: must be >= 1/, null],
    ['a sensor id of the wrong type', { sensorId: '2' }, /^\/sensorId: must be integer/, null],
    ['a time missing', { at: undefined }, /^\(result\): must have required property 'at'/, 2],
    ['a message of the wrong type', { message: 7 }, /^\/message: must be string/, 2],
    ['a duration of the wrong type', { durationMs: '4' }, /^\/durationMs: must be number/, 2],
    ['channels that are not a list', { channels: {} }, /^\/channels: must be array/, 2],
    ['a field results do not have', { extra: 1 }, /must NOT have additional properties/, 2],
    ['not an object at all', 'reading', /^\(result\): must be object/, null],
  ];

  for (const [name, change, reason, sensorId] of unmendable) {
    it(`refuses ${name} alone, and keeps the rest in order`, () => {
      const bad =
        typeof change === 'string'
          ? change
          : Object.fromEntries(
              Object.entries({ ...good(2), ...change } as Record<string, unknown>).filter(
                ([, value]) => value !== undefined,
              ),
            );
      const { kept, unfit } = taken([good(1), bad, good(3)]);
      assert.deepEqual(kept, [good(1), good(3)]);
      assert.equal(unfit?.refused.length, 1);
      assert.equal(unfit.refused[0]?.sensorId, sensorId);
      // And its time, which with the sensor names the result when it is sent again (`P-288`):
      // null when there is none to read, or the result is not an object at all.
      assert.equal(
        unfit.refused[0].at,
        typeof bad === 'string' || bad['at'] === undefined ? null : '2026-10-07T09:00:00.000Z',
      );
      assert.match(unfit.refused[0].reason, reason);
      assert.deepEqual(unfit.fitted, []);
    });
  }

  it('names a refused result by a time only when it is one the schema could take (`P-288`)', () => {
    // A time of the wrong type or past 64 characters names nothing: the core would remember a
    // key as long as a peer cared to send.
    for (const at of [7, '', 'x'.repeat(65)]) {
      const { unfit } = taken([{ ...good(2), outcome: 'maybe', at }]);
      assert.equal(unfit?.refused.length, 1);
      assert.equal(unfit.refused[0]?.at, null, JSON.stringify(at));
    }
    const { unfit } = taken([{ ...good(2), outcome: 'maybe', at: 'x'.repeat(64) }]);
    assert.equal(unfit?.refused[0]?.at, 'x'.repeat(64));
  });

  it('says at most five of one result’s errors', () => {
    const channels = Array.from({ length: 8 }, () => ({ key: 'k', value: 'x' }));
    const reason = refusedAlone({ ...good(2), outcome: 'maybe', channels });
    assert.match(reason, /; and 4 more$/);
  });

  it('fits a message too long, as the probe would have, and says what the schema said', () => {
    const { kept, unfit } = taken([good(1), { ...good(2), message: 'x'.repeat(5_000) }]);
    assert.equal(kept.length, 2);
    assert.equal(kept[1]?.message.length, RESULT_LIMITS.message);
    assert.ok(kept[1].message.endsWith('…'));
    assert.deepEqual(unfit?.refused, []);
    assert.deepEqual(unfit.fitted, [
      {
        sensorId: 2,
        at: '2026-10-07T09:00:00.000Z',
        reason: '/message: must NOT have more than 2000 characters',
        problems: [],
        droppedChannels: 0,
      },
    ]);
  });

  it('drops channels no core takes, keeps the others, and counts what it dropped', () => {
    const channels = [
      { key: 'rtt', value: 1, name: 'n'.repeat(300), unit: 'u'.repeat(80), colour: 'red' },
      { key: '', value: 2 },
      { key: 'k'.repeat(101), value: 3 },
      { key: 'text', value: 'four' },
      { key: 'loss', value: 0 },
    ];
    const { kept, unfit } = taken([{ ...good(2), channels }]);
    assert.deepEqual(
      kept[0]?.channels.map((one) => [one.key, one.name?.length, one.unit?.length]),
      [
        ['rtt', RESULT_LIMITS.name, RESULT_LIMITS.unit],
        ['loss', undefined, undefined],
      ],
    );
    assert.equal(unfit?.fitted[0]?.droppedChannels, 3);
    assert.equal(unfit.fitted[0].problems.length, 3);
  });

  it('drops the channels past the five hundredth', () => {
    const channels = Array.from({ length: 503 }, (_, at) => ({ key: `c${String(at)}`, value: at }));
    const { kept, unfit } = taken([{ ...good(2), channels }]);
    assert.equal(kept[0]?.channels.length, RESULT_LIMITS.channels);
    assert.equal(unfit?.fitted[0]?.droppedChannels, 3);
  });

  it('takes the NULs out of a result the schema took, which PostgreSQL text cannot hold', () => {
    const { kept, unfit } = taken([
      good(1),
      {
        ...good(2),
        message: 'line one\u0000line two',
        channels: [{ key: 'rtt', value: 1, name: 'Round\u0000trip', unit: 'm\u0000s' }],
      },
    ]);
    assert.equal(kept[1]?.message, 'line oneline two');
    assert.deepEqual(kept[1].channels, [{ key: 'rtt', value: 1, name: 'Roundtrip', unit: 'ms' }]);
    // Nothing was lost but the NULs, which is not worth a line: `fitResult` says the same.
    assert.equal(unfit, undefined);
  });

  it('drops a channel whose key holds a NUL or a lone surrogate, and says so', () => {
    const { kept, unfit } = taken([
      {
        ...good(2),
        message: 'half \uD83D pair',
        channels: [
          { key: 'r\u0000tt', value: 1 },
          { key: 'lone\uDC00', value: 2 },
          { key: 'pair😀', value: 3 },
        ],
      },
    ]);
    // Fitted on the core as a probe fits it, so the sensor's message says what was dropped
    // (`P-292`) as well as the lone surrogate made what PostgreSQL stores.
    assert.equal(kept[0]?.message, 'half � pair (2 channels could not be sent)');
    assert.deepEqual(kept[0].channels, [{ key: 'pair😀', value: 3 }]);
    assert.deepEqual(unfit?.refused, []);
    assert.equal(unfit.fitted[0]?.reason, '', 'the schema took it as sent');
    assert.equal(unfit.fitted[0].droppedChannels, 2);
  });

  it('still refuses a batch whole for what is wrong outside its results', () => {
    const bad = { ...good(2), outcome: 'maybe' };
    const told: UnfitResults[] = [];
    const parse = (message: Record<string, unknown>) => () =>
      parseProbeToCore(message, { onUnfitResults: (unfit) => told.push(unfit) });
    assert.throws(parse({ type: 'results', results: [good(1), bad] }), ProtocolError);
    assert.throws(parse({ type: 'results', batchId: '', results: [good(1)] }), ProtocolError);
    assert.throws(
      parse({ type: 'results', batchId: 'b', results: [good(1)], replay: true }),
      ProtocolError,
    );
    assert.throws(parse({ type: 'results', batchId: 'b', results: 'none' }), ProtocolError);
    assert.throws(
      parse({ type: 'results', batchId: 'b', results: Array.from({ length: 5_001 }, () => bad) }),
      /\/results: must NOT have more than 5000 items/,
    );
    assert.deepEqual(told, [], 'nothing is said of a batch that was refused');
  });

  it('takes a batch every result of which is refused, empty, so the probe can move on', () => {
    const { kept, unfit } = taken([{ ...good(1), outcome: 'maybe' }]);
    assert.deepEqual(kept, []);
    assert.equal(unfit?.refused.length, 1);
  });

  /**
   * A `query-result` carries the same result (`P-289`). Validated whole, one result its schema
   * refused closed the link: the operator was told the probe had gone, and every other query on
   * it failed too. Now its result goes the way a batch's does, by the same function.
   */
  describe('and a query’s answer holding one (`P-289`)', () => {
    it('takes an answer that fits as it was sent, and says nothing', () => {
      const { message, unfit } = answered(good(2));
      assert.deepEqual(message, { type: 'query-result', queryId: 'q1', result: good(2) });
      assert.equal(unfit, undefined);
    });

    for (const [name, change, reason, sensorId] of unmendable) {
      it(`refuses ${name} alone, and keeps the answer without it`, () => {
        const bad =
          typeof change === 'string'
            ? change
            : Object.fromEntries(
                Object.entries({ ...good(2), ...change } as Record<string, unknown>).filter(
                  ([, value]) => value !== undefined,
                ),
              );
        const { message, unfit } = answered(bad, { message: 'from the probe' });
        assert.deepEqual(message, {
          type: 'query-result',
          queryId: 'q1',
          message: 'from the probe',
        });
        assert.equal(unfit?.refused.length, 1);
        assert.equal(unfit.refused[0]?.sensorId, sensorId);
        assert.match(unfit.refused[0].reason, reason);
        assert.deepEqual(unfit.fitted, []);
      });
    }

    it('fits a result as a batch’s is fitted, and says what it changed', () => {
      const { message, unfit } = answered({
        ...good(2),
        message: `${'x'.repeat(5_000)}\u0000`,
        channels: [
          { key: 'rtt', value: 1, name: 'Round\u0000trip' },
          { key: 'text', value: 'four' },
        ],
      });
      assert.ok(message.type === 'query-result');
      assert.equal(message.result?.message.length, RESULT_LIMITS.message);
      assert.ok(!JSON.stringify(message).includes('\\u0000'), 'no NUL anywhere');
      assert.deepEqual(message.result.channels, [{ key: 'rtt', value: 1, name: 'Roundtrip' }]);
      assert.deepEqual(unfit?.refused, []);
      assert.equal(unfit.fitted.length, 1);
      assert.equal(unfit.fitted[0]?.droppedChannels, 1);
      assert.match(unfit.fitted[0].reason, /\/message: must NOT have more than 2000 characters/);
    });

    it('takes the NULs out of a result the schema took, and says nothing', () => {
      const { message, unfit } = answered({ ...good(2), message: 'one\u0000two' });
      assert.ok(message.type === 'query-result');
      assert.equal(message.result?.message, 'onetwo');
      assert.equal(unfit, undefined);
    });

    it('still refuses an answer whole for what is wrong outside its result', () => {
      const told: UnfitResults[] = [];
      const parse = (message: Record<string, unknown>) => () =>
        parseProbeToCore(message, { onUnfitResults: (unfit) => told.push(unfit) });
      const bad = { ...good(2), outcome: 'maybe' };
      assert.throws(parse({ type: 'query-result', result: bad }), ProtocolError);
      assert.throws(parse({ type: 'query-result', queryId: '', result: good(2) }), ProtocolError);
      assert.throws(
        parse({ type: 'query-result', queryId: 'q1', failure: 'nope', result: bad }),
        ProtocolError,
      );
      assert.throws(
        parse({ type: 'query-result', queryId: 'q1', result: good(2), extra: 1 }),
        ProtocolError,
      );
      // `/results/…` is a batch's path, not this one's.
      assert.throws(parse({ type: 'query-result', queryId: 'q1', results: [bad] }), ProtocolError);
      assert.deepEqual(told, [], 'nothing is said of an answer that was refused');
    });

    it('leaves an answer with no result as it was', () => {
      const failure = { type: 'query-result', queryId: 'q1', failure: 'busy', message: 'later' };
      assert.deepEqual(parseProbeToCore(failure), failure);
    });
  });
});

/**
 * **A pattern on the wire says a sentence, never its expression (`P-376`).** What the protocol
 * refuses is read in a log: the reason a connection closed, a health field dropped, a result
 * fitted or refused. `U-53` and `P-372` hold the catalogue, the API and the method registry to
 * the same rule.
 */
describe('a pattern on the wire says what it wants (P-376)', () => {
  /** A copy of the schema with every `x-patternMessage` taken out, for the controls. */
  function unsaid(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(unsaid);
    if (typeof node !== 'object' || node === null) return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== PATTERN_MESSAGE)
        .map(([key, value]) => [key, unsaid(value)]),
    );
  }

  /** The field each unsaid pattern sits on: the last segment of its path that is a name. */
  function fieldsOf(schema: unknown): string[] {
    return unsaidPatterns(schema).map(({ path, fault }) => {
      assert.equal(fault, 'unsaid', path);
      const names = path
        .split('.')
        .filter((segment) => !/^(?:\*|oneOf|properties)$/u.test(segment));
      return names.at(-1) ?? '';
    });
  }

  it('gives every pattern in every protocol schema a sentence, and no sentence without one', () => {
    assert.deepEqual(Object.keys(PROTOCOL_SCHEMAS).sort(), [
      'checkResult',
      'coreToProbe',
      'probeToCore',
    ]);
    for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
      assert.deepEqual(unsaidPatterns(schema), [], name);
    }
    // The control: with the sentences gone, the walk finds every pattern this protocol has, so
    // the empty lists above are the sentences' doing. The counter and where a check failed
    // (`P-285`) are in `results` and in `query-result`, which share the check result's schema.
    assert.deepEqual(fieldsOf(unsaid(PROTOCOL_SCHEMAS['probeToCore'])).sort(), [
      'address',
      'counter',
      'counter',
      'instanceId',
      'phase',
      'phase',
      'target',
      'target',
    ]);
    assert.deepEqual(fieldsOf(unsaid(PROTOCOL_SCHEMAS['coreToProbe'])), ['addresses']);
    assert.deepEqual(fieldsOf(unsaid(PROTOCOL_SCHEMAS['checkResult'])).sort(), [
      'counter',
      'phase',
      'target',
    ]);
  });

  /** Asserts a reason says the sentence, and neither the expression nor the value refused. */
  function saysTheSentence(text: string, at: string, said: RegExp, value: string): void {
    assert.match(text, new RegExp(`${at.replaceAll('/', '\\/')}: ${said.source}`, 'u'), text);
    assert.doesNotMatch(text, /must match pattern|\^|\$/u, text);
    assert.ok(!text.includes(value), `the value came back: ${text}`);
  }

  it('says it for a health field dropped from a heartbeat (P-224)', () => {
    const told: UnusableHealthField[][] = [];
    const sent = 'CANARY-not-a-uuid';
    const message = parseProbeToCore(
      { type: 'heartbeat', seq: 1, sentAt: 'now', health: { scheduled: 3, instanceId: sent } },
      {
        onUnusableHealth: (fields) => {
          told.push([...fields]);
        },
      },
    );
    assert.deepEqual(message, {
      type: 'heartbeat',
      seq: 1,
      sentAt: 'now',
      health: { scheduled: 3 },
    });
    assert.equal(told.length, 1);
    const [dropped] = told[0] ?? [];
    assert.ok(dropped !== undefined);
    assert.equal(dropped.value, 'string', 'a peer string is named by its type');
    saysTheSentence(dropped.reason, '/health/instanceId', /must be a UUID in lowercase/u, sent);
  });

  it('says it in the protocol error a sweep-progress is refused with', () => {
    const sent = '10.0.0.256';
    assert.throws(
      () =>
        parseProbeToCore({
          type: 'sweep-progress',
          runId: 7,
          cursor: 1,
          found: [{ address: sent, rttMs: 1 }],
          failed: 0,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        saysTheSentence(
          error.message,
          '/found/0/address',
          /must be a dotted-quad IPv4 address/u,
          sent,
        );
        return true;
      },
    );
  });

  it('says it in the protocol error an identify-start is refused with, at the probe', () => {
    const sent = '10.0.0.256';
    assert.throws(
      () =>
        parseCoreToProbe({
          type: 'identify-start',
          job: {
            runId: 7,
            addresses: ['10.0.0.5', sent],
            cursor: 0,
            timeoutMs: 1_000,
            concurrency: 8,
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        saysTheSentence(
          error.message,
          '/job/addresses/1',
          /must be a dotted-quad IPv4 address/u,
          sent,
        );
        return true;
      },
    );
  });

  it('says it for a query-result whose counter is fitted (P-289)', () => {
    const told: { unfit?: UnfitResults } = {};
    const sent = '12345678901234567890123';
    const message = parseProbeToCore(
      {
        type: 'query-result',
        queryId: 'q1',
        result: {
          sensorId: 1,
          at: '2026-10-09T10:00:00.000Z',
          outcome: 'ok',
          message: '',
          durationMs: 1,
          channels: [{ key: 'in', value: 1, counter: sent }],
        },
      },
      {
        onUnfitResults: (unfit) => {
          told.unfit = unfit;
        },
      },
    );
    assert.equal(message.type, 'query-result');
    saysTheSentence(
      told.unfit?.fitted[0]?.reason ?? '',
      '/channels/0/counter',
      new RegExp(COUNTER_SAID, 'u'),
      sent,
    );
  });
});

describe('the protocol Ajv is strict (P-379)', () => {
  it('refuses a mistyped keyword, a range with no type, and a required property not declared', () => {
    // Each of these compiled under `strict: false`, and constrained nothing it seemed to.
    assert.throws(
      () => protocolAjv().compile({ type: 'string', maxLenght: 5 }),
      /unknown keyword: "maxLenght"/u,
    );
    assert.throws(
      () => protocolAjv().compile({ type: 'object', properties: { n: { minimum: 0 } } }),
      /missing type "number" for keyword "minimum"/u,
    );
    assert.throws(
      () => protocolAjv().compile({ type: 'object', required: ['n'] }),
      /required property "n" is not defined/u,
    );
    // And what it is meant to take, it takes: the sentence beside a pattern is declared.
    protocolAjv().compile({ type: 'string', pattern: '^a$', [PATTERN_MESSAGE]: 'must be a' });
  });

  /**
   * What strict mode asked of the schemas is four `true` subschemas, beside a `required` that
   * names a property its own `properties` did not: `type` at both roots, a query's `kind`, and
   * the check result's `withheld` rule. `true` constrains nothing; this holds every frame below to
   * the same answer and the same errors as the schemas without them, compiled as they were.
   */
  it('answers every frame as the schemas did before they declared what they require', () => {
    const declaredOnlyForStrict = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(declaredOnlyForStrict);
      if (typeof node !== 'object' || node === null) return node;
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'properties' && typeof value === 'object' && value !== null) {
          const kept = Object.entries(value).filter(([, child]) => child !== true);
          if (kept.length === 0) continue;
          copy[key] = Object.fromEntries(
            kept.map(([name, child]) => [name, declaredOnlyForStrict(child)]),
          );
        } else {
          copy[key] = declaredOnlyForStrict(value);
        }
      }
      return copy;
    };
    const asBefore = new Ajv({
      allErrors: true,
      discriminator: true,
      strict: false,
      keywords: [patternMessageKeyword()],
    });
    const now = protocolAjv();
    const errorsOf = (validate: ValidateFunction, value: unknown): unknown =>
      validate(value)
        ? 'valid'
        : (validate.errors ?? []).map((e) => [e.instancePath, e.schemaPath, e.message]);

    const result = {
      sensorId: 5,
      at: '2026-10-09T10:00:00.000Z',
      outcome: 'error',
      message: 'refused',
      durationMs: 3,
      channels: [] as unknown[],
      withheld: true,
    };
    const assignment = {
      sensorId: 1,
      sensorType: 'icmp.ping',
      params: {},
      target: { host: '192.0.2.1', ipVersion: 'auto' },
      intervalSeconds: 60,
      timeoutMs: 30_000,
    };
    const { withheld: _mark, ...plain } = result;
    const frames: Record<string, readonly unknown[]> = {
      probeToCore: [
        hello,
        { type: 'bye', reason: 'stopping' },
        { type: 'results', batchId: 'b1', results: [result] },
        { type: 'results', batchId: 'b1', results: [{ ...result, outcome: 'ok' }] },
        { type: 'results', batchId: 'b1', results: [{ ...result, withheld: false }] },
        { type: 'results', batchId: 'b1', results: [{ ...result, channels: [{ key: 'a' }] }] },
        { type: 'query-result', queryId: 'q1', result },
        {},
        { type: 5 },
        { type: 'nonsense' },
        { reason: 'no type' },
        null,
        'hello',
      ],
      coreToProbe: [
        { type: 'query', queryId: 'q1', timeoutMs: 5_000, query: { kind: 'check', assignment } },
        { type: 'query', queryId: 'q1', timeoutMs: 5_000, query: { assignment } },
        { type: 'query', queryId: 'q1', timeoutMs: 5_000, query: { kind: 'probe', assignment } },
        { type: 'query', queryId: 'q1', timeoutMs: 5_000, query: { kind: 7 } },
        { type: 'query', queryId: 'q1', timeoutMs: 5_000, query: 'check' },
        { type: 'query-cancel', queryId: 'q1' },
        {},
        { type: null },
      ],
      checkResult: [
        result,
        plain,
        { ...plain, outcome: 'ok', channels: [{ key: 'a', value: 1 }] },
        { ...result, outcome: 'ok' },
        { ...result, withheld: 'yes' },
        { ...result, channels: [{ key: 'a', value: 1 }] },
        [],
      ],
    };
    // Accepted before, accepted now: the ones that must be, said outright.
    const accepted = [
      ['probeToCore', 0],
      ['probeToCore', 2],
      ['probeToCore', 6],
      ['coreToProbe', 0],
      ['checkResult', 0],
      ['checkResult', 1],
      ['checkResult', 2],
    ] as const;
    for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
      const before = asBefore.compile(declaredOnlyForStrict(schema) as object);
      const after = now.compile(schema as object);
      assert.notDeepEqual(declaredOnlyForStrict(schema), schema, `${name} gained a declaration`);
      for (const frame of frames[name] ?? []) {
        assert.deepEqual(errorsOf(after, frame), errorsOf(before, frame), JSON.stringify(frame));
      }
      for (const [which, index] of accepted) {
        if (which === name) assert.equal(errorsOf(after, frames[name]?.[index]), 'valid');
      }
    }
  });
});
