import { BUILD_MANIFEST, readBuildStamp, type BuildStamp } from '@ms/shared';

/**
 * Which build this is, from the manifest `scripts/package.sh` writes beside `dist` (`H-11`), and
 * what it was built to contain (`H-12`).
 *
 * Read from a file rather than from the launcher's environment, because not every launcher is
 * that script: WinSW starts `node.exe` on `main.js` directly, so a Windows service never saw
 * `MS_BUILD_VERSION` and reported itself as a working tree. `dist/src/version.js` resolves this
 * to the package directory, wherever it was installed.
 */
export const BUILD: BuildStamp = readBuildStamp(
  new URL(`../../${BUILD_MANIFEST}`, import.meta.url),
);

/** The version alone, where a person reads it. */
export const VERSION: string = BUILD.version;
