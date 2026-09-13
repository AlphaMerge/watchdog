import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * `@ms/shared/charts` stays browser-safe (`E-05`).
 *
 * The web app imports this directory. The rest of `@ms/shared` is service code — `pino`, `ajv`,
 * `node:net` — and one convenient import from it would pull a logger into the browser bundle, or
 * break the web build in a way that names a file nobody touched. So the rule is mechanical: a file
 * here imports only its neighbours.
 */

const directory = new URL('../../src/charts/', import.meta.url);

describe('the charts entry point', () => {
  it('imports nothing outside its own directory', () => {
    const files = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    assert.ok(files.length >= 4, `found ${files.join(', ')}`);
    for (const file of files) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      for (const match of source.matchAll(
        /\bfrom\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/gu,
      )) {
        const specifier = match[1] ?? match[2] ?? '';
        assert.match(
          specifier,
          /^\.\/[\w-]+\.js$/u,
          `${file} imports ${specifier}; this directory is loaded by the browser`,
        );
      }
    }
  });

  it('is published under its own subpath, so the web app never loads the service entry point', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, { default: string }> };
    assert.equal(manifest.exports['./charts']?.default, './dist/src/charts/index.js');
  });
});
