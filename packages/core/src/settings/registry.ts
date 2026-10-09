import { Ajv, type ValidateFunction } from 'ajv';
import { AppError } from '@ms/shared';

/**
 * The registry of inheritable settings.
 *
 * Every inheritable setting is declared here once: its key, the shape of its value, and the
 * value that applies when nothing in the tree defines it. The registry is what makes
 * inheritance uniform — the resolver never knows what a setting *means*, only how to find the
 * nearest ancestor that defines it.
 *
 * Adding a setting is a one-line change here. It needs no migration, because `object_setting`
 * is sparse and generic.
 */
export interface SettingDefinition<T> {
  key: string;
  /** JSON Schema for the value. Validated at the API boundary, before it reaches the database. */
  schema: Record<string, unknown>;
  /** Applies when no ancestor defines the setting. The bottom of every resolution chain. */
  default: T;
  description: string;
}

export class SettingError extends AppError {
  constructor(message: string, context: Record<string, string | number>) {
    super('SETTING_INVALID', message, { context });
    this.name = 'SettingError';
  }
}

/**
 * Scan settings (CAPABILITIES.MD §4). PRTG's own defaults: a one-minute interval at the root,
 * and "warn for one interval, then down" as the failure policy.
 */
export const SCAN_INTERVAL_SECONDS: SettingDefinition<number> = {
  key: 'scan.intervalSeconds',
  schema: { type: 'integer', minimum: 1, maximum: 86_400 },
  default: 60,
  description: 'How often a sensor is scanned, in seconds.',
};

export const SCAN_TIMEOUT_MS: SettingDefinition<number> = {
  key: 'scan.timeoutMs',
  schema: { type: 'integer', minimum: 100, maximum: 900_000 },
  default: 30_000,
  description: 'How long a single check may run before it is aborted.',
};

export const SCAN_RETRY_WARNINGS: SettingDefinition<number> = {
  key: 'scan.retryWarnings',
  schema: { type: 'integer', minimum: 0, maximum: 10 },
  default: 1,
  description:
    'Consecutive failed scans reported as Warning before the sensor goes Down. 0 goes Down immediately.',
};

/**
 * The schedule in effect for an object and everything beneath it (`M-09`).
 *
 * An ordinary inheritable setting rather than a mechanism of its own, so a group sets it, a
 * device overrides it, and a sensor reverts to inherit — with one resolver, one API and one
 * settings form, and no second parent-walk to keep in step with the first.
 *
 * `null` is both the default and a meaningful override: an object that sets it to null is
 * saying "monitor me always", which is how one device inside a scheduled group is exempted
 * without moving it out of the group.
 */
export const SCHEDULE_ID: SettingDefinition<number | null> = {
  key: 'schedule.id',
  schema: { type: ['integer', 'null'], minimum: 1 },
  default: null,
  description:
    'The schedule that decides when this object and everything beneath it is monitored. ' +
    'Null means always.',
};

/**
 * Where this object physically is (`N-06`).
 *
 * An ordinary inheritable setting and nothing more: a site set on a group applies to every
 * device beneath it, a device overrides it, and `%location` in a notification resolves whatever
 * the sensor inherits. That is PRTG's behaviour and it costs one declaration, because the
 * resolver already does the walking — there is no column, no migration and no second lookup.
 *
 * `[V2]`'s maps will read the same value rather than a second one that could disagree.
 */
export const OBJECT_LOCATION: SettingDefinition<string> = {
  key: 'object.location',
  schema: { type: 'string', maxLength: 500 },
  default: '',
  description:
    'Where this object is — a site, a rack, an address. Inherited downward, and available to ' +
    'notifications as %location.',
};

/**
 * The master object this one depends on (`M-11`).
 *
 * Inheritable like everything else, which is what gives `WORKFLOW.MD §5`'s three modes without
 * three mechanisms: *use parent* is not defining it, *select object* is defining it, and
 * *master object for parent device* is defining it on the parent device rather than on the
 * sensor. A `null` of one's own means "depend on nothing", which is how one sensor is exempted
 * from a dependency its device carries.
 *
 * The master must be a **sensor**. Devices and groups have no state of their own in this model —
 * `M-02` put state on sensors — so "the device is Down" is not yet a fact anything could read.
 * Widening this is a change to make when a device-level rollup exists, not before.
 */
export const DEPENDENCY_MASTER_ID: SettingDefinition<number | null> = {
  key: 'dependency.masterId',
  schema: { type: ['integer', 'null'], minimum: 1 },
  default: null,
  description:
    'The sensor whose going Down pauses this object and everything beneath it. Null means it ' +
    'depends on nothing.',
};

/**
 * How long dependents stay paused after the master recovers (`M-11`).
 *
 * Zero by default, and zero means *now*: the dependents are released in the transaction that
 * recorded the recovery. A non-zero delay exists for one reason — a flapping link that bounces
 * every few seconds would otherwise generate an alarm storm on every bounce — and it is paid for
 * with monitoring that resumes late, so it is opt-in.
 */
export const DEPENDENCY_DELAY_SECONDS: SettingDefinition<number> = {
  key: 'dependency.delaySeconds',
  schema: { type: 'integer', minimum: 0, maximum: 86_400 },
  default: 0,
  description:
    'Seconds to keep dependents paused after the master recovers, so a flapping master does ' +
    'not produce an alarm on every bounce.',
};

/**
 * The longest a setting key may be: what the API takes as one, in a path (`/settings/{key}`) or
 * in `?effective=` (`P-347`). Room to grow — the longest today is 23 — and checked here as each
 * key is registered, so a key the API could not name cannot be declared.
 */
export const MAX_SETTING_KEY = 100;

const DEFINITIONS: readonly SettingDefinition<unknown>[] = [
  SCAN_INTERVAL_SECONDS,
  SCAN_TIMEOUT_MS,
  SCAN_RETRY_WARNINGS,
  SCHEDULE_ID,
  DEPENDENCY_MASTER_ID,
  DEPENDENCY_DELAY_SECONDS,
  OBJECT_LOCATION,
];

const ajv = new Ajv({ allErrors: true, strict: false });

class Registry {
  readonly #byKey = new Map<string, SettingDefinition<unknown>>();
  readonly #validators = new Map<string, ValidateFunction>();

  constructor(definitions: readonly SettingDefinition<unknown>[]) {
    for (const definition of definitions) {
      if (this.#byKey.has(definition.key)) {
        throw new SettingError('duplicate setting key', { key: definition.key });
      }
      if (definition.key.length > MAX_SETTING_KEY) {
        throw new SettingError('setting key too long for the API to name', {
          key: definition.key,
        });
      }
      this.#byKey.set(definition.key, definition);
      this.#validators.set(definition.key, ajv.compile(definition.schema));
    }
  }

  get keys(): string[] {
    return [...this.#byKey.keys()];
  }

  definitions(): SettingDefinition<unknown>[] {
    return [...this.#byKey.values()];
  }

  has(key: string): boolean {
    return this.#byKey.has(key);
  }

  /** Throws `SettingError` for an unknown key, so a typo cannot be stored and never resolve. */
  get(key: string): SettingDefinition<unknown> {
    const definition = this.#byKey.get(key);
    if (definition === undefined) {
      throw new SettingError('unknown setting key', { key });
    }
    return definition;
  }

  defaultFor(key: string): unknown {
    return this.get(key).default;
  }

  /** Validates a value against its setting's schema. */
  validate(key: string, value: unknown): void {
    const validate = this.#validators.get(key);
    if (validate === undefined) {
      throw new SettingError('unknown setting key', { key });
    }
    if (!validate(value)) {
      const problems = (validate.errors ?? [])
        .map(
          (e) => `${e.instancePath === '' ? 'value' : e.instancePath} ${e.message ?? 'is invalid'}`,
        )
        .join('; ');
      throw new SettingError(`invalid value for ${key}: ${problems}`, { key });
    }
  }
}

export const settingRegistry = new Registry(DEFINITIONS);
