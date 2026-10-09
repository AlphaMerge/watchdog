import type { Fingerprint, Logger } from '@ms/shared';
import type { DeviceTemplateCatalogue } from '../device-templates/catalogue.js';
import type { SensorSpec } from '../device-templates/definition.js';
import type { AccessPrincipal, AccessRight, Reach, Visibility } from '../auth/access.js';
import type { Queryable } from '../db/pool.js';
import type { Actor } from '../objects/audit.js';
import { storedAccountWrites } from '../objects/credential-vouching.js';
import { ObjectError } from '../objects/errors.js';
import { asInstallation, type CredentialVoucher } from '../objects/sensor-reads.js';
import type { ObjectService } from '../objects/service.js';
import type { StoredVoucher } from '../objects/vouching.js';
import { DiscoveryError } from './errors.js';
import {
  GROUP_MOVED,
  RULE_DELETED,
  type DiscoveredHost,
  type DiscoveryRunRow,
  type DiscoveryService,
} from './service.js';

/**
 * Turning what a discovery found into devices and sensors (`D-04`).
 *
 * **Idempotency is the whole ticket, and it is not a nicety.** A discovery is re-run — on a
 * schedule (`D-07`), or by an operator who wants to pick up what has appeared since — and a
 * second run that duplicated everything would double the object tree, double the load on every
 * device in it, and double every alarm. `WORKFLOW.MD §2` states the rule: match on IP or DNS name
 * *within the target group*, and add only what is missing.
 *
 * **Within the group, deliberately.** The same address can legitimately exist twice in one
 * installation — two sites behind NAT both using `10.0.0.1`, a lab that mirrors production —
 * and matching across the whole tree would merge them into one device that is neither. A group
 * is the unit an operator scans into and the unit they think about.
 *
 * **Three keys, in order of how much they mean.** The address is what the sweep found and is
 * exact. The reverse name is what the identification learnt, and a device somebody created by
 * name years ago is the same machine. The short name is the last resort — `web01` where the
 * device says `web01.example.com` — and it is *only* consulted when nothing else matched,
 * because two sites can each have a `web01`.
 */

export interface RunVoucherOptions {
  authRequired: boolean;
  ruleWriter: (ruleId: number) => Promise<StoredVoucher | null>;
  rights: (
    principal: AccessPrincipal,
    objectIds: readonly number[],
    q: Queryable,
  ) => Promise<ReadonlyMap<number, AccessRight>>;
}

/**
 * Who vouches for sending credentials to the addresses a run found (`A-41`).
 *
 * The account that started it; else the account that last wrote the rule that started it; and,
 * with the authorisation layer off, the installation, as for every other write. Null for a run
 * with neither: its rule was deleted, which the column's `ON DELETE SET NULL` would otherwise make
 * look operator-started. Nobody stands behind such a run, and `provisionRun` fails it rather than
 * create anything — otherwise deleting a rule would be a way for its writer to hand the run the
 * installation's word. A run started by hand before `A-20` recorded who started it reads the same.
 */
export async function runVoucher(
  run: Pick<DiscoveryRunRow, 'createdBy' | 'scheduleId'>,
  options: RunVoucherOptions,
): Promise<CredentialVoucher | null> {
  if (!options.authRequired) return { kind: 'installation' };
  let stored: StoredVoucher;
  if (run.createdBy !== null) stored = { kind: 'account', userId: run.createdBy };
  else if (run.scheduleId !== null) {
    // A rule nobody on record wrote vouches for nothing; it is still a rule, and the run is not
    // failed for it — each sensor it cannot vouch for is one of the run's problems.
    stored = (await options.ruleWriter(run.scheduleId)) ?? { kind: 'account', userId: null };
  } else return null;
  if (stored.kind === 'installation') return stored;
  return {
    kind: 'account',
    userId: stored.userId,
    writes: storedAccountWrites(options.rights, stored.userId),
  };
}

export interface RunProvisioning {
  discovery: Pick<
    DiscoveryService,
    'get' | 'hosts' | 'recordProvisioning' | 'fail' | 'failIfGroupMoved'
  >;
  provisioner: Pick<ProvisionService, 'provision'>;
  /** The devices already in a group and their sensors, so a re-run creates nothing twice. */
  existing: (
    groupId: number,
  ) => Promise<{ devices: readonly ExistingDevice[]; sensors: readonly ExistingSensor[] }>;
  vouchers: RunVoucherOptions;
}

/**
 * Provisions what a run found, or fails the run with the reason it cannot be (`D-04`, `A-41`).
 *
 * Re-checks where the run belongs and who stands behind it when asked, rather than when the run
 * started. A run whose group has since moved under another probe creates nothing (`P-241`): its
 * hosts were found from the old probe's network, and would become devices in the new one's
 * branch. Nor does a run whose rule was deleted after it finished. Either way the run fails with
 * the reason, recorded in the audit, and the caller is refused with the same sentence.
 */
export async function provisionRun(
  options: RunProvisioning,
  runId: number,
  actor: Actor,
  sight: ProvisionSight,
): Promise<ProvisionReport> {
  const run = await options.discovery.get(runId);
  if (run === null) {
    throw new DiscoveryError(
      'DISCOVERY_RUN_NOT_FOUND',
      `there is no discovery run ${String(runId)}`,
      {
        context: { runId },
      },
    );
  }
  if (await options.discovery.failIfGroupMoved(run, actor)) {
    throw createdNothing(runId, GROUP_MOVED);
  }
  const credentials = await runVoucher(run, options.vouchers);
  if (credentials === null) {
    await options.discovery.fail(runId, RULE_DELETED, actor);
    throw createdNothing(runId, RULE_DELETED);
  }
  const [hosts, existing] = await Promise.all([
    options.discovery.hosts(runId, 65_536),
    options.existing(run.groupId),
  ]);
  const report = await options.provisioner.provision({
    run,
    hosts,
    existingDevices: existing.devices,
    existingSensors: existing.sensors,
    actor,
    credentials,
    sight,
  });
  await options.discovery.recordProvisioning(runId, report);
  return report;
}

/** The refusal for a run that failed when asked to provision, in the reason's own words. */
function createdNothing(runId: number, reason: string): DiscoveryError {
  return new DiscoveryError(
    'DISCOVERY_RUN_FAILED',
    `discovery run ${String(runId)} created nothing: ${reason}`,
    { context: { runId } },
  );
}

/**
 * What the caller who asked for a provisioning pass may see and change (`A-77`).
 *
 * **A pass writes as the installation and answers as its caller.** The sensors come from a
 * template, which the installation stands behind (`A-29`), so the writes are the installation's;
 * but which devices they land under, and what the report says about the group, is the caller's
 * business and nobody else's. A pass may match a device its caller cannot see — two devices at one
 * address would be the duplicate `D-04` exists to prevent — but it reports it without its id and
 * creates nothing under it, and it adds nothing to a device its caller may see and not write.
 *
 * A pass nobody asked for, a schedule's, has nobody to answer and passes `Visibility.EVERYTHING`
 * and `Reach.EVERYTHING`, as every internal caller does.
 */
export interface ProvisionSight {
  /** What the caller can see: what the report may name, and the words of a refusal. */
  readonly visibility: Visibility;
  /** Which devices the caller may add a sensor to, by the bar naming each would hold it to. */
  readonly writes: Reach;
}

/** What a pass reports for a host whose device its caller cannot see (`A-77`). */
export const HIDDEN_DEVICE_AT_ADDRESS = 'a device outside your view already has this address';
/** The same, for a device that matched on its name rather than the address. */
export const HIDDEN_DEVICE_BY_NAME = 'a device outside your view already has this name';
/** A sensor a template names that is already there, under a device the caller can see. */
export const HIDDEN_SENSOR_THERE = 'a sensor outside your view is already there';

export interface ProvisionOptions {
  /** For asking which of a group's devices and sensors the caller can see (`A-77`). */
  db: Queryable;
  objects: ObjectService;
  templates: DeviceTemplateCatalogue;
  logger: Logger;
  /** Which credential kinds a group can resolve, so a sensor that cannot authenticate is skipped. */
  credentialsFor: (groupId: number) => Promise<Set<string>>;
  /** Records which device a host became, so a re-run knows what it already made. */
  recordDevice: (runId: number, address: string, deviceId: number) => Promise<void>;
}

export interface ProvisionReport {
  /** Devices that already existed and were reused. The number that should grow on a re-run. */
  matched: number;
  devicesCreated: number;
  sensorsCreated: number;
  /** Devices given a master object, so one unreachable host is one alarm (`D-05`). */
  mastersSet: number;
  /** Sensors a template named that were already there. Zero duplicates is the promise. */
  sensorsSkipped: number;
  /** Hosts nothing could be created for, and why. Never silent. */
  problems: { address: string; problem: string }[];
  devices: { address: string; deviceId: number; created: boolean; sensors: string[] }[];
}

/** The bits of an existing device this needs to recognise it. */
export interface ExistingDevice {
  id: number;
  name: string;
  host: string;
}

export interface ExistingSensor {
  id: number;
  deviceId: number;
  sensorType: string;
  params: Record<string, unknown>;
}

/**
 * The devices already in a group and every sensor on them, for `D-04`'s idempotency check.
 *
 * Direct rather than through `ObjectService.list`, because what is wanted is the whole group at
 * once with the one field that identifies a device — and paging through a listing API to build
 * an in-memory index would be a page size somebody has to tune. **Every one, seen or not**: a
 * device the caller cannot see still stops a second one being made at its address, and what the
 * caller is told about it is decided by the pass (`A-77`).
 *
 * **In id order, and the pass depends on it** (`P-381`). `DeviceIndex` keeps the last device it is
 * given for an address or a name, and `sensorLike` takes the first sensor that matches a spec. So
 * two devices at one address, or two alike sensors on one device, resolve by position. Without an
 * `ORDER BY` PostgreSQL promises no position, and the plan picks one: a sequential scan returns the
 * rows in the order they were last written, so an edit to the older device moved it last. One run
 * could match the older device and the next the newer, and each add what its device lacked. Read
 * in id order, an address resolves to the newer device every time, as it does to a device the
 * pass itself creates, and a spec to the older sensor.
 */
export async function existingInGroup(
  q: Queryable,
  groupId: number,
): Promise<{ devices: ExistingDevice[]; sensors: ExistingSensor[] }> {
  const [devices, sensors] = await Promise.all([
    q.query<{ id: string; name: string; host: string | null }>(
      `SELECT o.id, o.name, d.host
       FROM object o
       JOIN device_config d ON d.object_id = o.id
       WHERE o.parent_id = $1 AND o.kind = 'device'
       ORDER BY o.id`,
      [groupId],
    ),
    q.query<{ id: string; parent_id: string; type: string; params: Record<string, unknown> }>(
      `SELECT s.id, s.parent_id, sc.type, sc.params
       FROM object s
       JOIN sensor_config sc ON sc.object_id = s.id
       JOIN object d ON d.id = s.parent_id
       WHERE d.parent_id = $1 AND d.kind = 'device' AND s.kind = 'sensor'
       ORDER BY s.id`,
      [groupId],
    ),
  ]);
  return {
    devices: devices.map((row) => ({ id: Number(row.id), name: row.name, host: row.host ?? '' })),
    sensors: sensors.map((row) => ({
      id: Number(row.id),
      deviceId: Number(row.parent_id),
      sensorType: row.type,
      params: row.params,
    })),
  };
}

export interface ProvisionInput {
  run: DiscoveryRunRow;
  hosts: readonly DiscoveredHost[];
  /** Devices already in the target group. */
  existingDevices: readonly ExistingDevice[];
  /** The sensors those devices already have. */
  existingSensors: readonly ExistingSensor[];
  actor: Actor;
  /**
   * Who vouches for sending inherited credentials to the addresses this run found (`A-41`): the
   * account that started it, or that last wrote the rule that did.
   */
  credentials: CredentialVoucher;
  /** Who asked, and so what may be matched, reported and written under (`A-77`). */
  sight: ProvisionSight;
}

export class ProvisionService {
  readonly #db: Queryable;
  readonly #objects: ObjectService;
  readonly #templates: DeviceTemplateCatalogue;
  readonly #logger: Logger;
  readonly #credentialsFor: ProvisionOptions['credentialsFor'];
  readonly #recordDevice: ProvisionOptions['recordDevice'];

  constructor(options: ProvisionOptions) {
    this.#db = options.db;
    this.#objects = options.objects;
    this.#templates = options.templates;
    this.#logger = options.logger.child({ component: 'provision' });
    this.#credentialsFor = options.credentialsFor;
    this.#recordDevice = options.recordDevice;
  }

  /**
   * Creates what is missing and nothing else.
   *
   * **One host at a time rather than one transaction for the lot.** A discovery of a /24 is two
   * hundred devices and a thousand sensors; one transaction holding the tree lock for all of it
   * would block every other write in the installation for as long as it took, and a failure
   * three-quarters through would roll back work that was perfectly good. Each host is
   * independent, and a host that fails is recorded and skipped — so a re-run finishes what this
   * one could not.
   */
  async provision(input: ProvisionInput): Promise<ProvisionReport> {
    const report: ProvisionReport = {
      matched: 0,
      devicesCreated: 0,
      sensorsCreated: 0,
      mastersSet: 0,
      sensorsSkipped: 0,
      problems: [],
      devices: [],
    };

    const index = new DeviceIndex(input.existingDevices);
    const sensorsByDevice = new Map<number, ExistingSensor[]>();
    for (const sensor of input.existingSensors) {
      const held = sensorsByDevice.get(sensor.deviceId);
      if (held === undefined) sensorsByDevice.set(sensor.deviceId, [sensor]);
      else held.push(sensor);
    }

    // **What the caller can see of the group, and write** (`A-77`): asked once, for every device
    // and sensor already there. Both are the caller's grants as every route reads them; neither
    // asks anything of an administrator or of a schedule's pass.
    const { visibility, writes } = input.sight;
    const seen = await visibility.visibleAmong(this.#db, [
      ...input.existingDevices.map((device) => device.id),
      ...input.existingSensors.map((sensor) => sensor.id),
    ]);
    const writable = new Set(
      (
        await writes.split(
          this.#db,
          input.existingDevices.map((device) => device.id).filter((id) => seen.has(id)),
        )
      ).reached,
    );

    const credentials = await this.#credentialsFor(input.run.groupId);
    // What a template names, the installation stands behind: the template is a file somebody with
    // the server's file system put there (`A-29`). The audit still says who started the run. Where
    // the credentials go is another matter: the addresses are the run's, not the template's, so
    // whoever chose them vouches for sending the group's credentials there (`A-41`).
    const writer = {
      ...asInstallation(input.actor),
      credentials: input.credentials,
      // And a refusal goes back to the caller in their own view: the owner of a set they may not
      // send is often the group or probe above their branch (`A-16`, `A-77`).
      answers: visibility,
    };
    // Empty means every template, which is what almost every run wants (`D-06`).
    const only = new Set(input.run.templates);

    for (const [position, host] of input.hosts.entries()) {
      try {
        const fingerprint = host.fingerprint ?? unidentified(host.address);
        const plan = this.#templates.plan(fingerprint, credentials, only);

        const found = index.find(host.address, fingerprint.reverseName);
        let deviceId: number;
        let created = false;

        if (found !== null && !seen.has(found.device.id)) {
          // **Matched, and not the caller's to know about** (`A-77`). Creating a second device
          // would be the duplicate this pass exists to prevent, and naming this one would hand
          // over a hidden id. So neither: the host is reported without an id, nothing is made
          // under the device, and nothing is recorded against it.
          report.problems.push({
            address: host.address,
            problem: found.by === 'address' ? HIDDEN_DEVICE_AT_ADDRESS : HIDDEN_DEVICE_BY_NAME,
          });
          continue;
        }
        if (found !== null && !writable.has(found.device.id)) {
          // Seen and not writable: the caller may know it is there, and may not add to it.
          report.matched += 1;
          await this.#recordDevice(input.run.id, host.address, found.device.id);
          report.devices.push({
            address: host.address,
            deviceId: found.device.id,
            created: false,
            sensors: [],
          });
          report.problems.push({
            address: host.address,
            problem: `nothing was added to device ${String(found.device.id)}: adding a sensor to it needs write on it`,
          });
          continue;
        }

        if (found !== null) {
          deviceId = found.device.id;
          report.matched += 1;
        } else {
          const device = await this.#objects.create(writer, {
            kind: 'device',
            parentId: input.run.groupId,
            name: deviceName(host.address, fingerprint),
            host: host.address,
            ipVersion: 'v4',
            tags: plan.tags,
            comments: describe(fingerprint),
          });
          deviceId = device.id;
          created = true;
          report.devicesCreated += 1;
          // Indexed immediately: two addresses that resolve to the same name in one run would
          // otherwise become two devices, and the second would be the duplicate this ticket
          // exists to prevent.
          index.add(
            { id: device.id, name: device.name, host: host.address },
            fingerprint.reverseName,
          );
          // The caller's, having just been made in a group they write.
          seen.add(device.id);
          writable.add(device.id);
        }

        const already = sensorsByDevice.get(deviceId) ?? [];
        const names: string[] = [];
        let masterSensorId: number | null = null;
        // Set when a sensor met a tree that stayed busy (`P-229`): the run stops after this host.
        let busy: ObjectError | null = null;
        // **The master first, on a device this pass created** (`P-229`). A run that stops on a
        // busy tree keeps what it made, and a device is mastered only by the pass that created it,
        // so a master tried last would leave a device stopped part-way with no master for good:
        // a re-run only matches it. Which spec is the master does not change, only when it is
        // tried.
        for (const spec of created ? masterFirst(plan.sensors) : plan.sensors) {
          const there = sensorLike(already, spec);
          if (there !== undefined) {
            // Counted only where the caller can see it (`A-77`). A hidden one still stops a
            // duplicate, and the caller is told only that something they cannot see is there.
            if (seen.has(there.id)) report.sensorsSkipped += 1;
            else {
              report.problems.push({
                address: host.address,
                problem: `${spec.type}: ${HIDDEN_SENSOR_THERE}`,
              });
            }
            continue;
          }
          try {
            const sensor = await this.#objects.create(writer, {
              kind: 'sensor',
              parentId: deviceId,
              name: spec.name ?? spec.type,
              sensorType: spec.type,
              ...(spec.params === undefined ? {} : { params: { ...spec.params } }),
            });
            // Added to the in-memory list as well as created, so two templates naming the same
            // sensor in one pass cannot both create it — `plan` deduplicates, and this is the
            // belt to that braces.
            already.push({
              id: sensor.id,
              deviceId,
              sensorType: spec.type,
              params: { ...(spec.params ?? {}) },
            });
            seen.add(sensor.id);
            sensorsByDevice.set(deviceId, already);
            report.sensorsCreated += 1;
            names.push(sensor.name);
            // The first spec that claims it, and only one per device: a second would overwrite
            // the first, and which one won would depend on template order.
            if (spec.master === true && masterSensorId === null) masterSensorId = sensor.id;
          } catch (error) {
            // The whole run's problem, not this sensor's (`P-229`). The rest of this device's
            // sensors would wait for the tree too, so none is tried; but what this pass made of the
            // device is still finished below, its master and its record, before the run stops.
            if (treeBusy(error)) {
              busy = error;
              break;
            }
            // **Per sensor, not per host.** A template naming a sensor that cannot be created —
            // a required parameter it does not supply, a type whose schema changed under it —
            // must not take the rest of that device's sensors with it. Found the first time
            // provisioning ran: a built-in template named `snmp.diskfree` without its mount
            // point, and the device came out with a Ping and nothing else while the report said
            // nothing was wrong.
            report.problems.push({
              address: host.address,
              problem: `${spec.type}: ${error instanceof Error ? error.message : 'could not be created'}`,
            });
          }
        }

        // **Only on a device this pass created.** A device an operator already set up has
        // dependency choices of its own — possibly "none", deliberately — and a discovery that
        // overwrote them would be editing a decision somebody made on purpose, silently, on
        // every re-run. `D-04`'s whole promise is that a second run changes nothing.
        if (created && masterSensorId !== null) {
          try {
            // `device` mode writes the setting on the *device*, so every other sensor under it
            // inherits this one as master and the master itself keeps scanning — `M-11` gets
            // that from one `a.master_id <> o.id` rather than a special case.
            await this.#objects.setDependency(
              writer,
              masterSensorId,
              'device',
              undefined,
              undefined,
            );
            report.mastersSet += 1;
          } catch (error) {
            // A device with its sensors and no master is a working device; failing the whole
            // host over the dependency would be losing the sensors to save the wiring.
            report.problems.push({
              address: host.address,
              problem: `the master dependency could not be set: ${error instanceof Error ? error.message : 'unknown'}`,
            });
          }
        }

        await this.#recordDevice(input.run.id, host.address, deviceId);
        report.devices.push({ address: host.address, deviceId, created, sensors: names });
        // Now the run stops, by the host's catch, as it does for a device that met the tree.
        if (busy !== null) throw busy;
      } catch (error) {
        // Recorded, never silent. A host that could not be provisioned is the one thing an
        // operator needs to see after a discovery, and a run that reported success while
        // skipping a machine is worse than one that reported the failure.
        const problem = error instanceof Error ? error.message : 'could not be provisioned';
        report.problems.push({ address: host.address, problem });
        this.#logger.error(
          { runId: input.run.id, address: host.address, problem },
          'a host could not be provisioned',
        );
        if (treeBusy(error)) {
          // **The run stops here** (`P-229`). The tree lock is one lock for the installation,
          // so every host after this one would wait 30 s for it too, one sensor at a time — a
          // /24 could hold the discovery pump for hours. Each host not tried is named, and a
          // re-run finishes them, as it finishes any host that failed.
          const rest = input.hosts.slice(position + 1);
          for (const skipped of rest) {
            report.problems.push({
              address: skipped.address,
              problem:
                'not provisioned: the run stopped when the object tree stayed busy; run it again',
            });
          }
          this.#logger.warn(
            { runId: input.run.id, notTried: rest.length },
            'provisioning stopped: the object tree stayed busy',
          );
          break;
        }
      }
    }

    this.#logger.info({ runId: input.run.id, ...counts(report) }, 'discovery provisioned');
    return report;
  }
}

/** A change that waited for the tree lock and gave up (`P-229`). */
function treeBusy(error: unknown): error is ObjectError {
  return error instanceof ObjectError && error.code === 'OBJECT_TREE_BUSY';
}

/** The specs with the first one marked master moved to the front, the rest in their order. */
function masterFirst(specs: readonly SensorSpec[]): readonly SensorSpec[] {
  const at = specs.findIndex((spec) => spec.master === true);
  if (at <= 0) return specs;
  return [specs[at] as SensorSpec, ...specs.slice(0, at), ...specs.slice(at + 1)];
}

function counts(report: ProvisionReport): Record<string, number> {
  return {
    matched: report.matched,
    devicesCreated: report.devicesCreated,
    sensorsCreated: report.sensorsCreated,
    sensorsSkipped: report.sensorsSkipped,
    problems: report.problems.length,
  };
}

/**
 * Existing devices, indexed by every name they might be recognised under.
 *
 * A class rather than three maps built inline, because a device created during the run has to
 * join the index — and forgetting to add one of the three keys is exactly the bug that makes a
 * second run duplicate the first.
 */
class DeviceIndex {
  readonly #byHost = new Map<string, ExistingDevice>();
  readonly #byName = new Map<string, ExistingDevice>();
  readonly #byShortName = new Map<string, ExistingDevice>();

  constructor(devices: readonly ExistingDevice[]) {
    for (const device of devices) this.add(device);
  }

  add(device: ExistingDevice, reverseName?: string): void {
    const host = device.host.trim().toLowerCase();
    if (host !== '') {
      this.#byHost.set(host, device);
      // A device whose *host* is a name is also findable by that name, which is how a device
      // somebody created years ago as `web01.example.com` is recognised when a sweep finds the
      // address behind it.
      if (!isAddress(host)) {
        this.#byName.set(host, device);
        this.#byShortName.set(shortName(host), device);
      }
    }
    const name = device.name.trim().toLowerCase();
    if (name !== '') {
      this.#byName.set(name, device);
      this.#byShortName.set(shortName(name), device);
    }
    if (reverseName !== undefined && reverseName.trim() !== '') {
      const reverse = reverseName.trim().toLowerCase();
      this.#byName.set(reverse, device);
      this.#byShortName.set(shortName(reverse), device);
    }
  }

  /**
   * The device this host already is, or null.
   *
   * **In order of how much each key means**, and the order is the point: the address is exact,
   * the full name is nearly so, and the short name is a guess that two sites can both satisfy.
   * Consulting the short name first would merge `web01.london` and `web01.paris` into one device
   * the first time both were discovered.
   */
  find(
    address: string,
    reverseName?: string,
  ): { device: ExistingDevice; by: 'address' | 'name' } | null {
    const byAddress = this.#byHost.get(address.trim().toLowerCase());
    if (byAddress !== undefined) return { device: byAddress, by: 'address' };

    const reverse = (reverseName ?? '').trim().toLowerCase();
    if (reverse === '') return null;

    const byName = this.#byName.get(reverse) ?? this.#byShortName.get(shortName(reverse));
    return byName === undefined ? null : { device: byName, by: 'name' };
  }
}

/** `web01` from `web01.example.com`. */
function shortName(name: string): string {
  return name.split('.')[0] ?? name;
}

function isAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * The sensor a device already has that this spec would make, if it has one.
 *
 * **Type *and* parameters, matching how a template plans them.** Two `http.request` sensors on
 * different paths are two sensors and both belong; two on the same path are a duplicate. Only
 * the parameters the *spec* names are compared — a sensor created by hand carries every default
 * its schema has, and requiring those to match too would make every re-run create a second copy
 * of everything.
 */
function sensorLike(
  existing: readonly ExistingSensor[],
  spec: SensorSpec,
): ExistingSensor | undefined {
  return existing.find((one) => {
    if (one.sensorType !== spec.type) return false;
    for (const [key, value] of Object.entries(spec.params ?? {})) {
      if (JSON.stringify(one.params[key]) !== JSON.stringify(value)) return false;
    }
    return true;
  });
}

/** A device's name: what it calls itself, then what DNS calls it, then its address. */
function deviceName(address: string, fingerprint: Fingerprint): string {
  const sysName = (fingerprint.sysName ?? '').trim();
  // `sysName` first, because it is what the device was configured to call itself and is what an
  // operator will see on its own console. A reverse record is what somebody typed into DNS,
  // which is usually the same and occasionally years out of date.
  if (sysName !== '' && !isAddress(sysName)) return sysName.slice(0, 200);
  const reverse = (fingerprint.reverseName ?? '').trim().replace(/\.$/, '');
  if (reverse !== '') return reverse.slice(0, 200);
  return address;
}

/** What the discovery knew, in the device's comments, so an operator can see why it got what it got. */
function describe(fingerprint: Fingerprint): string {
  const parts = [
    `Discovered as ${fingerprint.kind} (confidence ${String(fingerprint.confidence)}).`,
  ];
  if (fingerprint.vendor !== undefined) parts.push(`Vendor: ${fingerprint.vendor}.`);
  if (fingerprint.sysDescr !== undefined)
    parts.push(`sysDescr: ${fingerprint.sysDescr.slice(0, 300)}`);
  if (fingerprint.evidence.length > 0) parts.push(`Evidence: ${fingerprint.evidence.join('; ')}`);
  return parts.join('\n').slice(0, 2_000);
}

/** What a host with no fingerprint gets: the generic plan, which is exactly what it would get. */
function unidentified(address: string): Fingerprint {
  return {
    address,
    ports: [],
    kind: 'unknown',
    confidence: 0,
    evidence: ['this host answered a ping and was not identified'],
  };
}
