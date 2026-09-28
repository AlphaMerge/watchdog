import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Which build this is (`H-11`).
 *
 * **Every build ever made said `0.1.0`**, because the version came from `package.json` and
 * nothing else did — so two builds a month apart were the same build to an operator, to a bug
 * report, and to the field-test runbook, whose first instruction is "say which build you are
 * testing". The commit is what tells them apart; the version is what a person reads.
 */
export interface BuildIdentity {
  /** `package.json`'s version when the build was packaged; `0.0.0-dev` from a working tree. */
  readonly version: string;
  /**
   * The full commit the build was packaged from, or null when nobody could say — a working tree,
   * a package made before `H-11`, or a packaging run that could not see the repository.
   */
  readonly commit: string | null;
  /**
   * Packaged from a tree with changes nobody committed, so `commit` names the nearest code and
   * not this code. A build like that is identified by nothing, which is the point of saying so.
   */
  readonly dirty: boolean;
}

/** The file `scripts/package.sh` writes into each packaged service, beside its `dist`. */
export const BUILD_MANIFEST = 'build.json';

/** What a build knows about itself when it was never packaged. */
export const DEVELOPMENT_VERSION = '0.0.0-dev';

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Parse a manifest, refusing anything that is not one.
 *
 * **Refused, not defaulted.** A manifest that exists and does not parse is a damaged
 * installation, and a service that starts anyway reports itself as unidentified — exactly the
 * state the manifest exists to end, with nothing saying why.
 */
export function parseBuildManifest(text: string, source: string): BuildIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} is not a build manifest: expected an object`);
  }
  const { version, commit, dirty } = parsed as Record<string, unknown>;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`${source} has no version`);
  }
  let named: string | null;
  if (commit === null) named = null;
  else if (typeof commit === 'string' && COMMIT.test(commit)) named = commit;
  else {
    throw new Error(
      `${source} names a commit that is not a full commit id: ${JSON.stringify(commit)}`,
    );
  }
  if (typeof dirty !== 'boolean') {
    throw new Error(`${source} does not say whether the tree was modified`);
  }
  return { version, commit: named, dirty };
}

/**
 * The identity of the build whose manifest would be at `manifest`.
 *
 * No manifest is the ordinary state of a working tree, not an error: the version then comes from
 * `MS_BUILD_VERSION` if a harness set one, and the commit is unknown — not guessed from a `.git`
 * that the running process has no reason to trust describes it.
 */
export function readBuildIdentity(
  manifest: URL,
  env: NodeJS.ProcessEnv = process.env,
): BuildIdentity {
  const path = fileURLToPath(manifest);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      version: env['MS_BUILD_VERSION'] ?? DEVELOPMENT_VERSION,
      commit: null,
      dirty: false,
    };
  }
  return parseBuildManifest(text, path);
}

/**
 * Whether the identity names exactly one body of code: a commit, and nothing on top of it.
 *
 * Anything that caches across builds keys on this, and must assume "changed" when it is false.
 */
export function isExactBuild(build: BuildIdentity): build is BuildIdentity & { commit: string } {
  return build.commit !== null && !build.dirty;
}

/** `1.0.0-rc.1 (commit 1a2b3c4d5e6f)`, for a start-up line or `--help`. */
export function describeBuild(build: BuildIdentity): string {
  if (build.commit === null) return `${build.version} (commit unknown)`;
  const short = build.commit.slice(0, 12);
  return build.dirty
    ? `${build.version} (commit ${short}, with uncommitted changes)`
    : `${build.version} (commit ${short})`;
}
