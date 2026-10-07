import { strict as assert } from 'node:assert';
import { parseProbeToCore, RESULT_LIMITS, type CheckResult, type UnfitResults } from '@ms/shared';

/**
 * That the core's own parser takes a batch holding this result **as it was sent**. Since `P-281`
 * the core fits a result itself and refuses alone one it cannot, so not throwing says nothing:
 * what says the probe fitted it is that the core had nothing to fit or refuse.
 */
export function assertCoreTakesAsSent(result: CheckResult): void {
  let unfit: UnfitResults | undefined;
  const parsed = parseProbeToCore(
    { type: 'results', batchId: 'fits-1', results: [result] },
    { onUnfitResults: (told) => (unfit = told) },
  );
  assert.equal(unfit, undefined, `the core had to fit or refuse it: ${JSON.stringify(unfit)}`);
  assert.ok(parsed.type === 'results' && parsed.results.length === 1);
}

/**
 * That a runner made `test.unfit`'s readings fit the wire (`P-277`): the core's own parser takes
 * a batch holding it, no string in it holds a NUL, and only the one channel fit to send is sent,
 * with its name and unit clipped, and the message says how many were not (`P-292`).
 */
export function assertFits(result: CheckResult | undefined): void {
  assert.ok(result !== undefined);
  assert.equal(result.outcome, 'ok');
  assertCoreTakesAsSent(result);
  assert.ok(!JSON.stringify(result).includes('\\u0000'), 'no NUL anywhere');
  assert.ok(result.message.startsWith('saidmmm'), result.message.slice(0, 20));
  // The four channels that could not be sent, said in the sensor's own message (`P-292`), and
  // the check's words clipped to make room for it.
  assert.ok(
    result.message.endsWith('m… (4 channels could not be sent)'),
    result.message.slice(-40),
  );
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
