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
import type { FlowReceiverOptions, ReceivedFlow } from '@ms/sensors/flow';
import type { ReceivedTrap, TrapReceiverOptions } from '@ms/sensors/snmp';
import type { ReceivedSyslog, SyslogReceiverOptions } from '@ms/sensors/syslog';
import { FlowListener } from '../src/listeners/flow-listener.js';
import { TrapListener } from '../src/listeners/trap-listener.js';
import { SyslogListener } from '../src/listeners/syslog-listener.js';
import { within } from './support/probe-process.js';

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
const flowType = typeOf('flow.netflow');

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
  params: Readonly<Record<string, unknown>> = {},
  host = '192.0.2.7',
): Promise<{ primary: number; message: string; missed: number }> {
  const executed = await type.execute({
    sensorId,
    target: { host, ipVersion: 'auto' },
    params: { sourceIsDevice: false, ...params },
    credentials: {},
    signal: new AbortController().signal,
    received,
  });
  const primary = executed.channels[0]?.value;
  assert.ok(typeof primary === 'number');
  const missed = executed.channels.find((one) => one.key === 'dropped')?.value ?? 0;
  return { primary, message: executed.message ?? '', missed };
}

/** The syslog message the device sends, parsed once rather than per delivery. */
const SYSLOG_LINE = parseSyslog('<35>Aug 27 09:15:00 gw sshd[1]: authentication failure');

/** One NetFlow v5 export of one flow record, numbered as the exporter would. */
const flowExport = (sequence: number): ReceivedFlow => ({
  source: '192.0.2.7',
  message: {
    dialect: 'netflow5',
    sequence,
    sequenceCounts: 'flows',
    undecodable: 0,
    sysUptimeMs: 3_600_000,
    unixSecs: 1_700_000_000,
    records: [
      {
        srcAddr: '10.0.0.1',
        dstAddr: '10.0.0.2',
        srcPort: 1_000,
        dstPort: 443,
        protocol: 6,
        packets: 1,
        octets: 64,
        inputIf: 1,
        outputIf: 2,
        samplingRate: 1,
      },
    ],
  },
});

async function probeOf(
  every = EVERY,
  withSyslog = true,
  withFlow = false,
): Promise<{
  traps: TrapListener;
  syslog: SyslogListener;
  flows: FlowListener;
  advance: (ms: number) => void;
  /** `count` of each, all at once, as a device in trouble sends them. */
  burst: (count: number) => void;
  /** The device stops sending; time still passes. */
  silence: () => void;
  received: () => { traps: number; messages: number; flows: number };
}> {
  let now = T0;
  let deliverTrap: ((trap: ReceivedTrap) => void) | undefined;
  let deliverSyslog: ((message: ReceivedSyslog) => void) | undefined;
  let deliverFlow: ((flow: ReceivedFlow) => void) | undefined;
  let flowSequence = 0;
  const clock = (): Date => new Date(now);
  const traps = new TrapListener({
    logger: silent,
    port: 0,
    address: '127.0.0.1',
    transport: 'udp4',
    communities: [],
    bufferSize: 100,
    now: clock,
    monotonic: () => now - T0,
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
    monotonic: () => now - T0,
    open: (options: SyslogReceiverOptions) => {
      deliverSyslog = options.onMessage;
      return { close: () => Promise.resolve() };
    },
  });
  const flows = new FlowListener({
    logger: silent,
    port: 0,
    address: '127.0.0.1',
    ipVersion: 'udp4',
    exporters: [],
    bufferSize: 100,
    now: clock,
    monotonic: () => now - T0,
    open: (options: FlowReceiverOptions) => {
      deliverFlow = options.onFlow;
      return {
        close: () => Promise.resolve(),
        templates: () => ({ held: 0, redefined: 0, expired: 0, evicted: 0 }),
      };
    },
  });
  await traps.start();
  await syslog.start();
  await flows.start();

  const send = (): void => {
    deliverTrap?.({ source: '192.0.2.7', detail, community: 'public' });
    if (withSyslog) {
      deliverSyslog?.({ source: '192.0.2.7', transport: 'udp', message: SYSLOG_LINE });
    }
    if (withFlow) {
      deliverFlow?.(flowExport(flowSequence));
      flowSequence += 1;
    }
  };
  // The device's ordinary traffic, one every `every` milliseconds, for however long passes.
  let nextSend = T0 + every;
  const advance = (ms: number): void => {
    const until = now + ms;
    while (nextSend <= until) {
      now = nextSend;
      send();
      nextSend += every;
    }
    now = until;
  };
  const silence = (): void => {
    nextSend = Number.POSITIVE_INFINITY;
  };
  const burst = (count: number): void => {
    for (let i = 0; i < count; i += 1) send();
  };
  return {
    traps,
    syslog,
    flows,
    advance,
    burst,
    silence,
    received: () => ({
      traps: traps.stats().received,
      messages: syslog.stats().received,
      flows: flows.stats().received,
    }),
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

  it('raises no alarm when a cut push kept the sensors off the wheel for two hours', async () => {
    // The probe has run, its sensors scanning each minute, when the core sends a full push and
    // the link drops after chunk one — which holds only the ping sensor. The scheduler stops
    // scanning the other forty; the link stays down two hours and the buffers wrap. The whole push
    // then brings them back. Kept cursors would hand each two hours as one reading and a loss.
    const probe = await probeOf();
    probe.traps.retain(held, true);
    probe.syslog.retain(held, true);
    const lastRead = new Map<number, number>();
    for (let minute = 0; minute < 3; minute += 1) {
      probe.advance(MINUTE);
      const total = probe.received();
      for (const id of trapIds) {
        probe.traps.drain(id, MINUTE);
        lastRead.set(id, total.traps);
      }
      for (const id of syslogIds) {
        probe.syslog.drain(id, MINUTE);
        lastRead.set(id, total.messages);
      }
    }

    probe.traps.retain([999], false);
    probe.syslog.retain([999], false);
    probe.advance(OUTAGE);
    probe.traps.retain(held, true);
    probe.syslog.retain(held, true);

    let breaches = 0;
    let failures = 0;
    for (let index = 0; index < SENSORS; index += 1) {
      probe.advance(3_000);
      const total = probe.received();
      for (const [type, id, batch, received] of [
        [
          trapType,
          trapIds[index] ?? 0,
          probe.traps.drain(trapIds[index] ?? 0, MINUTE),
          total.traps,
        ],
        [
          syslogType,
          syslogIds[index] ?? 0,
          probe.syslog.drain(syslogIds[index] ?? 0, MINUTE),
          total.messages,
        ],
      ] as const) {
        assert.equal(
          batch.items.length + (batch.earlier ?? 0) + batch.dropped,
          received - (lastRead.get(id) ?? 0),
          `sensor ${String(id)} cannot account for what arrived since its last scan`,
        );
        assert.ok((batch.earlier ?? 0) > 300, 'two hours came before the window');
        try {
          const { primary } = await scan(type, id, batch);
          if (primary > LIMIT) breaches += 1;
        } catch {
          failures += 1;
        }
      }
    }
    assert.equal(failures, 0, 'a first scan after the cut failed: an alarm for the outage');
    assert.equal(breaches, 0, 'a first scan after the cut crossed its limit');
  });

  it('puts no outage on the Missed channel when a steady flood overran the buffer for two hours', async () => {
    // Two thousand traps a minute into a buffer of a hundred, for the two hours the probe waited
    // for its core. Every ordinary scan misses about 1,900 — the buffer is too small for this
    // device, and the Missed channel says so, a minute at a time; an operator who accepts it
    // turns off "fail when notifications were missed" and sets a limit on Missed above it. The
    // first scans after the reconnect must read as one minute does, not as two hours: the
    // ring cannot date most of what it lost, and that is undated, not missed.
    const FLOOD = 30;
    const probe = await probeOf(FLOOD, false);
    probe.advance(OUTAGE);
    probe.traps.retain(held, true);
    const perMinute = MINUTE / FLOOD;

    let spikes = 0;
    for (const id of trapIds) {
      probe.advance(3_000);
      const received = probe.received().traps;
      const batch = probe.traps.drain(id, MINUTE);
      assert.equal(
        batch.items.length + batch.dropped + (batch.earlier ?? 0) + (batch.undated ?? 0),
        received,
        `sensor ${String(id)} cannot account for every trap`,
      );
      const { missed, message } = await scan(trapType, id, batch, { warnOnDropped: false });
      if (missed > perMinute) spikes += 1;
      assert.match(message, /more traps left the probe’s buffer before it could tell/);
    }
    assert.equal(
      spikes,
      0,
      'a first scan missed more than a minute’s traffic: the outage as one reading',
    );
    assert.ok(probe.traps.stats().overwrittenUnread > 200_000, 'and Probe Health has the loss');

    // An ordinary minute on the same device, for comparison: the Missed channel's usual reading.
    probe.advance(MINUTE);
    const last = trapIds[SENSORS - 1] ?? 0;
    const minute = await scan(trapType, last, probe.traps.drain(last, MINUTE), {
      warnOnDropped: false,
    });
    assert.ok(
      minute.missed > 1_800 && minute.missed <= perMinute,
      `a minute missed ${String(minute.missed)}`,
    );
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

describe('a first scan that fails on what it missed still names what it did not read (`P-274`)', () => {
  // A batch the ring could not date always carries a full buffer `dropped`, and syslog always,
  // and trap and flow under their default parameters, fail on `dropped`. Before `P-274` that
  // failure said the hundred overwritten and not the hundreds of thousands the ring could not
  // date, which only Probe Health's total had. Only `sourceIsDevice` is set, as everywhere here:
  // the simulated device is not the sensor's host.
  const FLOW_ID = 301;
  const all = [...held, FLOW_ID];

  async function firstScans(
    probe: Awaited<ReturnType<typeof probeOf>>,
    failure = /overwritten before this sensor read them/,
    params: Readonly<Record<string, unknown>> = {},
    host?: string,
  ): Promise<{ type: SensorType; noun: string; batch: ReceivedBatch; message: string }[]> {
    probe.traps.retain(all, true);
    probe.syslog.retain(all, true);
    probe.flows.retain(all, true);
    probe.advance(3_000);
    const scans: { type: SensorType; noun: string; batch: ReceivedBatch; message: string }[] = [];
    for (const [type, noun, id, batch] of [
      [trapType, 'traps', trapIds[0] ?? 0, probe.traps.drain(trapIds[0] ?? 0, MINUTE)],
      [syslogType, 'messages', syslogIds[0] ?? 0, probe.syslog.drain(syslogIds[0] ?? 0, MINUTE)],
      [flowType, 'flow records', FLOW_ID, probe.flows.drain(FLOW_ID, MINUTE)],
    ] as const) {
      let message: string | undefined;
      const scanned = within(
        10_000,
        `${type.id}'s first scan`,
        scan(type, id, batch, params, host),
      );
      await assert.rejects(scanned, (error: unknown) => {
        assert.ok(error instanceof Error);
        message = error.message;
        return true;
      });
      assert.ok(message !== undefined);
      assert.match(message, failure, `${type.id}: the failure is still the one it was`);
      scans.push({ type, noun, batch, message });
    }
    return scans;
  }

  it('names the undated, after a flood the ring could not date', async () => {
    // Two thousand a minute of each, for the two hours the probe waited for its core.
    const probe = await probeOf(30, true, true);
    probe.advance(OUTAGE);
    for (const { type, noun, batch, message } of await firstScans(probe)) {
      const undated = batch.undated ?? 0;
      assert.ok(undated > 200_000, `${type.id}: most of two hours could not be dated`);
      assert.equal(batch.dropped, 100, `${type.id}: and a full buffer is dropped`);
      const said =
        `; ${String(undated)} more ${noun} left the probe’s ` +
        'buffer before it could tell when they arrived';
      assert.ok(message.includes(said), `${type.id} does not name the undated: ${message}`);
    }
  });

  it('names the earlier, after a burst inside the window', async () => {
    // Two hours of the ordinary three a minute, then a burst of 150 half a minute before the
    // scans: more than the buffer holds inside the window, and two hours before it.
    const probe = await probeOf(EVERY, true, true);
    probe.advance(OUTAGE + 30_000);
    probe.burst(150);
    for (const { type, noun, batch, message } of await firstScans(probe)) {
      const earlier = batch.earlier ?? 0;
      assert.ok(earlier > 300, `${type.id}: two hours came before the window`);
      assert.ok(batch.dropped > 0, `${type.id}: and the burst overran the buffer`);
      const said =
        `; ${String(earlier)} ${noun} the probe received ` +
        `before ${batch.since} are not in this reading`;
      assert.ok(message.includes(said), `${type.id} does not name the earlier: ${message}`);
    }
  });

  it('names the earlier when a flow sensor fails on silence: the exporter stopped recently', async () => {
    // The exporter sent its ordinary three a minute for 1 h 55 min of the two hours the probe
    // waited for its core, then stopped. The first scan's window is quiet, so the flow sensor
    // fails on silence under its default parameters — and the earlier count is what tells the
    // operator the exporter was sending until a few minutes ago.
    const probe = await probeOf(EVERY, false, true);
    probe.advance(OUTAGE - 5 * MINUTE);
    probe.silence();
    probe.advance(5 * MINUTE);
    probe.flows.retain(all, true);
    probe.advance(3_000);
    const batch = probe.flows.drain(FLOW_ID, MINUTE);
    assert.equal(batch.items.length, 0, 'nothing in the window');
    assert.equal(batch.dropped, 0);
    const earlier = batch.earlier ?? 0;
    assert.equal(earlier, probe.received().flows, 'all of it came before the window');
    assert.ok(earlier > 300);

    let message: string | undefined;
    await assert.rejects(
      within(10_000, 'the flow sensor’s first scan', scan(flowType, FLOW_ID, batch)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        message = error.message;
        return true;
      },
    );
    assert.ok(message !== undefined);
    assert.match(
      message,
      /^no flows arrived from any exporter since /,
      'still the silence failure',
    );
    const said =
      `; ${String(earlier)} flow records the probe received before ${batch.since} are not in ` +
      'this reading';
    assert.ok(message.includes(said), `the silence failure does not name the earlier: ${message}`);
  });

  it('names the earlier when the device’s name resolves to nothing', async () => {
    // Each type counts only its device's own messages by default, and a device name that resolves
    // to nothing fails the scan (`P-246`) — after the listener has moved the cursor.
    const probe = await probeOf(EVERY, true, true);
    probe.advance(OUTAGE);
    for (const { type, noun, batch, message } of await firstScans(
      probe,
      /that name did not resolve to any address/,
      { sourceIsDevice: true },
      'no-such-device.invalid',
    )) {
      const earlier = batch.earlier ?? 0;
      assert.ok(earlier > 300, `${type.id}: two hours came before the window`);
      const said =
        `; ${String(earlier)} ${noun} the probe received ` +
        `before ${batch.since} are not in this reading`;
      assert.ok(message.includes(said), `${type.id} does not name the earlier: ${message}`);
    }
  });
});
