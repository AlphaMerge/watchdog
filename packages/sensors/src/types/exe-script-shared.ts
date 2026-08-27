import type { CheckContext, JsonSchema } from '../contract.js';
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
    items: { type: 'string', maxLength: 1_000 },
  },
  env: {
    type: 'array',
    maxItems: 20,
    default: [],
    title: 'Environment',
    description:
      'The program gets **only** these, plus PATH and the placeholders below. It does not ' +
      'inherit this probe’s environment, which holds whatever arrived through MS_* overrides — ' +
      'handing that to a script is how a credential leaves the machine.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
          title: 'Name',
        },
        value: { type: 'string', maxLength: 2_000, default: '', title: 'Value' },
      },
    },
  },
  secret: {
    type: 'string',
    maxLength: 2_000,
    writeOnly: true,
    default: '',
    title: 'Secret',
    description:
      'Passed to the program as `MS_SECRET` in its environment, for a script that needs an API ' +
      'key. Write-only: no API route returns it, to anyone. In the environment rather than an ' +
      'argument, because arguments are world-readable through `ps`.',
  },
  workingDirectory: {
    type: 'string',
    maxLength: 500,
    default: '',
    title: 'Working directory',
    description: 'Empty runs the program in the directory it was found in, which is usually right.',
  },
  timeoutMs: {
    type: 'integer',
    minimum: 1_000,
    maximum: 300_000,
    default: 30_000,
    title: 'Timeout',
    description:
      'The program is sent SIGTERM at this point and killed shortly after — and the whole ' +
      'process *group* is, so a script that backgrounds something does not outlive its own kill.',
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
  const { resolveProgram } = await import('../support/script/resolve.js');
  const { runProgram } = await import('@ms/shared');

  const program = typeof context.params['program'] === 'string' ? context.params['program'] : '';
  const resolved = await resolveProgram(program);

  const timeoutMs = Number(context.params['timeoutMs'] ?? 30_000);
  const declaredCwd =
    typeof context.params['workingDirectory'] === 'string'
      ? context.params['workingDirectory'].trim()
      : '';

  const run = await runProgram({
    file: resolved.file,
    args: readArgs(context),
    cwd: declaredCwd === '' ? resolved.directory : declaredCwd,
    env: readEnv(context),
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });

  if (run.outcome === 'failed') {
    throw new ScriptError(`${program} could not be started: ${run.message} (${run.code})`);
  }
  if (run.outcome === 'timeout') {
    throw new ScriptError(
      `${program} was still running after ${String(timeoutMs)} ms and was ` +
        `${run.hardKilled ? 'killed' : 'stopped'}${tail(run.stderr)}`,
    );
  }
  if (run.outcome === 'signalled') {
    throw new ScriptError(`${program} was killed by ${run.signal}${tail(run.stderr)}`);
  }
  if (run.code !== 0) {
    // The exit code is the program's own answer and the message is where it said why. Both,
    // because "exit 1" alone is not a diagnosis (CLAUDE.md).
    throw new ScriptError(
      `${program} exited with code ${String(run.code)}${tail(run.stderr) || tail(run.stdout)}`,
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
 * The program's whole environment.
 *
 * Built, never inherited. `PATH` is what a script needs to find `awk`; `MS_HOST` and `MS_SENSOR_ID`
 * are the placeholders in a form a program can read without argument parsing; `MS_SECRET` is the
 * one write-only parameter, and it is here rather than in an argument because arguments are
 * world-readable through `ps`.
 */
function readEnv(context: CheckContext): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    MS_HOST: context.target.host,
    MS_SENSOR_ID: String(context.sensorId),
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
      if (name === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      env[name] = typeof record['value'] === 'string' ? record['value'] : '';
    }
  }

  const secret = context.params['secret'];
  if (typeof secret === 'string' && secret !== '') env['MS_SECRET'] = secret;
  return env;
}

/** The last of a stream, for a diagnosis. Bounded: this ends up in a sensor's message. */
function tail(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const last = trimmed.split('\n').slice(-3).join(' ');
  return `: ${last.length > 300 ? `${last.slice(0, 300)}…` : last}`;
}
