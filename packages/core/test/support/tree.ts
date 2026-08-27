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
import { DependencyPauses } from '../../src/dependencies/pauses.js';
import { DependencyRepository } from '../../src/dependencies/repository.js';
import { ScheduleRepository } from '../../src/schedules/repository.js';
import { SensorStateService, type AlarmReactor } from '../../src/state/service.js';
import { testSensorTypes } from './sensor-types.js';
import type { Queryable } from '../../src/db/pool.js';
import { CredentialVault } from '../../src/vault/service.js';
import { VaultKeyring } from '../../src/vault/keyring.js';
import { VaultSealer } from '../../src/vault/sealer.js';

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
  /**
   * A second sink to forward to, the way `CompositeAuditSink` does in production.
   *
   * Some things ride the audit sink rather than being called directly — `R-04`'s config push
   * and `M-04`'s cache invalidation — and testing one means putting it where it actually sits,
   * inside the mutation's own transaction.
   */
  also: AuditSink | undefined;

  async record(
    q: Queryable,
    actor: Actor,
    mutations: readonly Mutation[],
    at: Date,
  ): Promise<void> {
    await this.also?.record(q, actor, mutations, at);
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
  /** The vault the service was wired with (`A-05`). Its keys live only in this process. */
  vault: CredentialVault;
  /** Present only when `buildHarness` was asked for one; `M-08`'s pauses need it. */
  states: SensorStateService | undefined;
  /** The dependency reactor the service was wired with, when states were asked for (`M-11`). */
  dependencies: DependencyPauses | undefined;
  rootId: number;
}

export async function buildHarness(
  db: Database,
  options: { states?: boolean; alarms?: AlarmReactor } = {},
): Promise<Harness> {
  await new Migrator({ db, logger: silent, migrations: MIGRATIONS }).up();

  const repository = new ObjectRepository();
  const resolver = new InheritanceResolver({ db, logger: silent });
  const audit = new CapturingAuditSink();
  // Opt-in, because most tests here are about the tree and would only be paying for a cache.
  // A pause without it still writes and still stops the probe scanning — the states simply do
  // not move, which is not a system anyone should run and is exactly what `M-08` tests.
  const states =
    options.states === true
      ? new SensorStateService({
          db,
          logger: silent,
          settings: resolver,
          // Where the notification engine sits in production (`N-02`): `reevaluate` is the
          // choke point for every state change that is not a check result, so a pause, an
          // acknowledgement or a schedule window reaches it here or not at all.
          ...(options.alarms === undefined ? {} : { alarms: options.alarms }),
        })
      : undefined;
  // Built here rather than in each test, because the pause sweep releases dependency delays and
  // a harness whose sweep could not would let that regress unnoticed (`M-11`).
  const dependencies =
    states === undefined
      ? undefined
      : new DependencyPauses({ logger: silent, settings: resolver, states });

  // A keyring made here rather than loaded: a test that wrote a key file would leave one on
  // disk, and the crypto itself is covered against real files in `vault-crypto.test.ts`.
  const vault = new CredentialVault({
    resolver,
    sealer: new VaultSealer(VaultKeyring.fromKeys([{ id: 'test-key', key: Buffer.alloc(32, 7) }])),
    logger: silent,
  });

  const service = new ObjectService({
    db,
    repository,
    resolver,
    audit,
    vault,
    sensorTypes: testSensorTypes(),
    ...(states === undefined ? {} : { states }),
    ...(dependencies === undefined ? {} : { dependencyDelays: dependencies }),
    // Read-only, and unconditional: the pause view has to be able to say a schedule is holding
    // an object (`M-09`), and a harness that could not would let that regress unnoticed.
    schedules: new ScheduleRepository(),
    // Read-only and unconditional, for the same reason: the pause view has to be able to say a
    // master is holding an object (`M-11`), and refusing a dependency loop is not optional.
    dependencies: new DependencyRepository(),
    logger: silent,
  });

  const root = await repository.getRoot(db);
  return { service, repository, resolver, audit, vault, states, dependencies, rootId: root.id };
}

export { LoggingAuditSink };
