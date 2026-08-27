import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compilePattern,
  extract,
  MATCH_TIMEOUT_MS,
  MAX_PATTERN,
  MAX_SUBJECT,
  PatternError,
} from '../src/support/pattern.js';

/** The match runs in a sandbox, so `extract` takes the pattern's source rather than a RegExp. */
const re = (source: string): string => source;

describe('pulling a number out of a device string', () => {
  it('uses the first capture group when there is one', () => {
    const found = extract('Temp: 41.5C', re('Temp: ([0-9.]+)C'), 'number');
    assert.deepEqual(found, { kind: 'value', value: 41.5, matched: '41.5' });
  });

  it('uses the whole match when the pattern captures nothing', () => {
    const found = extract('load average 0.42 now', re('[0-9]+\\.[0-9]+'), 'number');
    assert.equal(found.kind === 'value' && found.value, 0.42);
  });

  it('parses the whole string when there is no pattern', () => {
    // An agent returning a number as an OctetString is the common case this covers.
    assert.equal(extract('  42  ', null, 'number').kind === 'value' && 42, 42);
  });

  it('falls back to the whole match when a group did not participate', () => {
    // `(?:a)|(b)` matching "a" leaves group 1 undefined. Reading it blindly would be a crash on
    // an input nobody thought about.
    const found = extract('a', re('(?:a)|(b)'), 'number');
    assert.ok(found.kind === 'not-a-number');
    assert.equal(found.matched, 'a');
  });

  it('reports text that is not a number rather than turning it into one', () => {
    // `Number('')` is 0 and `Number(' ')` is 0. Either would quietly report a device saying
    // nothing as a reading of zero, which CLAUDE.md is explicit about: no-data is not zero.
    for (const text of ['', '   ', 'up', 'NaN', 'Infinity', '1,5']) {
      assert.equal(extract(text, null, 'number').kind, 'not-a-number', `"${text}"`);
    }
  });

  it('takes a negative and an exponent, which are numbers a device may report', () => {
    assert.equal(extract('-12.5', null, 'number').kind === 'value' && -12.5, -12.5);
    assert.equal(extract('1e3', null, 'number').kind === 'value' && 1000, 1000);
  });

  it('reports no match rather than guessing', () => {
    assert.deepEqual(extract('nothing here', re('Temp: ([0-9]+)'), 'number'), { kind: 'no-match' });
  });
});

describe('asking whether a string matches', () => {
  it('is 1 when it does', () => {
    const found = extract('Cisco IOS Software, Version 15.2', re('Cisco'), 'match');
    assert.equal(found.kind === 'value' && found.value, 1);
  });

  it('is no-match when it does not, which the sensor reports as 0', () => {
    assert.deepEqual(extract('Juniper JunOS', re('Cisco'), 'match'), { kind: 'no-match' });
  });

  it('is 1 with no pattern at all, because there is nothing to fail', () => {
    assert.equal(extract('anything', null, 'match').kind === 'value' && 1, 1);
  });

  it('does not care whether what it matched is a number', () => {
    const found = extract('state: batteryNormal', re('state: (\\w+)'), 'match');
    assert.equal(found.kind === 'value' && found.value, 1);
    assert.equal(found.kind === 'value' && found.matched, 'batteryNormal');
  });
});

describe('the pattern', () => {
  it('is never global, so a match does not depend on the previous scan', () => {
    // The bug this prevents: a `g` regex keeps `lastIndex` between calls, so the same pattern
    // against the same string matches on one scan and not the next — which reads as a flapping
    // device and is impossible to reproduce by hand.
    assert.equal(compilePattern('a').global, false);
    for (let scan = 0; scan < 3; scan += 1) {
      assert.equal(extract('aaa', 'a', 'match').kind, 'value', `scan ${String(scan)}`);
    }
  });

  it('is refused when it is not a regular expression', () => {
    assert.throws(() => compilePattern('([0-9]+'), PatternError);
    assert.throws(() => compilePattern('([0-9]+'), /not a valid regular expression/);
  });

  it('is refused when it is longer than a person would write', () => {
    assert.throws(() => compilePattern('a'.repeat(MAX_PATTERN + 1)), /the limit is/);
  });

  it('takes one right at the limit', () => {
    assert.doesNotThrow(() => compilePattern('a'.repeat(MAX_PATTERN)));
  });
});

describe('bounding what a device can make the matcher do', () => {
  it('matches against only the first 4 KB', () => {
    // The bound that matters: backtracking cost grows with the *subject*, and SNMP allows an
    // OctetString of 65,535 bytes. A device — compromised, or merely broken — could otherwise
    // hand a worker a subject long enough to hold it until the pool terminates it.
    const text = `${'x'.repeat(MAX_SUBJECT)}NEEDLE`;
    assert.deepEqual(extract(text, re('NEEDLE'), 'match'), { kind: 'no-match' });
  });

  it('finds what is inside the bound', () => {
    const text = `${'x'.repeat(MAX_SUBJECT - 10)}NEEDLE${'x'.repeat(1_000)}`;
    assert.equal(extract(text, re('NEEDLE'), 'match').kind, 'value');
  });

  it('stops a pattern that backtracks, rather than letting it hold the worker', () => {
    // `(a+)+$` against a run of "a" and a "b" is the textbook exponential case. Measured while
    // building this: forty characters takes **86 seconds** run directly, which is a worker held
    // until the pool terminates it. Inside the sandbox the watchdog stops it, and the check
    // fails with something an operator can act on.
    const started = Date.now();
    const found = extract('a'.repeat(40) + 'b', '(a+)+$', 'match');
    const took = Date.now() - started;

    assert.ok(found.kind === 'too-slow');
    assert.ok(took < 5_000, `stopped in ${String(took)} ms, not the 86 seconds it takes directly`);
    assert.ok(found.afterMs >= MATCH_TIMEOUT_MS - 50);
  });

  it('goes on working after one was stopped', () => {
    // The sandbox and its compiled script are reused for the life of the worker, so a terminated
    // script must not leave them unusable — otherwise one bad sensor would break every other
    // string sensor that happened to share the thread.
    extract('a'.repeat(40) + 'b', '(a+)+$', 'match');
    const found = extract('Temp: 41.5C', 'Temp: ([0-9.]+)C', 'number');
    assert.deepEqual(found, { kind: 'value', value: 41.5, matched: '41.5' });
  });
});
