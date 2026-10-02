import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  ethernetFrame,
  exportNetflowV5,
  renderIpfix,
  renderNetflowV5,
  renderNetflowV9,
  renderSflow,
  type TemplateSpec,
} from '@ms/simulators';
import {
  versionFor,
  type CheckResult,
  type ProbeHealthReport,
  type ProbeToCoreMessage,
  type SensorAssignment,
} from '@ms/shared';
import {
  FakeCore,
  freeUdpPort,
  generateCerts,
  LOOPBACK_V6,
  loopbackV6Available,
  opensslAvailable,
  sendUdp,
  startProbe,
  udpPortTaken,
  type RunningProbe,
} from './support/probe-process.js';

/**
 * The flow collector in a running probe (`B-07`).
 *
 * `B-01`…`B-06` built a decoder, a listener, a sensor type and five health fields, each with its
 * own tests, and `main.ts` constructed none of it: a flow sensor could be created, and every scan
 * of it failed naming a configuration key the schema refused. Nothing below constructs a
 * `FlowListener`. Each case starts `ms-probe` from a configuration file, lets a core assign it a
 * `flow.netflow` sensor, and reads what the probe sends back.
 *
 * `B-09` is the rest of what reaches that socket and had only been sent to a listener: NetFlow v9,
 * IPFIX and sFlow, the buffer's size and the socket's family.
 */

/** Whether `::1` can be bound here. Asked once, before the cases are declared. */
const v6 = await loopbackV6Available();

const SENSOR_ID = 41;
const FLOW_FIELDS = [
  'flowReceived',
  'flowRejected',
  'flowMalformed',
  'flowMissed',
  'flowUndecodable',
] as const;

const flowSensor: SensorAssignment = {
  sensorId: SENSOR_ID,
  sensorType: 'flow.netflow',
  params: {},
  // The exporter below sends from here, and the sensor counts only its own device's flows.
  target: { host: '127.0.0.1', ipVersion: 'auto' },
  intervalSeconds: 1,
  timeoutMs: 10_000,
};

/**
 * One template for both templated dialects: source, destination, protocol, octets, packets.
 * RFC 7012's element ids, which v9 shares for these five.
 */
const TEMPLATE: TemplateSpec = {
  templateId: 256,
  fields: [
    { id: 8, length: 4 },
    { id: 12, length: 4 },
    { id: 4, length: 1 },
    { id: 1, length: 4 },
    { id: 2, length: 4 },
  ],
};

/** One data record laid out to `TEMPLATE`, from 10.0.x.y to 10.0.0.2. */
function templated(source: number, protocol: number, octets: number, packets: number): Buffer {
  const record = Buffer.alloc(17);
  record.set([10, 0, (source >> 8) & 0xff, source & 0xff], 0);
  record.set([10, 0, 0, 2], 4);
  record.writeUInt8(protocol, 8);
  record.writeUInt32BE(octets, 9);
  record.writeUInt32BE(packets, 13);
  return record;
}

const resultFor =
  (accept: (result: CheckResult) => boolean) =>
  (message: ProbeToCoreMessage): CheckResult | undefined =>
    message.type === 'results'
      ? message.results.find((result) => result.sensorId === SENSOR_ID && accept(result))
      : undefined;

const healthOf = (message: ProbeToCoreMessage): ProbeHealthReport | undefined =>
  message.type === 'heartbeat' ? message.health : undefined;

const channel = (result: CheckResult, key: string): number | undefined =>
  result.channels.find((reading) => reading.key === key)?.value ?? undefined;

describe(
  'the flow collector in a running probe (`B-07`)',
  { skip: opensslAvailable ? false : 'openssl is not available' },
  () => {
    let dir: string;
    const running: RunningProbe[] = [];
    const cores: FakeCore[] = [];

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-probe-flow-'));
      generateCerts(dir);
    });

    after(async () => {
      for (const probe of running) await probe.stop().catch(() => undefined);
      for (const core of cores) await core.stop();
      await rm(dir, { recursive: true, force: true });
    });

    async function probeWith(
      flowListener: Record<string, unknown> | undefined,
      profile?: 'v1' | 'full',
      sensor: SensorAssignment = flowSensor,
    ): Promise<{ core: FakeCore; probe: RunningProbe }> {
      const { core, port } = await FakeCore.start(dir, [sensor]);
      cores.push(core);
      const probe = startProbe({
        dir,
        corePort: port,
        config: flowListener === undefined ? {} : { flowListener },
        ...(profile === undefined ? {} : { profile }),
      });
      running.push(probe);
      try {
        await core.waitFor('the probe to take its sensor', (message) =>
          message.type === 'config-ack' ? message : undefined,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the probe logged ` +
            JSON.stringify(probe.logs().slice(-8)),
          { cause: error },
        );
      }
      return { core, probe };
    }

    it(
      'counts a NetFlow datagram into a reading, and its counters into the heartbeat',
      { timeout: 300_000 },
      async () => {
        const port = await freeUdpPort();
        const { core, probe } = await probeWith(
          // An allow-list of one, so a datagram from anywhere else is turned away and counted.
          { enabled: true, port, address: '127.0.0.1', exporters: ['127.0.0.1'] },
          'full',
        );
        const collector = { host: '127.0.0.1', port };

        assert.equal(await udpPortTaken(port), true, 'the probe did not open its flow port');

        // Before anything is exported: the collector is running and has heard nothing, which is
        // a different failure from a collector nobody switched on.
        const silent = await core.waitFor(
          'a first scan',
          resultFor(() => true),
        );
        assert.equal(silent.outcome, 'error');
        assert.match(silent.message, /no flows arrived from 127\.0\.0\.1/);
        assert.deepEqual(silent.channels, [], 'a failed check records no channel values');

        // One datagram, two flows: 1,000 bytes of TCP and 500 of UDP from two sources.
        await exportNetflowV5(
          collector,
          [
            { srcAddr: '10.0.0.1', octets: 1_000, packets: 4, protocol: 6 },
            { srcAddr: '10.0.0.9', octets: 500, packets: 2, protocol: 17 },
          ],
          { flowSequence: 0 },
        );
        const reading = await core.waitFor(
          'a reading of the exported flows',
          resultFor((result) => result.outcome === 'ok'),
        );
        assert.match(reading.message, /^2 flows, .* from 2 sources since /);
        const bytes = channel(reading, 'bytes');
        const tcp = channel(reading, 'tcp');
        const udp = channel(reading, 'udp');
        assert.ok(bytes !== undefined && bytes > 0, `no traffic was read: ${String(bytes)}`);
        assert.ok(tcp !== undefined && udp !== undefined && udp > 0);
        // Rates over one window, so the ratios are exactly what was exported whatever the window.
        assert.ok(Math.abs(tcp / udp - 2) < 1e-9, `TCP ${String(tcp)} against UDP ${String(udp)}`);
        assert.ok(Math.abs(bytes / udp - 3) < 1e-9, `all ${String(bytes)} against ${String(udp)}`);
        assert.equal(channel(reading, 'icmp'), 0);
        assert.equal(channel(reading, 'hosts'), 2);

        // Three more, one for each counter that says what a reading cannot: a sequence that
        // jumped from 2 to 7 (five flows the exporter sent and this probe never got), a datagram
        // cut short, and one from an exporter that is not on the list. Linux answers for the
        // whole of 127.0.0.0/8, which is what lets one host be two exporters.
        const mark = core.received.length;
        await exportNetflowV5(collector, [{ octets: 64 }], { flowSequence: 7 });
        await sendUdp(renderNetflowV5([{ octets: 64 }], { truncateTo: 30 }), collector);
        await sendUdp(
          renderNetflowV5([{ octets: 64 }], { flowSequence: 8 }),
          collector,
          '127.0.0.2',
        );
        // And one to an address the collector was not told to listen on, which nothing counts.
        await sendUdp(renderNetflowV5([{ octets: 64 }], { flowSequence: 8 }), {
          host: '127.0.0.2',
          port,
        });

        const health = await core.waitFor(
          'a heartbeat carrying all four datagrams',
          (message) => {
            const sent = healthOf(message);
            return sent?.flowReceived === 3 && sent.flowRejected === 1 && sent.flowMalformed === 1
              ? sent
              : undefined;
          },
          { from: mark },
        );
        assert.equal(health.flowMissed, 5);
        assert.equal(health.flowUndecodable, 0);

        // The same probe against a core one version below the counters. That core's health schema
        // may not have the five fields, and it refuses the whole heartbeat for one it does not
        // know. Named by the capability and not as "this build's version less one": the build has
        // moved on since (`A-41c` is 24), and one below it is a core that does have them.
        const below = versionFor('flowCounters') - 1;
        core.protocolVersion = below;
        const reconnect = core.received.length;
        core.dropLink();
        const older = await core.waitFor('a heartbeat to the older core', healthOf, {
          from: reconnect,
        });
        assert.equal(typeof older.scheduled, 'number', 'the rest of the report still goes');
        for (const field of FLOW_FIELDS) {
          assert.equal(
            field in older,
            false,
            `${field} was sent to a core at protocol ${String(below)}`,
          );
        }

        assert.deepEqual(core.refused, [], 'the probe sent something a core refuses');
        assert.equal(await probe.stop(), 0, 'the probe did not stop cleanly');
        const stopped = probe.logs().find((line) => line['msg'] === 'flow listener stopped');
        assert.ok(stopped !== undefined, 'the collector was not closed in the probe’s shutdown');
        assert.equal(stopped['received'], 3, 'and it had counted every flow it was sent');
        assert.equal(await udpPortTaken(port), false, 'the flow port outlived the probe');
      },
    );

    it(
      'reads NetFlow v9, IPFIX and sFlow as it reads v5, and fails a scan its buffer was too small for (`B-09`)',
      { timeout: 300_000 },
      async () => {
        const port = await freeUdpPort();
        // The smallest buffer the schema allows, so one datagram can overrun it.
        const BUFFER = 100;
        const { core, probe } = await probeWith(
          { enabled: true, port, address: '127.0.0.1', bufferSize: BUFFER },
          'full',
        );
        const collector = { host: '127.0.0.1', port };
        const ok = resultFor((result) => result.outcome === 'ok');
        const near = (actual: number | undefined, expected: number, what: string): void => {
          assert.ok(
            actual !== undefined && expected > 0 && Math.abs(actual / expected - 1) < 1e-9,
            `${what}: ${String(actual)} against ${String(expected)}`,
          );
        };

        // The sensor's cursor exists from its first scan, and everything below is counted from it.
        const silent = await core.waitFor(
          'a first scan',
          resultFor(() => true),
        );
        assert.match(silent.message, /no flows arrived from 127\.0\.0\.1/);

        // **One datagram a dialect, and the next only once the last was read.** A datagram is
        // decoded and buffered in one turn of the probe's loop, so a scan sees all of it or none,
        // and each reading below is of exactly one dialect whenever its scan happened to land.

        // NetFlow v9: template and data together, three UDP flows from three sources.
        let mark = core.received.length;
        await sendUdp(
          renderNetflowV9(
            [TEMPLATE],
            [
              {
                templateId: 256,
                records: [
                  templated(1, 17, 300, 3),
                  templated(2, 17, 300, 3),
                  templated(3, 17, 300, 3),
                ],
              },
            ],
            { sequence: 0 },
          ),
          collector,
        );
        const v9 = await core.waitFor('a reading of the NetFlow v9 flows', ok, { from: mark });
        assert.match(v9.message, /^3 flows, .* from 3 sources since /);
        assert.equal(channel(v9, 'hosts'), 3);
        assert.equal(channel(v9, 'tcp'), 0);
        near(channel(v9, 'udp'), channel(v9, 'bytes') ?? 0, 'v9 was all UDP');
        // 900 octets in 9 packets across 3 flows, as rates over one window.
        near(channel(v9, 'bytes'), (channel(v9, 'flows') ?? 0) * 300, 'v9 octets per flow');
        near(channel(v9, 'bytes'), (channel(v9, 'packets') ?? 0) * 100, 'v9 octets per packet');

        // IPFIX: the same template under its own set id and header, one ICMP flow.
        mark = core.received.length;
        await sendUdp(
          renderIpfix([TEMPLATE], [{ templateId: 256, records: [templated(7, 1, 640, 10)] }], {
            sequence: 0,
          }),
          collector,
        );
        const ipfix = await core.waitFor('a reading of the IPFIX flow', ok, { from: mark });
        assert.match(ipfix.message, /^1 flow, .* from 1 source since /);
        assert.equal(channel(ipfix, 'udp'), 0);
        near(channel(ipfix, 'icmp'), channel(ipfix, 'bytes') ?? 0, 'IPFIX was all ICMP');
        near(
          channel(ipfix, 'bytes'),
          (channel(ipfix, 'packets') ?? 0) * 64,
          'IPFIX octets per packet',
        );

        // sFlow: two sampled TCP frames of 1,500 bytes, each standing for a thousand. **Its
        // datagram is the agent's forty-first** (`B-10`): sFlow counts datagrams as v9 does, and
        // this address sent v9 datagram 0 above, so a collector that kept one count for both
        // would read thirty-nine lost here. `flowMissed` below says none were.
        mark = core.received.length;
        await sendUdp(
          renderSflow(
            [
              {
                samplingRate: 1_000,
                frameLength: 1_500,
                frame: ethernetFrame({ srcAddr: '10.0.1.1', protocol: 6 }),
              },
              {
                samplingRate: 1_000,
                frameLength: 1_500,
                frame: ethernetFrame({ srcAddr: '10.0.1.2', protocol: 6 }),
              },
            ],
            { sequence: 40 },
          ),
          collector,
        );
        const sflow = await core.waitFor('a reading of the sFlow samples', ok, { from: mark });
        assert.match(
          sflow.message,
          /^2 flows, .* from 2 sources since .*; estimated from 2 sampled$/,
        );
        near(channel(sflow, 'tcp'), channel(sflow, 'bytes') ?? 0, 'sFlow was all TCP');
        // Scaled by the sampling rate: a sample is a thousand packets of 1,500 bytes, not one.
        near(channel(sflow, 'packets'), (channel(sflow, 'flows') ?? 0) * 1_000, 'sFlow packets');
        near(channel(sflow, 'bytes'), (channel(sflow, 'packets') ?? 0) * 1_500, 'sFlow octets');

        const heard = await core.waitFor(
          'a heartbeat carrying all three dialects',
          (message) => {
            const sent = healthOf(message);
            return sent?.flowReceived === 6 ? sent : undefined;
          },
          { from: mark },
        );
        assert.equal(heard.flowMalformed, 0, 'a dialect was refused');
        assert.equal(heard.flowUndecodable, 0, 'a template was not learnt');
        assert.equal(heard.flowMissed, 0, 'one dialect’s sequence was read against another’s');

        // **The overflow, in one datagram, so no scan can land in the middle of it.** IPFIX has no
        // thirty-record limit: a hundred and fifty records arrive as one message and go into a
        // buffer of a hundred in one turn of the loop, and whichever scan comes next finds its
        // cursor fifty behind the oldest record still held. Nothing here depends on when it runs.
        const SENT = 150;
        // And the exporter's own count says ten records never arrived: 1 was next, this is 11.
        mark = core.received.length;
        await sendUdp(
          renderIpfix(
            [TEMPLATE],
            [
              {
                templateId: 256,
                records: Array.from({ length: SENT }, (_unused, index) =>
                  templated(index + 1, 6, 100, 1),
                ),
              },
            ],
            { sequence: 11 },
          ),
          collector,
        );
        // The first scan that is not silence. One already drained when the datagram landed may
        // still report "no flows arrived" after the mark, and that one is not about this.
        const short = await core.waitFor(
          'the scan after the overflow',
          resultFor((result) => !/no flows arrived/.test(result.message)),
          { from: mark },
        );
        assert.equal(short.outcome, 'error', short.message);
        assert.match(
          short.message,
          new RegExp(`^${String(SENT - BUFFER)} flows reached this probe but were overwritten`),
        );
        assert.deepEqual(short.channels, [], 'a count known to be short was recorded');

        // **What overflowed is the sensor's failure and not `flowMissed`.** That channel is what
        // the exporter sent and the probe never received — the ten above. The fifty were received
        // and counted, and lost to a buffer; adding them would report a local sizing mistake as a
        // lossy network.
        const overrun = await core.waitFor(
          'a heartbeat carrying the overflow',
          (message) => {
            const sent = healthOf(message);
            return sent?.flowReceived === 6 + SENT ? sent : undefined;
          },
          { from: mark },
        );
        assert.equal(overrun.flowMissed, 10);
        assert.equal(overrun.flowMalformed, 0);

        // One failed scan, not a sensor behind for ever: the cursor caught up when it failed.
        mark = core.received.length;
        await exportNetflowV5(collector, [{ octets: 64 }], { flowSequence: 0 });
        const again = await core.waitFor('a reading after the overflow', ok, { from: mark });
        assert.match(again.message, /^1 flow, /);

        assert.deepEqual(core.refused, [], 'the probe sent something a core refuses');
        assert.equal(await probe.stop(), 0, 'the probe did not stop cleanly');
        const stopped = probe.logs().find((line) => line['msg'] === 'flow listener stopped');
        assert.ok(stopped !== undefined);
        assert.equal(stopped['buffered'], BUFFER, 'the buffer was not the size it was given');
        assert.equal(stopped['overwritten'], 6 + SENT + 1 - BUFFER);
      },
    );

    it(
      'listens on the family `ipVersion` names (`B-09`)',
      { timeout: 180_000, skip: v6 ? false : 'this machine has no IPv6 loopback to bind' },
      async () => {
        const port = await freeUdpPort(LOOPBACK_V6);
        const { core, probe } = await probeWith(
          { enabled: true, port, address: '::1', ipVersion: 'udp6' },
          'full',
          // The exporter is the device, and over this socket the device is `::1`.
          { ...flowSensor, target: { host: '::1', ipVersion: 'auto' } },
        );

        assert.equal(await udpPortTaken(port, LOOPBACK_V6), true, 'nothing listens on [::1]');
        // One socket, one family: the same port on 127.0.0.1 is nobody's.
        assert.equal(await udpPortTaken(port), false, 'a udp6 collector also took the IPv4 port');

        await core.waitFor(
          'a first scan',
          resultFor(() => true),
        );
        const mark = core.received.length;
        // From an IPv6 socket, because the collector's address is one.
        await exportNetflowV5({ host: '::1', port }, [{ octets: 640, packets: 10 }], {
          flowSequence: 0,
        });
        const reading = await core.waitFor(
          'a reading of a flow exported over IPv6',
          resultFor((result) => result.outcome === 'ok'),
          { from: mark },
        );
        assert.match(reading.message, /^1 flow, /);

        assert.deepEqual(core.refused, [], 'the probe sent something a core refuses');
        assert.equal(await probe.stop(), 0);
        assert.equal(
          await udpPortTaken(port, LOOPBACK_V6),
          false,
          'the flow port outlived the probe',
        );
      },
    );

    it(
      'binds nothing until it is turned on, and the sensor names the setting that does it',
      { timeout: 180_000 },
      async () => {
        const port = await freeUdpPort();
        // Everything but `enabled`, so the only thing between this probe and a socket is that.
        const { core, probe } = await probeWith({ port, address: '127.0.0.1' }, 'full');

        const refused = await core.waitFor(
          'a first scan',
          resultFor(() => true),
        );
        assert.equal(refused.outcome, 'error');
        assert.match(refused.message, /flow collector is not running/);
        assert.match(
          refused.message,
          /set `flowListener\.enabled` to true in the probe’s configuration/,
        );
        assert.equal(
          await udpPortTaken(port),
          false,
          'a probe with the collector off bound its port',
        );

        // And its five channels gap: a zero would say a collector is running and hearing nothing.
        const health = await core.waitFor('a heartbeat', healthOf);
        for (const field of FLOW_FIELDS) assert.equal(field in health, false, field);

        assert.deepEqual(core.refused, [], 'the probe sent something a core refuses');
        assert.equal(await probe.stop(), 0);
      },
    );

    it(
      'binds nothing in a v1 build whatever the setting says, and still refuses the sensor by name',
      { timeout: 180_000 },
      async () => {
        const port = await freeUdpPort();
        const { core, probe } = await probeWith(
          { enabled: true, port, address: '127.0.0.1' },
          'v1',
        );

        const refused = await core.waitFor(
          'a first scan',
          resultFor(() => true),
        );
        assert.equal(refused.outcome, 'error');
        assert.match(
          refused.message,
          /sensor type "flow\.netflow" is not in this build: the v1 profile leaves it out/,
        );
        assert.equal(await udpPortTaken(port), false, 'a v1 probe opened a flow port');
        assert.ok(
          probe
            .logs()
            .some(
              (line) =>
                line['level'] === 'warn' &&
                String(line['msg']).startsWith('flowListener.enabled is set and this build'),
            ),
          'a setting that did nothing was not mentioned',
        );

        const health = await core.waitFor('a heartbeat', healthOf);
        for (const field of FLOW_FIELDS) assert.equal(field in health, false, field);

        assert.deepEqual(core.refused, [], 'the probe sent something a core refuses');
        assert.equal(await probe.stop(), 0);
      },
    );
  },
);
