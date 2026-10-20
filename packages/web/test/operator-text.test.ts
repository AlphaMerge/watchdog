import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * No internal ticket in anything the UI says (`U-92`).
 *
 * The UI's own text is written here, and read by an operator who has no `TASKS.md`: the empty
 * catalogue said "P-08 (Ping), P-09 (HTTP), P-10 (Port) and P-11 (DNS) are the first four types",
 * and a sensor with no channels that they exist from its creation "(P-05)". What the core serves —
 * a schema's descriptions, a channel's name, a lookup's text — is the core's test to hold
 * (`operator-text.test.ts` there); this holds what the web package writes itself.
 *
 * **Read from the source, as `control-edges.test.ts` reads it**, so text on a page no test renders
 * is held too. Every string, template and JSX text counts, and a comment does not: it is the one
 * place in a source file a ticket belongs.
 */

/** A ticket as the repository names them, `P-07`, `A-41b`, `V2-01`, or a decision record. */
const TICKET = /\b(?:[A-Z]|V2|ADR)-\d+[a-z]?\b/u;

const SRC = resolve(process.cwd(), 'src');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/** Every string a source file holds outside its comments, with the line it is on. */
function textsIn(file: string): { readonly line: number; readonly text: string }[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the text the UI writes itself (U-92)', () => {
  it('names a ticket by the pattern, and nothing an operator needs', () => {
    for (const ticket of ['(`P-07`)', 'A-41b', 'V2-01', 'ADR-003', 'P-08 (Ping)']) {
      expect(ticket).toMatch(TICKET);
    }
    for (const word of ['SHA-256', 'UTF-8', 'AES-256', 'abc-123', 'IF-MIB', 'x-patternMessage']) {
      expect(word).not.toMatch(TICKET);
    }
  });

  it('cites no ticket, in any string, template or JSX text under src', () => {
    const files = filesUnder(SRC);
    const texts = files.flatMap((file) =>
      textsIn(file).map((one) => ({ ...one, file: relative(SRC, file) })),
    );
    // The walk reaches the pages, their attributes and their JSX text.
    expect(files.length).toBeGreaterThan(100);
    expect(texts.some((one) => one.file === join('routes', 'Overview.tsx'))).toBe(true);
    expect(texts.some((one) => one.text.includes('No channels.'))).toBe(true);
    expect(
      texts
        .filter((one) => TICKET.test(one.text))
        .map((one) => `${one.file}:${String(one.line)}: ${one.text.trim()}`),
    ).toEqual([]);
  });
});
