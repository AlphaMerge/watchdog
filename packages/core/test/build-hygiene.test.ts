import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
 * No route grows a credential-shaped field in a response without someone saying why (`P-55`).
 *
 * **This is a default-deny list, and it exists because the hand-maintained one failed.**
 * `api-routes.test.ts` sweeps a list of URLs with a canary and asserts no secret comes back. That
 * catches everything on the list and nothing else, and `GET /discovery/schedules` — which
 * returned the stored SNMP community in cleartext from three separate responses — was never on
 * it. CLAUDE.md's rule is absolute: a credential is never returned by any API route, to anyone,
 * including administrators.
 *
 * `docs/api-reference.md` is generated from the live route set (`H-07`) and kept in step by the
 * check above, so reading it is reading every route's declared response — the same derived-not-
 * enumerated property that made `H-07`'s completeness guard work. A new route cannot dodge this
 * by not being added anywhere.
 *
 * It matches on *names*, so it is a smoke alarm and not a proof: it cannot tell whether a field
 * called `note` holds a password. What it does is make the easy mistake loud.
 */
describe('credential-shaped response fields', () => {
  /**
   * Each of these is a deliberate exception with a reason, and the reason is the point: an entry
   * added without one is how the rule erodes.
   */
  const ALLOWED = new Map([
    [
      'secret',
      'TOTP enrolment and API-token creation return it once, at creation. A shared secret the operator is never shown cannot be enrolled or used.',
    ],
    [
      'token',
      'The API token, returned once by its creation route for the same reason. It is hashed at rest and never readable again.',
    ],
    [
      'credentials',
      "The object detail's credential block carries presence and inheritance source, never a value — which the canary sweep in api-routes.test.ts asserts directly.",
    ],
    ['credentialsChanged', 'A boolean on a clone response.'],
    [
      'droppedCredentialKinds',
      'A list of credential *kind* names that were not copied, never their values.',
    ],
    ['mustChangePassword', 'A boolean on the session and user routes.'],
    ['cappedByToken', "A boolean saying an API token's ceiling limited the right."],
  ]);

  const SHAPE =
    /(community|password|secret|auth_?key|priv_?key|passphrase|token|api_?key|credential)/i;

  it('are all accounted for', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const reference = await readFile(join(repoRoot, 'docs', 'api-reference.md'), 'utf8');

    const unexplained: string[] = [];
    for (const line of reference.split('\n')) {
      // `**200** { a, b, c }` — the generator's rendering of a declared response shape.
      const match = /^\*\*(2\d\d)\*\*\s*\{(.+)\}\s*$/.exec(line);
      if (match === null) continue;
      for (const raw of (match[2] ?? '').split(',')) {
        const field = raw.trim();
        if (field === '' || !SHAPE.test(field) || ALLOWED.has(field)) continue;
        if (!unexplained.includes(field)) unexplained.push(field);
      }
    }

    assert.deepEqual(
      unexplained,
      [],
      'a response now carries a credential-shaped field that nothing justifies:\n  ' +
        `${unexplained.join('\n  ')}\n` +
        'Either stop returning it, or add it to ALLOWED with the reason it is safe.',
    );
  });
});

/**
 * Every link between documents points at a file that exists (`P-54`).
 *
 * **The documentation is a graph and nothing was checking its edges.** Adding a finding means
 * adding a line to `docs/README.md`'s index by hand, and the two findings written on 2026-09-04
 * were missing from it until somebody happened to look — a typo in the path would have been just
 * as silent, and the reader who follows a dead link is the one person who needed the document.
 *
 * `H-07` generates the two references that *can* be generated so they cannot drift. This is the
 * same argument for the half that cannot be: the prose stays hand-written, but a link in it either
 * resolves or the build goes red.
 *
 * Ticket cross-references are deliberately not checked here. `P-24` waited on `D-05`'s "VMware
 * transport" for weeks, and `D-05` exists — the reference resolved perfectly and was pointing at a
 * ticket that had never been about that. Checking that a name exists would have said nothing, and
 * would have implied a guarantee it cannot give.
 */
describe('documentation links', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
  // Written for an operator to fill in when they run the field test, not a link to follow.
  const placeholder = /<[^>]+>/;

  it('all resolve to a file that exists', async () => {
    const roots = ['docs', 'CLAUDE.md', 'README.md'];
    const files: string[] = [];
    for (const root of roots) {
      const full = join(repoRoot, root);
      if (root.endsWith('.md')) {
        files.push(full);
        continue;
      }
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const here = join(dir, entry.name);
          if (entry.isDirectory()) await walk(here);
          else if (entry.name.endsWith('.md')) files.push(here);
        }
      };
      await walk(full);
    }

    const broken: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // `[label](path.md)` and paths named in backticks, which is how this repo cites documents.
      const targets = [
        ...[...text.matchAll(/\]\(([^)#\s]+\.md)[^)]*\)/g)].map((m) => m[1]),
        ...[...text.matchAll(/`((?:docs|findings)\/[^`\s]+\.md)`/g)].map((m) => m[1]),
      ];
      for (const target of targets) {
        if (target === undefined || target.startsWith('http') || placeholder.test(target)) continue;
        const beside = join(file, '..', target);
        const fromRoot = join(repoRoot, target);
        if (!existsSync(beside) && !existsSync(fromRoot)) {
          broken.push(`${relative(repoRoot, file)} → ${target}`);
        }
      }
    }

    assert.deepEqual(broken, [], `dead documentation links:\n  ${broken.join('\n  ')}`);
  });

  /**
   * And the other direction, which is the one that actually happened.
   *
   * A dead link is loud when someone follows it. A finding that nothing links to is silent for
   * ever: it was written, committed, and is now reachable only by listing the directory. Two of
   * the findings written on 2026-09-04 sat unindexed until somebody thought to look, and there is
   * no reason to expect the next author to think of it either.
   */
  it('leave no findings document unreachable', async () => {
    const findingsDir = join(repoRoot, 'docs', 'findings');
    const findings = (await readdir(findingsDir)).filter((name) => name.endsWith('.md'));

    // Everything outside `findings/` itself: a finding cited only by another finding is still
    // unreachable from the documentation an operator or a maintainer actually starts from.
    const corpus: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const here = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (here !== findingsDir) await walk(here);
        } else if (entry.name.endsWith('.md')) corpus.push(await readFile(here, 'utf8'));
      }
    };
    await walk(join(repoRoot, 'docs'));
    corpus.push(await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8'));

    const text = corpus.join('\n');
    const orphans = findings.filter((name) => !text.includes(name));
    assert.deepEqual(
      orphans,
      [],
      `findings nothing links to — add them to docs/README.md's index:\n  ${orphans.join('\n  ')}`,
    );
  });
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

/**
 * Every number the probe sends must be read by something (`P-79`).
 *
 * `PROBE_HEALTH_SCHEMA` is `additionalProperties: false`, so adding a field to it is a deliberate
 * act with a protocol bump attached — and precisely *because* it is deliberate, it is easy to
 * finish the probe side, bump the version, watch the tests pass, and never wire the core side at
 * all. Five fields had reached that state: `skippedTicks`, `spoolCorrupt` and `sessionsOpened`
 * from older tickets, and `checksOutstanding` and `checkStalledMs` from `P-76`, which was written
 * the day before this check was. All five were measured on the probe, validated on the wire, and
 * discarded on arrival.
 *
 * Nothing failed, because nothing was wrong — the probe measured correctly and the core did not
 * crash. That is the shape of every defect in this family: a run that reports what it measured
 * and says nothing about what it never looked at (`P-49`, `P-52`, `P-75`). `CLAUDE.md` says the
 * system monitors itself; a counter nobody can read is not monitoring, it is bookkeeping.
 *
 * The check is against `probe-health.ts` alone, with comments stripped and matched on a word
 * boundary, because that is the one place a health field becomes a channel reading. A broad grep across `packages/core` is what
 * missed `sessionsOpened` when this was first audited by hand: the name appeared in a *comment*
 * beside `sessionsEvicted`, describing a diagnosis the operator could not actually make.
 */
describe('the probe health protocol', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

  it('has every field it defines read by the core', async () => {
    const schema = await readFile(
      join(repoRoot, 'packages', 'shared', 'src', 'protocol', 'messages.ts'),
      'utf8',
    );
    const start = schema.indexOf('const PROBE_HEALTH_SCHEMA');
    const end = schema.indexOf('\n} as const', start);
    assert.ok(start !== -1 && end !== -1, 'PROBE_HEALTH_SCHEMA has moved or changed shape');
    const fields = [
      ...new Set(
        [...schema.slice(start, end).matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*):\s*\S/gm)].map(
          (m) => m[1] ?? '',
        ),
      ),
    ];
    // A sanity floor on the extraction itself: a regex that silently matched nothing would make
    // this test pass for ever while checking absolutely nothing, which is the failure it exists
    // to catch, arriving in the guard.
    assert.ok(fields.length > 30, `only found ${String(fields.length)} fields; the parse is wrong`);

    const source = await readFile(
      join(repoRoot, 'packages', 'core', 'src', 'health', 'probe-health.ts'),
      'utf8',
    );
    // Comments stripped: a field named only in prose is exactly the case that fooled the manual
    // audit, and a mention is not a reading.
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');

    // Word-boundary, not substring (`P-80`). `includes` let a field whose name is a *prefix* of
    // another be satisfied by its longer sibling — `sessionsOpen` by `sessionsOpened` — so the
    // guard could pass while the shorter one was read by nothing. The floor above catches a regex
    // that matches nothing; only this catches a match that is accidentally satisfied.
    const unread = fields.filter((field) => !new RegExp(`\\b${field}\\b`).test(code));
    assert.deepEqual(
      unread,
      [],
      `the probe sends these and the core reads none of them — give each a channel in ` +
        `packages/sensors/src/types/probe-health.ts and map it in packages/core/src/health/` +
        `probe-health.ts, or delete it from the protocol:\n  ${unread.join('\n  ')}`,
    );
  });
});
