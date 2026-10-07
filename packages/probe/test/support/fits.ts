import { strict as assert } from 'node:assert';
import { parseProbeToCore, RESULT_LIMITS, type CheckResult } from '@ms/shared';

/**
 * That a runner made `test.unfit`'s readings fit the wire (`P-277`): the core's own parser takes
 * a batch holding it, no string in it holds a NUL, and only the one channel fit to send is sent,
 * with its name and unit clipped.
 */
export function assertFits(result: CheckResult | undefined): void {
  assert.ok(result !== undefined);
  assert.equal(result.outcome, 'ok');
  assert.doesNotThrow(() =>
    parseProbeToCore({ type: 'results', batchId: 'fits-1', results: [result] }),
  );
  assert.ok(!JSON.stringify(result).includes('\\u0000'), 'no NUL anywhere');
  assert.ok(result.message.startsWith('saidmmm'), result.message.slice(0, 20));
  assert.ok(result.message.endsWith('…'));
  assert.equal(result.message.length, RESULT_LIMITS.message);
  assert.deepEqual(
    result.channels.map((channel) => channel.key),
    ['kept'],
  );
  const [kept] = result.channels;
  assert.ok(kept?.name !== undefined && kept.unit !== undefined);
  assert.equal(kept.value, 1);
  assert.equal(kept.name.length, RESULT_LIMITS.name);
  assert.ok(kept.name.startsWith('namednnn'));
  assert.equal(kept.unit.length, RESULT_LIMITS.unit);
}
