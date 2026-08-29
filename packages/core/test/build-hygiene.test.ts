import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

/**
 * `tsc -b` is incremental and never deletes output for a source file that has gone away.
 *
 * For a test that means it keeps running for ever, against whatever the code looked like when it
 * was last compiled — two throwaway files from the S-03 review were found still running here,
 * long after their sources were deleted. For anything under `src` it is worse: `scripts/
 * package.sh` copies `dist` wholesale, so a deleted module keeps shipping, and the pool loads
 * its registry *by path* — a stale one would be loadable in production.
 *
 * P-05 deleted `placeholder-registry.ts` and left exactly that behind, which is why this now
 * covers `src` as well as `test`, and every package rather than just this one.
 */
describe('build hygiene', () => {
  it('has no compiled file whose source has been deleted', async () => {
    // At runtime this file is <repo>/packages/core/dist/test/build-hygiene.test.js.
    const packagesRoot = join(import.meta.dirname, '..', '..', '..');
    const orphans: string[] = [];

    for (const pkg of await readdir(packagesRoot).catch(() => [])) {
      const dist = join(packagesRoot, pkg, 'dist');
      for (const area of ['src', 'test']) {
        await compare(join(dist, area), join(packagesRoot, pkg, area), (file) => {
          orphans.push(relative(packagesRoot, file));
        });
      }
    }

    assert.deepEqual(
      orphans,
      [],
      `compiled output with no source — delete it, or run "npm run clean" and rebuild:\n  ${orphans.join('\n  ')}`,
    );
  });

  /**
   * `P-21` moved the measured budgets out of `npm test` and behind `npm run test:perf`, which
   * buys an ordinary run that never reports a perf failure and costs the thing this checks: a
   * suite nothing runs automatically is a suite that can rot for weeks without anybody noticing.
   *
   * So the wiring is asserted rather than assumed. A new file under `test/perf/` that no script
   * globs, or a `test` script that quietly starts running them again, fails here — in the suite
   * that *does* run on every push.
   */
  it('has every perf test behind test:perf, and none of them in the ordinary run', async () => {
    const packagesRoot = join(import.meta.dirname, '..', '..', '..');
    const problems: string[] = [];

    for (const pkg of await readdir(packagesRoot).catch(() => [])) {
      const perfDir = join(packagesRoot, pkg, 'test', 'perf');
      const perfTests = (await readdir(perfDir).catch(() => [])).filter((name) =>
        name.endsWith('.test.ts'),
      );
      if (perfTests.length === 0) continue;

      const manifest = JSON.parse(
        await readFile(join(packagesRoot, pkg, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string> };
      const scripts = manifest.scripts ?? {};

      if (scripts['test:perf'] === undefined) {
        problems.push(`${pkg} has ${String(perfTests.length)} perf tests and no test:perf script`);
      }
      // `dist/test/*.test.js` does not descend into `perf/`; `**` does, which is the mistake
      // this catches — it is one character and it puts the budgets back in the ordinary run.
      for (const key of ['test', 'test:unit']) {
        const script = scripts[key];
        if (script !== undefined && script.includes('dist/test/**')) {
          problems.push(`${pkg}'s ${key} script globs perf tests: ${script}`);
        }
      }
    }

    assert.deepEqual(problems, [], problems.join('\n  '));
  });
});

/** Walks compiled output, reporting any `.js` with no matching `.ts` beside its source. */
async function compare(
  compiledDir: string,
  sourceDir: string,
  report: (file: string) => void,
): Promise<void> {
  const entries = await readdir(compiledDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;

  const sources = new Set(
    (await readdir(sourceDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await compare(join(compiledDir, entry.name), join(sourceDir, entry.name), report);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    if (!sources.has(entry.name.replace(/\.js$/, '.ts'))) {
      report(join(compiledDir, entry.name));
    }
  }
}
