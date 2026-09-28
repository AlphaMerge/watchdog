import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv, type ErrorObject, type JSONSchemaType, type ValidateFunction } from 'ajv';
import * as ajvFormats from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { ConfigError } from '../errors/app-error.js';
import { crossFieldProblems } from './schema.js';

/** Where a configuration value came from. Reported at boot so operators can see the layering. */
export interface ConfigSources {
  file: string | null;
  envOverrides: string[];
  /**
   * `MS_*` variables that are not configuration — the launcher's `MS_BUILD_VERSION`, an
   * operator's `MS_NODE`, a test harness's own knobs. Reported so they stay discoverable.
   */
  ignoredEnv: string[];
}

export interface LoadConfigOptions<T> {
  schema: JSONSchemaType<T>;
  /** Explicit path. Falls back to `--config <path>` in argv, then `<PREFIX>CONFIG_FILE`. */
  configFile?: string | undefined;
  /** Defaults to `MS_`. */
  envPrefix?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}

export interface LoadedConfig<T> {
  config: T;
  sources: ConfigSources;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `LOG_LEVEL` -> `logLevel`, `TLS` -> `tls`. */
function toCamelCase(segment: string): string {
  return segment
    .toLowerCase()
    .split('_')
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

function setDeep(target: PlainObject, path: readonly string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (key === undefined) return;
    const next = cursor[key];
    if (!isPlainObject(next)) {
      const created: PlainObject = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  const last = path[path.length - 1];
  if (last !== undefined) cursor[last] = value;
}

function deepMerge(base: PlainObject, overlay: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function resolveConfigFile(
  explicit: string | undefined,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  envPrefix: string,
): string | null {
  if (explicit !== undefined && explicit !== '') return resolve(explicit);
  const flagIndex = argv.indexOf('--config');
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (fromFlag !== undefined && fromFlag !== '') return resolve(fromFlag);
  const fromEnv = env[`${envPrefix}CONFIG_FILE`];
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  return null;
}

function readConfigFile(path: string): PlainObject {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Cannot read configuration file: ${path}`, {
      context: { path, phase: 'read' },
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(
      `Configuration file is not valid JSON: ${path} (${cause instanceof Error ? cause.message : String(cause)})`,
      { context: { path, phase: 'parse' }, cause },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Configuration file must contain a JSON object: ${path}`, {
      context: { path, phase: 'parse' },
    });
  }
  return parsed;
}

/**
 * Builds the environment overlay.
 *
 * `MS_DATABASE__POOL_SIZE=40`            -> `database.poolSize = "40"` (coerced by the schema)
 * `MS_DATABASE__PASSWORD__FROM_FILE=...` -> reads the secret out of the named file, so systemd
 *                                           `LoadCredential=` and Docker secrets work without
 *                                           putting the password in the process environment.
 */
function collectEnvOverlay(
  env: NodeJS.ProcessEnv,
  envPrefix: string,
  sections: ReadonlySet<string>,
): { overlay: PlainObject; keys: string[]; ignored: string[] } {
  const overlay: PlainObject = {};
  const keys: string[] = [];
  const ignored: string[] = [];
  const fromFileSuffix = '__FROM_FILE';

  for (const [rawKey, rawValue] of Object.entries(env)) {
    if (!rawKey.startsWith(envPrefix) || rawValue === undefined) continue;
    const withoutPrefix = rawKey.slice(envPrefix.length);
    if (withoutPrefix === '' || withoutPrefix === 'CONFIG_FILE') continue;

    const readsFile = withoutPrefix.endsWith(fromFileSuffix);
    const pathPart = readsFile ? withoutPrefix.slice(0, -fromFileSuffix.length) : withoutPrefix;
    const path = pathPart
      .split('__')
      .filter((s) => s !== '')
      .map(toCamelCase);
    if (path.length === 0) continue;

    // The prefix is a shared namespace, not ours alone: the release launcher exports
    // MS_BUILD_VERSION, operators set MS_NODE, harnesses add their own knobs. Only variables
    // whose first segment names a real configuration section are treated as settings. A typo
    // in a leaf name is still a hard error, which is where typos actually happen.
    const section = path[0];
    if (section === undefined || !sections.has(section)) {
      ignored.push(rawKey);
      continue;
    }

    let value: unknown = rawValue;
    if (readsFile) {
      try {
        value = readFileSync(rawValue, 'utf8').trim();
      } catch (cause) {
        throw new ConfigError(`Cannot read secret file referenced by ${rawKey}: ${rawValue}`, {
          context: { envVar: rawKey, path: rawValue, phase: 'read-secret' },
          cause,
        });
      }
    }

    setDeep(overlay, path, value);
    keys.push(rawKey);
  }

  return { overlay, keys: keys.sort(), ignored: ignored.sort() };
}

function formatAjvError(error: ErrorObject): string {
  const location =
    error.instancePath === '' ? '(root)' : error.instancePath.slice(1).replaceAll('/', '.');
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty ?? '?';
    return `${location}: unknown setting "${extra}"`;
  }
  if (error.keyword === 'enum') {
    const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
    return `${location}: ${error.message ?? 'is invalid'} (${allowed.join(', ')})`;
  }
  return `${location}: ${error.message ?? 'is invalid'}`;
}

/**
 * Layered configuration: schema defaults -> file -> environment. Validated once at boot; a bad
 * configuration fails the process immediately with every problem listed, not just the first.
 */
export function loadConfig<T>(options: LoadConfigOptions<T>): LoadedConfig<T> {
  const envPrefix = options.envPrefix ?? 'MS_';
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);

  const filePath = resolveConfigFile(options.configFile, argv, env, envPrefix);
  const fileLayer = filePath === null ? {} : readConfigFile(filePath);
  const schemaProperties = (options.schema as { properties?: Record<string, unknown> }).properties;
  const sections = new Set(Object.keys(schemaProperties ?? {}));

  const { overlay, keys, ignored } = collectEnvOverlay(env, envPrefix, sections);
  const merged = deepMerge(fileLayer, overlay);

  const ajv = new Ajv({
    useDefaults: true,
    coerceTypes: true,
    allErrors: true,
    allowUnionTypes: true,
  });
  // ajv-formats is CommonJS with `module.exports = plugin` and `exports.default = plugin`.
  // `.default` is the callable at runtime; its published typings describe the module as a
  // namespace, so the cast is where that lie gets contained.
  const addFormats = ajvFormats.default as unknown as FormatsPlugin;
  addFormats(ajv);

  const invalid = (problems: readonly string[]): ConfigError => {
    const unique = [...new Set(problems)];
    return new ConfigError(`Configuration is invalid:\n  - ${unique.join('\n  - ')}`, {
      context: { file: filePath ?? '(none)', problemCount: unique.length },
    });
  };

  const validate: ValidateFunction<T> = ajv.compile(options.schema);
  if (!validate(merged)) throw invalid((validate.errors ?? []).map(formatAjvError));
  // The rules across fields (`A-38`), once every field has a value of the right type — which is
  // what they read.
  const crossField = crossFieldProblems(options.schema, merged);
  if (crossField.length > 0) throw invalid(crossField);

  // `validate` is a type predicate: past the guard, `merged` is a `T`.
  return {
    config: merged,
    sources: { file: filePath, envOverrides: keys, ignoredEnv: ignored },
  };
}
