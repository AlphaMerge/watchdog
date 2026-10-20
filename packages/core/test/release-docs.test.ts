import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import {
  parseReleaseDocs,
  releaseDocs as readReleaseDocs,
  type ReleaseDocs,
} from './support/release-docs.js';

/**
 * What a release ships of `docs/` (`H-51`).
 *
 * **`package.sh` copied the whole directory**, so every tarball, `.deb` and `.rpm` installed the
 * backlog (`TASKS.md`, some 46,000 lines), the roadmap, the scope contract, six design records and
 * a hundred findings files into `/opt/ms/docs`, on every core and every remote probe host.
 * `scripts/lib/release-docs.txt` now says what ships, and `package-provenance.test.ts` holds
 * `package.sh` to it. This holds the list itself to the three things that make it right:
 *
 * - **Every document is decided**, so a new one is shipped or kept on purpose, and the
 *   repository's own are kept.
 * - **Whatever sends the operator to a document can reach it**: a unit, a script the release
 *   installs, and every string in the source, which is what the services print, log, serve and
 *   write into the database. A string naming a kept document is a pointer the operator cannot
 *   follow, and is reworded rather than shipping the document.
 * - **A shipped document links only to shipped ones.** The repository's link check
 *   (`build-hygiene.test.ts`, *documentation links*) resolves against the whole tree, where a link
 *   to `TASKS.md` works; installed, it points at nothing.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const docsDir = join(repoRoot, 'docs');

const releaseDocs = (): ReleaseDocs => readReleaseDocs(repoRoot);

/**
 * A document's name as a sentence or a path gives it, and where under `docs/` that is:
 * `docs/administration.md`, `/opt/ms/docs/installation.md`, `state-machine.md 2.2` and
 * `WORKFLOW.MD §7` all name a document there. `CLAUDE.md` names one that is not.
 */
const DOCUMENT_NAME = /[\w./-]*?[\w-]+\.(?:md|MD)\b/gu;

function documentsNamed(text: string): string[] {
  return [...text.matchAll(DOCUMENT_NAME)].map((match) =>
    match[0]
      .replace(/^\.\//u, '')
      .replace(/^\/opt\/ms\//u, '')
      .replace(/^docs\//u, ''),
  );
}

/** A SQL comment, as `operator-text.test.ts` reads one: not text anybody is shown. */
const SQL_COMMENT = /(?<=^|\s)--(?=\s|$)[^\n]*/gu;

/**
 * Every string a source file holds, outside its comments, with its SQL comments taken out, and
 * JSX text with them. A template is one text, its parts joined where the placeholders were, so a
 * SQL comment running past one is still a comment; what a placeholder holds is read for itself.
 * A migration's SQL is read too: its `RAISE` is what an operator meets when it refuses, and its
 * `COMMENT ON` is the database's own documentation.
 */
function stringsIn(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push(node.text.replace(SQL_COMMENT, ''));
      return;
    }
    if (ts.isJsxText(node)) {
      found.push(node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head, ...node.templateSpans.map((span) => span.literal)];
      found.push(
        parts
          .map((part) => part.text)
          .join(' ')
          .replace(SQL_COMMENT, ''),
      );
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * What a packaging script writes from a heredoc: the launchers, the `.deb`'s maintainer scripts
 * and the `.rpm`'s spec, which the release installs. The rest of the script is ours.
 */
function heredocBodies(script: string): string[] {
  return [
    ...script.matchAll(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)/gu),
  ].map((match) => match[3] ?? '');
}

/** Fenced blocks and inline code: what a Markdown reader shows as code, never as a link. */
function withoutCode(markdown: string): string {
  return markdown
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gmu, '')
    .replace(/(`+)[\s\S]*?\1/gu, '');
}

/**
 * Every link target a Markdown document has: inline links and images, reference definitions, and
 * an HTML `href` or `src`. What a reader can follow, and only that.
 */
function linkTargets(markdown: string): string[] {
  const text = withoutCode(markdown);
  return [
    ...[...text.matchAll(/\]\(\s*<([^>]*)>[^)]*\)/gu)].map((match) => match[1]),
    ...[...text.matchAll(/\]\(\s*([^)<\s]+)[^)]*\)/gu)].map((match) => match[1]),
    ...[...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gmu)].map((match) => match[1]),
    ...[...text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gu)].map((match) => match[1]),
  ].filter((target): target is string => target !== undefined);
}

/**
 * The targets of `doc`'s links that a release installing `shipped` does not have: anything
 * relative that resolves outside `docs/` or to a document not shipped. A URL with a scheme and an
 * anchor in the same document are not files.
 */
function danglingLinks(doc: string, markdown: string, shipped: readonly string[]): string[] {
  return linkTargets(markdown).filter((target) => {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('#')) return false;
    const path = target.split('#')[0] ?? '';
    const resolved = posix.normalize(posix.join(posix.dirname(doc), decodeURI(path)));
    return !shipped.includes(resolved);
  });
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Every route `docs/api-reference.md` lists, with a pattern that matches it whatever stands for a
 * parameter. `build-hygiene.test.ts` holds that page to the routes the core registers.
 */
function referenceRoutes(): { readonly key: string; readonly pattern: RegExp }[] {
  const page = readFileSync(join(docsDir, 'api-reference.md'), 'utf8');
  return [...page.matchAll(/^### `([A-Z]+) (\/\S*)`$/gmu)].map(([, method = '', path = '']) => {
    // `{id}` is one segment, whatever fills it; the rest is literal.
    const segments = path.split(/\{[^}/]+\}/u).map(escapeRegExp);
    return {
      key: `${method} ${path}`,
      pattern: new RegExp(`^${method} ${segments.join('[^/]+')}$`, 'u'),
    };
  });
}

/** A route a document names in code: `GET /objects/:id`, `POST /api/v1/probes/<gid>/approve`. */
const ROUTE_SPAN = /`(GET|POST|PUT|PATCH|DELETE) (\/[^`\s]*)`/gu;

/**
 * What a named route can mean: the path as written and, when it is not under `/api/`, under
 * `/api/v1`, as prose shortens it. The query goes, and a parameter however spelled is one segment.
 */
function routeReadings(method: string, path: string): string[] {
  const bare = (path.split('?')[0] ?? '').replace(/:[A-Za-z]+|<[A-Za-z]+>|\{[A-Za-z]+\}/gu, '1');
  return [bare, ...(bare.startsWith('/api/') ? [] : [`/api/v1${bare}`])].map(
    (one) => `${method} ${one}`,
  );
}

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'dist' ? [] : filesUnder(path, keep);
    }
    return keep(entry.name) ? [path] : [];
  });
}

interface Pointer {
  readonly where: string;
  readonly document: string;
}

/**
 * Every document a release sends its operator to, and where from: each file under `deploy/` whole
 * (units, installers, the setup and its fragments, all installed), what the packaging scripts
 * write from heredocs, and every string in every package's source.
 */
function pointers(): Pointer[] {
  const found: Pointer[] = [];
  const add = (where: string, text: string): void => {
    for (const document of documentsNamed(text)) found.push({ where, document });
  };
  for (const path of filesUnder(join(repoRoot, 'deploy'), () => true)) {
    add(relative(repoRoot, path), readFileSync(path, 'utf8'));
  }
  for (const script of readdirSync(join(repoRoot, 'scripts')).filter((name) =>
    /^package.*\.sh$/u.test(name),
  )) {
    const path = join(repoRoot, 'scripts', script);
    for (const body of heredocBodies(readFileSync(path, 'utf8')))
      add(relative(repoRoot, path), body);
  }
  const packages = join(repoRoot, 'packages');
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, 'src');
    if (!existsSync(src)) continue;
    for (const path of filesUnder(
      src,
      (name) => /\.tsx?$/u.test(name) && !name.endsWith('.d.ts'),
    )) {
      for (const text of stringsIn(path, readFileSync(path, 'utf8')))
        add(relative(repoRoot, path), text);
    }
  }
  return found;
}

describe('the documents a release ships (`H-51`)', () => {
  it('decide every document in docs/ once, and keep the repository’s own', () => {
    const { ship, keep, problems } = releaseDocs();
    assert.deepEqual(problems, [], 'lines package.sh would refuse');

    // Not a dotfile a desktop leaves behind, which nothing ships either.
    const entries = readdirSync(docsDir)
      .filter((name) => !name.startsWith('.'))
      .map((name) => (statSync(join(docsDir, name)).isDirectory() ? `${name}/` : name));
    const decided = [...ship, ...keep];
    assert.deepEqual(
      entries.filter((entry) => !decided.includes(entry)),
      [],
      'documents release-docs.txt neither ships nor keeps — decide each',
    );
    assert.deepEqual(
      decided.filter((entry, index) => decided.indexOf(entry) !== index),
      [],
      'documents decided twice',
    );
    assert.deepEqual(
      ship.filter(
        (path) => !existsSync(join(docsDir, path)) || statSync(join(docsDir, path)).isDirectory(),
      ),
      [],
      'shipped entries that are not a file in docs/',
    );
    assert.deepEqual(
      keep.filter((path) => !entries.includes(path)),
      [],
      'kept entries that are not in docs/',
    );

    // The repository's own, which is what `H-51` found shipped. The field-test runbook is how we
    // qualify a candidate; the findings are how a number was measured.
    for (const internal of [
      'README.md',
      'TASKS.md',
      'PLAN.md',
      'CAPABILITIES.MD',
      'WORKFLOW.MD',
      'runbook-field-test.md',
      'findings/',
    ]) {
      assert.ok(keep.includes(internal), `${internal} is the repository's, and ships`);
    }
    assert.deepEqual(
      ship.filter((path) => path.startsWith('findings/')),
      [],
      'a findings file ships',
    );
    // Every design record but ADR-001, whose Decision 4 migration 004's checksummed refusal names.
    // Read from the directory, so a new record is held here without a line of its own. Nothing
    // else would hold them: a record with no relative links passes the link test shipped or kept.
    const records = entries.filter((name) => /^ADR-\d{3}-[\w-]+\.md$/u.test(name));
    assert.ok(records.length >= 6, `${String(records.length)} design records found in docs/`);
    assert.deepEqual(
      records.filter((name) => name !== 'ADR-001-architecture.md' && !keep.includes(name)),
      [],
      'design records the release ships, beside ADR-001',
    );
    assert.ok(
      ship.includes('ADR-001-architecture.md'),
      'ADR-001, which migration 004 names, is kept',
    );
    assert.ok(ship.includes('index.md'), 'the release has no index of its own');
  });

  it('include every document a unit, an installed script or a string in the source names', () => {
    const { ship } = releaseDocs();
    const found = pointers();
    const named = new Set(found.map(({ document }) => document));
    // Presence first, so that a reader that finds nothing cannot pass: the units and `ms-setup`
    // name the first three, migration 004's licence refusal the ADR, the catalogue's refusal of a
    // malformed type the guide, and migration 040's column comment the state machine.
    for (const expected of [
      'installation.md',
      'administration.md',
      'runbook-backup-restore.md',
      'sizing.md',
      'ADR-001-architecture.md',
      'adding-a-sensor-type.md',
      'state-machine.md',
    ]) {
      assert.ok(named.has(expected), `nothing was found naming ${expected}`);
    }
    const unreachable = found
      .filter(({ document }) => !ship.includes(document))
      .map(({ where, document }) => `${where} → ${document}`);
    assert.deepEqual(
      [...new Set(unreachable)],
      [],
      'pointers at a document the release does not ship — ship it, or say what it says',
    );
  });

  it('link only to each other', () => {
    const { ship } = releaseDocs();
    assert.ok(ship.length > 0);
    const broken = ship.flatMap((doc) =>
      danglingLinks(doc, readFileSync(join(docsDir, doc), 'utf8'), ship).map(
        (target) => `${doc} → ${target}`,
      ),
    );
    assert.deepEqual(broken, [], 'links in a shipped document to a file the release does not have');
  });

  /**
   * The release's index told operators the OpenAPI document was at `/openapi.json`, copied from
   * the repository's map; the core serves it at `GET /api/v1/openapi.json` only, which the API
   * reference beside it said (`H-51` review). So a route a shipped document names is looked up in
   * the reference, and the document's file name is never written without its route.
   */
  it('name only routes the core registers, and the OpenAPI document at its own', () => {
    const { ship } = releaseDocs();
    const routes = referenceRoutes();
    // Presence, so that a page whose headings were not read cannot pass.
    assert.ok(routes.length > 100, `${String(routes.length)} routes read from the API reference`);
    assert.ok(routes.some(({ key }) => key === 'GET /api/v1/openapi.json'));

    // The shipped documents, and the repository's map the release's index was written from.
    const named: string[] = [];
    const unknown: string[] = [];
    const misnamed: string[] = [];
    for (const doc of [...ship, 'README.md']) {
      const text = readFileSync(join(docsDir, doc), 'utf8');
      for (const [span, method = '', path = ''] of text.matchAll(ROUTE_SPAN)) {
        named.push(`${doc}: ${span}`);
        const readings = routeReadings(method, path);
        if (!routes.some(({ pattern }) => readings.some((one) => pattern.test(one)))) {
          unknown.push(`${doc}: ${span}`);
        }
      }
      for (const [mention, before = ''] of text.matchAll(/(\S*)openapi\.json/gu)) {
        if (!before.endsWith('/api/v1/')) misnamed.push(`${doc}: ${mention}`);
      }
    }
    // A route in full, one shortened as prose shortens it, and the one this was written for.
    for (const expected of [
      'troubleshooting.md: `GET /api/v1/build`',
      'troubleshooting.md: `GET /objects/:id/settings`',
      'index.md: `GET /api/v1/openapi.json`',
    ]) {
      assert.ok(named.includes(expected), `${expected} was not found`);
    }
    assert.deepEqual(unknown, [], 'routes a document names that the core does not register');
    assert.deepEqual(
      misnamed,
      [],
      'the OpenAPI document named other than at GET /api/v1/openapi.json, the route that serves it',
    );
  });

  it('reach the .deb, the .rpm and the MSI through the staged tree, not the repository', () => {
    // `package.sh` stages the list, and each package copies what it staged. The MSI copied the
    // repository's whole docs/ until `H-51`, past the list.
    for (const script of ['package-deb.sh', 'package-rpm.sh', 'package-msi.sh']) {
      const text = readFileSync(join(repoRoot, 'scripts', script), 'utf8');
      assert.match(text, /cp -R "\$\{stage\}\/docs" /u, `${script} copies no staged docs`);
      assert.doesNotMatch(
        text,
        /\$\{repo_root\}\/docs\b/u,
        `${script} reads the repository's docs/`,
      );
    }
  });

  it('find each shape of pointer and link they were written for, planted', () => {
    assert.deepEqual(
      documentsNamed(
        'see /opt/ms/docs/installation.md, docs/administration.md, WORKFLOW.MD §7, ' +
          'state-machine.md 2.2, ./sizing.md, docs/findings/2026-01-01-x.md and CLAUDE.md; *.md',
      ),
      [
        'installation.md',
        'administration.md',
        'WORKFLOW.MD',
        'state-machine.md',
        'sizing.md',
        'findings/2026-01-01-x.md',
        'CLAUDE.md',
      ],
    );

    const source = [
      "const a = 'see WORKFLOW.MD';",
      '// CAPABILITIES.MD, in a comment',
      '/** PLAN.md, in a doc comment */',
      'const q = `SELECT ${a} -- TASKS.md, a SQL comment',
      'FROM x WHERE y = $1 -- also ${a} README.md`;',
      "const r = `RAISE EXCEPTION 'x' USING HINT = 'see docs/ADR-001-architecture.md'`;",
      'const v = <p title="sizing.md">see administration.md {`web-ui.md`}</p>;',
    ].join('\n');
    assert.deepEqual(
      stringsIn('planted.tsx', source).flatMap((text) => documentsNamed(text)),
      ['WORKFLOW.MD', 'ADR-001-architecture.md', 'sizing.md', 'administration.md', 'web-ui.md'],
    );

    const script = [
      '# TASKS.md, our comment',
      'cat > "$root/DEBIAN/postinst" <<\'POSTINST\'',
      'echo "see /opt/ms/docs/installation.md"',
      'POSTINST',
      'echo "PLAN.md, at build time"',
      'cat > launcher <<LAUNCHER',
      'exec node main.js # CAPABILITIES.MD',
      'LAUNCHER',
    ].join('\n');
    assert.deepEqual(
      heredocBodies(script).flatMap((body) => documentsNamed(body)),
      ['installation.md', 'CAPABILITIES.MD'],
    );

    const markdown = [
      '# A shipped document',
      'Read [the guide](installation.md#upgrading), [the backlog](TASKS.md) and',
      '[the root](../README.md); ![a picture](findings/plot.png "title") and',
      '[angled](<PLAN.md>), [a finding][f], <a href="WORKFLOW.MD">html</a>,',
      '[the web](https://example.com/TASKS.md), [here](#a-heading), [the index](./index.md).',
      'Plain text, `[in code](CAPABILITIES.MD)`, and findings/x.md are not links.',
      '```markdown',
      '[in a fence](runbook-field-test.md)',
      '```',
      '',
      '[f]: findings/2026-01-01-x.md',
    ].join('\n');
    assert.deepEqual(
      danglingLinks('planted.md', markdown, ['installation.md', 'index.md']).sort(),
      [
        '../README.md',
        'PLAN.md',
        'TASKS.md',
        'WORKFLOW.MD',
        'findings/2026-01-01-x.md',
        'findings/plot.png',
      ],
    );
    // A named route, however its parameter is spelled, read as the reference spells it.
    assert.deepEqual(routeReadings('GET', '/objects/:id/settings?inherited=true'), [
      'GET /objects/1/settings',
      'GET /api/v1/objects/1/settings',
    ]);
    assert.deepEqual(routeReadings('POST', '/api/v1/probes/<gid>/approve'), [
      'POST /api/v1/probes/1/approve',
    ]);
    assert.deepEqual(
      [
        ...'`GET /metrics`, `DELETE /a/{id}`, `GET`, `GET objects`, GET /b'.matchAll(ROUTE_SPAN),
      ].map(([, method, path]) => `${String(method)} ${String(path)}`),
      ['GET /metrics', 'DELETE /a/{id}'],
    );

    // Resolved against the document's own directory, as a reader's viewer resolves it.
    assert.deepEqual(
      danglingLinks('guide/planted.md', '[up](../installation.md) [here](installation.md)', [
        'installation.md',
      ]),
      ['installation.md'],
    );
  });

  it('read release-docs.txt as package.sh does', () => {
    assert.deepEqual(
      parseReleaseDocs(
        '# a comment\n\nship index.md\n  keep findings/\nship a.md b.md\nshop c.md\nship\n',
      ),
      {
        ship: ['index.md'],
        keep: ['findings/'],
        problems: [
          'line 5: "ship a.md b.md"',
          'line 6: "shop" is neither ship nor keep',
          'line 7: "ship"',
        ],
      },
    );
  });
});
