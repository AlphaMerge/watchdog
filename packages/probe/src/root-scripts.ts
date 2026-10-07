import type { ProbeConfig } from '@ms/shared';

/**
 * A probe that runs as root, and whose scripts would too (`P-276`).
 *
 * **`processUid` is the only thing between a script and the probe's account.** Without it a check
 * process, and every script it starts, runs as the user the probe runs as. For the packaged unit
 * that is `ms-probe`, which holds the probe's certificate and nothing else. For a probe somebody
 * starts as root — by hand, or under a drop-in that sets `User=root` — it is root, so whoever can
 * put a file in `scriptDir` has the machine. And the checks `P-266` makes before it ends what a
 * dead check process left running ask whether a process group belongs to the user checks run as:
 * as root, that is every root process on the host, and the check protects nothing.
 *
 * **Refused only where it is that.** The only sensor types that run in a process of their own
 * are the EXE/Script family, and they run nothing without a script directory, so a root probe
 * with none is said in a warning and starts: `processUid` would change nothing there. With a
 * script directory it refuses, unless `allowScriptsAsRoot` says it was meant, and then it starts
 * and says so at every start.
 *
 * **Asked of the effective user, and not on Windows**, where `process.geteuid` does not exist,
 * `processUid` is ignored, and the probe runs as the account WinSW gives it (release 1.1).
 */

export type RootScripts =
  /** Not root, not POSIX, or root with checks run as another user and group: nothing to say. */
  | { readonly kind: 'fine' }
  /** Root, and no script directory: said, and the probe starts. */
  | { readonly kind: 'no-scripts'; readonly message: string }
  /** Root with scripts, told to run them as root anyway: said at every start. */
  | { readonly kind: 'allowed'; readonly message: string }
  /** Root with scripts, and nobody said so: the probe does not start. */
  | { readonly kind: 'refused'; readonly message: string };

type Settings = Pick<
  ProbeConfig['probe'],
  'processUid' | 'processGid' | 'scriptDir' | 'allowScriptsAsRoot'
>;

const HOW =
  'set probe.processUid and probe.processGid to an unprivileged account, or run the probe as ' +
  'one, as the packaged ms-probe.service does';

/**
 * What a probe with these settings, running as effective user `euid`, says or does at start.
 *
 * **A `processUid` without a `processGid` is root's group** (`P-276` review). The runner passes a
 * gid only when it is above 0, so a root probe's scripts would run as that user and keep group 0:
 * every file root's group may write — a `root:root 0660` socket, say — is open to whoever writes
 * the script directory. So that is refused the same way, naming the gid, and the opt-out covers
 * it too. Nothing shipped sets one without the other, so no installation meets it unchosen.
 */
export function rootScripts(probe: Settings, euid: number | undefined): RootScripts {
  if (euid !== 0) return { kind: 'fine' };
  const user = probe.processUid > 0;
  if (user && probe.processGid > 0) return { kind: 'fine' };
  if (probe.scriptDir === '') {
    // Nothing runs in a process of its own without a script directory, so with a uid set there
    // nothing of this probe's settings runs as root or in its group.
    if (user) return { kind: 'fine' };
    return {
      kind: 'no-scripts',
      message:
        'this probe runs as root. It runs no scripts (probe.scriptDir is empty), so nothing ' +
        `else runs as root because of it; before giving it a script directory, ${HOW}`,
    };
  }
  if (probe.allowScriptsAsRoot) {
    return {
      kind: 'allowed',
      message: user
        ? `probe.allowScriptsAsRoot: is true, so every script in ${probe.scriptDir} runs as uid ` +
          `${String(probe.processUid)} in root's group (gid 0): whoever can write there can ` +
          `write whatever root's group can. To stop it, ${HOW}`
        : `probe.allowScriptsAsRoot: is true, so every script in ${probe.scriptDir} runs as ` +
          'root: whoever can write there has this machine, and the probe cannot tell what a ' +
          `dead check left running from any other root process. To stop it, ${HOW}`,
    };
  }
  return { kind: 'refused', message: refusal(probe, user) };
}

function refusal(probe: Settings, user: boolean): string {
  const where = `(probe.scriptDir: ${probe.scriptDir})`;
  return user
    ? `probe.processGid: is not set, so this probe, which runs as root with a script directory ` +
        `${where}, would run every script in it as uid ${String(probe.processUid)} in root's ` +
        `group (gid 0). Either ${HOW}; or set probe.allowScriptsAsRoot: true to run them in ` +
        "root's group anyway"
    : 'probe.processUid: is not set, and this probe runs as root with a script directory ' +
        `${where}, so every script in it would run as root. Either ${HOW}; or set ` +
        'probe.allowScriptsAsRoot: true to run them as root anyway';
}

/**
 * What `config check` says of it (`P-276`), a note and never a problem or a warning.
 *
 * The check cannot know which account the service will run as — the installer runs it as root for
 * a unit that runs the probe as `ms-probe` — so it says what would happen if it were root, and
 * only where that is a refusal. Not on Windows, where there is no root to start as.
 */
export function rootScriptsNote(
  probe: Settings,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') return undefined;
  const asRoot = rootScripts(probe, 0);
  if (asRoot.kind !== 'refused') return undefined;
  return (
    'started as root, this probe would refuse to start: ' +
    `${asRoot.message}. The packaged ms-probe.service runs it as ms-probe, which this does not ` +
    'apply to'
  );
}
