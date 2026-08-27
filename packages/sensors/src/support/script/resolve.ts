import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Turning a sensor parameter into a program this probe is willing to run (`T-19`).
 *
 * **This is the security boundary of the whole ticket, and it is one function on purpose.**
 * Everything else about an EXE/Script sensor is ordinary: spawn a program, read its output, parse
 * it. What makes it different from every other sensor type is that the thing being run is named
 * by somebody typing into a form — so "which programs may a sensor name" has to have exactly one
 * answer, in one place, that no new parameter can route around.
 *
 * **The answer is: a file inside a directory the operator configured on the probe, and nothing
 * else.** Not an absolute path, not a relative one, not `..` — a name. This is PRTG's model
 * (`Custom Sensors\EXE`) and it is the right one: an installation deploys the scripts it trusts
 * into a directory, and *creating a sensor* then cannot become *running an arbitrary command*.
 * Without it, anyone who may add a sensor may run `/bin/sh` as the probe's account, which is
 * every credential this system holds.
 *
 * **`realpath` before the check, not after.** A symbolic link inside the directory pointing at
 * `/bin/sh` is the obvious way around a prefix comparison done on the name; resolving first and
 * comparing the *resolved* path is what closes it. The same call is what makes a directory that
 * is itself a symlink work correctly rather than being refused.
 */

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

/**
 * The characters a program name may contain.
 *
 * Deliberately not "anything the filesystem allows". A name with a space, a quote or a semicolon
 * in it is never *needed* — nothing spawns through a shell here, so those characters buy an
 * operator nothing and cost a reviewer the confidence that they buy an attacker nothing either.
 * Forward slashes are allowed so scripts can be filed in subdirectories, and `..` is refused
 * outright before any path work happens.
 */
const NAME = /^[A-Za-z0-9._\-/]+$/;

export const SCRIPT_DIR_ENV = 'MS_SCRIPT_DIR';

/**
 * Where this probe keeps the programs it will run.
 *
 * From the environment, which is how a probe-level policy setting reaches a check running in a
 * child process of its own (`P-03`). Never from `params`: a directory an operator could set per
 * sensor would make the directory decorative.
 */
export function scriptDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[SCRIPT_DIR_ENV];
  if (configured === undefined || configured.trim() === '') {
    throw new ScriptError(
      'this probe has no script directory configured, so it will not run a program — set ' +
        '`probe.scriptDir` on the probe and put the script in it. A sensor cannot name a path ' +
        'of its own, because then creating a sensor would be the same thing as running any ' +
        'command as this probe',
    );
  }
  return configured.trim();
}

export interface ResolvedProgram {
  /** The real, absolute path to spawn. */
  readonly file: string;
  /** The directory it was found in, which is the default working directory. */
  readonly directory: string;
}

/** Resolves a program name against the probe's script directory, or says why it will not. */
export async function resolveProgram(
  name: string,
  directory: string = scriptDirectory(),
): Promise<ResolvedProgram> {
  const trimmed = name.trim();
  if (trimmed === '') throw new ScriptError('this sensor names no program to run');
  if (isAbsolute(trimmed)) {
    throw new ScriptError(
      `"${trimmed}" is an absolute path, and a sensor may only name a program inside this ` +
        'probe’s script directory',
    );
  }
  if (!NAME.test(trimmed)) {
    throw new ScriptError(
      `"${trimmed}" is not a program name — letters, digits, dot, dash, underscore and a ` +
        'forward slash for a subdirectory. Nothing here is run through a shell, so a name ' +
        'needing anything else is a name pointing somewhere it should not',
    );
  }
  if (trimmed.split('/').includes('..')) {
    throw new ScriptError(`"${trimmed}" climbs out of the script directory`);
  }

  const root = await realpath(directory).catch(() => {
    throw new ScriptError(
      `this probe’s script directory ${directory} does not exist — create it, or correct ` +
        '`probe.scriptDir`',
    );
  });

  const candidate = join(root, trimmed);
  const real = await realpath(candidate).catch(() => {
    throw new ScriptError(`there is no program called "${trimmed}" in ${root}`);
  });

  // Resolved first, compared second: a symlink inside the directory pointing at `/bin/sh` is the
  // obvious way around a comparison made on the name.
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new ScriptError(
      `"${trimmed}" resolves to ${real}, which is outside this probe’s script directory — a ` +
        'symbolic link out of it is not a way to widen what a sensor may run',
    );
  }

  const info = await stat(real);
  if (!info.isFile()) throw new ScriptError(`"${trimmed}" is not a file`);

  if (process.platform !== 'win32') {
    await access(real, constants.X_OK).catch(() => {
      throw new ScriptError(
        `"${trimmed}" is not executable — chmod +x it, or run it through its interpreter by ` +
          'making the interpreter the program and the script an argument',
      );
    });
  }

  return { file: real, directory: resolve(real, '..') };
}
