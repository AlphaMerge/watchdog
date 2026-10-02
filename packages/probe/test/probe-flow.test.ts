import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { exportNetflowV5, renderNetflowV5 } from '@ms/simulators';
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
 */

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
    ): Promise<{ core: FakeCore; probe: RunningProbe }> {
      const { core, port } = await FakeCore.start(dir, [flowSensor]);
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
      { timeout: 120_000 },
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
      'binds nothing until it is turned on, and the sensor names the setting that does it',
      { timeout: 60_000 },
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
      { timeout: 60_000 },
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
