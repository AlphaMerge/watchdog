import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { parseProbeToCore, type CheckResult, type UnfitResults } from '../src/protocol/messages.js';
import { fitResult, RESULT_LIMITS } from '../src/protocol/result-fit.js';

/**
 * `fitResult` (`P-277`): a check result made to fit the wire schema and PostgreSQL before a runner
 * hands it on. The property at the end holds it to the core's own parser, so the bounds here and
 * the schema's cannot drift apart.
 */

const base: CheckResult = {
  sensorId: 7,
  at: '2026-10-07T09:00:00.000Z',
  outcome: 'ok',
  message: 'all well',
  durationMs: 12.5,
  channels: [{ key: 'value', value: 42, name: 'Value', unit: 'ms' }],
};

/**
 * What the core does with a batch holding this one result: throws unless its schema takes the
 * result as sent. Since `P-281` the core fits and refuses results itself, so a result it took is
 * not enough: it must not have had to change it.
 */
function coreTakes(result: CheckResult): void {
  let unfit: UnfitResults | undefined;
  const parsed = parseProbeToCore(
    { type: 'results', batchId: 'fit-1', results: [result] },
    { onUnfitResults: (told) => (unfit = told) },
  );
  assert.equal(unfit, undefined, `the core had to fit it: ${JSON.stringify(unfit)}`);
  assert.ok(parsed.type === 'results' && parsed.results.length === 1);
}

const codePoints = (text: string): number => Array.from(text).length;

describe('fitResult', () => {
  it('sends a result that fits as it is', () => {
    const fitted = fitResult({
      ...base,
      channels: [
        ...base.channels,
        { key: 'octets', value: 1, counter: '18446744073709551615', counterBits: 64 },
      ],
    });
    assert.deepEqual(fitted.result, {
      ...base,
      channels: [
        ...base.channels,
        { key: 'octets', value: 1, counter: '18446744073709551615', counterBits: 64 },
      ],
    });
    assert.deepEqual(fitted.problems, []);
  });

  it('keeps a refusal’s mark, and only on what had it', () => {
    const refused = fitResult({ ...base, outcome: 'error', channels: [], withheld: true });
    assert.equal(refused.result.withheld, true);
    assert.equal('withheld' in fitResult(base).result, false);
  });

  it('clips a long message to the limit, ending in an ellipsis', () => {
    const { result, problems } = fitResult({ ...base, message: 'x'.repeat(5_000) });
    assert.equal(result.message.length, RESULT_LIMITS.message);
    assert.ok(result.message.endsWith('x…'));
    assert.deepEqual(problems, [], 'the ellipsis says it; nothing was lost from the readings');
    coreTakes(result);
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    // 1,998 units, then a pair across the 1,999th and 2,000th.
    const { result } = fitResult({ ...base, message: `${'x'.repeat(1_998)}😀${'y'.repeat(10)}` });
    assert.equal(result.message, `${'x'.repeat(1_998)}…`);
    assert.ok(codePoints(result.message) <= RESULT_LIMITS.message);
  });

  it('takes the NULs out of every string PostgreSQL would be handed', () => {
    const { result } = fitResult({
      ...base,
      message: 'a\u0000b',
      channels: [{ key: 'value', value: 1, name: 'N\u0000ame', unit: 'm\u0000s' }],
    });
    assert.equal(result.message, 'ab');
    assert.deepEqual(result.channels, [{ key: 'value', value: 1, name: 'Name', unit: 'ms' }]);
  });

  it('drops a key with a lone surrogate, and makes other text what PostgreSQL will store', () => {
    // `pg` encodes a lone surrogate as U+FFFD. A key so stored never matched the key sent, so
    // every reading of the channel was dropped and the channel created again every batch.
    const { result, problems } = fitResult({
      ...base,
      message: 'high \uD800 and low \uDC00, a pair 😀',
      channels: [
        { key: 'lone\uD800', value: 1 },
        { key: '\uDC00lone', value: 2 },
        { key: 'pair😀', value: 3, name: 'n\uD83D', unit: '\uDE00u' },
      ],
    });
    assert.equal(result.message, 'high \uFFFD and low \uFFFD, a pair 😀');
    assert.deepEqual(result.channels, [
      { key: 'pair😀', value: 3, name: 'n\uFFFD', unit: '\uFFFDu' },
    ]);
    assert.equal(problems.length, 2);
    assert.match(problems[0] ?? '', /well-formed/);
  });

  it('drops a channel whose key cannot be sent, and never clips a key into another one', () => {
    const { result, problems } = fitResult({
      ...base,
      channels: [
        { key: 'k'.repeat(RESULT_LIMITS.key), value: 1 },
        { key: 'k'.repeat(RESULT_LIMITS.key + 1), value: 2 },
        { key: '', value: 3 },
        { key: 'a\u0000b', value: 4 },
        { key: 5 as unknown as string, value: 5 },
        // A hundred characters as the schema counts them, two hundred UTF-16 units.
        { key: '😀'.repeat(RESULT_LIMITS.key), value: 6 },
      ],
    });
    assert.deepEqual(
      result.channels.map((channel) => channel.value),
      [1, 6],
    );
    assert.equal(problems.length, 4);
    assert.match(problems[0] ?? '', /channel 1's key is not 1 to 100 characters/);
    coreTakes(result);
  });

  it('drops a channel with no finite number, which leaves a gap and never a made-up value', () => {
    const { result, problems } = fitResult({
      ...base,
      channels: [
        { key: 'nan', value: Number.NaN },
        { key: 'inf', value: Number.POSITIVE_INFINITY },
        { key: 'text', value: '4' as unknown as number },
        { key: 'missing' } as unknown as CheckResult['channels'][number],
        { key: 'value', value: 0 },
      ],
    });
    assert.deepEqual(result.channels, [{ key: 'value', value: 0 }]);
    assert.equal(problems.length, 4);
    assert.match(problems[0] ?? '', /"nan" has no finite number/);
  });

  it('leaves off a counter or a width the schema refuses, and keeps the value', () => {
    const { result, problems } = fitResult({
      ...base,
      channels: [
        { key: 'a', value: 1, counter: '-1' },
        { key: 'b', value: 2, counter: '1'.repeat(21) },
        { key: 'c', value: 3, counterBits: 16 as unknown as 32 },
        { key: 'd', value: 4, counter: '9', counterBits: 32 },
      ],
    });
    assert.deepEqual(result.channels, [
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
      { key: 'c', value: 3 },
      { key: 'd', value: 4, counter: '9', counterBits: 32 },
    ]);
    assert.equal(problems.length, 3);
  });

  it('clips a name and a unit, and leaves off a name left empty', () => {
    const { result, problems } = fitResult({
      ...base,
      channels: [
        { key: 'a', value: 1, name: 'n'.repeat(500), unit: 'u'.repeat(500) },
        { key: 'b', value: 2, name: '\u0000' },
      ],
    });
    assert.equal(result.channels[0]?.name?.length, RESULT_LIMITS.name);
    assert.equal(result.channels[0].unit?.length, RESULT_LIMITS.unit);
    assert.deepEqual(result.channels[1], { key: 'b', value: 2 });
    assert.deepEqual(problems, []);
    coreTakes(result);
  });

  it('sends the first channels up to the limit and says how many it dropped', () => {
    const channels = Array.from({ length: RESULT_LIMITS.channels + 3 }, (_, at) => ({
      key: `c${String(at)}`,
      value: at,
    }));
    const { result, problems } = fitResult({ ...base, channels });
    assert.equal(result.channels.length, RESULT_LIMITS.channels);
    assert.equal(result.channels.at(-1)?.key, `c${String(RESULT_LIMITS.channels - 1)}`);
    assert.deepEqual(problems, ['3 channels past the first 500 were dropped']);
    coreTakes(result);
  });

  it('copies no field the schema does not know, on a channel or on the result', () => {
    const { result } = fitResult({
      ...base,
      extra: 1,
      channels: [{ key: 'value', value: 1, limits: { high: 2 } }],
    } as unknown as CheckResult);
    assert.deepEqual(result, { ...base, channels: [{ key: 'value', value: 1 }] });
  });

  it('gives a duration that is not a number of milliseconds as 0', () => {
    for (const durationMs of [Number.NaN, -1, Number.POSITIVE_INFINITY, '5' as unknown as number]) {
      assert.equal(fitResult({ ...base, durationMs }).result.durationMs, 0, String(durationMs));
    }
  });

  it('gives a message that is not text as empty', () => {
    assert.equal(fitResult({ ...base, message: 5 as unknown as string }).result.message, '');
  });

  it('makes anything at all into a result the core takes, with no NUL in it', () => {
    const text = fc.string({ unit: 'binary', maxLength: 2_400 });
    const channel = fc.oneof(
      fc.record(
        {
          key: fc.oneof(text, fc.constant(''), fc.integer()),
          value: fc.oneof(fc.double(), fc.integer(), text, fc.constant(null)),
          counter: fc.oneof(text, fc.stringMatching(/^[0-9]{1,22}$/)),
          counterBits: fc.constantFrom(16, 32, 64, '64'),
          name: fc.oneof(text, fc.integer()),
          unit: text,
          other: fc.anything(),
        },
        { requiredKeys: [] },
      ),
      fc.anything(),
    );
    fc.assert(
      fc.property(
        text,
        fc.oneof(fc.double(), fc.integer()),
        fc.array(channel, { maxLength: 520 }),
        (message, durationMs, channels) => {
          const { result } = fitResult({
            ...base,
            message,
            durationMs,
            channels: channels as CheckResult['channels'],
          });
          coreTakes(result);
          assert.ok(!JSON.stringify(result).includes('\\u0000'));
          // Node's own `isWellFormed`, which the ES2023 lib this build targets does not type.
          const texts = [
            result.message,
            ...result.channels.flatMap((one) => [one.key, one.name ?? '', one.unit ?? '']),
          ];
          for (const one of texts) {
            assert.ok((one as unknown as { isWellFormed(): boolean }).isWellFormed(), one);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
