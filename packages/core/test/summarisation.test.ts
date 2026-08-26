import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  countKinds,
  DEFAULT_SUMMARISATION,
  digestSubject,
  disposition,
  isSummarisationMode,
  kindOf,
  MAX_DIGEST_CHARS,
  MAX_DIGEST_LINES,
  splitDigest,
  summarises,
  SUMMARISATION_MODES,
  type MessageKind,
  type SummarisationMode,
} from '../src/notifications/summarisation.js';

describe('what kind of message a notification is', () => {
  it('reads a recovery as an Up whatever state the trigger was armed on', () => {
    // A trigger armed on Warning that recovers is still the message saying "it is fine now".
    assert.equal(kindOf({ reason: 'recovery', state: 'up' }), 'up');
    assert.equal(kindOf({ reason: 'clear', state: null }), 'up');
  });

  it('reads the problem states as Down, including an acknowledged one', () => {
    for (const state of ['down', 'down_acknowledged', 'down_partial'] as const) {
      assert.equal(kindOf({ reason: 'initial', state }), 'down', state);
    }
  });

  it('reads a threshold breach as a Down, deliberately', () => {
    // The mode names are written in terms of Down and Up, so a literal reading would hold a
    // filling disk for the whole window — an operator who asked for "all Downs immediately"
    // would get a late digest about it. Between noisier than asked for and later than asked
    // for, an alarm system takes the noisy one.
    assert.equal(kindOf({ reason: 'threshold', state: null }), 'down');
  });

  it('reads the middle states as neither, which is what "summarise others" is about', () => {
    assert.equal(kindOf({ reason: 'initial', state: 'warning' }), 'other');
    assert.equal(kindOf({ reason: 'initial', state: 'unknown' }), 'other');
    assert.equal(kindOf({ reason: 'initial', state: 'unusual' }), 'other');
  });
});

describe('the six modes', () => {
  /** Every combination, written out, because this table *is* the feature. */
  const TABLE: Record<
    SummarisationMode,
    { first: Record<MessageKind, string>; second: Record<MessageKind, string> }
  > = {
    'always-immediate': {
      first: { down: 'immediate', up: 'immediate', other: 'immediate' },
      second: { down: 'immediate', up: 'immediate', other: 'immediate' },
    },
    'first-down': {
      first: { down: 'immediate', up: 'held', other: 'held' },
      second: { down: 'held', up: 'held', other: 'held' },
    },
    'first-down-and-up': {
      first: { down: 'immediate', up: 'immediate', other: 'held' },
      second: { down: 'held', up: 'held', other: 'held' },
    },
    'downs-immediate': {
      first: { down: 'immediate', up: 'held', other: 'held' },
      second: { down: 'immediate', up: 'held', other: 'held' },
    },
    'downs-and-ups-immediate': {
      first: { down: 'immediate', up: 'immediate', other: 'held' },
      second: { down: 'immediate', up: 'immediate', other: 'held' },
    },
    'always-summarise': {
      first: { down: 'held', up: 'held', other: 'held' },
      second: { down: 'held', up: 'held', other: 'held' },
    },
  };

  it('decides the first message of a window the way the table says', () => {
    for (const mode of SUMMARISATION_MODES) {
      for (const kind of ['down', 'up', 'other'] as const) {
        assert.equal(disposition(mode, kind, []), TABLE[mode].first[kind], `${mode}/${kind}`);
      }
    }
  });

  it('decides the second one differently only where "first" appears in the name', () => {
    // Which is the whole distinction an operator is choosing between: "first Down immediately"
    // turns a forty-sensor outage into one message and a digest; "all Downs immediately" sends
    // forty.
    for (const mode of SUMMARISATION_MODES) {
      for (const kind of ['down', 'up', 'other'] as const) {
        const released: MessageKind[] = ['down', 'up', 'other'];
        assert.equal(
          disposition(mode, kind, released),
          TABLE[mode].second[kind],
          `${mode}/${kind}`,
        );
      }
    }
  });

  it('lets the first Up through even after a Down has gone, and not the other way round', () => {
    // The default mode, and the case that separates it from "first down": a storm's first
    // recovery is worth a message of its own.
    assert.equal(disposition('first-down-and-up', 'up', ['down']), 'immediate');
    assert.equal(disposition('first-down', 'up', []), 'held');
  });

  it('only opens a window for a mode that ever holds anything', () => {
    assert.equal(summarises('always-immediate'), false);
    for (const mode of SUMMARISATION_MODES.filter((one) => one !== 'always-immediate')) {
      assert.equal(summarises(mode), true, mode);
    }
  });

  it('defaults to the mode CAPABILITIES.MD calls the default', () => {
    assert.equal(DEFAULT_SUMMARISATION, 'first-down-and-up');
    assert.equal(isSummarisationMode('first-down-and-up'), true);
    assert.equal(isSummarisationMode('firstDownAndUp'), false);
  });
});

describe('splitting a digest', () => {
  const entries = (count: number, length = 10) =>
    Array.from({ length: count }, (_, index) => ({
      member: index,
      line: String(index).padEnd(length, '.'),
    }));

  it('keeps a small window in one message', () => {
    const parts = splitDigest(entries(5));
    assert.equal(parts.length, 1);
    assert.equal(parts[0]?.members.length, 5);
  });

  it('splits at twenty-five notifications', () => {
    const parts = splitDigest(entries(60));
    assert.deepEqual(
      parts.map((part) => part.members.length),
      [MAX_DIGEST_LINES, MAX_DIGEST_LINES, 10],
    );
  });

  it('splits at about a thousand characters as well', () => {
    // Both caps, because either one alone lets a digest through that a mail client truncates —
    // and what gets cut off is the end, which in a cascade is the part that explains it.
    const parts = splitDigest(entries(20, 200));
    assert.ok(parts.length > 1, 'twenty 200-character lines is over the character cap');
    for (const part of parts) {
      const size = part.lines.reduce((total, line) => total + line.length + 1, 0);
      assert.ok(size <= MAX_DIGEST_CHARS + 201, `a part came to ${String(size)} characters`);
    }
  });

  it('gives an over-long single line a message of its own rather than dropping it', () => {
    // It is somebody's alarm. The cap is there to keep messages readable, not to decide which
    // outages are worth reporting.
    const parts = splitDigest([
      { member: 'a', line: 'x'.repeat(4_000) },
      { member: 'b', line: 'short' },
    ]);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0]?.members, ['a']);
    assert.deepEqual(parts[1]?.members, ['b']);
  });

  it('produces nothing from nothing', () => {
    assert.deepEqual(splitDigest([]), []);
  });
});

describe('a digest’s subject', () => {
  it('counts what is in this message, so the numbers agree with the lines below them', () => {
    const counts = countKinds(['down', 'down', 'up']);
    assert.deepEqual(counts, { down: 2, up: 1, other: 0 });
    assert.equal(
      digestSubject({ siteName: 'Acme', counts, total: 3, part: 1, parts: 1 }),
      'Acme: 3 notifications — 2 down, 1 up',
    );
  });

  it('says which of how many when a storm splits', () => {
    assert.equal(
      digestSubject({
        siteName: 'Acme',
        counts: { down: 25, up: 0, other: 0 },
        total: 25,
        part: 2,
        parts: 3,
      }),
      'Acme: 25 notifications — 25 down (2 of 3)',
    );
  });

  it('reads properly for one, and without a site nobody named', () => {
    assert.equal(
      digestSubject({
        siteName: '',
        counts: { down: 0, up: 1, other: 0 },
        total: 1,
        part: 1,
        parts: 1,
      }),
      '1 notification — 1 up',
    );
  });
});
