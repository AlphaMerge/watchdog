import { pino } from 'pino';
import { Migrator } from '../../src/db/migrator.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import type { Database } from '../../src/db/pool.js';
import { InheritanceResolver } from '../../src/settings/inheritance.js';
import {
  LoggingAuditSink,
  type Actor,
  type AuditSink,
  type Mutation,
} from '../../src/objects/audit.js';
import { ObjectRepository } from '../../src/objects/repository.js';
import { ObjectService } from '../../src/objects/service.js';
import { testSensorTypes } from './sensor-types.js';
import type { Queryable } from '../../src/db/pool.js';

export const silent = pino({ level: 'silent' });

export const testActor: Actor = { kind: 'system', component: 'test' };

/**
 * Captures what the service would have written to the audit log.
 *
 * `persist` makes the sink actually write through the `Queryable` it was handed. That is the
 * only way to test the sink's central contract — that it runs *inside* the mutation's
 * transaction — because an in-memory array survives a rollback and therefore cannot tell a
 * committed audit entry from an abandoned one.
 */
export class CapturingAuditSink implements AuditSink {
  readonly recorded: Mutation[] = [];
  /** When set, every mutation is also written to the `audit_probe` table through `q`. */
  persist = false;

  async record(q: Queryable, _actor: Actor, mutations: readonly Mutation[]): Promise<void> {
    this.recorded.push(...mutations);
    if (!this.persist) return;
    for (const mutation of mutations) {
      await q.query('INSERT INTO audit_probe (action, object_id) VALUES ($1, $2)', [
        mutation.action,
        mutation.objectId,
      ]);
    }
  }
}

export interface Harness {
  service: ObjectService;
  repository: ObjectRepository;
  resolver: InheritanceResolver;
  audit: CapturingAuditSink;
  rootId: number;
}

export async function buildHarness(db: Database): Promise<Harness> {
  await new Migrator({ db, logger: silent, migrations: MIGRATIONS }).up();

  const repository = new ObjectRepository();
  const resolver = new InheritanceResolver({ db, logger: silent });
  const audit = new CapturingAuditSink();
  const service = new ObjectService({
    db,
    repository,
    resolver,
    audit,
    sensorTypes: testSensorTypes(),
    logger: silent,
  });

  const root = await repository.getRoot(db);
  return { service, repository, resolver, audit, rootId: root.id };
}

export { LoggingAuditSink };
