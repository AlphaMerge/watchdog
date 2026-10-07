/**
 * Every control, every format character (which holds every bidirectional control), the two
 * Unicode line and paragraph separators, every variation selector (`N-29`), and every other
 * default-ignorable code point that is not a mark (`N-27` review).
 */
const ESCAPABLE =
  String.raw`[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Variation_Selector}]` +
  String.raw`|(?!\p{Mn})\p{Default_Ignorable_Code_Point}`;

/** CRLF first, so it is taken as one; then each of those. */
const UNSAFE = new RegExp(String.raw`\r\n|${ESCAPABLE}`, 'gu');

/** One code point of those, for asking whether a joiner's neighbour is left as it is. */
const ESCAPABLE_ONE = new RegExp(`^(?:${ESCAPABLE})$`, 'u');

/** The variation selectors: VS1–VS16, VS17–VS256, and Mongolian's four free ones (`N-29`). */
const SELECTOR = /^\p{Variation_Selector}$/u;

/** VS15 and VS16, which draw an emoji as text or as a picture. */
const TEXT_STYLE = '\ufe0e';
const EMOJI_STYLE = '\ufe0f';

/**
 * What a keycap is made of: a digit, `#` or `*`, then U+FE0F, then the combining enclosing keycap.
 * VS16 after one of those three is kept only inside a keycap (`N-29` review).
 */
const KEYCAP_BASE = /^[0-9#*]$/u;
const KEYCAP = '\u{20e3}';

/** Mongolian's free variation selectors, U+180B–U+180D and U+180F. */
const MONGOLIAN_SELECTOR = /^(?=\p{Variation_Selector})\p{scx=Mong}$/u;

/**
 * What a Mongolian free variation selector varies: a Mongolian character that is drawn. Not
 * another selector, not the vowel separator U+180E (a format character, escaped), and not the
 * narrow no-break space U+202F, which Mongolian uses and which draws as a gap.
 */
const MONGOLIAN = /^(?![\p{Variation_Selector}\p{Cf}\p{White_Space}])\p{scx=Mong}$/u;

/** The two joiners, kept only where they join (`N-27`). */
const ZWNJ = '\u200c';
const ZWJ = '\u200d';

/**
 * The scripts whose letters a joiner changes, by `Script_Extensions` so that a vowel sign or a
 * virama counts with its letters. The cursive ones — Arabic (Persian, Urdu), Syriac, N'Ko,
 * Mongolian, Adlam, Hanifi Rohingya, Mandaic — and the Brahmic ones whose conjuncts ZWJ and ZWNJ
 * shape: Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam and
 * Sinhala. A joiner is kept between two characters of the same one of these.
 */
const JOINING_SCRIPTS: readonly RegExp[] = [
  /^\p{scx=Arab}$/u,
  /^\p{scx=Syrc}$/u,
  /^\p{scx=Nkoo}$/u,
  /^\p{scx=Mong}$/u,
  /^\p{scx=Adlm}$/u,
  /^\p{scx=Rohg}$/u,
  /^\p{scx=Mand}$/u,
  /^\p{scx=Deva}$/u,
  /^\p{scx=Beng}$/u,
  /^\p{scx=Guru}$/u,
  /^\p{scx=Gujr}$/u,
  /^\p{scx=Orya}$/u,
  /^\p{scx=Taml}$/u,
  /^\p{scx=Telu}$/u,
  /^\p{scx=Knda}$/u,
  /^\p{scx=Mlym}$/u,
  /^\p{scx=Sinh}$/u,
];

/** What an emoji ZWJ sequence joins: the pictures. */
const PICTURE = /^\p{Extended_Pictographic}$/u;

/** A skin tone, which may stand between a picture and the ZWJ after it, as a kept VS16 may. */
const SKIN_TONE = /^\p{Emoji_Modifier}$/u;

/**
 * A delivery error fit to store as `last_error` and to show to whoever reads it (`N-24`), and to
 * hand back to whoever sent a test notification (`N-27`).
 *
 * An error quotes the far end — a webhook's response body, a program's last line, a relay's
 * reply — and the far end can say anything. These things in what it says do harm:
 *
 * - **U+0000**, which PostgreSQL text cannot hold (`22021`). The write recording the attempt
 *   failed, the request kept its claim's lease, and it was sent again every time that ran out
 *   (`P-277`).
 * - **Other control characters** (`\p{Cc}`: C0, DEL and C1). An escape sequence rewrites a
 *   terminal that prints the row or the log line; a carriage return writes over the text before
 *   it; in a browser they are invisible, so two different errors read the same.
 * - **Bidirectional controls** (`\p{Bidi_Control}`: the embeddings and overrides U+202A–U+202E,
 *   the isolates U+2066–U+2069, and the marks U+061C, U+200E, U+200F). An override shows its
 *   text in an order other than the one it has, which is exactly how a quoted error is made to
 *   say something its sender did not. Every one is a format character, so `\p{Cf}` names them.
 * - **Other format characters** (`\p{Cf}`, `N-27`): the zero-width space U+200B, the word joiner
 *   and invisible operators U+2060–U+2064, the byte-order mark U+FEFF, the soft hyphen U+00AD,
 *   the tag characters U+E0001–U+E007F, which spell ASCII nobody can see. And the line and
 *   paragraph separators U+2028 and U+2029, which are not format characters but break a line in
 *   one reader and not in the next. None can reorder text; each can make two errors look alike,
 *   or carry words a reader cannot see — "refused" and "re\u200Bfused" are different strings
 *   that nobody can tell apart on screen. Escaped for the reason the controls are: a reader
 *   should see that something was there.
 *
 * - **Other default-ignorable code points that are not marks** (`N-27` review). The Hangul
 *   fillers U+115F, U+1160, U+3164 and U+FFA0 are letters (`\p{Lo}`) that draw nothing, and the
 *   unassigned default-ignorables (U+2065, U+FFF0–U+FFF8, U+E0000, U+E0002–U+E001F,
 *   U+E0080–U+E0FFF) are drawn as nothing by every renderer that follows Unicode, so each of
 *   them hides as a zero-width space does: "re" U+115F "fused" reads as "refused".
 *
 * **Except the two joiners where they join.** ZWNJ (U+200C) and ZWJ (U+200D) are format
 * characters too, and they are how Persian, Arabic and Indic text is written and how an emoji
 * sequence is one picture: escaped everywhere, a Persian relay's refusal would read broken. So a
 * joiner is kept between two characters of the same joining script (`JOINING_SCRIPTS`), and a
 * ZWJ is kept before a picture that follows a picture, alone, with a skin tone, or with a kept
 * U+FE0F. Everywhere else it does nothing but hide, and is escaped: between Latin, Cyrillic, Greek,
 * Hebrew or CJK letters, which no joiner changes ("от" ZWJ "казано" reads as "отказано"),
 * between two scripts, at either end, or beside a space, a mark of another script or an escape.
 * A combining mark alone does not admit one: a Latin letter with an accent is still Latin, and
 * an Indic virama is already its script's. Nor does a neighbour that is itself escaped, so that
 * a second pass changes nothing (`joins`).
 *
 * **Variation selectors only where they select, one at a time** (`N-29`). A variation selector
 * (VS1–VS16 at U+FE00–U+FE0F, VS17–VS256 at U+E0100–U+E01EF, and Mongolian's U+180B–U+180D and
 * U+180F) draws nothing and says nothing: it picks a glyph for the character before it. Unicode
 * gives a character at most one. So a run of them after one letter — 256 to pick from, a byte
 * each — is text nobody sees, and two errors carrying different runs read the same. A selector
 * is kept only in the two places it changes what a reader sees:
 *
 * - **VS15 or VS16 directly after a picture** (`\p{Extended_Pictographic}`, `PICTURE`), and
 *   **VS16 between a digit, `#` or `*` and U+20E3**, which is a keycap (`N-29` review). That is
 *   a heart drawn red rather than black, a keycap, and the U+FE0F inside a ZWJ sequence:
 *   escaped, the emoji would break.
 * - **A Mongolian free variation selector directly after a Mongolian character that is drawn**
 *   (`MONGOLIAN`), which is how a Mongolian letter takes the form its word needs.
 *
 * The base is a picture, not `\p{Emoji}`, which also holds the digits, `#`, `*`, the regional
 * indicators and the skin tones: "4" VS16 "0" reads as "40", so a selector kept after every
 * digit would hide one per digit. Nor is it the bases `emoji-variation-sequences.txt` lists: no
 * Unicode property names them, and a list copied here would be a table frozen at one Unicode
 * version, the reason migration 071 calls this rather than restating it. A picture is what
 * `joins` already takes one to be, and a VS16 before a ZWJ is kept only where `selects` keeps
 * it, so the two cannot disagree.
 *
 * Every other one is escaped: after a letter, a space, an escape or another selector, at the
 * start, and VS1–VS14 and VS17–VS256 wherever they stand. Those pick between glyphs of a
 * character the reader still sees — a slashed zero, a regional form of an ideograph — and never
 * change what it says, so escaping them leaves the character there with its `\ufe00` after it;
 * kept after any ideograph, each would hide a byte. What a selector can still hide is one of two
 * after a picture and one of four after a Mongolian character: a bit or two beside a character
 * that is there to see, never a run.
 *
 * Neither of the other two answers. **Escaping only runs** would keep one selector on every
 * character, and "refused" with a different VS17–VS256 on each letter is seven hidden bytes that
 * look exactly like "refused". **Keeping them all** is what this was.
 *
 * **Not the other default-ignorable marks** (`\p{Mn}`: the combining grapheme joiner U+034F and
 * Khmer's U+17B4 and U+17B5). They attach to a visible character without changing what it says.
 *
 * **Escaped, not removed.** Each becomes `\uXXXX`, or `\u{XXXXX}` beyond the BMP so that a tag
 * character is not read as four hex digits and a letter. A reader sees *something was there* —
 * a body that tried to reverse itself reads as one that tried, instead of as plain text with a
 * few characters quietly missing. That costs at most nine characters for one, and every error
 * that quotes the far end already keeps 200 characters of it.
 *
 * **Newline and tab are kept**, and CRLF becomes a newline. A webhook's body is often several
 * lines, and the API returns this text to scripts that print it; neither character can disguise
 * anything. The logs view shows the error on one line, where the browser collapses them to a
 * space. A carriage return on its own is escaped: it is the one that overwrites.
 *
 * **At storage, not at display** — this is applied where `#record` writes `last_error`, the one
 * place a transport's words become one. What reads it is the logs view, the
 * `/notification-requests` API, and the Notification delivery health that Core Health turns
 * into its sensor message, which becomes state history and is itself sent out as an alarm.
 * Escaping in the logs view alone would leave the other two, and the API's readers are scripts
 * and terminals this project does not write. Rows written before `N-24` are rewritten with this
 * by migration 071 (`N-28`), which calls it rather than restating it.
 * The log lines `#record` writes beside the row carry the same escaped text: pino's JSON escapes
 * only U+0000 to U+001F, so a C1 or an override would reach the journal as the far end wrote it.
 * A test send (`test-send.ts`) stores nothing, and applies this to what it reports and logs.
 *
 * **It leaves its own output as it is**: `legible(legible(x))` is `legible(x)`. Migration 071
 * runs it over rows that may already be legible, and stops rewriting them only because of this
 * (`N-28`).
 *
 * A literal backslash followed by `u` in the original reads the same as an escape. This is a
 * diagnosis for a person, not data to parse back.
 */
export function legible(text: string): string {
  return text.replace(UNSAFE, (found: string, at: number) => {
    if (found === '\r\n') return '\n';
    if (found === '\n' || found === '\t') return found;
    if ((found === ZWNJ || found === ZWJ) && joins(found, text, at)) return found;
    if (SELECTOR.test(found) && selects(found, text, at)) return found;
    const point = found.codePointAt(0) ?? 0;
    const hex = point.toString(16);
    return point > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}

/**
 * Whether the joiner at `at` stands where it joins: in a joining script, or in an emoji.
 *
 * **Never beside a neighbour that is itself escaped** (`N-29` review). Arabic's number signs
 * U+0600–U+0604 and U+0890–U+0891, the letter mark U+061C, Syriac's U+070F and Mongolian's
 * U+180B–U+180F are format characters or selectors of a joining script. A joiner kept beside one
 * that was escaped stood, in the output, beside the last hex digit of its escape, and a second
 * pass escaped it: `legible()` did not leave its own output as it was, which migration 071's
 * re-run relies on (`N-28`).
 */
function joins(joiner: string, text: string, at: number): boolean {
  const before = pointBefore(text, at);
  const beforeAt = at - before.length;
  const after = pointAt(text, at + 1);
  if (!stays(before, text, beforeAt) || !stays(after, text, at + 1)) return false;
  if (JOINING_SCRIPTS.some((script) => script.test(before) && script.test(after))) return true;
  if (joiner !== ZWJ || !PICTURE.test(after)) return false;
  if (PICTURE.test(before)) return true;
  // VS16 only where `selects` keeps it, which before a ZWJ is only after a picture; a skin tone
  // only where it follows a picture itself. After a letter either is drawn as nothing, and would
  // carry a ZWJ in with it.
  if (before === EMOJI_STYLE) return selects(before, text, beforeAt);
  return SKIN_TONE.test(before) && PICTURE.test(pointBefore(text, beforeAt));
}

/** Whether the code point `point`, at `at`, is one `legible()` leaves as it is. Not at an end. */
function stays(point: string, text: string, at: number): boolean {
  if (point === '') return false;
  if (!ESCAPABLE_ONE.test(point)) return true;
  return SELECTOR.test(point) && selects(point, text, at);
}

/**
 * Whether the variation selector at `at` picks a glyph for the code point before it, as it was
 * written (`N-29`). A selector before it is no base, so a run keeps at most its first.
 *
 * VS15 and VS16 vary a picture. After a digit, `#` or `*`, only VS16 is kept, and only when the
 * keycap mark follows it (`N-29` review): "4" VS16 "0" reads as "40" and hides a selector, and a
 * regional indicator or a skin tone is no picture either.
 */
function selects(selector: string, text: string, at: number): boolean {
  const base = pointBefore(text, at);
  if (selector === TEXT_STYLE || selector === EMOJI_STYLE) {
    if (KEYCAP_BASE.test(base)) {
      return selector === EMOJI_STYLE && pointAt(text, at + selector.length) === KEYCAP;
    }
    return PICTURE.test(base);
  }
  return MONGOLIAN_SELECTOR.test(selector) && MONGOLIAN.test(base);
}

/** The whole code point that ends at `end`, or '' at the start. */
function pointBefore(text: string, end: number): string {
  if (end <= 0) return '';
  const low = text.charCodeAt(end - 1);
  const high = end >= 2 ? text.charCodeAt(end - 2) : -1;
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
    ? text.slice(end - 2, end)
    : text.slice(end - 1, end);
}

/** The whole code point that starts at `start`, or '' at the end. */
function pointAt(text: string, start: number): string {
  const point = text.codePointAt(start);
  return point === undefined ? '' : String.fromCodePoint(point);
}
