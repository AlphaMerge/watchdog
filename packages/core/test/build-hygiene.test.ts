import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
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
/**
 * The two generated documents (`H-07`).
 *
 * `docs/sensor-reference.md` and `docs/api-reference.md` are rendered from the catalogue and from
 * the OpenAPI document, and the whole reason they are generated is that a hand-written reference
 * is right on the day it is written and silently wrong from then on. That only holds if something
 * fails when they drift, and this is that something: a parameter renamed, a channel added, a
 * route registered — any of them makes the committed file stale, and the build goes red rather
 * than the documentation going quietly wrong.
 *
 * Each generator's own `--check` does the comparing, so there is one renderer and no second
 * implementation of it here to disagree.
 */
describe('generated documentation', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

  for (const generator of ['sensor-reference', 'api-reference']) {
    it(`has docs/${generator}.md in step with the code`, () => {
      const run = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts', 'docs', `${generator}.mjs`), '--check'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      assert.equal(
        run.status,
        0,
        `${run.stdout}${run.stderr}\nRegenerate with: node scripts/docs/${generator}.mjs`,
      );
    });
  }
});

/**
 * Every `.ps1` in the tree parses (`P-53`).
 *
 * **A parse error in `ms-setup.ps1` breaks every Windows install**, and until now the only thing
 * anywhere that would have caught one was `H-06`'s `windows-install` CI job — which has never run,
 * because CI is disabled. So the scripts that register the services, open the firewall and gate an
 * upgrade on `config check` were unchecked by anything at all.
 *
 * `H-06` recorded that a local check was impossible: "PowerShell publishes no arm64 container, the
 * amd64 one dies under QEMU on an Apple Silicon machine, and the `dotnet tool` package is broken —
 * three routes tried, all dead." That was true of those three routes and not of the fourth:
 * `P-51` put the official `linux-arm64` tarball in the toolchain image for the Windows *sensor*
 * transport, and a parser is a parser.
 *
 * Parsing is not running. This cannot tell whether `New-Service` was called with the right
 * arguments — only Windows can, which is what `H-06` still waits for. It catches the class of
 * mistake that costs a release, at the price of one process.
 */
describe('PowerShell installers', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
  const pwsh = ((): string => {
    for (const candidate of [process.env['MS_TEST_PWSH'] ?? '', 'pwsh', 'powershell.exe']) {
      if (candidate === '') continue;
      const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$true'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (probe.status === 0) return candidate;
    }
    return '';
  })();

  it('parse without error', { skip: pwsh === '' ? 'no pwsh on this machine' : false }, () => {
    // One process for every file: starting PowerShell costs far more than parsing does, and the
    // report has to name which file failed rather than only that one did.
    const script = [
      '$bad = @()',
      "Get-ChildItem -Recurse -Path 'deploy','scripts' -Filter *.ps1 | ForEach-Object {",
      '  $errors = $null',
      '  [System.Management.Automation.Language.Parser]::ParseFile(',
      '    $_.FullName, [ref]$null, [ref]$errors) | Out-Null',
      '  if ($errors -and $errors.Count -gt 0) {',
      '    foreach ($e in $errors) {',
      '      $bad += ($_.FullName + ":" + $e.Extent.StartLineNumber + " " + $e.Message)',
      '    }',
      '  }',
      '}',
      'if ($bad.Count -gt 0) { $bad -join "`n"; exit 1 }',
      "Write-Output 'ok'",
    ].join('\n');

    const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  });
});

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
