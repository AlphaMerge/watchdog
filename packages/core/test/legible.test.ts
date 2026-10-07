import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { legible } from '../src/notifications/legible.js';

// What a delivery error becomes before it is stored as `last_error` (`N-24`). The far end writes
// part of it, so everything that can rewrite a terminal, hide text or reorder it is escaped where
// a reader can see it, and the two characters that only lay text out are kept.
describe('legible', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    [
      'plain text is unchanged',
      '503 from hooks.example.test — try later',
      '503 from hooks.example.test — try later',
    ],
    ['NUL, which PostgreSQL text cannot hold (P-277)', 'bad\u0000request', 'bad\\u0000request'],
    ['an ANSI escape sequence', '\u001b[2J\u001b[31mok', '\\u001b[2J\\u001b[31mok'],
    ['a backspace', 'failed\u0008\u0008', 'failed\\u0008\\u0008'],
    ['DEL', 'a\u007fb', 'a\\u007fb'],
    [
      'C1 controls, including CSI and NEL',
      'a\u0080b\u0085c\u009bd\u009f',
      'a\\u0080b\\u0085c\\u009bd\\u009f',
    ],
    ['a lone carriage return, which overwrites', 'all good\rFAILED', 'all good\\u000dFAILED'],
    ['a newline is kept', 'line one\nline two', 'line one\nline two'],
    ['a tab is kept', 'key:\tvalue', 'key:\tvalue'],
    ['CRLF becomes a newline', 'line one\r\nline two\r\n', 'line one\nline two\n'],
    ['a right-to-left override', 'invoice\u202etxt.exe', 'invoice\\u202etxt.exe'],
    [
      'every embedding and override',
      '\u202a\u202b\u202c\u202d\u202e',
      '\\u202a\\u202b\\u202c\\u202d\\u202e',
    ],
    ['every isolate', '\u2066\u2067\u2068\u2069', '\\u2066\\u2067\\u2068\\u2069'],
    ['the bidirectional marks', '\u200e\u200f\u061c', '\\u200e\\u200f\\u061c'],
    ['right-to-left text itself is not a control', 'שגיאה 500', 'שגיאה 500'],
    ['an emoji is not a control', 'down 🔥', 'down 🔥'],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      assert.equal(legible(input), expected);
    });
  }

  it('leaves nothing that is a control or a bidirectional control, except newline and tab', () => {
    // Every code point in the BMP, once each: whatever the regex misses shows up here.
    let all = '';
    for (let point = 0; point <= 0xffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      all += String.fromCodePoint(point);
    }
    const left = legible(all).match(/[^\P{Cc}\n\t]|\p{Bidi_Control}/gu) ?? [];
    assert.deepEqual(left, []);
    // And the two it keeps are still there, once each.
    assert.equal(legible(all).match(/[\n\t]/g)?.length, 2);
  });
});
