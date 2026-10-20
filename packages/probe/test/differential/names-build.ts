import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The build the differential's boxes load (`P-432` S8, `P-460`): every `.js` under the builds
 * `scripts/lib/names-diff.sh` lists (`MS_NAMES_DIFF_BUILT`'s second column), which the worktree
 * mounts read-only into each box. The policy's build alone (`policyDigest`) is the narrow key the
 * committed recordings hold; this is the whole of what a run judges: the walk (`dns-check.js`,
 * `forward-budget.js`), the regressions (`name-resolver.js`, `name-resolution.js`,
 * `lookup-helper.js`), the replay and its processes, the simulator and the system lookup.
 *
 * - `buildDigest` names that build by its bytes: each image's run and each box's carries it, and
 *   the verdict holds every one to the build as it is when the verdict runs.
 * - `BuildWatch` sees a rebuild while a run goes on, even one whose bytes come back as they were
 *   (a mutant built and then restored and built again): every rebuild writes the files anew, so
 *   their size, mtime or ctime moves. The replay forks a process per row and spawns one per plan,
 *   each loading the build afresh, so it looks before each row and at its end.
 */

/** Each build the boxes load, from the repo's root: `MS_NAMES_DIFF_BUILT`'s second column. */
export const BUILT_TREES = [
  'packages/probe/dist/src',
  'packages/probe/dist/test/differential',
  'packages/probe/dist/test/support',
  'packages/simulators/dist/src',
  'packages/sensors/dist/src',
  'packages/shared/dist/src',
] as const;

/** The repo's root as the boxes mount it (`/ms`), from this file's build in `dist`. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Every `.js` under the trees, from the root, sorted; a tree that is not there is named so. */
function builtFiles(root: string, trees: readonly string[]): string[] {
  const out: string[] = [];
  for (const tree of trees) {
    const dir = join(root, tree);
    if (!existsSync(dir)) {
      out.push(`${tree}/ (missing)`);
      continue;
    }
    for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (entry.endsWith('.js')) out.push(`${tree}/${entry}`);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const sha256 = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');

/** The sha256 of every file's path and bytes, in order. */
export function buildDigest(
  root: string = REPO_ROOT,
  trees: readonly string[] = BUILT_TREES,
): string {
  const lines = builtFiles(root, trees).map((path) =>
    path.endsWith(' (missing)') ? path : `${path}\0${sha256(readFileSync(join(root, path)))}`,
  );
  return sha256(lines.join('\n'));
}

/** Every file's path, size, mtime and ctime: what a rebuild moves, its bytes the same or not. */
function buildStamp(root: string, trees: readonly string[]): string {
  return builtFiles(root, trees)
    .map((path) => {
      if (path.endsWith(' (missing)')) return path;
      try {
        const stat = statSync(join(root, path), { bigint: true });
        return `${path} ${String(stat.size)} ${String(stat.mtimeNs)} ${String(stat.ctimeNs)}`;
      } catch {
        return `${path} (gone)`;
      }
    })
    .join('\n');
}

/** The build as a run began, and whether it changed since: looked at as often as the run says. */
export class BuildWatch {
  readonly digest: string;
  readonly #root: string;
  readonly #trees: readonly string[];
  readonly #stamp: string;
  #rebuilt: string | undefined;

  constructor(root: string = REPO_ROOT, trees: readonly string[] = BUILT_TREES) {
    this.#root = root;
    this.#trees = trees;
    this.#stamp = buildStamp(root, trees);
    this.digest = buildDigest(root, trees);
    // Written between the stamp and the digest: the digest may be of either build.
    if (buildStamp(root, trees) !== this.#stamp) this.#rebuilt = 'as the run began';
  }

  /** Looks again, `where` saying when; the first change seen is kept. */
  look(where: string): void {
    if (this.#rebuilt !== undefined) return;
    if (buildStamp(this.#root, this.#trees) !== this.#stamp) this.#rebuilt = where;
  }

  /** Where the build was first seen changed, or undefined. */
  rebuilt(): string | undefined {
    return this.#rebuilt;
  }

  /** The run's fields: `buildDigest`, and `rebuilt` when it changed. */
  fields(): { buildDigest: string; rebuilt?: string } {
    return {
      buildDigest: this.digest,
      ...(this.#rebuilt === undefined ? {} : { rebuilt: this.#rebuilt }),
    };
  }
}
