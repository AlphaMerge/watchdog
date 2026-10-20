import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The edge of every control in the UI, read from its source (`U-87`).
 *
 * `U-23` walked the Credentials tab in a browser and found six buttons edged in the hairline,
 * 1.36:1 on the light surface where WCAG 1.4.11 asks 3:1 of a control's edge, and a list entry's
 * box naming `border-subtle`, a colour the stylesheet does not define, which Tailwind turns into no
 * rule at all. Its test holds that tab as rendered. The same buttons were on the rediscovery rules,
 * a discovery run and a trigger's delete, which no test of that tab could see; these read every
 * component instead, so a control on a page no test renders is held too.
 *
 * **Parsed, not matched with a pattern.** A control's classes are as often a constant (`BUTTON`),
 * an import (`INPUT`) or a ternary as a literal, so each name a `className` uses is followed to
 * what it is declared as, in its own file or the one it is imported from, and every string found
 * there counts. That counts both branches of a ternary, which is right for a rule about what may
 * ever be drawn.
 */

const SRC = resolve(process.cwd(), 'src');
// Off disk, as `charts.test.ts` reads it: a CSS import is empty here.
const stylesheet = readFileSync(join(SRC, 'index.css'), 'utf8');
/** The colours `@theme` gives Tailwind: `border-x`, `bg-x` and `text-x` exist for these. */
const COLOURS = new Set(
  [...stylesheet.matchAll(/--color-([a-z0-9-]+):/gu)].map((match) => match[1] ?? ''),
);

/**
 * What a control's edge may be drawn in. The control grey is 3.22:1 at worst, the accent 4.75:1,
 * and every text colour and state `-fg` 4.5:1 on its own surface (`index.css`); `transparent` is
 * an edge that is not drawn, as on a tab that is not the current one, which its text identifies.
 * The hairline (`border`), a state's tint (`down-border` …) and the surfaces are none of these.
 */
const EDGE = /^(?:control|accent|text|text-muted|[a-z]+-fg|transparent)$/u;

/** What a reader presses or types in. A label is not one here: the control it labels is. */
const CONTROLS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'a',
  'Link',
  'NavLink',
]);

/** What follows `border-`, `bg-` or `text-` when it is a width, a side, a size or a style. */
const NOT_A_COLOUR =
  /^(?:\d+|[tblrxyse](?:-\d+)?|xs|sm|base|lg|\d?xl|left|center|right|justify|start|end|solid|dashed|dotted|double|none|hidden|collapse|separate|transparent|current|inherit|wrap|nowrap|balance|pretty|ellipsis|clip|offset-\d+|inset|cover|contain|no-repeat|repeat|auto|fixed|local|scroll|top|bottom|\[.*\])$/u;

interface Module {
  readonly file: string;
  readonly source: ts.SourceFile;
  /** Every `const` and `function` by name, with what it is declared as. */
  readonly declared: ReadonlyMap<string, readonly ts.Node[]>;
  /** Every name imported from another file of the package, by its local name. */
  readonly imported: ReadonlyMap<string, { readonly from: string; readonly name: string }>;
}

const modules = new Map<string, Module>();

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function moduleFile(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(
    (candidate) => existsSync(candidate),
  );
}

function load(file: string): Module {
  const held = modules.get(file);
  if (held !== undefined) return held;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const declared = new Map<string, ts.Node[]>();
  const declare = (name: string, node: ts.Node): void => {
    declared.set(name, [...(declared.get(name) ?? []), node]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declare(node.name.text, node.initializer);
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body) {
      declare(node.name.text, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const imported = new Map<string, { from: string; name: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    const from = statement.moduleSpecifier.text.startsWith('.')
      ? moduleFile(file, statement.moduleSpecifier.text)
      : undefined;
    if (from === undefined || bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imported.set(element.name.text, { from, name: (element.propertyName ?? element.name).text });
    }
  }

  const loaded = { file, source, declared, imported };
  modules.set(file, loaded);
  return loaded;
}

/** Every string in `node`, and in whatever each name in it is declared as. */
function stringsIn(module: Module, node: ts.Node, seen: Set<string>): string[] {
  const found: string[] = [];
  const visit = (at: ts.Node): void => {
    if (
      ts.isStringLiteral(at) ||
      ts.isNoSubstitutionTemplateLiteral(at) ||
      ts.isTemplateHead(at) ||
      ts.isTemplateMiddle(at) ||
      ts.isTemplateTail(at)
    ) {
      found.push(at.text);
    } else if (ts.isIdentifier(at)) {
      // A property's own name is not a name to follow: `entry.id` follows `entry` only.
      const parent = at.parent;
      const isMember =
        (ts.isPropertyAccessExpression(parent) && parent.name === at) ||
        (ts.isPropertyAssignment(parent) && parent.name === at);
      if (!isMember) found.push(...stringsOf(module, at.text, seen));
    }
    ts.forEachChild(at, visit);
  };
  visit(node);
  return found;
}

/** The strings a name is declared as, here or in the file it is imported from. */
function stringsOf(module: Module, name: string, seen: Set<string>): string[] {
  const key = `${module.file}#${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const local = module.declared.get(name);
  if (local !== undefined) return local.flatMap((node) => stringsIn(module, node, seen));
  const imported = module.imported.get(name);
  return imported === undefined ? [] : stringsOf(load(imported.from), imported.name, seen);
}

/** The classes an element is given: its `className`, and one a spread object carries. */
function classesOf(module: Module, element: ts.JsxOpeningLikeElement): string[] | undefined {
  const seen = new Set<string>();
  let strings: string[] | undefined;
  for (const attribute of element.attributes.properties) {
    if (
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === 'className' &&
      attribute.initializer !== undefined
    ) {
      strings = [...(strings ?? []), ...stringsIn(module, attribute.initializer, seen)];
    } else if (ts.isJsxSpreadAttribute(attribute) && ts.isIdentifier(attribute.expression)) {
      for (const declared of module.declared.get(attribute.expression.text) ?? []) {
        if (!ts.isObjectLiteralExpression(declared)) continue;
        for (const property of declared.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'className'
          ) {
            strings = [...(strings ?? []), ...stringsIn(module, property.initializer, seen)];
          }
        }
      }
    }
  }
  if (strings === undefined) return undefined;
  return strings.flatMap((text) => text.split(/\s+/u)).filter((name) => name !== '');
}

/** A class as Tailwind reads its utility: variants (`hover:`), opacity (`/50`) and `!` off. */
function utilityOf(name: string): string {
  return (name.split(':').at(-1) ?? '').split('/')[0]?.replace(/^!/u, '') ?? '';
}

/** The colour a `border-…` utility draws an edge in; `undefined` for a width, side or style. */
function edgeColourOf(utility: string): string | undefined {
  const match = /^border(?:-[xytblrse](?=-|$))?(?:-(.+))?$/u.exec(utility);
  const rest = match?.[1];
  if (rest === undefined) return undefined;
  if (/^(?:\d+|solid|dashed|dotted|double|none|hidden|collapse|separate)$/u.test(rest)) {
    return undefined;
  }
  return rest.startsWith('spacing') ? undefined : rest;
}

interface Found {
  readonly where: string;
  readonly tag: string;
  readonly classes: readonly string[] | undefined;
  readonly control: boolean;
}

/** Every element in the package with what it is given to wear. */
function elements(): Found[] {
  return filesUnder(SRC)
    .filter((file) => file.endsWith('.tsx'))
    .flatMap((file) => {
      const module = load(file);
      const found: Found[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(module.source);
          const line = module.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          found.push({
            where: `${relative(SRC, file)}:${String(line)} <${tag}>`,
            tag,
            classes: classesOf(module, node),
            control: CONTROLS.has(tag),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(module.source);
      return found;
    });
}

describe('every control, as written (U-87)', () => {
  const all = elements();
  const controls = all.filter((element) => element.control);

  it('edges every control in the control grey, the accent or a text colour, never the hairline or a tint', () => {
    // Enough to know the source was read and the constants followed: `CredentialsPanel`'s
    // `BUTTON`, `discovery-fields`' `INPUT`, `Control`'s ternary, `ReportSettings`' `field`.
    const edged = controls.filter((control) =>
      (control.classes ?? []).some((name) => edgeColourOf(utilityOf(name)) !== undefined),
    );
    expect(edged.length).toBeGreaterThan(150);
    expect(edged.map((control) => control.where)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^routes\/detail\/CredentialsPanel\.tsx:\d+ <button>$/u),
        expect.stringMatching(/^routes\/DiscoveryView\.tsx:\d+ <select>$/u),
        expect.stringMatching(/^forms\/Control\.tsx:\d+ <select>$/u),
        expect.stringMatching(/^reports\/ReportSettings\.tsx:\d+ <textarea>$/u),
      ]),
    );

    const wrong = controls.flatMap((control) =>
      (control.classes ?? [])
        .map((name) => edgeColourOf(utilityOf(name)))
        .filter((colour) => colour !== undefined && !EDGE.test(colour))
        .map((colour) => `${control.where}: border-${String(colour)}`),
    );
    expect(wrong).toEqual([]);
  });

  it('reads the classes of every control that is given any', () => {
    // A `className` that names nothing this can follow — a prop passed in — would be a control the
    // rule above never looked at.
    const unread = controls.filter(
      (control) => control.classes !== undefined && control.classes.length === 0,
    );
    expect(unread.map((control) => control.where)).toEqual([]);
  });

  it('names no colour the stylesheet lacks, on any element, so no edge falls back to the text colour', () => {
    expect(COLOURS.size).toBeGreaterThan(20);
    const unknown = all.flatMap((element) =>
      (element.classes ?? []).flatMap((name) => {
        const utility = utilityOf(name);
        const named = /^(?:border|bg|text|divide|outline|ring)-(.+)$/u.exec(utility)?.[1];
        if (named === undefined || NOT_A_COLOUR.test(named) || COLOURS.has(named)) return [];
        // `border-t-down-fg`: a side, then the colour.
        const sided = /^[xytblrse]-(.+)$/u.exec(named)?.[1];
        return sided !== undefined && COLOURS.has(sided) ? [] : [`${element.where}: ${name}`];
      }),
    );
    expect(unknown).toEqual([]);
  });
});
