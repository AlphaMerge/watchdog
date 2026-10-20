import type { RouteKey } from './surface.js';

/**
 * What `docs/api-reference.md` starts a mark with, under a tag's heading or a route's (`H-51`):
 * `scripts/docs/api-reference-render.mjs` writes it first under the heading, before anything that
 * reads as though the release had the route.
 */
export const NOT_IN_RELEASE = '**Not in 1.0 — v2, in the full build only.**';

/**
 * Every route the API reference lists, and whether it is marked as not in 1.0: by the note under
 * its tag's heading, or by one under its own. The shared schemas' headings are not routes. Read by
 * `candidate-surface.test.ts`, which holds the marks to a v1 core, and by `release-docs.test.ts`,
 * which holds the shipped documents to them; `api-reference-render.test.ts` holds this reader to
 * the renderer.
 */
export function referenceMarks(page: string): Map<RouteKey, boolean> {
  const lines = page.split('\n');
  /** The first line after `index` that is not blank. */
  const next = (index: number): string =>
    lines.slice(index + 1).find((line) => line.trim() !== '') ?? '';
  const marks = new Map<RouteKey, boolean>();
  let wholeTag = false;
  lines.forEach((line, index) => {
    if (line.startsWith('## ')) wholeTag = next(index).startsWith(NOT_IN_RELEASE);
    const route = /^### `([A-Z]+) (\/[^`\s]*)`$/u.exec(line);
    if (route === null) return;
    const key: RouteKey = `${route[1] ?? ''} ${route[2] ?? ''}`;
    if (marks.has(key)) throw new Error(`the API reference lists ${key} twice`);
    marks.set(key, wholeTag || next(index).startsWith(NOT_IN_RELEASE));
  });
  return marks;
}
