import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describeError, type Logger } from '@ms/shared';

/**
 * What this probe is, across restarts (`R-01`).
 *
 * **The identity is state, not configuration, and keeping the two apart is the point.** The
 * config file is what an operator wrote; this file is what the core told the probe it is. Before
 * this existed the assigned GID lived only in memory, so every restart enrolled again under a
 * fresh identity — an approval queue that grew a row per restart, and a probe that could never
 * be approved for longer than it stayed up.
 *
 * **It also means copying a config file does not clone an identity.** An operator standing up a
 * second probe copies `probe.json`; they do not copy this. The second machine enrols as itself
 * and waits for its own approval, where a GID carried in the config file would have had two
 * machines claiming one branch and scanning the same sensors twice.
 *
 * Beside the spool because that is the probe's own writable directory. Clearing it costs a
 * re-enrolment and a second approval — safe, visible, and the failure an operator would guess.
 */

export interface ProbeIdentity {
  gid: string;
  /**
   * The key issued to this probe alone, once it has been approved.
   *
   * Empty until then: an unapproved probe presents the shared enrolment key from its config,
   * because it has nothing else to present.
   */
  accessKey: string;
}

export const EMPTY_IDENTITY: ProbeIdentity = { gid: '', accessKey: '' };

export function identityPath(spoolDir: string): string {
  return join(spoolDir, 'identity.json');
}

/**
 * Reads the stored identity, or an empty one.
 *
 * **Every failure reads as "no identity yet"**, including a corrupt file. Enrolling again costs
 * one approval; refusing to start costs a probe that is down until somebody logs in, and a probe
 * that will not start because of a file it wrote itself is the worse of those two.
 */
export async function readIdentity(path: string, logger: Logger): Promise<ProbeIdentity> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { ...EMPTY_IDENTITY };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    const record = parsed as Record<string, unknown>;
    return {
      gid: typeof record['gid'] === 'string' ? record['gid'] : '',
      accessKey: typeof record['accessKey'] === 'string' ? record['accessKey'] : '',
    };
  } catch (error) {
    logger.warn(
      { path, err: describeError(error) },
      'the stored probe identity could not be read; enrolling again',
    );
    return { ...EMPTY_IDENTITY };
  }
}

/**
 * Writes the identity, owner-readable only.
 *
 * `0o600` because the file holds a key that lets this machine be this probe. Written to a
 * temporary name and renamed, so a crash mid-write leaves the previous identity rather than half
 * of the new one — the same rule the spool follows for its segments.
 */
export async function writeIdentity(
  path: string,
  identity: ProbeIdentity,
  logger: Logger,
): Promise<void> {
  const temporary = `${path}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const { rename } = await import('node:fs/promises');
    await rename(temporary, path);
  } catch (error) {
    // Not fatal: the probe works for as long as it stays up, and re-enrols if it restarts.
    // Losing the link over a read-only directory would be a worse trade than losing the
    // identity, and this line is what tells an operator which one happened.
    //
    // **That "re-enrols if it restarts" depends on the core, and for a while it was not true**
    // (`P-37`). The core used to close its enrolment fallback the moment it *wrote down* a key's
    // hash, so a probe that reached this branch restarted, presented the enrolment key it still
    // had, and was refused for ever — the trade described above silently stopped being the trade
    // being made. The fallback now closes when the probe first *uses* a key, which is what makes
    // carrying on here safe. If that ever changes, this catch has to change with it.
    logger.error(
      { path, err: describeError(error) },
      'the probe identity could not be stored; a restart will enrol again',
    );
  }
}

/**
 * What a probe should do when the core refuses the key it is holding (`P-38`).
 *
 * **A decision, separated from the doing, because the doing needs a live core and the decision
 * needs none.** Four outcomes and each is a different situation an operator would want named
 * differently; getting them confused is how a probe ends up looping in silence.
 */
export type StaleKeyAction =
  /** Drop the stored key and present the configured enrolment key on the next handshake. */
  | 'retry-with-enrolment'
  /** Already presenting the configured key, so the refusal is not about which key is held. */
  | 'nothing-to-retry'
  /** A stored key the core rejects and no enrolment key to fall back on: a human is needed. */
  | 'no-enrolment-key'
  /** The fallback was already used against this refusal; do not hammer the door. */
  | 'already-tried';

export function staleKeyAction(options: {
  /** The key this probe currently presents, or `''` when it has none of its own. */
  readonly stored: string;
  /** `core.accessKey` from the configuration file, or `''` when none is set. */
  readonly configured: string;
  /** Whether the fallback has already been taken since the last successful handshake. */
  readonly alreadyTried: boolean;
}): StaleKeyAction {
  if (options.alreadyTried) return 'already-tried';

  // Nothing to abandon: this probe is already presenting the configured key, so a refusal means
  // the core has revoked it or the configured key is simply wrong. Retrying the same key would
  // change nothing, and reporting it as a stale-key problem would send somebody looking in the
  // wrong place.
  if (options.stored === '' || options.stored === options.configured) return 'nothing-to-retry';

  if (options.configured === '') return 'no-enrolment-key';

  return 'retry-with-enrolment';
}
