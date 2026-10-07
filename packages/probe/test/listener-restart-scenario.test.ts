import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import {
  BUILT_IN_SENSOR_TYPES,
  parseSyslog,
  type ReceivedBatch,
  type SensorType,
  type TrapDetail,
} from '@ms/sensors';
import type { ReceivedTrap, TrapReceiverOptions } from '@ms/sensors/snmp';
import type { ReceivedSyslog, SyslogReceiverOptions } from '@ms/sensors/syslog';
import { TrapListener } from '../src/listeners/trap-listener.js';
import { SyslogListener } from '../src/listeners/syslog-listener.js';

/**
 * One outage, one alarm, across a probe restart (`P-254`, `M-17`'s rule at the probe).
 *
 * A probe starts and cannot reach its core for two hours. Its listeners hear a device the whole
 * time — a trap and a syslog error every twenty seconds, three a minute, which is its ordinary
 * rate — and the buffers overrun. Then the core answers, and forty trap and syslog sensors that
 * scan once a minute, each with an upper limit of five a minute on its count, take their first
 * scans across the next minute.
 *
 * Read back to the listener's start, every one of those first scans is two hours of traffic as
 * one reading, or a loss the buffer could not hold, and every sensor alarms on the reconnect:
 * forty alarms, for one outage, at a rate no interval exceeded. Read one interval back, each is
 * the reading any of its scans would give, nothing fails and no limit is crossed — and nothing is
 * lost silently either: what came before the window is in each first scan's message, and every
 * message the listener received is in the reading, in `earlier`, or in `dropped`.
 */

const silent = pino({ level: 'silent' });
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const OUTAGE = 2 * 60 * MINUTE;
const EVERY = 20_000;
const LIMIT = 5;
const SENSORS = 20;

const typeOf = (id: string): SensorType => {
  const type = BUILT_IN_SENSOR_TYPES.find((one) => one.id === id);
  assert.ok(type !== undefined, `no ${id} type`);
  return type;
};
const trapType = typeOf('snmp.trap');
const syslogType = typeOf('syslog.receiver');

const detail: TrapDetail = {
  trapOid: '1.3.6.1.6.3.1.1.5.3',
  version: 'v2c',
  kind: 'trap',
  varbinds: [],
};

async function scan(
  type: SensorType,
  sensorId: number,
  received: ReceivedBatch,
): Promise<{ primary: number; message: string }> {
  const executed = await type.execute({
    sensorId,
    target: { host: '192.0.2.7', ipVersion: 'auto' },
    params: { sourceIsDevice: false },
    credentials: {},
    signal: new AbortController().signal,
    received,
  });
  const primary = executed.channels[0]?.value;
  assert.ok(typeof primary === 'number');
  return { primary, message: executed.message ?? '' };
}

async function probeOf(): Promise<{
  traps: TrapListener;
  syslog: SyslogListener;
  advance: (ms: number) => void;
  received: () => { traps: number; messages: number };
}> {
  let now = T0;
  let deliverTrap: ((trap: ReceivedTrap) => void) | undefined;
  let deliverSyslog: ((message: ReceivedSyslog) => void) | undefined;
  const clock = (): Date => new Date(now);
  const traps = new TrapListener({
    logger: silent,
    port: 0,
    address: '127.0.0.1',
    transport: 'udp4',
    communities: [],
    bufferSize: 100,
    now: clock,
    open: (options: TrapReceiverOptions) => {
      deliverTrap = options.onTrap;
      return { close: () => Promise.resolve() };
    },
  });
  const syslog = new SyslogListener({
    logger: silent,
    port: 0,
    address: '127.0.0.1',
    udp: true,
    tcp: false,
    ipVersion: 'udp4',
    senders: [],
    bufferSize: 100,
    now: clock,
    open: (options: SyslogReceiverOptions) => {
      deliverSyslog = options.onMessage;
      return { close: () => Promise.resolve() };
    },
  });
  await traps.start();
  await syslog.start();

  // The device's ordinary traffic, one of each every twenty seconds, for however long passes.
  let nextSend = T0 + EVERY;
  const advance = (ms: number): void => {
    const until = now + ms;
    while (nextSend <= until) {
      now = nextSend;
      deliverTrap?.({ source: '192.0.2.7', detail, community: 'public' });
      deliverSyslog?.({
        source: '192.0.2.7',
        transport: 'udp',
        message: parseSyslog('<35>Aug 27 09:15:00 gw sshd[1]: authentication failure'),
      });
      nextSend += EVERY;
    }
    now = until;
  };
  return {
    traps,
    syslog,
    advance,
    received: () => ({ traps: traps.stats().received, messages: syslog.stats().received }),
  };
}

const trapIds = Array.from({ length: SENSORS }, (_, i) => 101 + i);
const syslogIds = Array.from({ length: SENSORS }, (_, i) => 201 + i);
/** Every sensor the probe holds, a ping sensor among them, as the sweep hands each listener. */
const held = [...trapIds, ...syslogIds, 999];

describe('a probe restart after a long wait for its core (`P-254`)', () => {
  it('raises no alarm on any sensor, and accounts for every message', async () => {
    const probe = await probeOf();
    probe.advance(OUTAGE);
    // The core answers; the push settles and the listeners are swept with what the probe holds.
    probe.traps.retain(held);
    probe.syslog.retain(held);

    let breaches = 0;
    let failures = 0;
    // Each sensor's first scan, spread across the next minute as the wheel's phases spread them.
    for (let index = 0; index < SENSORS; index += 1) {
      probe.advance(3_000);
      const total = probe.received();

      const trapBatch = probe.traps.drain(trapIds[index] ?? 0, MINUTE);
      const syslogBatch = probe.syslog.drain(syslogIds[index] ?? 0, MINUTE);
      for (const [type, id, batch, received, noun] of [
        [trapType, trapIds[index] ?? 0, trapBatch, total.traps, 'traps'],
        [syslogType, syslogIds[index] ?? 0, syslogBatch, total.messages, 'messages'],
      ] as const) {
        // Every message the listener received is read, before the window, or lost in it.
        assert.equal(
          batch.items.length + (batch.earlier ?? 0) + batch.dropped,
          received,
          `sensor ${String(id)} cannot account for every one of its listener's ${noun}`,
        );
        assert.ok((batch.earlier ?? 0) > 0, 'two hours came before the window');
        try {
          const { primary, message } = await scan(type, id, batch);
          if (primary > LIMIT) breaches += 1;
          assert.match(
            message,
            new RegExp(`; ${String(batch.earlier)} ${noun} the probe received`),
          );
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error;
          failures += 1;
        }
      }
    }
    assert.equal(failures, 0, 'a first scan failed: an alarm for the outage');
    assert.equal(breaches, 0, 'a first scan crossed its per-minute limit: an alarm for the outage');

    // And the scans after are ordinary: one interval, about three.
    probe.advance(MINUTE);
    const last = trapIds[SENSORS - 1] ?? 0;
    const next = await scan(trapType, last, probe.traps.drain(last, MINUTE));
    assert.ok(next.primary >= 2 && next.primary <= 4, `a minute read ${String(next.primary)}`);
  });

  it('would have alarmed on every sensor, read back to the listener’s start', async () => {
    // What the window prevents, measured on the same traffic: the first `P-254` change read to
    // the listener's start, and every first scan was a buffer's worth or a loss.
    const probe = await probeOf();
    probe.advance(OUTAGE);
    probe.traps.retain(held);
    probe.syslog.retain(held);

    let alarms = 0;
    for (const id of trapIds) {
      try {
        const { primary } = await scan(
          trapType,
          id,
          probe.traps.drain(id, Number.POSITIVE_INFINITY),
        );
        if (primary > LIMIT) alarms += 1;
      } catch {
        alarms += 1;
      }
    }
    assert.equal(alarms, SENSORS, 'one outage, and an alarm on every trap sensor');
  });
});
