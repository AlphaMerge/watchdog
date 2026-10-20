import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

/**
 * No internal ticket in anything this package says (`U-92`).
 *
 * What is here reaches an operator from both services: a discovery level's description, which the
 * core serves; the words a configuration check prints; the lines either service logs as it starts
 * and stops; and the reasons discovery's sweep gives for the ports it asks about. So every string
 * under `src` is read from the source, as the web's `operator-text.test.ts` reads its own: every
 * string literal and every part of a template, and no comment, which is the one place in a source
 * file a ticket belongs.
 */

/** A ticket as the repository names them, `P-07`, `A-41b`, `V2-01`, or a decision record. */
const TICKET = /\b(?:[A-Z]|V2|ADR)-\d+[a-z]?\b/u;

// At runtime this file is packages/shared/dist/test/operator-text.test.js.
const SRC = join(import.meta.dirname, '..', '..', 'src');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

interface Text {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every string a source file holds outside its comments, with the line it is on. */
function textsIn(file: string): Text[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: Text[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ file: relative(SRC, file), line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the text the shared package writes (U-92)', () => {
  it('names a ticket by the pattern, and nothing an operator needs', () => {
    for (const ticket of ['(`P-07`)', 'A-41b', 'V2-01', 'ADR-003', 'that T-09 can reach']) {
      assert.match(ticket, TICKET, ticket);
    }
    for (const word of ['SHA-256', 'UTF-8', 'X-Forwarded-For', 'IPv4']) {
      assert.doesNotMatch(word, TICKET, word);
    }
  });

  it('cites no ticket, in any string or template under src', () => {
    const files = filesUnder(SRC);
    const texts = files.flatMap(textsIn);
    // The walk reaches a discovery level's description, a reason the sweep asks a port, and the
    // parts of a template.
    assert.ok(files.length > 30, String(files.length));
    for (const [file, text] of [
      [join('net', 'discovery-levels.ts'), 'Sweeps the range and creates a device'],
      [join('net', 'fingerprint.ts'), 'WinRM — a Windows machine'],
      [join('config', 'check.ts'), 'configuration is valid for '],
    ] as const) {
      assert.ok(
        texts.some((one) => one.file === file && one.text.includes(text)),
        `the walk reaches "${text}" in ${file}`,
      );
    }
    assert.deepEqual(
      texts
        .filter((one) => TICKET.test(one.text))
        .map((one) => `${one.file}:${String(one.line)}: ${one.text.trim()}`),
      [],
    );
  });
});
