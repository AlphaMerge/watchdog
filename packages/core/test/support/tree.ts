import { pino } from 'pino';
import { PauseRepository } from '../../src/objects/pause-repository.js';
import { Migrator } from '../../src/db/migrator.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import type { SensorCatalogue, SensorType } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import { catalogueSensorTypeGate } from '../../src/objects/sensor-type-gate.js';
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
import { testCatalogue } from './sensor-types.js';
import type { Queryable } from '../../src/db/pool.js';
import { CredentialVault } from '../../src/vault/service.js';
import { VaultKeyring } from '../../src/vault/keyring.js';
import { VaultSealer } from '../../src/vault/sealer.js';

export const silent = pino({ level: 'silent' });

/**
 * The system, which is also a `Writer`: it vouches as the installation (`A-29`), so a test that
 * is not about who may name what does not have to say whose sight it writes with.
 */
export const testActor: Extract<Actor, { kind: 'system' }> = { kind: 'system', component: 'test' };

/**
 * A person, by login, for a service that records who acted and uses the login as well (`A-17`).
 *
 * The login is what matters to the callers: a report renders as its creator when nobody else is
 * named, and a grant's `granted_by` is the login. The id is not an account, and nothing that takes
 * one of these looks it up.
 */
export function actorNamed(login: string): Actor {
  return { kind: 'user', userId: 0, login };
}

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
  options: {
    states?: boolean;
    alarms?: AlarmReactor;
    types?: readonly SensorType[];
    /**
     * A whole catalogue in place of the test types and `types` (`P-302`): the shipped one, for a
     * test about what the real types declare.
     */
    catalogue?: SensorCatalogue;
    /** The sensors the core is declining to evaluate (`A-29`); `SensorVouching.withheld`. */
    withheldSensors?: () => ReadonlyMap<number, string>;
    /** A lost probe's sensors (`R-05`); `ProbeReachability.unreachableSensors`. */
    unreachableSensors?: () => ReadonlySet<number>;
    /** The sensors a probe's clock has frozen (`P-232`); `ClockFreeze.frozenSensors`. */
    clockFrozenSensors?: () => ReadonlySet<number>;
    /** The sensors whose checks their probe could not start (`P-265`); `NotStarted.heldSensors`. */
    notStartedSensors?: () => ReadonlySet<number>;
    /** The factories held for their inputs' probe (`M-26`); `FactoryReach.unreached`. */
    unreachedFactories?: () => ReadonlySet<number>;
    /** How long a change waits for the tree lock (`P-229`); 30 s unless a test is about it. */
    treeLockWaitMs?: number;
    /** The object service's logger, for a test about what it says (`P-311`); silent otherwise. */
    logger?: Logger;
  } = {},
): Promise<Harness> {
  await new Migrator({ db, logger: silent, migrations: MIGRATIONS }).up();

  const repository = new ObjectRepository(
    options.treeLockWaitMs === undefined ? {} : { treeLockWaitMs: options.treeLockWaitMs },
  );
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
          pauses: new PauseRepository(),
          // Where the notification engine sits in production (`N-02`): `reevaluate` is the
          // choke point for every state change that is not a check result, so a pause, an
          // acknowledgement or a schedule window reaches it here or not at all.
          ...(options.alarms === undefined ? {} : { alarms: options.alarms }),
          ...(options.withheldSensors === undefined
            ? {}
            : { withheldSensors: options.withheldSensors }),
          ...(options.unreachableSensors === undefined
            ? {}
            : { unreachableSensors: options.unreachableSensors }),
          ...(options.clockFrozenSensors === undefined
            ? {}
            : { clockFrozenSensors: options.clockFrozenSensors }),
          ...(options.notStartedSensors === undefined
            ? {}
            : { notStartedSensors: options.notStartedSensors }),
          ...(options.unreachedFactories === undefined
            ? {}
            : { unreachedFactories: options.unreachedFactories }),
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
    sensorTypes: catalogueSensorTypeGate(options.catalogue ?? testCatalogue(options.types ?? [])),
    ...(states === undefined ? {} : { states }),
    ...(dependencies === undefined ? {} : { dependencyDelays: dependencies }),
    // Read-only, and unconditional: the pause view has to be able to say a schedule is holding
    // an object (`M-09`), and a harness that could not would let that regress unnoticed.
    schedules: new ScheduleRepository(),
    // Read-only and unconditional, for the same reason: the pause view has to be able to say a
    // master is holding an object (`M-11`), and refusing a dependency loop is not optional.
    dependencies: new DependencyRepository(),
    logger: options.logger ?? silent,
  });

  const root = await repository.getRoot(db);
  return { service, repository, resolver, audit, vault, states, dependencies, rootId: root.id };
}

export { LoggingAuditSink };
