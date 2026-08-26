import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { describeError, runProgram, type Logger, type ProgramConfig, type ProgramRun } from '@ms/shared';
import { PROGRAM_METHOD } from '../methods.js';
import { substitute, type Escaping, type MessageContext } from '../placeholders.js';
import type { DeliveryResult, DeliveryTransport, OutgoingMessage } from './transport.js';

export interface ProgramTransportOptions {
  config: ProgramConfig;
  logger: Logger;
}

/** What the program is told, beyond its arguments. */
const MAX_ARGS = 32;

/**
 * Execute-program delivery (`N-10`, `CAPABILITIES.MD §5.2`).
 *
 * The escape hatch: whatever an installation needs that no built-in method covers — an SMS
 * gateway with its own CLI, a ticket system, a klaxon on a Raspberry Pi — is a script.
 *
 * **Which makes it the most dangerous thing in the notification subsystem, and the design is
 * mostly about that.** A template is data an operator can edit through the API. If a template
 * could name any path, then permission to edit a notification would be permission to run
 * anything as the service account — a privilege escalation with a form in front of it. So the
 * program is named *relative to a configured directory*, the resolved real path has to still be
 * inside it, and the whole method is off until an operator sets that directory up.
 *
 * The rest is `runProgram` in `@ms/shared`: no shell, a hard timeout that takes down the process
 * group rather than one process, bounded output, and an environment that is built rather than
 * inherited.
 */
export class ProgramTransport implements DeliveryTransport {
  readonly method = PROGRAM_METHOD.id;
  readonly #config: ProgramConfig;
  readonly #logger: Logger;

  constructor(options: ProgramTransportOptions) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: 'program' });
  }

  /**
   * None: an argument is one argv entry and a body is one stream, and neither has a syntax a
   * value could break out of. That is the point of never using a shell — the escaping problem
   * `N-08` had to solve for a JSON document does not exist here.
   */
  bodyEscaping(): Escaping {
    return 'none';
  }

  async send(message: OutgoingMessage): Promise<DeliveryResult> {
    const settings = message.settings;
    const name = typeof settings['path'] === 'string' ? settings['path'] : '';

    const resolved = await this.#resolve(name);
    if (!resolved.ok) return { ok: false, retryable: false, error: resolved.reason };

    const args = [
      ...readArgs(settings['args']),
      // After the visible ones, which is what the schema promises.
      ...readArgs(settings['secretArgs']),
    ]
      .slice(0, MAX_ARGS)
      .map((argument) => substitute(argument, message.context, 'none').text);

    const run = await runProgram({
      file: resolved.file,
      args,
      // The programs directory, so a script can find whatever sits beside it without knowing
      // where it was installed.
      cwd: this.#config.directory,
      env: environmentFor(message),
      // The body on stdin, so a message longer than the platform's argv limit still arrives.
      stdin: message.body,
      timeoutMs: typeof settings['timeoutMs'] === 'number' ? settings['timeoutMs'] : 30_000,
      maxOutputBytes: this.#config.maxOutputBytes,
      graceMs: this.#config.killGraceMs,
      ...(this.#config.uid < 0 ? {} : { uid: this.#config.uid }),
      ...(this.#config.gid < 0 ? {} : { gid: this.#config.gid }),
    });

    this.#log(message.requestId, name, run);
    return classify(name, run);
  }

  /**
   * Turns a template's `path` into a file this is allowed to run, or says why not.
   *
   * Four refusals, and each closes a different way out of the directory: an absolute path ignores
   * it, `..` walks out of it, a symlink points out of it, and a real path that merely *starts*
   * with the directory's characters (`/opt/ms/programs-evil`) is not inside it. The last one is
   * why the comparison is against `directory + sep` rather than a prefix.
   */
  async #resolve(name: string): Promise<{ ok: true; file: string } | { ok: false; reason: string }> {
    if (this.#config.directory === '') {
      return {
        ok: false,
        reason:
          'no notification program directory is configured, so no program may run; ' +
          'set notifications.program.directory',
      };
    }
    if (name === '') return { ok: false, reason: 'no program was named' };
    if (isAbsolute(name)) {
      return { ok: false, reason: `"${name}" is an absolute path; name a file in the programs directory` };
    }

    let root: string;
    try {
      root = await realpath(resolve(this.#config.directory));
    } catch (error: unknown) {
      // Configured but missing is an installation problem, not a template problem, and it may be
      // a mount that has not come back yet.
      return {
        ok: false,
        reason: `the programs directory cannot be read: ${describeError(error).message}`,
      };
    }

    let file: string;
    try {
      file = await realpath(join(root, name));
    } catch (error: unknown) {
      return { ok: false, reason: `"${name}": ${describeError(error).message}` };
    }
    if (file !== root && !file.startsWith(root + sep)) {
      // A symlink is a path too, and this is the check that notices one pointing at /bin/sh.
      return { ok: false, reason: `"${name}" resolves outside the programs directory` };
    }
    return { ok: true, file };
  }

  /**
   * The program's output, in the journal.
   *
   * Both streams, whether it succeeded or not: a notification script's stdout is the only account
   * anybody gets of what it did, and the run that needs explaining is usually the one that
   * "worked". The program's *name* is logged and never its arguments — `secretArgs` is in there.
   */
  #log(requestId: number, name: string, run: ProgramRun): void {
    const details = {
      requestId,
      program: name,
      outcome: run.outcome,
      durationMs: run.durationMs,
      ...(run.stdout === '' ? {} : { stdout: run.stdout }),
      ...(run.stderr === '' ? {} : { stderr: run.stderr }),
      ...(run.truncated ? { truncated: true } : {}),
    };
    if (run.outcome === 'exited' && run.code === 0) {
      this.#logger.info(details, 'notification program finished');
      return;
    }
    this.#logger.warn(details, 'notification program did not succeed');
  }
}

/**
 * What the program runs with, built rather than inherited.
 *
 * **Inheriting would hand it every secret this process holds.** `MS_NOTIFICATIONS__SMTP__PRIMARY__PASSWORD`
 * and `MS_DATABASE__PASSWORD` are supported overrides (`N-07`), so a script dropped in the
 * programs directory would be able to read the relay password out of its own environment. The
 * allowlist below is what a program needs to *run*; everything else it gets is about the alarm.
 *
 * The facts are passed as well as being available through `%placeholders` in the arguments,
 * because a script that reads them from the environment needs no configuration at all — the
 * template names the program and nothing else.
 */
function environmentFor(message: OutgoingMessage): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const context = message.context;
  Object.assign(environment, {
    MS_REQUEST_ID: String(message.requestId),
    MS_SUBJECT: message.subject,
    MS_PRIORITY: String(message.priority),
    ...factEnvironment(context),
  });
  return environment;
}

function factEnvironment(context: MessageContext): Record<string, string> {
  return {
    MS_SENSOR_ID: String(context.sensorId),
    MS_SENSOR: context.sensorName,
    MS_DEVICE: context.deviceName,
    MS_GROUP: context.groupName,
    MS_PROBE: context.probeName,
    MS_HOST: context.host,
    MS_LOCATION: context.location,
    MS_TAGS: context.tags.join(', '),
    MS_SENSOR_PRIORITY: String(context.priority),
    MS_STATUS: context.state,
    MS_LAST_STATUS: context.previousState ?? '',
    MS_MESSAGE: context.message,
    // Empty, not "0" — no-data is not zero (`CLAUDE.md`), and a script doing arithmetic on it
    // must be able to tell "nothing was measured" from a measurement of nought.
    MS_LAST_VALUE: context.lastValue === null ? '' : String(context.lastValue),
    MS_DATETIME: context.at.toISOString(),
    MS_SINCE: context.since.toISOString(),
    MS_LINK: context.publicUrl === '' ? '' : `${context.publicUrl.replace(/\/+$/, '')}/objects/${String(context.sensorId)}`,
    MS_SITE: context.siteName,
  };
}

/**
 * The environment variables a program is given from this process's own.
 *
 * `PATH` because a script calling `curl` has to find it; the Windows four because almost nothing
 * runs there without them; `HOME`, `LANG` and `TZ` because a program that writes a timestamp or
 * a message should agree with the rest of the installation about what they mean.
 */
const PASSED_THROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'SystemRoot',
  'windir',
  'PATHEXT',
  'COMSPEC',
  'TEMP',
];

/**
 * What one run means for the delivery.
 *
 * **A non-zero exit is not retried.** The program is a side effect — it opens a ticket, it sends
 * an SMS, it pulls a lever — and running it five more times because it reported a problem is how
 * one alarm becomes five tickets. It said no; that is an answer. A timeout is different: the
 * program never got to say anything, so it is worth another go. So is a signal, which is
 * somebody else ending it rather than the program deciding anything.
 *
 * A timed-out program may still have done its work before it was killed, so a script that can be
 * run twice is a script that will behave. That is the same at-least-once bargain the dispatcher
 * makes everywhere else, and it is the right way round: a duplicate is an annoyance, a lost alarm
 * is the failure the subsystem exists to prevent.
 */
function classify(name: string, run: ProgramRun): DeliveryResult {
  const took = `${String(run.durationMs)} ms`;
  switch (run.outcome) {
    case 'exited':
      if (run.code === 0) return { ok: true, detail: `${name} exited 0 in ${took}` };
      return {
        ok: false,
        retryable: false,
        error: `${name} exited ${String(run.code)}${excerpt(run)}`,
      };
    case 'timeout':
      return {
        ok: false,
        retryable: true,
        error: `${name} did not finish within ${took} and was ${run.hardKilled ? 'killed' : 'stopped'}`,
      };
    case 'signalled':
      return { ok: false, retryable: true, error: `${name} was ended by ${run.signal}${excerpt(run)}` };
    case 'failed':
      return {
        ok: false,
        // Out of process slots, file handles or memory is this machine being busy. A program
        // that is missing or not executable stays missing however many times it is tried.
        retryable: TRANSIENT_SPAWN_ERRORS.has(run.code),
        error: `${name} could not be run: ${run.message}`,
      };
  }
}

const TRANSIENT_SPAWN_ERRORS = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);

/** The last thing the program said, which is usually why it failed. */
function excerpt(run: ProgramRun): string {
  const said = (run.stderr === '' ? run.stdout : run.stderr).trim();
  if (said === '') return '';
  const lines = said.split('\n');
  return ` — ${(lines[lines.length - 1] ?? '').slice(0, 200)}`;
}

function readArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
