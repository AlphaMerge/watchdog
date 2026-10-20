import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

/**
 * No internal ticket in anything the probe says (`U-92`).
 *
 * The probe writes a check's message where its type could not — a check that never started, a
 * process that died, a probe that is stopping — and that is the sensor's message, its state-log
 * entry and every notification carrying `%lastmessage`. It also writes the journal an operator
 * reads when a probe will not connect. None of it is served from a registry the core could walk,
 * so it is read here, from the source, as the web's `operator-text.test.ts` reads its own: every
 * string literal and every part of a template, and no comment, which is the one place in a source
 * file a ticket belongs.
 */

/** A ticket as the repository names them, `P-07`, `A-41b`, `V2-01`, or a decision record. */
const TICKET = /\b(?:[A-Z]|V2|ADR)-\d+[a-z]?\b/u;

// At runtime this file is packages/probe/dist/test/operator-text.test.js.
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

describe('the text the probe writes (U-92)', () => {
  it('names a ticket by the pattern, and nothing an operator needs', () => {
    for (const ticket of ['(`P-07`)', 'A-41b', 'V2-01', 'ADR-003']) {
      assert.match(ticket, TICKET, ticket);
    }
    for (const word of ['SHA-256', 'UTF-8', 'EAI_AGAIN', 'IPv6']) {
      assert.doesNotMatch(word, TICKET, word);
    }
  });

  it('cites no ticket, in any string or template under src', () => {
    const files = filesUnder(SRC);
    const texts = files.flatMap(textsIn);
    // The walk reaches a check's message the probe writes, a part of a template, and a log line.
    assert.ok(files.length > 40, String(files.length));
    for (const [file, text] of [
      [join('runner', 'process-runner.ts'), 'this probe failed while reading'],
      [join('runner', 'process-runner.ts'), ' ms it is allowed, so the check never ran'],
      ['result-sink.ts', 'a check result arrived after the result spool closed'],
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
