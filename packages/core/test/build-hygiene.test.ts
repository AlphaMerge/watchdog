import { strict as assert } from 'node:assert';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * `tsc -b` is incremental and never deletes output for a source file that has gone away, while
 * the test runner globs the compiled directory. A test whose source is deleted therefore keeps
 * running — for ever, against whatever the code looked like when it was last compiled.
 *
 * That is not hypothetical: two throwaway files written during the S-03 review were found still
 * running here, long after their sources were removed. They happened to pass, so the only cost
 * was a confusing test count, but a stale test that *fails* is a much worse afternoon.
 */
describe('build hygiene', () => {
  it('runs no compiled test whose source has been deleted', async () => {
    // At runtime this file is <package>/dist/test/build-hygiene.test.js.
    const compiledRoot = import.meta.dirname;
    const sourceRoot = join(compiledRoot, '..', '..', 'test');

    const orphans: string[] = [];
    for (const directory of ['.', 'perf']) {
      const compiled = await readdir(join(compiledRoot, directory)).catch(() => []);
      const sources = new Set(await readdir(join(sourceRoot, directory)).catch(() => []));
      for (const file of compiled) {
        if (!file.endsWith('.test.js')) continue;
        if (!sources.has(file.replace(/\.js$/, '.ts'))) {
          orphans.push(join(directory, file));
        }
      }
    }

    assert.deepEqual(
      orphans,
      [],
      `these compiled tests have no source and are still being run — delete them, ` +
        `or run "npm run clean" and rebuild:\n  ${orphans.join('\n  ')}`,
    );
  });
});
