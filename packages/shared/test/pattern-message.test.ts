import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PATTERN_MESSAGE } from '../src/index.js';
import { PATTERN_MESSAGE as PATTERN_MESSAGE_FOR_BROWSER } from '../src/schema/pattern-message.js';

/**
 * `@ms/shared/pattern-message` stays browser-safe (`P-379`).
 *
 * The schema form reads `PATTERN_MESSAGE` from here, so the web bundle loads this file, where it
 * used to write the key as a literal of its own. The service entry point pulls in `ajv`, `pino`
 * and `node:` modules, so the rule is checked on what runs, as `capability-versions` is: the
 * compiled file imports nothing at all.
 */
describe('the pattern message entry point', () => {
  it('compiles to a file that imports nothing', () => {
    // Beside this test's own compiled file: `dist/test/` and `dist/src/`.
    const compiled = readFileSync(
      new URL('../src/schema/pattern-message.js', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(compiled, /^\s*import\b/mu, 'a static import reached the browser file');
    assert.doesNotMatch(compiled, /\bimport\s*\(/u, 'a dynamic import reached the browser file');
    assert.doesNotMatch(compiled, /\brequire\s*\(/u);
  });

  it('is published under its own subpath, so the web app never loads the service entry point', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, { default: string }> };
    assert.equal(
      manifest.exports['./pattern-message']?.default,
      './dist/src/schema/pattern-message.js',
    );
  });

  it('is the key the service entry point exports', () => {
    assert.equal(PATTERN_MESSAGE_FOR_BROWSER, PATTERN_MESSAGE);
    assert.equal(PATTERN_MESSAGE, 'x-patternMessage');
  });
});
