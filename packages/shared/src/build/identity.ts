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

/**
 * What a build was packaged to contain (`H-12`).
 *
 * `v1` is the release candidate: the v2 subsystems that share `main` with it — flow, maps,
 * reports, libraries — are not constructed, and the sensor types that cannot run on a Linux
 * probe are not in its catalogue. `full` is everything on `main`.
 *
 * **Stamped by the packaging step, never configured.** An operator setting would sit one `MS_*`
 * environment variable from "on", and a release candidate that is v1 until somebody sets a
 * variable is not a v1 release candidate.
 */
export type BuildProfile = 'v1' | 'full';

export const BUILD_PROFILES: readonly BuildProfile[] = ['v1', 'full'];

/** Which build this is, and what it was built to contain: everything `build.json` says. */
export interface BuildStamp extends BuildIdentity {
  readonly profile: BuildProfile;
}

/** The file `scripts/package.sh` writes into each packaged service, beside its `dist`. */
export const BUILD_MANIFEST = 'build.json';

/** What a build knows about itself when it was never packaged. */
export const DEVELOPMENT_VERSION = '0.0.0-dev';

/**
 * The profile of a build that was never packaged: everything, because a working tree is where
 * every subsystem is developed and tested. `MS_BUILD_PROFILE` narrows it for a test that needs a
 * v1 build to ask. A packaged build never reaches this — it has a manifest, and a manifest that
 * does not name a profile is refused rather than read as this one.
 */
export const DEVELOPMENT_PROFILE: BuildProfile = 'full';

const COMMIT = /^[0-9a-f]{40}$/;

function isProfile(value: unknown): value is BuildProfile {
  return BUILD_PROFILES.some((profile) => profile === value);
}

/**
 * Parse a manifest, refusing anything that is not one.
 *
 * **Refused, not defaulted.** A manifest that exists and does not parse is a damaged
 * installation, and a service that starts anyway reports itself as unidentified — exactly the
 * state the manifest exists to end, with nothing saying why.
 */
export function parseBuildManifest(text: string, source: string): BuildStamp {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} is not a build manifest: expected an object`);
  }
  const { version, commit, dirty, profile } = parsed as Record<string, unknown>;
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
  // A package from before `H-12` has no profile, and it is not read as `full`: the one thing a
  // v1 build must never do is turn into everything because a field went missing.
  if (profile === undefined) {
    throw new Error(`${source} does not say which profile it was built as`);
  }
  if (!isProfile(profile)) {
    throw new Error(
      `${source} names a profile this build does not know: ${JSON.stringify(profile)} ` +
        `(expected one of ${BUILD_PROFILES.join(', ')})`,
    );
  }
  return { version, commit: named, dirty, profile };
}

/**
 * The stamp of the build whose manifest would be at `manifest`.
 *
 * No manifest is the ordinary state of a working tree, not an error: the version then comes from
 * `MS_BUILD_VERSION` if a harness set one, and the commit is unknown — not guessed from a `.git`
 * that the running process has no reason to trust describes it. The profile is
 * `MS_BUILD_PROFILE`, or everything. **Neither variable is read when a manifest exists**, so no
 * environment can change what a packaged build contains.
 */
export function readBuildStamp(manifest: URL, env: NodeJS.ProcessEnv = process.env): BuildStamp {
  const path = fileURLToPath(manifest);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const profile = env['MS_BUILD_PROFILE'] ?? DEVELOPMENT_PROFILE;
    if (!isProfile(profile)) {
      throw new Error(
        `MS_BUILD_PROFILE names a profile this build does not know: ${JSON.stringify(profile)} ` +
          `(expected one of ${BUILD_PROFILES.join(', ')})`,
      );
    }
    return {
      version: env['MS_BUILD_VERSION'] ?? DEVELOPMENT_VERSION,
      commit: null,
      dirty: false,
      profile,
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

/** `1.0.0-rc.1 (v1 profile, commit 1a2b3c4d5e6f)`, for a start-up line or `--help`. */
export function describeBuild(build: BuildStamp): string {
  const profile = `${build.profile} profile`;
  if (build.commit === null) return `${build.version} (${profile}, commit unknown)`;
  const short = build.commit.slice(0, 12);
  return build.dirty
    ? `${build.version} (${profile}, commit ${short}, with uncommitted changes)`
    : `${build.version} (${profile}, commit ${short})`;
}
