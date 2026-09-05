import { testCatalogue } from '../support/sensor-types.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../../src/api/server.js';
import { AuditRepository } from '../../src/audit/store.js';
import { HistoryService } from '../../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, silent, testActor } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * A committed measurement, per CLAUDE.md.
 *
 * S-13's claim is that "the common UI read can be conditional again" — so the thing to measure is
 * what a conditional read saves. The full render resolves every inherited setting and credential
 * for every level of the chain; the 304 walks the same chain once, reading two columns.
 */
const INCLUDE = 'settings,credentials,ancestors';
const ROUNDS = 50;

describe(
  'conditional GET performance',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let app: FastifyInstance;
    let deviceId: number;

    before(async () => {
      scratch = await createScratchDatabase('condgetperf');
      const h = await buildHarness(scratch.db);

      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: true,
        },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db: scratch.db, logger: silent }),
        db: scratch.db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      app = server.app;

      // Root, probe, four nested groups, a device: seven levels, which is a deeper tree than
      // most and therefore the case where resolution costs most.
      let parentId = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'perf-probe',
        })
      ).id;
      for (let depth = 0; depth < 4; depth += 1) {
        const group = await h.service.create(testActor, {
          kind: 'group',
          parentId,
          name: `group-${String(depth)}`,
        });
        parentId = group.id;
        // A setting and a credential at every level, so resolution has something to walk.
        await h.service.setSetting(testActor, parentId, 'scan.intervalSeconds', 60 + depth, {
          kind: 'none',
        });
        await scratch.db.query(
          `INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
           VALUES ($1, 'snmp', '{}'::jsonb, '\\x00'::bytea, 'k1')`,
          [parentId],
        );
      }
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId,
          name: 'perf-device',
          host: '192.0.2.80',
        })
      ).id;
    });

    after(async () => {
      await scratch.drop();
    });

    it('answers a repeat read for a fraction of the cost of rendering it', async () => {
      const url = `/api/v1/objects/${String(deviceId)}`;
      const first = await app.inject({ method: 'GET', url, query: { include: INCLUDE } });
      assert.equal(first.statusCode, 200);
      const etag = first.headers['etag'] as string;
      assert.ok(etag.includes('-'), 'the tag covers the chain, not just the version');

      const time = async (headers: Record<string, string>): Promise<number> => {
        const startedAt = process.hrtime.bigint();
        for (let round = 0; round < ROUNDS; round += 1) {
          const response = await app.inject({
            method: 'GET',
            url,
            query: { include: INCLUDE },
            headers,
          });
          assert.equal(response.statusCode, headers['if-none-match'] === undefined ? 200 : 304);
        }
        return Number(process.hrtime.bigint() - startedAt) / 1e6 / ROUNDS;
      };

      const rendered = await time({});
      const conditional = await time({ 'if-none-match': etag });
      const bytes = Buffer.byteLength(first.body);

      process.stdout.write(
        `\n    measured, a seven-level chain with a setting and a credential at each level:\n` +
          `      full render   ${rendered.toFixed(2).padStart(6)} ms  ${String(bytes).padStart(5)} bytes\n` +
          `      304           ${conditional.toFixed(2).padStart(6)} ms      0 bytes  ` +
          `(${(rendered / conditional).toFixed(1)}x cheaper)\n`,
      );

      // The ordering is what matters and it is structural: the 304 path does one chain walk,
      // the render resolves every inherited value at every level. A conditional read that is not
      // clearly cheaper means the short-circuit has stopped short-circuiting.
      assert.ok(
        conditional < rendered,
        `304 took ${conditional.toFixed(2)} ms against ${rendered.toFixed(2)} ms to render`,
      );
    });
  },
);
