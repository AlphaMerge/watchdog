import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  capabilitiesFor,
  describeSkew,
  isProtocolCompatible,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  versionFor,
} from '../src/index.js';
import {
  INTRODUCED,
  isProtocolCompatible as isProtocolCompatibleForBrowser,
  MIN_PROTOCOL_VERSION as MIN_PROTOCOL_VERSION_FOR_BROWSER,
  versionFor as versionForBrowser,
} from '../src/protocol/capability-versions.js';

/**
 * `@ms/shared/capability-versions` stays browser-safe (`P-294`).
 *
 * The add-sensor form reads the version a listener's counter arrived in from here, so the web
 * bundle loads this file. The rest of `protocol/` pulls in `ajv` through the message schemas, and
 * one value import from a neighbour would carry it into the browser. So the rule is checked on
 * what runs: the compiled file imports nothing at all.
 */
describe('the capability versions entry point', () => {
  it('compiles to a file that imports nothing', () => {
    // Beside this test's own compiled file: `dist/test/` and `dist/src/`.
    const compiled = readFileSync(
      new URL('../src/protocol/capability-versions.js', import.meta.url),
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
      manifest.exports['./capability-versions']?.default,
      './dist/src/protocol/capability-versions.js',
    );
  });

  it('is the table every gate reads, with every capability once, oldest first', () => {
    assert.equal(versionFor, versionForBrowser, 'one function, re-exported');
    const names = INTRODUCED.map(([name]) => name);
    assert.deepEqual([...names].sort(), Object.keys(capabilitiesFor(PROTOCOL_VERSION)).sort());
    assert.equal(new Set(names).size, names.length);
    for (let index = 1; index < INTRODUCED.length; index++) {
      const [name, since] = INTRODUCED[index] ?? ['', 0];
      const [before, earlier] = INTRODUCED[index - 1] ?? ['', 0];
      assert.ok(
        since >= earlier,
        `${name} at ${String(since)} after ${before} at ${String(earlier)}`,
      );
    }
    assert.ok(INTRODUCED.every(([, since]) => since <= PROTOCOL_VERSION));
  });

  it('holds the floor the handshake refuses by, so the form says "refused" by the same rule (U-33)', () => {
    assert.equal(isProtocolCompatible, isProtocolCompatibleForBrowser, 'one function, re-exported');
    assert.equal(MIN_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION_FOR_BROWSER);
    // And `incompatible`, which the registry refuses a hello over, is exactly its negation.
    for (const version of [
      -1,
      0,
      MIN_PROTOCOL_VERSION,
      12,
      PROTOCOL_VERSION,
      PROTOCOL_VERSION + 1,
      1.5,
    ]) {
      assert.equal(
        describeSkew(version).kind === 'incompatible',
        !isProtocolCompatible(version),
        String(version),
      );
    }
  });
});
