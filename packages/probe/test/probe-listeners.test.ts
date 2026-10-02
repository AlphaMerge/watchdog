import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sendTcp } from '@ms/simulators';
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
  within,
  type RunningProbe,
} from './support/probe-process.js';

/**
 * What the trap and syslog buffers overwrote unread, in a running probe (`B-14`).
 *
 * `B-11` put the flow collector's count on the heartbeat and left these two where they were: per
 * sensor, and in a stop line nobody reads until the probe has stopped. Nothing below constructs a
 * listener. `ms-probe` is started from a configuration file with all three listeners on, a core
 * assigns it a trap sensor and a syslog sensor, each buffer is overrun over its own socket, and
 * the number is read from the heartbeat the probe sends.
 */

const TRAP_SENSOR = 51;
const SYSLOG_SENSOR = 52;
/** `B-14`'s two fields, one capability, a version after `flowOverwritten`. */
const LISTENER_FIELDS = ['trapOverwritten', 'syslogOverwritten'] as const;
/** The smallest buffer either schema allows, so a burst a test can send overruns it. */
const BUFFER = 100;

const trapSensor: SensorAssignment = {
  sensorId: TRAP_SENSOR,
  sensorType: 'snmp.trap',
  // **Not failing on a loss, so that every scan says what it read and what it lost.** A trap is
  // one datagram, a burst of them cannot be made to arrive in one turn of the probe's loop, and
  // a scan may land in the middle of it. With this off the sensor reports `dropped` as a channel
  // scan by scan, and their sum is what the probe's own count has to equal wherever scans fell.
  params: { warnOnDropped: false },
  target: { host: '127.0.0.1', ipVersion: 'auto' },
  intervalSeconds: 1,
  timeoutMs: 10_000,
};

const syslogSensor: SensorAssignment = {
  sensorId: SYSLOG_SENSOR,
  sensorType: 'syslog.receiver',
  params: {},
  target: { host: '127.0.0.1', ipVersion: 'auto' },
  intervalSeconds: 1,
  timeoutMs: 10_000,
};

/** One BER element with a short-form length, which is all a trap this small needs. */
function ber(tag: number, ...parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  assert.ok(body.length < 128, 'this helper writes short-form lengths only');
  return Buffer.concat([Buffer.from([tag, body.length]), body]);
}

/** An OID under 1.3 whose arcs are all below 128, so each is one byte. */
function oid(arcs: readonly number[]): Buffer {
  return ber(0x06, Buffer.from([0x2b, ...arcs]));
}

/**
 * An SNMPv2c linkDown trap, as bytes (RFC 3416 §4.2.6): `sysUpTime.0`, then `snmpTrapOID.0`.
 *
 * Rendered here and not by `net-snmp`, which is what the probe's receiver decodes with and which
 * stays inside `@ms/sensors`.
 */
function renderTrap(requestId: number): Buffer {
  const uptime = ber(0x30, oid([6, 1, 2, 1, 1, 3, 0]), ber(0x43, Buffer.from([0x2a])));
  const linkDown = ber(0x30, oid([6, 1, 6, 3, 1, 1, 4, 1, 0]), oid([6, 1, 6, 3, 1, 1, 5, 3]));
  const pdu = ber(
    0xa7,
    // Two bytes with the first between 1 and 127: a positive INTEGER in its shortest form.
    ber(0x02, Buffer.from([1 + ((requestId >> 8) % 127), requestId & 0xff])),
    ber(0x02, Buffer.from([0])),
    ber(0x02, Buffer.from([0])),
    ber(0x30, uptime, linkDown),
  );
  return ber(0x30, ber(0x02, Buffer.from([1])), ber(0x04, Buffer.from('public')), pdu);
}

/** A TCP port on 127.0.0.1 that was free a moment ago. */
async function freeTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') throw new Error('no TCP port to be had');
  return address.port;
}

const resultFor =
  (sensorId: number, accept: (result: CheckResult) => boolean) =>
  (message: ProbeToCoreMessage): CheckResult | undefined =>
    message.type === 'results'
      ? message.results.find((result) => result.sensorId === sensorId && accept(result))
      : undefined;

const healthOf = (message: ProbeToCoreMessage): ProbeHealthReport | undefined =>
  message.type === 'heartbeat' ? message.health : undefined;

const channel = (result: CheckResult, key: string): number =>
  result.channels.find((reading) => reading.key === key)?.value ?? 0;

/** What the trap sensor's scans have accounted for between them: read, and lost. */
function trapTotals(core: FakeCore): { read: number; dropped: number; failed: number } {
  let read = 0;
  let dropped = 0;
  let failed = 0;
  for (const message of core.received) {
    if (message.type !== 'results') continue;
    for (const result of message.results) {
      if (result.sensorId !== TRAP_SENSOR) continue;
      if (result.outcome !== 'ok') {
        failed += 1;
        continue;
      }
      read += channel(result, 'count') + channel(result, 'unmatched');
      dropped += channel(result, 'dropped');
    }
  }
  return { read, dropped, failed };
}

describe(
  'what the trap and syslog buffers overwrote unread, in a running probe (`B-14`)',
  { skip: opensslAvailable ? false : 'openssl is not available' },
  () => {
    let dir: string;
    const running: RunningProbe[] = [];
    const cores: FakeCore[] = [];

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-probe-listeners-'));
      generateCerts(dir);
    });

    after(async () => {
      for (const probe of running) await probe.stop().catch(() => undefined);
      for (const core of cores) await core.stop();
      await rm(dir, { recursive: true, force: true });
    });

    async function probeWith(
      config: Record<string, unknown>,
      sensors: readonly SensorAssignment[],
    ): Promise<{ core: FakeCore; probe: RunningProbe }> {
      const { core, port } = await FakeCore.start(dir, sensors);
      cores.push(core);
      const probe = startProbe({ dir, corePort: port, config, profile: 'full' });
      running.push(probe);
      try {
        await core.waitFor('the probe to take its sensors', (message) =>
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
      'carries each buffer’s own count in the heartbeat, and neither to a core at 25',
      { timeout: 300_000 },
      async () => {
        const trapPort = await freeUdpPort();
        const syslogPort = await freeTcpPort();
        const flowPort = await freeUdpPort();
        const { core, probe } = await probeWith(
          {
            trapListener: {
              enabled: true,
              port: trapPort,
              address: '127.0.0.1',
              bufferSize: BUFFER,
            },
            // TCP only: a stream is the one transport here that can deliver a flood in one piece.
            syslogListener: {
              enabled: true,
              port: syslogPort,
              address: '127.0.0.1',
              udp: false,
              tcp: true,
              bufferSize: BUFFER,
            },
            // On, with no flow sensor, so the older core below has a flow field to be sent.
            flowListener: { enabled: true, port: flowPort, address: '127.0.0.1' },
          },
          [trapSensor, syslogSensor],
        );
        const lines = (count: number, what: string): { message: string }[] =>
          Array.from({ length: count }, (_unused, index) => ({
            message: `${what} ${String(index)}`,
          }));
        const syslog = (count: number, what: string): Promise<void> =>
          within(60_000, `${what} to be sent`, sendTcp(syslogPort, lines(count, what)));
        const heartbeat = (
          what: string,
          accept: (health: ProbeHealthReport) => boolean,
          from: number,
        ): Promise<ProbeHealthReport> =>
          core.waitFor(
            what,
            (message) => {
              const sent = healthOf(message);
              return sent !== undefined && accept(sent) ? sent : undefined;
            },
            { from },
          );

        // Each sensor's cursor exists from its first scan, and everything below is counted from
        // the two of them.
        await core.waitFor(
          'a first syslog scan',
          resultFor(SYSLOG_SENSOR, () => true),
        );
        await core.waitFor(
          'a first trap scan',
          resultFor(TRAP_SENSOR, () => true),
        );

        // **Syslog, where the transport allows one turn.** The receiver takes every whole frame
        // out of a TCP chunk before it returns, and one write this small arrives as one chunk on
        // loopback, so a scan sees all of a send or none of it.
        const READ = 6;
        let mark = core.received.length;
        await syslog(READ, 'read');
        const read = await core.waitFor(
          'a reading of the six messages',
          resultFor(
            SYSLOG_SENSOR,
            (result) => result.outcome === 'ok' && channel(result, 'messages') > 0,
          ),
          { from: mark },
        );
        assert.equal(channel(read, 'messages'), READ, read.message);
        const quiet = await heartbeat(
          'a heartbeat carrying the six messages',
          (health) => health.syslogReceived === READ,
          mark,
        );
        assert.equal(quiet.syslogOverwritten, 0, 'six messages in a buffer of a hundred');
        assert.equal(quiet.trapOverwritten, 0, 'a trap listener that has heard nothing');
        assert.equal(quiet.flowOverwritten, 0, 'and the flow collector’s own, beside them');

        // A hundred and fifty into a buffer of a hundred: the six that were read and the first
        // fifty of these leave it, and only the fifty were anybody's to lose.
        const SENT = 150;
        mark = core.received.length;
        await syslog(SENT, 'flood');
        const short = await core.waitFor(
          'the syslog scan after the overflow',
          resultFor(SYSLOG_SENSOR, (result) => result.outcome === 'error'),
          { from: mark },
        );
        assert.match(
          short.message,
          new RegExp(`^${String(SENT - BUFFER)} messages were overwritten before this sensor`),
        );
        const overrun = await heartbeat(
          'a heartbeat carrying the syslog overflow',
          (health) => health.syslogReceived === READ + SENT,
          mark,
        );
        // The fifty the scan named, and not the fifty-six that left the buffer.
        assert.equal(overrun.syslogOverwritten, SENT - BUFFER);
        assert.equal(overrun.trapOverwritten, 0, 'the syslog buffer’s loss was counted as traps');

        // One more, which overwrites a message the failed scan had caught up past: the count is
        // of what was lost, and a full buffer giving up a read message does not move it.
        mark = core.received.length;
        await syslog(1, 'after');
        const settled = await heartbeat(
          'a heartbeat carrying the message after the overflow',
          (health) => health.syslogReceived === READ + SENT + 1,
          mark,
        );
        assert.equal(settled.syslogOverwritten, SENT - BUFFER);

        // **Traps, where it does not.** One trap is one datagram. Six first, which the sensor
        // reads, so that what leaves the buffer later is not all unread.
        const collector = { host: '127.0.0.1', port: trapPort };
        mark = core.received.length;
        for (let id = 0; id < READ; id += 1) await sendUdp(renderTrap(id), collector);
        await core.waitFor(
          'the six traps to be read',
          () => (trapTotals(core).read === READ ? true : undefined),
          { from: mark },
        );
        const heard = await heartbeat(
          'a heartbeat carrying the six traps',
          (health) => health.trapReceived === READ,
          mark,
        );
        assert.equal(heard.trapOverwritten, 0, 'six traps in a buffer of a hundred');
        assert.equal(heard.trapMalformed, 0, 'the probe could not read a trap this test rendered');

        // Four hundred, as fast as a socket takes them. However many scans land among them, each
        // reads at most the buffer's hundred, and the burst is over in well under two intervals:
        // at least a hundred are lost, and how many exactly is the sensor's to say.
        const BURST = 400;
        mark = core.received.length;
        await within(
          60_000,
          'the burst of traps to be sent',
          (async (): Promise<void> => {
            for (let id = 0; id < BURST; id += 1) await sendUdp(renderTrap(READ + id), collector);
          })(),
        );
        const flooded = await heartbeat(
          'a heartbeat carrying the whole burst',
          (health) => health.trapReceived === READ + BURST,
          mark,
        );
        // Nothing arrives after this heartbeat, so the count in it is final.
        const lost = flooded.trapOverwritten;
        assert.ok(lost !== undefined && lost >= BURST - 3 * BUFFER, `lost ${String(lost)}`);
        assert.ok(lost <= BURST - BUFFER, `more lost than left the buffer unread: ${String(lost)}`);
        assert.equal(
          flooded.syslogOverwritten,
          SENT - BUFFER,
          'the trap loss moved syslog’s count',
        );
        assert.equal(flooded.flowOverwritten, 0, 'or the flow collector’s');

        // **The same number from the other side.** Every trap was either handed to a scan or
        // lost before one, and the scans say which, each time.
        const totals = await core.waitFor(
          'the trap sensor to account for every trap',
          () => {
            const now = trapTotals(core);
            return now.read + now.dropped === READ + BURST ? now : undefined;
          },
          { from: mark },
        );
        assert.equal(totals.failed, 0, 'a trap scan failed, and what it held is in no reading');
        assert.equal(lost, totals.dropped, 'the probe’s count is not what its sensor lost');

        // A core one version below the two fields is sent everything it knows — the listeners'
        // older counters, and `flowOverwritten` from the version before — and neither of these:
        // its health schema is closed, and it would refuse the heartbeat for one.
        const below = versionFor('listenerOverwritten') - 1;
        assert.equal(below, versionFor('flowOverwritten'), 'the older core here is one at 25');
        core.protocolVersion = below;
        const reconnect = core.received.length;
        core.dropLink();
        const older = await core.waitFor('a heartbeat to the older core', healthOf, {
          from: reconnect,
        });
        assert.equal(older.trapReceived, READ + BURST, 'what a core at 25 knows still goes');
        assert.equal(older.syslogReceived, READ + SENT + 1);
        assert.equal(older.flowOverwritten, 0, 'and so does the field 25 added');
        for (const field of LISTENER_FIELDS) {
          assert.equal(
            field in older,
            false,
            `${field} was sent to a core at protocol ${String(below)}`,
          );
        }

        assert.deepEqual(core.refused, [], 'the probe sent something a core refuses');
        assert.equal(await probe.stop(), 0, 'the probe did not stop cleanly');
        const stopped = (msg: string): Record<string, unknown> => {
          const line = probe.logs().find((one) => one['msg'] === msg);
          assert.ok(line !== undefined, `no "${msg}" line`);
          return line;
        };
        // The stop lines tell the two numbers apart, as the flow collector's does.
        const traps = stopped('snmp trap listener stopped');
        assert.equal(traps['overwritten'], READ + BURST - BUFFER);
        assert.equal(traps['overwrittenUnread'], lost);
        const messages = stopped('syslog listener stopped');
        assert.equal(messages['overwritten'], READ + SENT + 1 - BUFFER);
        assert.equal(messages['overwrittenUnread'], SENT - BUFFER);
      },
    );

    it('sends each field only for a listener the probe runs', { timeout: 180_000 }, async () => {
      // Syslog alone. A zero for the trap listener would say one is running and losing nothing.
      const syslogPort = await freeTcpPort();
      const { core, probe } = await probeWith(
        {
          syslogListener: {
            enabled: true,
            port: syslogPort,
            address: '127.0.0.1',
            udp: false,
            tcp: true,
          },
        },
        [syslogSensor],
      );
      const health = await core.waitFor('a heartbeat', healthOf);
      assert.equal(health.syslogOverwritten, 0);
      assert.equal(health.syslogReceived, 0);
      assert.equal('trapOverwritten' in health, false, 'a probe with no trap listener sent it');
      assert.equal('trapReceived' in health, false);

      assert.deepEqual(core.refused, [], 'the probe sent something a core refuses');
      assert.equal(await probe.stop(), 0);
    });
  },
);
