import type { CheckContext, JsonSchema } from '../contract.js';
import { abortReason, endedHow } from '../support/program-ended.js';
import { SCRIPT_GRACE_MS } from '../support/script/grace.js';
import { scrubberOf } from '../support/secrets.js';
import { ScriptError } from '../support/script/resolve.js';

/**
 * What the two EXE/Script types share (`T-19`).
 *
 * The program, its arguments, its environment and how long it may run are the same questions for
 * both; only what is done with the output differs. Keeping the *running* in one place is what
 * makes "which programs may a sensor name" one answer rather than two.
 */

/** Enough output for any sensible script, and bounded so a chatty one cannot fill memory. */
const MAX_OUTPUT_BYTES = 512 * 1024;

export { SCRIPT_GRACE_MS };

/**
 * The only variables a sensor may set (`S-19`): its own namespace, and nothing an interpreter,
 * a loader or a library reads.
 *
 * **An allow-list, because a deny-list cannot be finished.** `BASH_ENV` and `PS4` run a command
 * in any bash script, and `NODE_OPTIONS=--import=data:…` does it in any node script — all three
 * measured on this project's own toolchain, as the unprivileged account the probe runs as. Past
 * those, `LD_PRELOAD`, `PERL5OPT`, `PYTHONPATH`, `OPENSSL_CONF`, `GIT_SSH_COMMAND`, a proxy
 * beside `SSLKEYLOGFILE` — every tool a script might call reads variables of its own, and a list
 * of the dangerous ones is a list of the ones somebody has thought of so far. Nothing reads
 * `MS_VAR_` but a script written to.
 */
export const SENSOR_VARIABLE = /^MS_VAR_[A-Z0-9_]+$/;

/**
 * Where the script's secret goes (`A-40`): wherever the program, told what its arguments,
 * environment and working directory tell it, sends it.
 *
 * All four, not the program alone. A script that takes its target as an argument —
 * `check_rest.sh https://…` with `MS_SECRET` as the bearer token — is the common case, not the
 * rare one, and binding only the program would let anyone with `write` on the sensor point that
 * argument at a listener of their own and keep the secret. Re-entering it when a threshold
 * argument changes is the price.
 */
export const SCRIPT_SECRET_DESTINATIONS: Readonly<Record<string, readonly string[]>> = {
  secret: ['program', 'args', 'env', 'workingDirectory'],
};

export const SCRIPT_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  program: {
    type: 'string',
    minLength: 1,
    maxLength: 255,
    title: 'Program',
    description:
      'The file to run, **inside this probe’s script directory** — a name, not a path. That ' +
      'directory is set on the probe and cannot be overridden here, because a sensor that could ' +
      'name any path would make creating a sensor the same thing as running any command as the ' +
      'account this probe holds its credentials in.',
  },
  args: {
    type: 'array',
    maxItems: 20,
    default: [],
    title: 'Arguments',
    description:
      'Passed one per entry, never joined into a command line and never through a shell — so a ' +
      'space or a quote in an argument is just a character. `%host`, `%sensorid` and `%device` ' +
      'are substituted.',
    // The singular, for `U-12`'s repeating control.
    items: { title: 'Argument', type: 'string', maxLength: 1_000 },
  },
  env: {
    type: 'array',
    maxItems: 20,
    default: [],
    title: 'Environment',
    description:
      '**Each name starts with `MS_VAR_`**, then capitals, digits and underscores — a variable ' +
      'like `BASH_ENV` or `NODE_OPTIONS` tells the interpreter to run code the sensor’s writer ' +
      'chose, so no other name reaches a script. The program gets **only** these, ' +
      'plus `PATH`, `LANG`, `LC_*` and `TZ` as this probe has them and the placeholders below. ' +
      'It does not inherit the rest of this probe’s environment, which holds whatever arrived ' +
      'through MS_* overrides — handing that to a script is how a credential leaves the machine.',
    items: {
      // The singular, for `U-12`'s repeating control: the fieldset is named for the
      // parameter and an entry inside it wants this.
      title: 'Variable',
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          minLength: 8,
          maxLength: 100,
          pattern: SENSOR_VARIABLE.source,
          'x-patternMessage': 'must start with MS_VAR_, then capitals, digits and underscores only',
          title: 'Name',
          description:
            'Starts with `MS_VAR_`, then capitals, digits and underscores. Only these reach a ' +
            'script: a variable like `BASH_ENV` or `NODE_OPTIONS` tells the interpreter to run ' +
            'code the sensor’s writer chose.',
        },
        value: { type: 'string', maxLength: 2_000, default: '', title: 'Value' },
      },
    },
  },
  secret: {
    type: 'string',
    maxLength: 2_000,
    writeOnly: true,
    // No default: an empty one would be stored for every script sensor and read back as "set",
    // so a secret left behind by an edit (`A-40`) would look as if it were still there.
    title: 'Secret',
    description:
      'Passed to the program as `MS_SECRET` in its environment, for a script that needs an API ' +
      'key. Write-only: no API route returns it, to anyone. In the environment rather than an ' +
      'argument, because arguments are world-readable through `ps`. Changing the program, its ' +
      'arguments, its environment or its working directory clears the secret unless you enter ' +
      'it again: those decide where the script sends it.',
  },
  workingDirectory: {
    type: 'string',
    maxLength: 500,
    default: '',
    title: 'Working directory',
    description:
      'A directory **inside this probe’s script directory**, named the way the program is. ' +
      'Empty runs the program in the directory it was found in, which is usually right.',
  },
  timeoutMs: {
    type: 'integer',
    minimum: 1_000,
    maximum: 300_000,
    default: 30_000,
    title: 'Timeout',
    description:
      'On Linux the program is sent SIGTERM at this point and SIGKILL one second later — and ' +
      'the whole process *group* is, so a script that backgrounds something does not outlive ' +
      'its own kill. The sensor’s scan timeout ends it the same way, if that comes first; the ' +
      'message says which of the two it ran into. On Windows the program itself is ended at ' +
      'once, and what it started is not.',
  },
};

export interface ScriptRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

/**
 * Runs the program a sensor names, and returns what it printed.
 *
 * Failures of the *program* — a non-zero exit, a signal, a timeout — are thrown here, because
 * they are the same failure whatever format the output was going to be in. What the output
 * *means* is the caller's.
 */
export async function runScript(context: CheckContext): Promise<ScriptRun> {
  const { resolveProgram, resolveWorkingDirectory } = await import('../support/script/resolve.js');
  const { runProgram } = await import('@ms/shared');

  const program = typeof context.params['program'] === 'string' ? context.params['program'] : '';
  // What the program printed is its words, and a secret it was handed may be in them: scrubbed
  // before `tail` cuts it, so no half of one survives the cut (`S-21`).
  const scrub = scrubberOf(context);
  // The environment first: a refused variable is a sensor to correct, and says so before
  // anything on disk is looked at.
  const env = readEnv(context);
  const resolved = await resolveProgram(program);

  const timeoutMs = Number(context.params['timeoutMs'] ?? 30_000);
  const cwd = await resolveWorkingDirectory(
    typeof context.params['workingDirectory'] === 'string'
      ? context.params['workingDirectory']
      : '',
    resolved,
  );

  // Ended before it began: nothing to start, and a program started only to be stopped would say
  // nothing of its own.
  if (context.signal.aborted) {
    throw new ScriptError(`${program} was not started: ${abortReason(context.signal)}`);
  }

  // **Two limits, and whichever comes first ends it** (`P-262`): this sensor's own `timeoutMs`,
  // and the check's, which arrives as `ctx.signal`. Without the signal a script ran to its own
  // limit past the check's, and only the probe's kill of the whole check process stopped it —
  // with the probe's words and none of the script's.
  const run = await runProgram({
    file: resolved.file,
    args: readArgs(context),
    cwd,
    env,
    timeoutMs,
    signal: context.signal,
    graceMs: SCRIPT_GRACE_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });

  if (run.outcome === 'failed') {
    throw new ScriptError(`${program} could not be started: ${run.message} (${run.code})`);
  }
  if (run.outcome === 'timeout') {
    // What it printed before it was stopped is where it got to: stderr first, as for an exit.
    const said = tail(scrub(run.stderr)) || tail(scrub(run.stdout));
    const how = endedHow(run.hardKilled, SCRIPT_GRACE_MS);
    throw new ScriptError(
      run.endedBy === 'deadline'
        ? `${program} was still running after ${String(timeoutMs)} ms, its own timeout, and ` +
            `was ${how}${said}`
        : `${program} was still running after ${String(run.endedAfterMs)} ms when the check was ` +
            `ended (${abortReason(context.signal)}), and was ${how}${said}`,
    );
  }
  if (run.outcome === 'signalled') {
    throw new ScriptError(`${program} was killed by ${run.signal}${tail(scrub(run.stderr))}`);
  }
  if (run.code !== 0) {
    // The exit code is the program's own answer and the message is where it said why. Both,
    // because "exit 1" alone is not a diagnosis (CLAUDE.md).
    throw new ScriptError(
      `${program} exited with code ${String(run.code)}${tail(scrub(run.stderr)) || tail(scrub(run.stdout))}`,
    );
  }
  if (run.truncated) {
    throw new ScriptError(
      `${program} printed more than ${String(MAX_OUTPUT_BYTES)} bytes — a reading parsed out of ` +
        'a truncated stream is worse than no reading',
    );
  }

  return {
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: run.code,
    durationMs: run.durationMs,
  };
}

/** `%host`, `%sensorid` and `%device`, substituted into arguments. Never a credential. */
function readArgs(context: CheckContext): string[] {
  const raw = context.params['args'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((one): one is string => typeof one === 'string')
    .map((one) =>
      one
        .replace(/%host\b/gi, context.target.host)
        .replace(/%sensorid\b/gi, String(context.sensorId))
        .replace(/%device\b/gi, context.target.host),
    );
}

/**
 * The program's whole environment (`S-19`).
 *
 * **Built from a stated base, never inherited.** From this probe's own environment, only what a
 * script needs to behave as it would at a terminal on this machine: `PATH` to find `awk`, and the
 * locale and time zone, so `date` and `sort` agree with the operator who wrote the script. The
 * rest of it — `NOTIFY_SOCKET`, which would let a script speak to systemd as the probe, the
 * `MS_*` overrides, whatever the unit file sets — stays with the probe. Then the sensor's own
 * `MS_VAR_*`, and last the system's: `MS_HOST` and `MS_SENSOR_ID`, which a program can read
 * without parsing arguments, and `MS_SECRET`, in the environment rather than an argument because
 * arguments are world-readable through `ps`.
 *
 * **A variable outside the namespace fails the check, naming it**, rather than being dropped. A
 * sensor saved before `S-19` may carry one, and a script that silently stopped seeing its setting
 * would be wrong in a way nobody could see; one that goes Down saying which variable to rename is
 * a two-minute fix. The API refuses the name on the next write, so this is the path for the ones
 * already stored.
 */
function readEnv(context: CheckContext): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    ...inheritedLocale(),
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
          TEMP: process.env['TEMP'] ?? 'C:\\Windows\\Temp',
        }
      : {}),
  };

  const raw = context.params['env'];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
      if (name === '') continue;
      if (!SENSOR_VARIABLE.test(name)) {
        throw new ScriptError(
          `this sensor sets the variable "${name}", and a sensor may set only MS_VAR_ names — ` +
            'a variable like BASH_ENV or NODE_OPTIONS tells the interpreter to run code the ' +
            `sensor’s writer chose. Rename it (${suggestedName(name)}, say) here and in the script`,
        );
      }
      env[name] = typeof record['value'] === 'string' ? record['value'] : '';
    }
  }

  // After the sensor's own, so none of it can be overridden — the namespace already keeps them
  // apart, and this keeps them apart if the namespace ever widens.
  env['MS_HOST'] = context.target.host;
  env['MS_SENSOR_ID'] = String(context.sensorId);
  const secret = context.params['secret'];
  if (typeof secret === 'string' && secret !== '') env['MS_SECRET'] = secret;
  return env;
}

/** What a refused name could be called instead: `api_url` and `MS_VAR_api` both suggest capitals. */
function suggestedName(name: string): string {
  const stem = name
    .toUpperCase()
    .replace(/^MS_VAR_/, '')
    .replace(/[^A-Z0-9_]/g, '_');
  return `MS_VAR_${stem === '' ? 'NAME' : stem}`;
}

/** `LANG`, every `LC_*` and `TZ`, as this probe has them; absent ones stay absent. */
function inheritedLocale(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === 'LANG' || name === 'TZ' || name.startsWith('LC_')) out[name] = value;
  }
  return out;
}

/** The last of a stream, for a diagnosis. Bounded: this ends up in a sensor's message. */
function tail(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const last = trimmed.split('\n').slice(-3).join(' ');
  return `: ${last.length > 300 ? `${last.slice(0, 300)}…` : last}`;
}
