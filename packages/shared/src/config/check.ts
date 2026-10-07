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
 *
 * **A check that read no file is not a pass** (`H-21`). With neither `--config` nor
 * `MS_CONFIG_FILE`, the loader validates the schema's defaults — which always validate — and this
 * used to say "configuration is valid" and exit 0. That was the documented pre-restart check, run
 * without a flag, on a `core.json` the restart then refused. The installed launchers now point at
 * `/etc/ms` themselves; anything that still reaches here without a file is told so and fails.
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
  /**
   * What only the running build can know about a configuration the schema accepts (`B-08`).
   *
   * The schema is the same in every build and a build is not: a v1 probe carries no flow sensor
   * type, so `flowListener.enabled: true` validates and does nothing. Asked only of a file that
   * loaded.
   *
   * **Two severities, because the exit code is an upgrade gate.** `place-release.sh` refuses to
   * replace anything when this exits non-zero. A `problem` is something the service would not
   * start with, or would start and do wrong: it fails the check. A `warning` is a setting the
   * service starts with and that has no effect: it is said, on stderr and marked as a warning,
   * and the check passes — a setting that does nothing must not hold a probe back from an
   * upgrade that the service itself would run.
   */
  readonly findings?: (config: T) => ConfigFindings;
}

export interface ConfigFindings {
  /** Each fails the check. */
  readonly problems?: readonly string[];
  /** Each is reported and does not. */
  readonly warnings?: readonly string[];
  /**
   * What is true of this configuration only on a condition the check cannot see (`P-276`).
   *
   * A probe that starts as root with scripts and no `processUid` refuses to, and nothing in the
   * file says which account the service will run as: the installer runs this check as root for a
   * unit that runs the probe as `ms-probe`. So it is not a warning, which the installer shows on
   * every upgrade, but a line on standard output with a pass, marked `note: `, for whoever runs
   * the check by hand. A failed check gives its problems and not these.
   */
  readonly notes?: readonly string[];
}

/** What every warning line starts with, so an installer or a person can pick them out. */
export const CONFIG_WARNING_PREFIX = 'warning: ';

/** What every note line starts with (`P-276`). */
export const CONFIG_NOTE_PREFIX = 'note: ';

export function runConfigCheck<T>(options: ConfigCheckOptions<T>): number {
  try {
    const loaded = loadConfig<T>({
      schema: options.schema,
      argv: [...options.argv],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (loaded.sources.file === null) {
      options.writeError(
        `no configuration file was read, so nothing about this installation was checked — ` +
          `pass --config <file> or set MS_CONFIG_FILE (${options.service} reads /etc/ms when installed)`,
      );
      return 1;
    }
    const findings = options.findings?.(loaded.config) ?? {};
    const problems = findings.problems ?? [];
    // Warnings first and whatever else is true: a failing check still owes them.
    for (const warning of findings.warnings ?? []) {
      options.writeError(`${CONFIG_WARNING_PREFIX}${warning}`);
    }
    if (problems.length > 0) {
      // Every one, like the loader's own: nobody should run this twice to find two.
      for (const problem of problems) options.writeError(problem);
      return 1;
    }
    options.write(`configuration is valid for ${options.service} ${options.version}`);
    options.write(`  file            ${loaded.sources.file}`);
    if (loaded.sources.envOverrides.length > 0) {
      options.write(`  environment     ${loaded.sources.envOverrides.join(', ')}`);
    }
    if (loaded.sources.ignoredEnv.length > 0) {
      // Not a failure — a harness's own knob is ordinary — but worth showing, because a
      // *misspelt section* looks exactly like one and is otherwise silent. What the product sets
      // itself never reaches here (`PRODUCT_ENV`, `H-32`).
      options.write(`  ignored MS_*    ${loaded.sources.ignoredEnv.join(', ')}`);
    }
    for (const note of findings.notes ?? []) {
      options.write(`${CONFIG_NOTE_PREFIX}${note}`);
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
