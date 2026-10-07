import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import {
  encodeFrame,
  FrameDecoder,
  parseCoreToProbe,
  PROTOCOL_VERSION,
  RESULT_LIMITS,
  type CoreToProbeMessage,
  type IngestionConfig,
} from '@ms/shared';
import type { Database } from '../src/db/pool.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { SensorOwnership } from '../src/ingestion/ownership.js';
import { IngestionService } from '../src/ingestion/service.js';
import { EMPTY_ASSIGNMENTS } from '../src/probes/config.js';
import { ProbeQueryService } from '../src/probes/queries.js';
import { ProbeRefusals } from '../src/probes/refusals.js';
import { ProbeEndpoint, type ResultReceiver } from '../src/transport/probe-endpoint.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { within } from './support/within.js';

/**
 * A peer that does not fit its results, over the wire to the core's own endpoint and ingestion
 * (`P-281`).
 *
 * A probe has fitted every result before it leaves since `P-277`; one built before it
 * (`v1.0.0-rc.2`), or anything else speaking the protocol, sends what its scripts wrote. The core
 * validated a `results` batch whole, so one result its schema refused closed the connection, and a
 * NUL in a message or a channel's name failed the write (`22021`) and had the batch asked for
 * again: either way the same batch came back for ever, and every sensor on the probe went stale.
 * The peer here is a socket and the protocol's framing, and nothing of the probe: nothing between
 * it and the core fits anything.
 */

const available = await databaseAvailable();

const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

/** A CA, a core certificate for 127.0.0.1 and a probe certificate, as the endpoint wants them. */
function generateCerts(dir: string): void {
  const run = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  };
  const key = ['-newkey', 'rsa:2048', '-sha256', '-nodes'];
  run([
    'req',
    '-x509',
    ...key,
    '-days',
    '2',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-subj',
    '/CN=test-ca',
  ]);
  const issue = (name: string, san: string | null): void => {
    run(['req', ...key, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`]);
    const ext: string[] = [];
    if (san !== null) {
      writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\n`, 'utf8');
      ext.push('-extfile', `${name}.ext`);
    }
    run([
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.crt`,
      '-days',
      '2',
      '-sha256',
      ...ext,
    ]);
  };
  issue('core', 'DNS:localhost,IP:127.0.0.1');
  issue('probe', null);
}

/** A peer that speaks the framing and nothing more: what it is told to send is what is sent. */
class RawPeer {
  readonly received: CoreToProbeMessage[] = [];
  readonly #socket: TLSSocket;
  readonly #decoder = new FrameDecoder();
  readonly #closed: Promise<void>;
  #arrived: (() => void) | undefined;

  private constructor(socket: TLSSocket) {
    this.#socket = socket;
    this.#closed = new Promise((resolve) =>
      socket.once('close', () => {
        resolve();
      }),
    );
    socket.on('data', (chunk: Buffer) => {
      for (const value of this.#decoder.push(chunk)) {
        this.received.push(parseCoreToProbe(value));
        this.#arrived?.();
      }
    });
    socket.on('error', () => undefined);
  }

  static async connect(dir: string, port: number): Promise<RawPeer> {
    const socket = connect({
      host: '127.0.0.1',
      port,
      cert: readFileSync(join(dir, 'probe.crt')),
      key: readFileSync(join(dir, 'probe.key')),
      ca: readFileSync(join(dir, 'ca.crt')),
      servername: 'localhost',
      rejectUnauthorized: true,
    });
    await within(
      10_000,
      'the TLS handshake',
      new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      }),
    );
    return new RawPeer(socket);
  }

  get open(): boolean {
    return !this.#socket.destroyed;
  }

  send(value: unknown): void {
    this.#socket.write(encodeFrame(value));
  }

  async waitFor<T>(what: string, pick: (message: CoreToProbeMessage) => T | undefined): Promise<T> {
    const found = (): T | undefined => {
      for (const message of this.received) {
        const picked = pick(message);
        if (picked !== undefined) return picked;
      }
      return undefined;
    };
    return within(
      15_000,
      `${what}; saw ${JSON.stringify(this.received.map((one) => one.type))}`,
      new Promise<T>((resolve) => {
        const check = (): void => {
          const picked = found();
          if (picked !== undefined) {
            this.#arrived = undefined;
            resolve(picked);
          }
        };
        this.#arrived = check;
        check();
      }),
    );
  }

  async closed(what: string): Promise<void> {
    await within(10_000, what, this.#closed);
  }

  close(): void {
    this.#socket.destroy();
  }
}

/** Its answer to a batch: the ack or nack naming it. */
const answerTo =
  (batchId: string) =>
  (message: CoreToProbeMessage): CoreToProbeMessage | undefined =>
    (message.type === 'results-ack' || message.type === 'results-nack') &&
    message.batchId === batchId
      ? message
      : undefined;

describe(
  'a results batch holding a result that does not fit, from a peer that does not fit them (`P-281`)',
  {
    skip: !available
      ? 'no PostgreSQL reachable (start docker-compose.dev.yml)'
      : !opensslAvailable
        ? 'openssl is not available'
        : false,
  },
  () => {
    // Each `undefined` until `before` gets that far, so `after` undoes what was done and no more.
    let dir: string | undefined;
    let scratch: ScratchDatabase | undefined;
    let db: Database;
    let h: Harness;
    let ingestor: Ingestor | undefined;
    let ingestion: IngestionService;
    let refusals: ProbeRefusals;
    let endpoint: ProbeEndpoint | undefined;
    let port: number;
    let probeId: number;
    const sensors: number[] = [];
    const logged: Record<string, unknown>[] = [];

    /**
     * An endpoint on this core's ingestion. `probeObjectFor` and `results` are what a case
     * changes: when the probe's branch is known, and what answers a batch.
     */
    async function startEndpoint(
      options: {
        probeObjectFor?: () => Promise<number | null>;
        results?: ResultReceiver;
        queries?: ProbeQueryService;
      } = {},
    ): Promise<{ endpoint: ProbeEndpoint; port: number }> {
      assert.ok(dir !== undefined);
      const started = new ProbeEndpoint({
        config: {
          host: '127.0.0.1',
          port: 0,
          tls: {
            certFile: join(dir, 'core.crt'),
            keyFile: join(dir, 'core.key'),
            caFile: join(dir, 'ca.crt'),
          },
          accessKeys: [],
          handshakeTimeoutMs: 5_000,
          heartbeatIntervalMs: 60_000,
        },
        logger: silent,
        coreVersion: '9.9.9',
        results: options.results ?? ingestion,
        ...(options.queries === undefined ? {} : { queries: options.queries }),
        probeConfig: {
          probeObjectFor: options.probeObjectFor ?? (() => Promise.resolve(probeId)),
          assignmentsFor: () => Promise.resolve(EMPTY_ASSIGNMENTS),
          touch: () => Promise.resolve(),
        },
      });
      return { endpoint: started, port: (await started.start()).port };
    }

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'ms-p281-'));
      generateCerts(dir);
      scratch = await createScratchDatabase('p281unfit');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      probeId = (
        await h.service.create(testActor, { kind: 'probe', parentId: h.rootId, name: 'Old probe' })
      ).id;
      const device = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probeId,
          name: 'Server',
          host: '192.0.2.10',
        })
      ).id;
      for (const name of ['NUL', 'Refused', 'Surrogate', 'Long', 'Plain']) {
        sensors.push(
          (
            await h.service.create(testActor, {
              kind: 'sensor',
              parentId: device,
              name,
              sensorType: 'icmp.ping',
              params: {},
            })
          ).id,
        );
      }
      const logger = pino(
        { level: 'warn' },
        {
          write: (line: string) => {
            logged.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      );
      refusals = new ProbeRefusals();
      ingestor = new Ingestor({ db, logger: silent, config: CONFIG });
      const states = h.states;
      assert.ok(states !== undefined);
      ingestion = new IngestionService({
        db,
        logger,
        ingestor,
        states,
        ownership: new SensorOwnership(),
        refusals,
      });
      ({ endpoint, port } = await startEndpoint());
    });

    after(async () => {
      try {
        await endpoint?.stop();
        await ingestor?.stop();
        await scratch?.drop();
      } finally {
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    });

    /** Connected, said hello, and given its (empty) configuration, so its branch is known. */
    async function peer(to = port): Promise<RawPeer> {
      assert.ok(dir !== undefined);
      const connected = await RawPeer.connect(dir, to);
      connected.send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        gid: 'old-probe',
        displayName: 'Old probe',
        agentVersion: '1.0.0-rc.2',
        accessKey: '',
      });
      await connected.waitFor('the configuration', (m) =>
        m.type === 'config-set' ? m : undefined,
      );
      return connected;
    }

    const at = (): string => new Date().toISOString();
    const good = (sensorId: number, value: number): Record<string, unknown> => ({
      sensorId,
      at: at(),
      outcome: 'ok',
      message: `${String(value)} ms`,
      durationMs: 3,
      channels: [{ key: 'rtt', value, name: 'Round trip', unit: 'ms' }],
    });

    const samplesOf = async (sensorId: number): Promise<number> =>
      (
        await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM sample s JOIN channel c ON c.id = s.channel_id ' +
            'WHERE c.sensor_id = $1',
          [sensorId],
        )
      ).map((row) => Number(row.n))[0] ?? 0;

    const channelsOf = async (sensorId: number) =>
      await db.query<{ key: string; name: string; unit: string }>(
        'SELECT key, name, unit FROM channel WHERE sensor_id = $1 ORDER BY key',
        [sensorId],
      );

    const messageOf = async (sensorId: number): Promise<string | undefined> =>
      (
        await db.query<{ message: string }>(
          'SELECT message FROM sensor_runtime WHERE object_id = $1',
          [sensorId],
        )
      )[0]?.message;

    it('refuses the one result, stores the rest without what PostgreSQL cannot hold, and the next batch flows', async () => {
      const [nul, refused, surrogate, long, plain] = sensors as [
        number,
        number,
        number,
        number,
        number,
      ];
      const probe = await peer();
      try {
        probe.send({
          type: 'results',
          batchId: 'unfit-1',
          sentAt: at(),
          results: [
            // Fits the schema, and holds U+0000 where PostgreSQL text cannot: the write failed
            // with 22021 and the batch was asked for again, for ever.
            {
              ...good(nul, 1),
              message: 'line one\u0000line two',
              // A channel the type does not declare, so its name and unit are the reading's.
              channels: [{ key: 'custom', value: 1, name: 'Cus\u0000tom', unit: 'm\u0000s' }],
            },
            // Cannot be fitted: an outcome that is not one. Refused alone.
            { ...good(refused, 2), outcome: 'maybe' },
            // A key with a lone surrogate, which `pg` would store as another key, and one fine.
            {
              ...good(surrogate, 3),
              channels: [
                { key: 'lone\uDC00', value: 3 },
                { key: 'custom', value: 3, name: 'Custom', unit: 'ms' },
              ],
            },
            // A script's message longer than the schema takes: fitted, as a probe fits it.
            { ...good(long, 4), message: 'x'.repeat(5_000) },
            good(plain, 5),
          ],
        });
        const answer = await probe.waitFor('the answer to the first batch', answerTo('unfit-1'));
        assert.equal(answer.type, 'results-ack', JSON.stringify(answer));
        assert.equal(answer.storedSamples, 4);

        // Stored, without the NULs.
        assert.equal(await samplesOf(nul), 1);
        assert.equal(await messageOf(nul), 'line oneline two');
        assert.deepEqual(
          (await channelsOf(nul)).find((one) => one.key === 'custom'),
          { key: 'custom', name: 'Custom', unit: 'ms' },
        );
        // Refused, and nothing of it stored.
        assert.equal(await samplesOf(refused), 0);
        // The channel with the lone surrogate dropped, the other kept. `rtt` and `loss` are the
        // ones the type declares, made when the sensor was.
        assert.deepEqual(
          (await channelsOf(surrogate)).map((one) => one.key),
          ['custom', 'loss', 'rtt'],
        );
        assert.equal(await samplesOf(surrogate), 1);
        // And the sensor says so in its own message, fitted on the core as on a probe (`P-292`).
        assert.equal(await messageOf(surrogate), '3 ms (1 channel could not be sent)');
        // The message clipped.
        const clipped = await messageOf(long);
        assert.equal(clipped?.length, RESULT_LIMITS.message);
        assert.ok(clipped.endsWith('…'));
        assert.equal(await samplesOf(plain), 1);

        // Counted where an operator looks for this probe, and in ingestion's own numbers.
        assert.equal(refusals.countsFor(probeId).refused, 1);
        assert.equal(refusals.countsFor(probeId).foreignRecently, 0, 'and not as foreign');
        assert.equal(ingestion.stats().refusedUnfit, 1);
        assert.equal(ingestion.stats().discardedUnfitReadings, 1);
        // Logged with the sensor's id.
        const refusal = logged.find((line) => line['results'] === 1 && 'refused' in line);
        assert.ok(refusal !== undefined, JSON.stringify(logged));
        assert.deepEqual(refusal['sensorIds'], [refused]);
        assert.equal(refusal['probeObjectId'], probeId);
        const fitted = logged.find((line) => 'fitted' in line);
        assert.ok(fitted !== undefined, JSON.stringify(logged));
        assert.deepEqual(fitted['sensorIds'], [surrogate, long]);
        assert.equal(fitted['readingsDropped'], 1);

        // The connection stayed up, and the next batch is taken: the spool moves on.
        assert.equal(probe.open, true);
        probe.send({
          type: 'results',
          batchId: 'unfit-2',
          sentAt: at(),
          results: sensors.map((sensorId, index) => good(sensorId, 10 + index)),
        });
        const next = await probe.waitFor('the answer to the next batch', answerTo('unfit-2'));
        assert.equal(next.type, 'results-ack', JSON.stringify(next));
        assert.equal(next.storedSamples, sensors.length);
        assert.equal(await samplesOf(refused), 1, 'the refused sensor’s next result is stored');
        assert.equal(refusals.countsFor(probeId).refused, 1, 'and nothing more refused');
      } finally {
        probe.close();
      }
    });

    it('acknowledges a batch every result of which was refused, so the spool still moves on', async () => {
      const probe = await peer();
      try {
        const before = refusals.countsFor(probeId).refused;
        probe.send({
          type: 'results',
          batchId: 'unfit-all',
          results: [{ ...good(sensors[0] ?? 0, 1), durationMs: 'slow' }],
        });
        const answer = await probe.waitFor('the answer', answerTo('unfit-all'));
        assert.equal(answer.type, 'results-ack', JSON.stringify(answer));
        assert.equal(refusals.countsFor(probeId).refused, before + 1);
        assert.equal(probe.open, true);
      } finally {
        probe.close();
      }
    });

    // `P-281` review: the refusal was counted as the batch was parsed, which on a reconnect is
    // before the session has looked up its probe's branch, so it went to no probe at all.
    it('counts a refusal in the first batch after the handshake on its probe, before the branch is known', async () => {
      const gate = { open: (): void => undefined };
      const opened = new Promise<void>((resolve) => {
        gate.open = resolve;
      });
      const started = await startEndpoint({
        probeObjectFor: async () => {
          await opened;
          return probeId;
        },
      });
      try {
        assert.ok(dir !== undefined);
        const probe = await RawPeer.connect(dir, started.port);
        try {
          probe.send({
            type: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            gid: 'old-probe',
            displayName: 'Old probe',
            agentVersion: '1.0.0-rc.2',
            accessKey: '',
          });
          await probe.waitFor('the welcome', (m) => (m.type === 'welcome' ? m : undefined));
          const before = refusals.countsFor(probeId).refused;
          probe.send({
            type: 'results',
            batchId: 'first',
            sentAt: at(),
            results: [good(sensors[4] ?? 0, 1), { ...good(sensors[1] ?? 0, 2), outcome: 'maybe' }],
          });
          // Answered at once and behind nothing: once its ack is here, the batch sent before it
          // has been parsed, while the branch is still being looked up.
          probe.send({ type: 'heartbeat', seq: 1, sentAt: at() });
          await probe.waitFor('the heartbeat’s ack', (m) =>
            m.type === 'heartbeat-ack' ? m : undefined,
          );
          assert.equal(
            probe.received.some((m) => answerTo('first')(m) !== undefined),
            false,
            'the batch was answered before the branch was known',
          );
          gate.open();
          const answer = await probe.waitFor('the answer to the first batch', answerTo('first'));
          assert.equal(answer.type, 'results-ack', JSON.stringify(answer));
          assert.equal(refusals.countsFor(probeId).refused, before + 1, 'counted on this probe');
        } finally {
          probe.close();
        }
      } finally {
        gate.open();
        await started.endpoint.stop();
      }
    });

    it('counts a refusal once, though the batch was refused back and sent again', async () => {
      let calls = 0;
      // Ingestion answers a write it could not make with a nack, as this does the first time.
      const flaky: ResultReceiver = {
        acceptProbeResults: (origin, message) => {
          calls += 1;
          return calls === 1
            ? Promise.resolve({
                type: 'results-nack',
                batchId: message.batchId,
                reason: 'storage-error',
                retryAfterMs: 0,
              })
            : ingestion.acceptProbeResults(origin, message);
        },
        unfitResults: (origin, unfit) => {
          ingestion.unfitResults(origin, unfit);
        },
      };
      const started = await startEndpoint({ results: flaky });
      try {
        const probe = await peer(started.port);
        try {
          const before = refusals.countsFor(probeId).refused;
          const unfitBefore = ingestion.stats().refusedUnfit;
          const batch = {
            type: 'results',
            batchId: 'again',
            sentAt: at(),
            results: [good(sensors[4] ?? 0, 1), { ...good(sensors[1] ?? 0, 2), outcome: 'maybe' }],
          };
          probe.send(batch);
          const nack = await probe.waitFor('the batch refused back', (m) =>
            m.type === 'results-nack' && m.batchId === 'again' ? m : undefined,
          );
          assert.equal(nack.reason, 'storage-error');
          assert.equal(refusals.countsFor(probeId).refused, before, 'not counted for a nack');
          probe.send(batch);
          await probe.waitFor('the batch acknowledged', (m) =>
            m.type === 'results-ack' && m.batchId === 'again' ? m : undefined,
          );
          assert.equal(refusals.countsFor(probeId).refused, before + 1, 'counted once');
          assert.equal(ingestion.stats().refusedUnfit, unfitBefore + 1);
        } finally {
          probe.close();
        }
      } finally {
        await started.endpoint.stop();
      }
    });

    // `P-288`: a batch whose ack was lost is sent again and stored again without a second row,
    // and its refusals were counted again. Not under the same batch id: the probe numbers every
    // send, and its spool may put the results with others queued since.
    it('counts a refusal once when the ack was lost and the results come again in a new batch', async () => {
      const [nul, refused, surrogate, , plain] = sensors as [
        number,
        number,
        number,
        number,
        number,
      ];
      const before = {
        probe: refusals.countsFor(probeId).refused,
        unfit: ingestion.stats().refusedUnfit,
        dropped: ingestion.stats().discardedUnfitReadings,
      };
      const stamp = at();
      // As the spool holds them: sent again, each is the same result.
      const spooled = [
        { ...good(plain, 1), at: stamp },
        { ...good(refused, 2), at: stamp, outcome: 'maybe' },
        {
          ...good(surrogate, 3),
          at: stamp,
          channels: [
            { key: 'lone\uDC00', value: 3 },
            { key: 'rtt', value: 3 },
          ],
        },
        // No time, so nothing names it: counted every time it arrives, a resend included.
        Object.fromEntries(Object.entries(good(nul, 4)).filter(([key]) => key !== 'at')),
      ];

      const first = await peer();
      try {
        first.send({ type: 'results', batchId: 'old-probe-1', sentAt: at(), results: spooled });
        const ack = await first.waitFor('the first answer', answerTo('old-probe-1'));
        assert.equal(ack.type, 'results-ack', JSON.stringify(ack));
        assert.equal(refusals.countsFor(probeId).refused, before.probe + 2);
        assert.equal(ingestion.stats().refusedUnfit, before.unfit + 2);
        assert.equal(ingestion.stats().discardedUnfitReadings, before.dropped + 1);
      } finally {
        // The link drops with the ack: as far as the probe knows, the batch was never answered.
        first.close();
      }

      const again = await peer();
      try {
        const queuedSince = good(plain, 5);
        again.send({
          type: 'results',
          batchId: 'old-probe-1-again',
          sentAt: at(),
          results: [...spooled, queuedSince],
        });
        const ack = await again.waitFor('the answer to the resend', answerTo('old-probe-1-again'));
        assert.equal(ack.type, 'results-ack', JSON.stringify(ack));
        // The refused result and the dropped reading once; the one with no time twice.
        assert.equal(refusals.countsFor(probeId).refused, before.probe + 3);
        assert.equal(ingestion.stats().refusedUnfit, before.unfit + 3);
        assert.equal(ingestion.stats().discardedUnfitReadings, before.dropped + 1);
        // And the log says what arrived, and how much of it was counted before.
        const resent = logged.findLast((line) => 'refused' in line);
        assert.ok(resent !== undefined, JSON.stringify(logged));
        assert.equal(resent['results'], 2);
        assert.equal(resent['countedBefore'], 1);
        const refitted = logged.findLast((line) => 'fitted' in line);
        assert.ok(refitted !== undefined, JSON.stringify(logged));
        assert.equal(refitted['readingsCountedBefore'], 1);
      } finally {
        again.close();
      }
    });

    describe('what is remembered to count an unfit result once (`P-288`)', () => {
      const time = '2026-10-08T09:00:00.000Z';
      const refusing = (sensorId: number) => ({
        refused: [{ sensorId, at: time, reason: '/outcome: invalid' }],
        fitted: [],
      });
      const fitting = (droppedChannels: number) => ({
        refused: [],
        fitted: [{ sensorId: 9, at: time, reason: '', problems: [], droppedChannels }],
      });
      const a = { gid: 'probe-a', probeObjectId: null };
      const b = { gid: 'probe-b', probeObjectId: null };
      const c = { gid: 'probe-c', probeObjectId: null };
      /**
       * Two results a probe, two probes: small enough to step past either bound. A probe's set
       * grows to three (the bound and a slack of one) and is trimmed back to two in one pass
       * (`P-295` review).
       */
      const small = (): IngestionService => {
        assert.ok(ingestor !== undefined);
        return new IngestionService({
          db,
          logger: silent,
          ingestor,
          resultsRemembered: 2,
          probesRemembered: 2,
        });
      };
      const counted = (service: IngestionService): number => service.stats().refusedUnfit;

      it('counts the same result once, and forgets its probe’s oldest past the bound', () => {
        const service = small();
        service.unfitResults(a, refusing(1));
        service.unfitResults(a, refusing(2));
        service.unfitResults(a, refusing(2));
        assert.equal(counted(service), 2, 'the same result counted once');
        service.unfitResults(a, refusing(3));
        assert.equal(service.stats().resultsRemembered, 3, 'past the bound by the slack');
        service.unfitResults(a, refusing(4));
        assert.equal(service.stats().resultsRemembered, 2, 'and trimmed back to the bound');
        service.unfitResults(a, refusing(1));
        assert.equal(counted(service), 5, 'the oldest forgotten, so counted again');
        service.unfitResults(a, refusing(3));
        assert.equal(counted(service), 5, 'the newest kept');
      });

      it('keeps a result sent a third time, though its probe sent more than the bound since', () => {
        const service = small();
        service.unfitResults(a, refusing(1));
        service.unfitResults(a, refusing(2));
        // Sent again: it moves to the newest end, so the trim forgets 2 and 3, not 1.
        service.unfitResults(a, refusing(1));
        service.unfitResults(a, refusing(3));
        service.unfitResults(a, refusing(1));
        service.unfitResults(a, refusing(4));
        assert.equal(service.stats().resultsRemembered, 2, 'trimmed');
        service.unfitResults(a, refusing(1));
        assert.equal(counted(service), 4, 'the result sent four times counted once');
        service.unfitResults(a, refusing(2));
        assert.equal(counted(service), 5, 'and the others were the ones forgotten');
      });

      it('does not forget one probe’s results for another probe’s, however many', () => {
        const service = small();
        service.unfitResults(a, refusing(1));
        // More than a probe's bound, all from another probe while the first reconnects.
        for (const sensorId of [10, 11, 12, 13]) service.unfitResults(b, refusing(sensorId));
        service.unfitResults(a, refusing(1));
        assert.equal(counted(service), 5, 'the first probe’s result still remembered');
        // And the same sensor at the same time from another probe is that probe's own.
        service.unfitResults(b, refusing(1));
        assert.equal(counted(service), 6);
        assert.equal(service.stats().probesRemembered, 2);
        // A's one, and B's two left by the trim and the one since.
        assert.equal(service.stats().resultsRemembered, 4);
      });

      it('forgets the probe heard from least recently past the bound on probes', () => {
        const service = small();
        service.unfitResults(a, refusing(1));
        service.unfitResults(b, refusing(1));
        // A again, so B is now the least recent.
        service.unfitResults(a, refusing(1));
        service.unfitResults(c, refusing(1));
        assert.equal(service.stats().probesRemembered, 2);
        assert.equal(counted(service), 3);
        service.unfitResults(a, refusing(1));
        assert.equal(counted(service), 3, 'A kept');
        service.unfitResults(b, refusing(1));
        assert.equal(counted(service), 4, 'B forgotten, so counted again');
      });

      it('counts Reports refused as ingestion counts, and a fitted result’s readings once', () => {
        assert.ok(ingestor !== undefined);
        const own = new ProbeRefusals();
        const service = new IngestionService({
          db,
          logger: silent,
          ingestor,
          refusals: own,
          resultsRemembered: 2,
        });
        const origin = { gid: 'bounded', probeObjectId: probeId };
        service.unfitResults(origin, refusing(1));
        service.unfitResults(origin, refusing(1));
        assert.equal(own.countsFor(probeId).refused, 1);
        // One that dropped nothing takes no place: had it, sensor 3 would have taken the set
        // past its bound and slack, and the trim would have forgotten sensor 1.
        service.unfitResults(origin, fitting(0));
        service.unfitResults(origin, refusing(2));
        service.unfitResults(origin, refusing(3));
        service.unfitResults(origin, refusing(1));
        assert.equal(counted(service), 3, 'still remembered');
        assert.equal(service.stats().discardedUnfitReadings, 0);
        service.unfitResults(origin, fitting(2));
        service.unfitResults(origin, fitting(2));
        assert.equal(service.stats().discardedUnfitReadings, 2);
      });
    });

    // `P-289`: a query's answer carries the same result, validated whole, so one its schema
    // refused closed the link: the operator who pressed "check now" was told the probe had gone,
    // and every other query on it failed with it.
    it('refuses a query’s result that cannot be fitted alone, says why, and keeps the link', async () => {
      const sender: { endpoint?: ProbeEndpoint } = {};
      const said: Record<string, unknown>[] = [];
      const queries = new ProbeQueryService({
        logger: pino(
          { level: 'warn' },
          {
            write: (line: string) => {
              said.push(JSON.parse(line) as Record<string, unknown>);
            },
          },
        ),
        refusals,
        sender: {
          sendQuery: (probeObjectId, message) =>
            sender.endpoint?.sendQuery(probeObjectId, message) ?? { kind: 'offline' },
        },
      });
      const started = await startEndpoint({ queries });
      sender.endpoint = started.endpoint;
      try {
        const probe = await peer(started.port);
        try {
          const sensorId = sensors[1] ?? 0;
          const check = {
            kind: 'check',
            assignment: {
              sensorId,
              sensorType: 'icmp.ping',
              params: {},
              target: { host: '192.0.2.10', ipVersion: 'v4' },
              intervalSeconds: 60,
              timeoutMs: 5_000,
            },
          } as const;
          const asked = new Set<string>();
          /** The next query the core sent, and nothing it sent before. */
          const nextQuery = (): Promise<string> =>
            probe.waitFor('a query', (m) => {
              if (m.type !== 'query' || asked.has(m.queryId)) return undefined;
              asked.add(m.queryId);
              return m.queryId;
            });
          const before = refusals.countsFor(probeId).refused;

          const refusing = queries.ask(probeId, check, { timeoutMs: 10_000 });
          probe.send({
            type: 'query-result',
            queryId: await nextQuery(),
            result: { ...good(sensorId, 1), outcome: 'maybe' },
          });
          const refused = await within(10_000, 'the refused answer', refusing);
          assert.ok(refused.kind === 'failed', JSON.stringify(refused));
          assert.equal(refused.failure, 'too-old', refused.message);
          assert.match(refused.message, /\/outcome: must be equal to one of the allowed values/);
          assert.equal(refusals.countsFor(probeId).refused, before + 1);
          assert.equal(queries.stats().unfit, 1);
          const warned = said.find((line) => 'refused' in line);
          assert.deepEqual(
            (warned?.['refused'] as { sensorId?: unknown } | undefined)?.sensorId,
            sensorId,
            `the log names the sensor: ${JSON.stringify(said)}`,
          );

          // The same link answers the next query, with a result the core fits as a current
          // probe fits it before sending: clipped, and without its NUL.
          const fitting = queries.ask(probeId, check, { timeoutMs: 10_000 });
          probe.send({
            type: 'query-result',
            queryId: await nextQuery(),
            result: { ...good(sensorId, 2), message: `${'x'.repeat(5_000)}\u0000` },
          });
          const fitted = await within(10_000, 'the fitted answer', fitting);
          assert.ok(fitted.kind === 'ok', JSON.stringify(fitted).slice(0, 300));
          assert.equal(fitted.result.message.length, RESULT_LIMITS.message);
          assert.ok(!fitted.result.message.includes('\u0000'));
          assert.ok(probe.open, 'the link is up');
          assert.equal(refusals.countsFor(probeId).refused, before + 1, 'a fitted one is not');

          // `P-300`: the same unfit answer after its deadline, which nobody awaits any more. It
          // was a debug line; it is refused and counted against the probe as the one on time is.
          // The shortest deadline the protocol takes.
          const expiring = queries.ask(probeId, check, { timeoutMs: 100 });
          const lateId = await nextQuery();
          const expired = await within(10_000, 'the deadline', expiring);
          assert.ok(expired.kind === 'failed' && expired.failure === 'timeout', expired.kind);
          probe.send({
            type: 'query-result',
            queryId: lateId,
            result: { ...good(sensorId, 3), outcome: 'maybe' },
          });
          // One link reads in order: once the next query's answer is taken, so was the late one.
          const after = queries.ask(probeId, check, { timeoutMs: 10_000 });
          probe.send({
            type: 'query-result',
            queryId: await nextQuery(),
            result: good(sensorId, 4),
          });
          assert.equal((await within(10_000, 'the answer after', after)).kind, 'ok');
          assert.equal(queries.stats().unfit, 2);
          assert.equal(refusals.countsFor(probeId).refused, before + 2);
          assert.ok(probe.open, 'the link is still up');
          assert.ok(
            said.some((line) => String(line['msg']).includes('nobody awaits') && 'refused' in line),
            `the late one is warned: ${JSON.stringify(said)}`,
          );
        } finally {
          probe.close();
        }
      } finally {
        await started.endpoint.stop();
      }
    });

    it('still closes on a batch that is wrong outside its results: that is the conversation', async () => {
      const probe = await peer();
      try {
        const before = refusals.countsFor(probeId).refused;
        // No batch id: nothing could name it in an answer.
        probe.send({ type: 'results', results: [good(sensors[0] ?? 0, 1)] });
        await probe.closed('the core to close on a protocol violation');
        assert.equal(refusals.countsFor(probeId).refused, before, 'no result was refused');
      } finally {
        probe.close();
      }
    });
  },
);
