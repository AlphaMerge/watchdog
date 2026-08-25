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

const DEFINITIONS: readonly SettingDefinition<unknown>[] = [
  SCAN_INTERVAL_SECONDS,
  SCAN_TIMEOUT_MS,
  SCAN_RETRY_WARNINGS,
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
