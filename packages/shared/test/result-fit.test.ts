import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  parseProbeToCore,
  type CheckFailure,
  type CheckResult,
  type UnfitResults,
} from '../src/protocol/messages.js';
import { fitFailure, fitLabel, fitResult, RESULT_LIMITS } from '../src/protocol/result-fit.js';

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
    assert.equal(fitted.dropped, 0);
  });

  it('keeps a refusal’s mark, and only on what had it', () => {
    const refused = fitResult({ ...base, outcome: 'error', channels: [], withheld: true });
    assert.equal(refused.result.withheld, true);
    assert.equal('withheld' in fitResult(base).result, false);
  });

  it('keeps where a failed check failed, bounded, and on a failed check only (P-285)', () => {
    const failed: CheckResult = { ...base, outcome: 'error', message: 'no reply', channels: [] };
    const named = { phase: 'connect', target: '192.0.2.7:161' };
    assert.deepEqual(fitResult({ ...failed, failure: named }).result.failure, named);
    // A target that is not a plain host is left off; a phase that is not a word takes it all.
    assert.deepEqual(
      fitResult({ ...failed, failure: { phase: 'connect', target: 'u:p@192.0.2.7' } }).result
        .failure,
      { phase: 'connect' },
    );
    assert.equal(
      'failure' in fitResult({ ...failed, failure: { phase: 'Connect to', target: 'h' } }).result,
      false,
    );
    // A success has nowhere it failed, and the schema refuses one that says so.
    assert.equal('failure' in fitResult({ ...base, failure: named }).result, false);
    assert.equal('failure' in fitResult(failed).result, false);
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
    assert.equal(
      result.message,
      'high \uFFFD and low \uFFFD, a pair 😀 (2 channels could not be sent)',
    );
    assert.deepEqual(result.channels, [
      { key: 'pair😀', value: 3, name: 'n\uFFFD', unit: '\uFFFDu' },
    ]);
    assert.equal(problems.length, 2);
    assert.match(problems[0] ?? '', /well-formed/);
  });

  it('drops a channel whose key cannot be sent, and never clips a key into another one', () => {
    const { result, problems, dropped } = fitResult({
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
    // `P-283`: what Probe Health counts, one for each channel that is not sent.
    assert.equal(dropped, 4);
    assert.match(problems[0] ?? '', /channel 1's key is not 1 to 100 characters/);
    coreTakes(result);
  });

  it('drops a channel with no finite number, which leaves a gap and never a made-up value', () => {
    const { result, problems, dropped } = fitResult({
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
    assert.equal(dropped, 4);
    assert.match(problems[0] ?? '', /"nan" has no finite number/);
  });

  it('leaves off a counter or a width the schema refuses, and keeps the value', () => {
    const { result, problems, dropped } = fitResult({
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
    // Each value was sent, so no reading was dropped (`P-283`).
    assert.equal(dropped, 0);
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
    const { result, problems, dropped } = fitResult({ ...base, channels });
    assert.equal(result.channels.length, RESULT_LIMITS.channels);
    assert.equal(dropped, 3);
    assert.equal(result.channels.at(-1)?.key, `c${String(RESULT_LIMITS.channels - 1)}`);
    assert.deepEqual(problems, ['3 channels past the first 500 were dropped']);
    coreTakes(result);
  });

  describe('saying in the sensor’s own message what was dropped (`P-292`)', () => {
    const unsendable = { key: 'nan', value: Number.NaN };

    it('ends the message with how many channels could not be sent', () => {
      const one = fitResult({ ...base, channels: [...base.channels, unsendable] });
      assert.equal(one.result.message, 'all well (1 channel could not be sent)');
      const three = fitResult({
        ...base,
        channels: [unsendable, { key: '', value: 1 }, 'not a channel', ...base.channels],
      } as unknown as CheckResult);
      assert.equal(three.dropped, 3);
      assert.equal(three.result.message, 'all well (3 channels could not be sent)');
      coreTakes(three.result);
    });

    it('says it alone when the check had nothing to say', () => {
      const { result } = fitResult({ ...base, message: '', channels: [unsendable] });
      assert.equal(result.message, '1 channel could not be sent');
    });

    it('counts the channels past the limit with the rest', () => {
      const channels = Array.from({ length: RESULT_LIMITS.channels + 2 }, (_, at) => ({
        key: `c${String(at)}`,
        value: at,
      }));
      channels[0] = unsendable;
      const { result } = fitResult({ ...base, channels });
      assert.equal(result.message, 'all well (3 channels could not be sent)');
    });

    it('keeps the note whole when the message is clipped, and clips the check’s words instead', () => {
      const { result } = fitResult({
        ...base,
        message: 'x'.repeat(5_000),
        channels: [unsendable],
      });
      assert.equal(result.message.length, RESULT_LIMITS.message);
      assert.ok(result.message.endsWith('x… (1 channel could not be sent)'), result.message);
      coreTakes(result);
    });

    it('says nothing when every value was sent, even with a counter left off', () => {
      const { result, problems } = fitResult({
        ...base,
        channels: [{ key: 'a', value: 1, counter: '-1' }],
      });
      assert.equal(problems.length, 1);
      assert.equal(result.message, 'all well');
    });

    it('says it once, however often the result is fitted again', () => {
      // The drain fits a spooled result on every retry, and the core fits what it refused.
      const once = fitResult({ ...base, channels: [unsendable, ...base.channels] });
      const twice = fitResult(once.result);
      assert.deepEqual(twice.result, once.result);
      assert.equal(twice.dropped, 0);
    });

    it('leaves the outcome as the check gave it', () => {
      // A Warning would change alarm volume (`M-17`); the message says it, the state does not.
      const { result } = fitResult({ ...base, channels: [unsendable] });
      assert.equal(result.outcome, 'ok');
    });
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
    // Words and hosts near their bounds as well as anything at all (`P-285`).
    const failure = fc.oneof(
      fc.record(
        {
          phase: fc.oneof(text, fc.stringMatching(/^[a-z][a-zA-Z0-9_ -]{0,33}$/), fc.integer()),
          target: fc.oneof(text, fc.stringMatching(/^[A-Za-z0-9.:@/?#%[\] -]{0,257}$/)),
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
        fc.constantFrom('ok' as const, 'error' as const),
        failure,
        (message, durationMs, channels, outcome, failed) => {
          const { result, dropped } = fitResult({
            ...base,
            outcome,
            message,
            durationMs,
            channels: channels as CheckResult['channels'],
            failure: failed as CheckFailure,
          });
          coreTakes(result);
          // `P-283`: every channel given is sent or counted as dropped, never both or neither.
          assert.equal(result.channels.length + dropped, channels.length);
          // `P-292`: the message says so whenever one was dropped, and fitting again adds nothing.
          if (dropped > 0) {
            const said = `${String(dropped)} channel${dropped === 1 ? '' : 's'} could not be sent`;
            assert.ok(
              result.message === said || result.message.endsWith(` (${said})`),
              result.message,
            );
          }
          assert.deepEqual(fitResult(result).result, result);
          assert.ok(!JSON.stringify(result).includes('\\u0000'));
          // Node's own `isWellFormed`, which the ES2023 lib this build targets does not type.
          const texts = [
            result.message,
            ...result.channels.flatMap((one) => [one.key, one.name ?? '', one.unit ?? '']),
          ];
          for (const one of texts) {
            assert.ok((one as unknown as { isWellFormed(): boolean }).isWellFormed(), one);
          }
          // Where it failed is kept exactly when `fitFailure` keeps it, and never on a success.
          const bounded = outcome === 'error' ? fitFailure(failed) : null;
          assert.deepEqual(result.failure, bounded ?? undefined);
        },
      ),
      { numRuns: 300 },
    );
  });
});

/**
 * `fitFailure` (`P-285`): the phase a check failed in and the host it was acting on, as the wire
 * carries them. The target is listed rather than filtered: what could carry a credential cannot
 * pass, whatever an error put in it.
 */
describe('fitFailure', () => {
  it('keeps a phase that is a word and a target that is a plain host', () => {
    for (const target of [
      '192.0.2.7',
      '192.0.2.7:22',
      'switch-3.example.net',
      'switch_3:161',
      '[2001:db8::7]:443',
      '2001:db8::7',
      'fe80::1%eth0',
      'a'.repeat(255),
    ]) {
      assert.deepEqual(fitFailure({ phase: 'host-key', target }), { phase: 'host-key', target });
    }
    for (const phase of ['connect', 'getBulk', 'worker-crash', 'tls13', 'a'.repeat(32)]) {
      assert.deepEqual(fitFailure({ phase }), { phase });
    }
  });

  it('leaves off a target that could carry more than a host, and keeps the phase', () => {
    for (const target of [
      'admin:secret@192.0.2.7',
      'https://192.0.2.7/',
      '192.0.2.7/status',
      '192.0.2.7?token=abc',
      'host#frag',
      'key=value',
      'two words',
      'tab\there',
      'nul\u0000',
      '',
      'a'.repeat(256),
      'b\u00fccher.example',
      7,
      null,
    ]) {
      assert.deepEqual(
        fitFailure({ phase: 'connect', target }),
        { phase: 'connect' },
        String(target),
      );
    }
  });

  it('gives nothing for a phase that is not a word, or for what is not a failure', () => {
    for (const phase of [
      '',
      'Connect',
      '1connect',
      'get_bulk',
      'connect to h',
      'a'.repeat(33),
      7,
    ]) {
      assert.equal(fitFailure({ phase, target: '192.0.2.7' }), null, String(phase));
    }
    for (const raw of [undefined, null, 'exec', 7, ['exec'], { target: '192.0.2.7' }]) {
      assert.equal(fitFailure(raw), null);
    }
  });

  it('copies nothing else an error held: no command, no address it was pinned to', () => {
    assert.deepEqual(
      fitFailure({ phase: 'exec', target: '192.0.2.7', command: 'cat secret', cause: 'x' }),
      { phase: 'exec', target: '192.0.2.7' },
    );
  });
});

/**
 * `fitLabel` (`P-402`, `P-405`): a declared channel name or unit as a `channel` row holds it. The
 * column counts code points (`length()`), so this does too — `clip`'s UTF-16 count would cut a
 * name over 200 UTF-16 units that fits 200 code points, which one character outside the Basic
 * Multilingual Plane can make, and that a create writes whole.
 */
describe('fitLabel', () => {
  const { name } = RESULT_LIMITS;
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('clips a long declaration to the limit, ending in an ellipsis', () => {
    const path = `/${'a'.repeat(2_047)}`;
    assert.equal(fitLabel(path, name), `${path.slice(0, name - 1)}…`);
    assert.equal(fitLabel('a'.repeat(name), name), 'a'.repeat(name), 'one that fits is kept');
  });

  it('counts code points, as the column does, and never cuts a pair in half', () => {
    const wide = '😀'.repeat(150);
    assert.equal(fitLabel(wide, name), wide, '300 UTF-16 units, 150 characters: it fits');
    const over = fitLabel('😀'.repeat(name + 1), name);
    assert.equal(over, `${'😀'.repeat(name - 1)}…`);
    assert.equal(codePoints(over), name);
  });

  it('takes out a NUL and mends a lone surrogate, as a reading’s words are', () => {
    assert.equal(fitLabel('\u0000', name), '');
    assert.equal(fitLabel('a\u0000b', name), 'ab');
    assert.equal(fitLabel('a\uD800b', name), 'a\uFFFDb');
  });

  it('gives what the column holds for any text, and gives it back unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 600 }),
        fc.integer({ min: 1, max: 250 }),
        (text, limit) => {
          const fitted = fitLabel(text, limit);
          assert.ok(
            codePoints(fitted) <= limit,
            `${String(codePoints(fitted))} > ${String(limit)}`,
          );
          assert.ok(!fitted.includes('\u0000'));
          assert.ok(!LONE_SURROGATE.test(fitted), 'no lone surrogate');
          assert.equal(fitLabel(fitted, limit), fitted, 'fitting twice changes nothing');
        },
      ),
      { numRuns: 500 },
    );
  });
});
