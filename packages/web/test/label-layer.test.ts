import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Which of the app's own CSS rules sit in a cascade layer, and which must not (`U-18`).
 *
 * **Unlayered CSS beats every layered rule, whatever the specificity or the order.** That one
 * fact decides two opposite things in `index.css`, and getting either backwards fails silently —
 * a declaration is written, accepted by the parser, and discarded.
 *
 * Asserted against the source rather than the built stylesheet because the source is where the
 * decision is made, and because a test that had to run Tailwind would take a build to answer a
 * question about one brace. What it cannot see is the cascade itself, so the reasoning is spelled
 * out here rather than left to the reader of a regex.
 */

/**
 * From the working directory, not from `import.meta.url`: under jsdom that is not a `file:` URL,
 * and `fileURLToPath` throws. Vitest runs with the package as its cwd in both the workspace
 * script and a direct invocation.
 */
const CSS = readFileSync(resolve('src/index.css'), 'utf8');

/** The body of the first `@layer <name> {` block, by brace matching. */
function layerBody(name: string): string {
  const opener = `@layer ${name} {`;
  const start = CSS.indexOf(opener);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start + opener.length - 1; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start + opener.length, i);
    }
  }
  return '';
}

/** Everything outside every `@layer` block — the rules that beat the utilities. */
function unlayered(): string {
  let out = '';
  let i = 0;
  while (i < CSS.length) {
    const next = CSS.indexOf('@layer ', i);
    if (next === -1) {
      out += CSS.slice(i);
      break;
    }
    out += CSS.slice(i, next);
    let depth = 0;
    let j = CSS.indexOf('{', next);
    if (j === -1) break;
    for (; j < CSS.length; j += 1) {
      if (CSS[j] === '{') depth += 1;
      else if (CSS[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

describe('cascade layers', () => {
  it('keeps .ms-label layered, so a colour utility beside it wins', () => {
    // While this rule was unlayered, `class="ms-label text-down-fg"` rendered muted grey and
    // `hover:text-text` did nothing — eight call sites were asking for a colour or a hover they
    // were not getting, and one of them reached about 1.5:1 on a filled accent button.
    expect(layerBody('components')).toContain('.ms-label {');
    expect(unlayered()).not.toContain('.ms-label {');
  });

  it('keeps the chart rules unlayered, so they beat uPlot', () => {
    // The opposite case, and the reason this is not "move all custom CSS into a layer". These
    // override `uplot/dist/uPlot.min.css`, which is imported from a component and is itself
    // unlayered: layering ours would make it lose, and the chart would quietly take uPlot's
    // palette instead of the app's.
    const outside = unlayered();
    expect(outside).toContain('.ms-chart .u-select');
    expect(outside).toContain('.ms-chart-tooltip {');
    expect(layerBody('components')).not.toContain('.ms-chart');
  });
});
