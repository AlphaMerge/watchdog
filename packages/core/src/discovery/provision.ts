import type { Fingerprint, Logger } from '@ms/shared';
import type { DeviceTemplateCatalogue } from '../device-templates/catalogue.js';
import type { SensorSpec } from '../device-templates/definition.js';
import type { Actor } from '../objects/audit.js';
import type { ObjectService } from '../objects/service.js';
import type { DiscoveredHost, DiscoveryRunRow } from './service.js';

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

export interface ProvisionOptions {
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
  deviceId: number;
  sensorType: string;
  params: Record<string, unknown>;
}

export interface ProvisionInput {
  run: DiscoveryRunRow;
  hosts: readonly DiscoveredHost[];
  /** Devices already in the target group. */
  existingDevices: readonly ExistingDevice[];
  /** The sensors those devices already have. */
  existingSensors: readonly ExistingSensor[];
  actor: Actor;
}

export class ProvisionService {
  readonly #objects: ObjectService;
  readonly #templates: DeviceTemplateCatalogue;
  readonly #logger: Logger;
  readonly #credentialsFor: ProvisionOptions['credentialsFor'];
  readonly #recordDevice: ProvisionOptions['recordDevice'];

  constructor(options: ProvisionOptions) {
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

    const credentials = await this.#credentialsFor(input.run.groupId);

    for (const host of input.hosts) {
      try {
        const fingerprint = host.fingerprint ?? unidentified(host.address);
        const plan = this.#templates.plan(fingerprint, credentials);

        const existing = index.find(host.address, fingerprint.reverseName);
        let deviceId: number;
        let created = false;

        if (existing !== null) {
          deviceId = existing.id;
          report.matched += 1;
        } else {
          const device = await this.#objects.create(input.actor, {
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
        }

        const already = sensorsByDevice.get(deviceId) ?? [];
        const names: string[] = [];
        let masterSensorId: number | null = null;
        for (const spec of plan.sensors) {
          if (hasSensor(already, spec)) {
            report.sensorsSkipped += 1;
            continue;
          }
          try {
            const sensor = await this.#objects.create(input.actor, {
              kind: 'sensor',
              parentId: deviceId,
              name: spec.name ?? spec.type,
              sensorType: spec.type,
              ...(spec.params === undefined ? {} : { params: { ...spec.params } }),
            });
            // Added to the in-memory list as well as created, so two templates naming the same
            // sensor in one pass cannot both create it — `plan` deduplicates, and this is the
            // belt to that braces.
            already.push({ deviceId, sensorType: spec.type, params: { ...(spec.params ?? {}) } });
            sensorsByDevice.set(deviceId, already);
            report.sensorsCreated += 1;
            names.push(sensor.name);
            // The first spec that claims it, and only one per device: a second would overwrite
            // the first, and which one won would depend on template order.
            if (spec.master === true && masterSensorId === null) masterSensorId = sensor.id;
          } catch (error) {
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
              input.actor,
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
      }
    }

    this.#logger.info({ runId: input.run.id, ...counts(report) }, 'discovery provisioned');
    return report;
  }
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
  find(address: string, reverseName?: string): ExistingDevice | null {
    const byAddress = this.#byHost.get(address.trim().toLowerCase());
    if (byAddress !== undefined) return byAddress;

    const reverse = (reverseName ?? '').trim().toLowerCase();
    if (reverse === '') return null;

    return this.#byName.get(reverse) ?? this.#byShortName.get(shortName(reverse)) ?? null;
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
 * Whether a device already has this sensor.
 *
 * **Type *and* parameters, matching how a template plans them.** Two `http.request` sensors on
 * different paths are two sensors and both belong; two on the same path are a duplicate. Only
 * the parameters the *spec* names are compared — a sensor created by hand carries every default
 * its schema has, and requiring those to match too would make every re-run create a second copy
 * of everything.
 */
function hasSensor(existing: readonly ExistingSensor[], spec: SensorSpec): boolean {
  return existing.some((one) => {
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
