import { BUILD_MANIFEST, readBuildStamp, type BuildStamp } from '@ms/shared';

/**
 * Which build this is, from the manifest `scripts/package.sh` writes beside `dist` (`H-11`), and
 * what it was built to contain (`H-12`).
 *
 * A file rather than the launcher's environment for the core's reason: WinSW runs `node.exe` on
 * `main.js` directly and never set `MS_BUILD_VERSION`. See `packages/core/src/version.ts`.
 */
export const BUILD: BuildStamp = readBuildStamp(
  new URL(`../../${BUILD_MANIFEST}`, import.meta.url),
);

/** The version alone, where a person reads it. */
export const VERSION: string = BUILD.version;
