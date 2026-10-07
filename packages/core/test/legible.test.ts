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
    // `N-27`: the format characters, which cannot reorder text but can hide in it.
    ['a zero-width space', 're\u200bfused', 're\\u200bfused'],
    ['a byte-order mark', '\ufeff503 Service Unavailable', '\\ufeff503 Service Unavailable'],
    ['a soft hyphen', 'de\u00adnied', 'de\\u00adnied'],
    ['the word joiner and an invisible operator', 'a\u2060b\u2062c', 'a\\u2060b\\u2062c'],
    ['the line and paragraph separators', 'one\u2028two\u2029three', 'one\\u2028two\\u2029three'],
    [
      'a tag character, escaped with braces beyond the BMP',
      'ok\u{e0041}\u{e007f}',
      'ok\\u{e0041}\\u{e007f}',
    ],
    // Kept where they join (`N-27` review): a joining script on both sides, or an emoji.
    ['ZWNJ inside a Persian word is kept', 'می\u200cخواهم', 'می\u200cخواهم'],
    ['ZWNJ after an Arabic vowel sign is kept', 'م\u0650\u200cخ', 'م\u0650\u200cخ'],
    ['ZWJ after a virama is kept', 'क्\u200dष', 'क्\u200dष'],
    ['ZWNJ after a virama is kept', 'क्\u200cष', 'क्\u200cष'],
    ['ZWJ inside an emoji sequence is kept', '👨\u200d👩\u200d👧', '👨\u200d👩\u200d👧'],
    ['ZWJ after a variation selector is kept', '❤\ufe0f\u200d🔥', '❤\ufe0f\u200d🔥'],
    ['ZWJ after a skin tone is kept', '👩🏽\u200d💻', '👩🏽\u200d💻'],
    // Escaped wherever they only hide.
    ['ZWJ between Latin letters is escaped', 'ad\u200dmin', 'ad\\u200dmin'],
    ['ZWJ between Cyrillic letters is escaped', 'от\u200dказано', 'от\\u200dказано'],
    ['ZWNJ between CJK characters is escaped', '拒\u200c绝', '拒\\u200c绝'],
    ['ZWJ between Greek letters is escaped', 'αβ\u200dγ', 'αβ\\u200dγ'],
    ['ZWJ between Hebrew letters is escaped', 'ש\u200dג', 'ש\\u200dג'],
    ['ZWJ between accented Latin letters is escaped', 'é\u200dé', 'é\\u200dé'],
    ['a Latin combining mark does not admit a joiner', 'a\u0301\u200db', 'a\u0301\\u200db'],
    ['a joiner between two joining scripts is escaped', 'م\u200dक', 'م\\u200dक'],
    ['ZWNJ between two emoji is escaped', '👨\u200c👩', '👨\\u200c👩'],
    ['ZWJ before a letter after an emoji is escaped', '👨\u200da', '👨\\u200da'],
    ['U+FE0F after a letter does not admit a ZWJ', 'd\ufe0f\u200d🔥', 'd\ufe0f\\u200d🔥'],
    ['ZWNJ beside ASCII on one side is escaped', 'می\u200ca', 'می\\u200ca'],
    ['a joiner at either end is escaped', '\u200dمی\u200c', '\\u200dمی\\u200c'],
    ['a joiner beside a space is escaped', 'می\u00a0\u200cخ', 'می\u00a0\\u200cخ'],
    ['a joiner beside another escape is escaped', 'م\u200b\u200dخ', 'م\\u200b\\u200dخ'],
    ['a joiner beside half a surrogate pair is escaped', 'م\u200d\ud83d', 'م\\u200d\ud83d'],
    ['a joiner beside a Hangul filler is escaped', 'م\u200d\u3164', 'م\\u200d\\u3164'],
    // The default-ignorables that are not marks (`N-27` review), and the marks that stay.
    [
      'the Hangul fillers, letters that draw nothing',
      're\u115ffu\u1160s\u3164e\uffa0d',
      're\\u115ffu\\u1160s\\u3164e\\uffa0d',
    ],
    [
      'the unassigned default-ignorables',
      'a\u2065b\ufff0c\ufff8d\u{e0000}e\u{e0002}f\u{e0080}g\u{e0fff}',
      'a\\u2065b\\ufff0c\\ufff8d\\u{e0000}e\\u{e0002}f\\u{e0080}g\\u{e0fff}',
    ],
    [
      'the default-ignorable marks are kept: CGJ and the variation selectors',
      'a\u034fb\ufe0e✓\u{e0100}',
      'a\u034fb\ufe0e✓\u{e0100}',
    ],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      assert.equal(legible(input), expected);
    });
  }

  it('escapes exactly the controls, format characters, separators and default-ignorables that are not marks', () => {
    // Every code point there is, alone, beyond the BMP too since the tag characters are
    // (`N-27`): escaped when it is one of those and is not newline or tab, and otherwise left
    // exactly as it was. A joiner alone joins nothing, so it is escaped too.
    const wrong: string[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const one = String.fromCodePoint(point);
      const hex = point.toString(16);
      const unsafe =
        /\p{Cc}/u.test(one) ||
        /\p{Cf}/u.test(one) ||
        /\p{Zl}/u.test(one) ||
        /\p{Zp}/u.test(one) ||
        (/\p{Default_Ignorable_Code_Point}/u.test(one) && !/\p{Mn}/u.test(one));
      const expected =
        !unsafe || one === '\n' || one === '\t'
          ? one
          : point > 0xffff
            ? `\\u{${hex}}`
            : `\\u${hex.padStart(4, '0')}`;
      if (legible(one) !== expected) wrong.push(hex);
    }
    assert.deepEqual(wrong, []);
  });

  it('leaves none of them in a text that holds every code point, except newline and tab', () => {
    // In context, so a joiner has neighbours: each joiner's are format characters, so neither
    // is kept.
    let all = '';
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      all += String.fromCodePoint(point);
    }
    const out = legible(all);
    const left =
      out.match(
        /[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}]|(?!\p{Mn})\p{Default_Ignorable_Code_Point}/gu,
      ) ?? [];
    assert.deepEqual(left, []);
    // And the two it keeps are still there, once each.
    assert.equal(out.match(/[\n\t]/g)?.length, 2);
  });
});
