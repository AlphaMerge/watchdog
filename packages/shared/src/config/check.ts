import type { JSONSchemaType } from 'ajv';
import { ConfigError } from '../errors/app-error.js';
import { loadConfig } from './load.js';

/**
 * `config check` — does this configuration load under *this* build? (`H-03`)
 *
 * In `@ms/shared` rather than in the core because **both services need it and for the same
 * reason**: `install.sh` upgrades them together, and a probe whose configuration a new build
 * cannot read fails exactly as unhelpfully as a core's would. The probe had no command-line
 * verbs at all before this, so `ms-probe config check` would have started a second probe.
 *
 * **The upgrade question, asked before the upgrade rather than after it.** Configuration is never
 * clobbered by the installer, which is right, and it means an upgrade can hand a new binary a
 * file written for an older one. If a setting was renamed, removed or made required, the first
 * anybody hears of it is the service failing to start — after the old one has already been
 * stopped, and with the answer in `journalctl` rather than in front of whoever ran the installer.
 *
 * So this exists to be run **while the old service is still running**: same loader, same schema,
 * same layering of defaults, file and `MS_*` environment, and a non-zero exit if the file this
 * build would read is not one it can read. `install.sh` runs it before it restarts anything.
 *
 * It reports every problem rather than the first, matching `loadConfig` — somebody fixing a
 * configuration should not have to run this five times to find five mistakes.
 *
 * **It does not connect to anything.** No database, no probe endpoint, no port. That is what
 * makes it safe to run against a live installation, and it is also the boundary of what it can
 * tell you: that the file parses and validates, not that the credentials in it are right.
 */

export interface ConfigCheckOptions<T> {
  readonly schema: JSONSchemaType<T>;
  /** `ms-core` or `ms-probe`, for the line that says what was checked. */
  readonly service: string;
  readonly version: string;
  /** Argv as given, so `--config` is honoured exactly as the server honours it. */
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
}

export function runConfigCheck<T>(options: ConfigCheckOptions<T>): number {
  try {
    const loaded = loadConfig<T>({
      schema: options.schema,
      argv: [...options.argv],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    options.write(`configuration is valid for ${options.service} ${options.version}`);
    options.write(`  file            ${loaded.sources.file ?? '(none — schema defaults only)'}`);
    if (loaded.sources.envOverrides.length > 0) {
      options.write(`  environment     ${loaded.sources.envOverrides.join(', ')}`);
    }
    if (loaded.sources.ignoredEnv.length > 0) {
      // Not a failure — `MS_BUILD_VERSION` and friends are ordinary — but worth showing, because
      // a *misspelt section* looks exactly like one of those and is otherwise silent.
      options.write(`  ignored MS_*    ${loaded.sources.ignoredEnv.join(', ')}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      options.writeError(error.message);
      return 1;
    }
    options.writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
