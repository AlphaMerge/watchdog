import {
  SensorTypeError,
  sensorTypesFor,
  standardCatalogue,
  withheldReason,
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
export function probeCatalogue(profile: BuildProfile = BUILD.profile): SensorCatalogue {
  return standardCatalogue(sensorTypesFor(profile));
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
      ? `no sensor type "${id}" is registered`
      : `sensor type "${id}" is not in this build: the ${profile} profile leaves it out, because ${reason}`,
  );
}
