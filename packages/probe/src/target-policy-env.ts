import { TARGET_POLICY_ENV, targetPolicyFrom } from '@ms/sensors';

/**
 * Hands `probe.targetPolicy` to everything that runs a check (`A-57`, `A-65`).
 *
 * **Two ways in, because there are two kinds of runner.** A worker thread inherits this
 * process's environment as it is when the worker starts, so the setting is written there, and
 * this must be called before a pool is. A check process is given an environment that is built
 * and never inherited, so the same setting comes back to be put in it (`childEnv`). The catalogue
 * in each reads it once and hands it to every check as `CheckTarget.policy`; discovery's
 * identification, in this process, reads the same variable (`A-63`).
 *
 * **What is written is always one of the three names.** The configuration's schema only lets
 * those through, and this does not rely on it: anything else is written as the default,
 * `link-local`, the way `targetPolicyFrom` reads it, so that no path from a value nobody
 * recognises ends at `none`.
 *
 * A function of its own so that it has a test: these were two lines in `main.ts`, and a line
 * there that stops handing the setting on fails nothing, while every sensor goes on working
 * under the default.
 */
export function handTargetPolicy(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const policy = targetPolicyFrom({ [TARGET_POLICY_ENV]: configured });
  env[TARGET_POLICY_ENV] = policy;
  return { [TARGET_POLICY_ENV]: policy };
}
