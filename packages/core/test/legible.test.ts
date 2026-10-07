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
    ['the default-ignorable marks that are not selectors are kept: CGJ', 'a\u{34f}b', 'a\u{34f}b'],
    ['and Khmer’s inherent vowels', '\u{1780}\u{17b4}\u{17b5}', '\u{1780}\u{17b4}\u{17b5}'],
    // The variation selectors (`N-29`): one, where it picks a glyph a reader sees, and no more.
    ['VS16 after an emoji is kept', 'down \u{2764}\u{fe0f}', 'down \u{2764}\u{fe0f}'],
    ['VS15 after an emoji is kept', '\u{2614}\u{fe0e}', '\u{2614}\u{fe0e}'],
    [
      'a keycap keeps its VS16',
      '1\u{fe0f}\u{20e3} #\u{fe0f}\u{20e3} *\u{fe0f}\u{20e3}',
      '1\u{fe0f}\u{20e3} #\u{fe0f}\u{20e3} *\u{fe0f}\u{20e3}',
    ],
    [
      'a ZWJ sequence keeps its VS16s',
      '\u{1f3f3}\u{fe0f}\u{200d}\u{1f308} \u{1f441}\u{fe0f}\u{200d}\u{1f5e8}\u{fe0f}',
      '\u{1f3f3}\u{fe0f}\u{200d}\u{1f308} \u{1f441}\u{fe0f}\u{200d}\u{1f5e8}\u{fe0f}',
    ],
    ['VS16 after a letter is escaped', 'refused\u{fe0f}', 'refused\\ufe0f'],
    ['VS15 after a letter is escaped', 'b\u{fe0e}', 'b\\ufe0e'],
    [
      'U+FE0F after a letter is escaped, and does not admit a ZWJ',
      'd\u{fe0f}\u{200d}\u{1f525}',
      'd\\ufe0f\\u200d\u{1f525}',
    ],
    [
      'a second selector after an emoji is escaped',
      '\u{2764}\u{fe0f}\u{fe0f}\u{fe0e}',
      '\u{2764}\u{fe0f}\\ufe0f\\ufe0e',
    ],
    [
      'a run of supplementary selectors on one letter is escaped, every one',
      'ok\u{e0168}\u{e0165}\u{e016c}\u{e016c}',
      'ok\\u{e0168}\\u{e0165}\\u{e016c}\\u{e016c}',
    ],
    [
      'one selector on each letter is escaped',
      'r\u{e0100}e\u{e0101}f\u{fe0f}',
      'r\\u{e0100}e\\u{e0101}f\\ufe0f',
    ],
    [
      'an ideographic variation selector is escaped, and its ideograph kept',
      '\u{845b}\u{e0100}',
      '\u{845b}\\u{e0100}',
    ],
    [
      'VS1–VS14 are escaped even after an emoji or a symbol they vary',
      '\u{2764}\u{fe00} \u{2269}\u{fe00} 0\u{fe00} \u{2764}\u{fe0d}',
      '\u{2764}\\ufe00 \u{2269}\\ufe00 0\\ufe00 \u{2764}\\ufe0d',
    ],
    ['a selector at the start is escaped', '\u{fe0f}ok', '\\ufe0fok'],
    ['a selector after a space is escaped', '\u{2764} \u{fe0f}', '\u{2764} \\ufe0f'],
    ['a selector after an escape is escaped', '\u{200b}\u{fe0f}', '\\u200b\\ufe0f'],
    ['a selector after a newline is escaped', '\u{2764}\n\u{fe0f}', '\u{2764}\n\\ufe0f'],
    [
      'a Mongolian free variation selector after a Mongolian letter is kept',
      '\u{1820}\u{180b} \u{182d}\u{180f}',
      '\u{1820}\u{180b} \u{182d}\u{180f}',
    ],
    [
      'a second Mongolian selector is escaped',
      '\u{182d}\u{180b}\u{180c}\u{180d}',
      '\u{182d}\u{180b}\\u180c\\u180d',
    ],
    [
      'a Mongolian selector after anything but a Mongolian character is escaped',
      'a\u{180b} \u{2764}\u{180c} \u{1820}\u{180e}\u{180b} \u{1820}\u{202f}\u{180d}',
      'a\\u180b \u{2764}\\u180c \u{1820}\\u180e\\u180b \u{1820}\u{202f}\\u180d',
    ],
    ['VS16 after a Mongolian letter is escaped', '\u{1820}\u{fe0f}', '\u{1820}\\ufe0f'],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      assert.equal(legible(input), expected);
    });
  }

  it('escapes exactly the controls, format characters, separators, variation selectors and default-ignorables that are not marks', () => {
    // Every code point there is, alone, beyond the BMP too since the tag characters are
    // (`N-27`): escaped when it is one of those and is not newline or tab, and otherwise left
    // exactly as it was. A joiner alone joins nothing, and a selector alone selects nothing
    // (`N-29`), so both are escaped too.
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
        /\p{Variation_Selector}/u.test(one) ||
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

  it('leaves none of them in a text that holds every code point, except newline, tab and one selector', () => {
    // In context, so a joiner and a selector have neighbours. Each joiner's are format
    // characters, so neither is kept. Each selector follows another selector, a format
    // character, or a character it does not vary, but for U+180B, the first Mongolian free
    // variation selector, which follows U+180A MONGOLIAN NIRUGU: a Mongolian character that is
    // drawn, so it is kept (`N-29`).
    let all = '';
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      all += String.fromCodePoint(point);
    }
    const out = legible(all);
    const left =
      out.match(
        /[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}\p{Variation_Selector}]|(?!\p{Mn})\p{Default_Ignorable_Code_Point}/gu,
      ) ?? [];
    assert.deepEqual(left, ['\u{180b}']);
    assert.ok(out.includes('\u{180a}\u{180b}\\u180c\\u180d\\u180e\\u180f'));
    // And the two it keeps are still there, once each.
    assert.equal(out.match(/[\n\t]/g)?.length, 2);
  });

  it('keeps VS15 and VS16 after exactly the pictures, VS16 in a keycap, a Mongolian selector after exactly the drawn Mongolian characters, and no other selector after anything', () => {
    // Every code point as the base of one selector of each kind (`N-29`), alone and before the
    // keycap mark. The base is made legible as it would be alone; the selector after it is kept
    // only where it varies it, and the keycap mark is never escaped.
    const picture = (base: string): boolean => /^\p{Extended_Pictographic}$/u.test(base);
    const keycap = (base: string): boolean => picture(base) || /^[0-9#*]$/u.test(base);
    const mongolian = (base: string): boolean =>
      /^\p{scx=Mong}$/u.test(base) &&
      !/^[\p{Variation_Selector}\p{Cf}\p{White_Space}]$/u.test(base);
    const never = (): boolean => false;
    const selectors: readonly (readonly [string, string, string, (base: string) => boolean])[] = [
      ['\u{fe0e}', '\\ufe0e', '', picture],
      ['\u{fe0f}', '\\ufe0f', '', picture],
      ['\u{fe0e}', '\\ufe0e', '\u{20e3}', picture],
      ['\u{fe0f}', '\\ufe0f', '\u{20e3}', keycap],
      ['\u{fe00}', '\\ufe00', '', never],
      ['\u{fe0d}', '\\ufe0d', '', never],
      ['\u{e0100}', '\\u{e0100}', '', never],
      ['\u{e01ef}', '\\u{e01ef}', '', never],
      ['\u{180b}', '\\u180b', '', mongolian],
      ['\u{180f}', '\\u180f', '', mongolian],
    ];
    // Counted, and the first few named: a rule gone wrong is wrong for a million bases at once.
    const wrong: string[] = [];
    let wrongCount = 0;
    const kept = new Map<string, number>();
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const base = String.fromCodePoint(point);
      const alone = legible(base);
      for (const [selector, escaped, after, varies] of selectors) {
        const keep = varies(base);
        const name = `${escaped}${after === '' ? '' : '+keycap'}`;
        if (keep) kept.set(name, (kept.get(name) ?? 0) + 1);
        if (legible(base + selector + after) !== alone + (keep ? selector : escaped) + after) {
          wrongCount += 1;
          if (wrong.length < 20) wrong.push(`${point.toString(16)}+${name}`);
        }
      }
    }
    assert.deepEqual({ wrongCount, wrong }, { wrongCount: 0, wrong: [] });
    // Presence, so that the sweep cannot pass by keeping nothing: every picture, the twelve
    // keycap bases, the drawn Mongolian characters, and nothing for the rest.
    const pictures = kept.get('\\ufe0f') ?? 0;
    assert.ok(pictures > 2_000, 'VS16 kept after the pictures');
    assert.equal(kept.get('\\ufe0e'), pictures);
    assert.equal(kept.get('\\ufe0e+keycap'), pictures);
    assert.equal(kept.get('\\ufe0f+keycap'), pictures + 12);
    assert.ok((kept.get('\\u180b') ?? 0) > 150, 'a Mongolian selector kept after Mongolian');
    assert.equal(kept.get('\\ufe00'), undefined);
    assert.equal(kept.get('\\u{e0100}'), undefined);
  });

  it('keeps VS16 after a bare digit, a regional indicator or a skin tone nowhere (N-29 review)', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['4\u{fe0f}0', '4\\ufe0f0'],
      ['HTTP 4\u{fe0e}0\u{fe0f}4', 'HTTP 4\\ufe0e0\\ufe0f4'],
      ['10.0.0.1:2\u{fe0f}5', '10.0.0.1:2\\ufe0f5'],
      ['#\u{fe0f} *\u{fe0f}', '#\\ufe0f *\\ufe0f'],
      ['4\u{fe0f}\u{20e3}', '4\u{fe0f}\u{20e3}'],
      ['4\u{fe0e}\u{20e3}', '4\\ufe0e\u{20e3}'],
      ['\u{2764}\u{fe0f}', '\u{2764}\u{fe0f}'],
      ['\u{a9}\u{fe0f} \u{203c}\u{fe0e}', '\u{a9}\u{fe0f} \u{203c}\u{fe0e}'],
      ['\u{1f1fa}\u{fe0f}', '\u{1f1fa}\\ufe0f'],
      ['\u{1f1fa}\u{1f1f8}', '\u{1f1fa}\u{1f1f8}'],
      ['\u{1f44d}\u{1f3fd}\u{fe0f}', '\u{1f44d}\u{1f3fd}\\ufe0f'],
    ];
    for (const [input, expected] of cases) assert.equal(legible(input), expected, input);
  });

  it('keeps a joiner only beside neighbours it leaves as they are (N-29 review)', () => {
    const cases: readonly (readonly [string, string])[] = [
      // A VS16 after an unassigned pictograph is kept, so the ZWJ after it is too.
      ['\u{1f02c}\u{fe0f}\u{200d}\u{1f525}', '\u{1f02c}\u{fe0f}\u{200d}\u{1f525}'],
      // A VS16 that is escaped admits no ZWJ.
      ['4\u{fe0f}\u{200d}\u{1f525}', '4\\ufe0f\\u200d\u{1f525}'],
      // A format character of a joining script is escaped, and so is the joiner beside it.
      ['\u{61c}\u{200c}\u{645}', '\\u061c\\u200c\u{645}'],
      ['\u{645}\u{200d}\u{600}', '\u{645}\\u200d\\u0600'],
      ['\u{710}\u{200d}\u{70f}', '\u{710}\\u200d\\u070f'],
      ['\u{1820}\u{200d}\u{180e}', '\u{1820}\\u200d\\u180e'],
      // A Mongolian selector that is escaped admits no joiner; one that is kept does.
      ['a\u{180b}\u{200d}\u{1820}', 'a\\u180b\\u200d\u{1820}'],
      ['\u{1820}\u{180b}\u{200d}\u{1821}', '\u{1820}\u{180b}\u{200d}\u{1821}'],
    ];
    for (const [input, expected] of cases) assert.equal(legible(input), expected, input);
  });

  it('leaves its own output as it is (N-28, N-29 review)', () => {
    // Every string of up to four code points from an alphabet of the things that interact —
    // selectors, joiners, pictures, digits, the keycap mark, regional indicators, skin tones,
    // joining-script letters and their format characters, Mongolian and its selectors, the
    // escapable ones — and then longer ones drawn from it with a fixed seed.
    const alphabet = [
      'a',
      '4',
      '#',
      ' ',
      '\n',
      '\r',
      '\\',
      '\u{fe0e}',
      '\u{fe0f}',
      '\u{fe00}',
      '\u{e0100}',
      '\u{200d}',
      '\u{200c}',
      '\u{200b}',
      '\u{20e3}',
      '\u{2764}',
      '\u{1f525}',
      '\u{1f02c}',
      '\u{1f1fa}',
      '\u{1f3fd}',
      '\u{645}',
      '\u{61c}',
      '\u{600}',
      '\u{915}',
      '\u{94d}',
      '\u{1820}',
      '\u{180b}',
      '\u{180e}',
      '\u{202f}',
      '\u{301}',
    ];
    const unstable: string[] = [];
    let checked = 0;
    const check = (text: string): void => {
      checked += 1;
      const once = legible(text);
      if (legible(once) !== once && unstable.length < 20) unstable.push(JSON.stringify(text));
    };
    const extend = (prefix: string, left: number): void => {
      if (prefix !== '') check(prefix);
      if (left === 0) return;
      for (const one of alphabet) extend(prefix + one, left - 1);
    };
    extend('', 4);
    // mulberry32: a fixed sequence, so a failure is the same failure on every run.
    let seed = 0x2829;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    for (let n = 0; n < 50_000; n += 1) {
      let text = '';
      const length = 5 + Math.floor(random() * 12);
      for (let i = 0; i < length; i += 1) {
        text += alphabet[Math.floor(random() * alphabet.length)] ?? '';
      }
      check(text);
    }
    assert.deepEqual(unstable, []);
    assert.equal(checked, 30 + 30 ** 2 + 30 ** 3 + 30 ** 4 + 50_000);
  });
});
