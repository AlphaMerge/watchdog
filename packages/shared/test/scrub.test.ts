import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MIN_SCRUBBED_LENGTH, SCRUBBED, scrubSecrets } from '../src/index.js';

/**
 * The one scrubber (`S-19`, moved here by `A-44`): a check's message on the probe and a
 * notification program's output in the core go through it. What it replaces, and where it stops.
 */
describe('scrubbing a secret out of text', () => {
  it('replaces every occurrence of every exact value', () => {
    assert.equal(
      scrubSecrets('key hunter2 refused; retry with hunter2', ['hunter2', 's3cret-token']),
      `key ${SCRUBBED} refused; retry with ${SCRUBBED}`,
    );
    assert.equal(scrubSecrets('nothing to see', ['hunter2']), 'nothing to see');
    assert.equal(scrubSecrets('no secrets at all', []), 'no secrets at all');
  });

  it('goes longest first, so a secret containing another goes whole', () => {
    assert.equal(scrubSecrets('x hunter2-long y', ['hunter2', 'hunter2-long']), `x ${SCRUBBED} y`);
  });

  it('leaves a value shorter than the floor, and anything encoded or partial', () => {
    assert.equal(MIN_SCRUBBED_LENGTH, 4);
    assert.equal(scrubSecrets('abcdef', ['abc']), 'abcdef');
    assert.equal(scrubSecrets('abcd', ['abcd']), SCRUBBED, 'the floor itself is scrubbed');
    const encoded = Buffer.from('hunter2-long').toString('base64');
    assert.equal(scrubSecrets(encoded, ['hunter2-long']), encoded);
    assert.equal(scrubSecrets('hunter2-', ['hunter2-long']), 'hunter2-');
  });
});
