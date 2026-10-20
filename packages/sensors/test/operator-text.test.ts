import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

/**
 * No internal ticket in anything a sensor type says (`U-92`).
 *
 * A type's text reaches the operator by more ways than a schema: a channel's name, which the
 * channel table and the graph legend show, whichever parameter turns it on; a default, which
 * fills the form; and what a check says when it fails — a result's `message` or the message of
 * an error `execute()` throws — which is the sensor's message, its state-log entry and every
 * notification carrying `%lastmessage`. The core's `operator-text.test.ts` walks what the API
 * serves, and none of the last can be walked that way: they exist only when a check runs. NetFlow
 * v5's decoder said "versions 9 and 10 arrive with B-03" for as long as nothing read it.
 *
 * **So every string under `src` is read from the source**, as the web's `operator-text.test.ts`
 * reads its own: every string literal and every part of a template, and no comment, which is the
 * one place in a source file a ticket belongs. None of this package's strings is for anybody but
 * the operator, so there is nothing to leave out.
 */

/** A ticket as the repository names them, `P-07`, `A-41b`, `V2-01`, or a decision record. */
const TICKET = /\b(?:[A-Z]|V2|ADR)-\d+[a-z]?\b/u;

// At runtime this file is packages/sensors/dist/test/operator-text.test.js.
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

describe('the text the sensor types write (U-92)', () => {
  it('names a ticket by the pattern, and nothing an operator needs', () => {
    for (const ticket of ['(`P-07`)', 'A-41b', 'V2-01', 'ADR-003', 'arrive with B-03']) {
      assert.match(ticket, TICKET, ticket);
    }
    for (const word of ['SHA-256', 'AES-256', 'UTF-8', 'IF-MIB', 'HOST-RESOURCES-MIB']) {
      assert.doesNotMatch(word, TICKET, word);
    }
  });

  it('cites no ticket, in any string or template under src', () => {
    const files = filesUnder(SRC);
    const texts = files.flatMap(textsIn);
    // The walk reaches what `{}` does not: a channel only a parameter turns on, a default, an
    // error a check throws, a check's message, and the parts of a template.
    assert.ok(files.length > 100, String(files.length));
    for (const [file, text] of [
      [join('types', 'port-tcp.ts'), 'Banner matched'],
      [join('types', 'mail-smtp.ts'), 'Message accepted in'],
      [join('types', 'mail-smtp.ts'), 'Monitoring test message'],
      [join('types', 'port-tcp.ts'), 'this sensor names no port'],
      [join('support', 'flow', 'netflow5.ts'), 'the only version this decoder reads'],
      ['catalogue.ts', ' primary channels for these '],
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
