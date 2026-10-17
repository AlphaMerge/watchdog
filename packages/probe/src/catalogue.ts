import {
  SensorTypeError,
  sensorTypesFor,
  standardCatalogue,
  withheldReason,
  type ResolveHost,
  type SensorCatalogue,
} from '@ms/sensors';
import type { BuildProfile } from '@ms/shared';
import { BUILD } from './version.js';

/**
 * The sensor types this probe runs: its build's profile of the built-in set (`H-12`).
 *
 * **Every place the probe asks what a type is comes through here** — the worker registry that
 * executes checks and the main thread that decides which types a listener feeds — so the two
 * cannot disagree about what this build contains.
 */
export function probeCatalogue(
  profile: BuildProfile = BUILD.profile,
  /** How a check resolves a name it checks: a pool worker's client of the probe's resolver (`P-426`). */
  options: { readonly resolve?: ResolveHost } = {},
): SensorCatalogue {
  return standardCatalogue(sensorTypesFor(profile), options);
}

/**
 * The refusal for a type this probe was asked to run and does not carry.
 *
 * **By name, and with the reason when the profile withheld it.** A v1 probe assigned a flow sensor
 * by a core that still has one says that flow is not in this build, which an operator can act
 * on; "no sensor type is registered" reads like a broken install. It is still
 * `UNKNOWN_SENSOR_TYPE`, so the pool reports it as its own phase rather than as a failing check.
 */
export function missingTypeError(
  id: string,
  profile: BuildProfile = BUILD.profile,
): SensorTypeError {
  const reason = withheldReason(profile, id);
  return new SensorTypeError(
    'UNKNOWN_SENSOR_TYPE',
    reason === undefined
      ? `no sensor type "${id}" is registered in this probe, which is probably older than the core`
      : `sensor type "${id}" is not in this build: the ${profile} profile leaves it out, because ${reason}`,
  );
}

/** How the wheel routes a due sensor of each type, where it does not go straight to the pool. */
export interface DispatchTables {
  /** Sensor type to the id of the listener that feeds it (`T-06`). */
  readonly listenerFor: ReadonlyMap<string, string>;
  /** Sensor types that run in a child process of their own (`P-03`). */
  readonly isolated: ReadonlySet<string>;
}

/**
 * The dispatch tables for a catalogue, asked of each type's declaration rather than matched on an
 * id: `T-20`'s syslog receiver was already the second listener, and a probe with a hardcoded type
 * id would need editing for each.
 *
 * **Built from this build's catalogue, so a v1 probe maps no listener to a type it does not
 * carry** (`H-12`). A flow listener wired into a v1 probe would then be fed by nothing; a
 * `flow.netflow` assignment goes to the pool, which refuses it by name.
 *
 * Building the catalogue in the main thread is cheap and loads no protocol stack: a type's heavy
 * imports live inside `execute`, which only a worker ever calls.
 */
export function dispatchTables(catalogue: SensorCatalogue = probeCatalogue()): DispatchTables {
  const listenerFor = new Map<string, string>();
  const isolated = new Set<string>();
  for (const summary of catalogue.summaries()) {
    const declaration = catalogue.declaration(summary.id);
    if (declaration.listener !== undefined) listenerFor.set(summary.id, declaration.listener);
    if (declaration.isolation === 'process') isolated.add(summary.id);
  }
  return { listenerFor, isolated };
}
