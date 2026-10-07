/**
 * CRLF first, so it is taken as one; then every control, every format character (which holds
 * every bidirectional control), the two Unicode line and paragraph separators, and every other
 * default-ignorable code point that is not a mark (`N-27` review).
 */
const UNSAFE = /\r\n|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?!\p{Mn})\p{Default_Ignorable_Code_Point}/gu;

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

/** What may stand between a picture and the ZWJ after it: a skin tone, or the emoji selector. */
const PICTURE_SUFFIX = /^[\p{Emoji_Modifier}\ufe0f]$/u;

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
 * ZWJ is kept before a picture that follows a picture, alone or with a skin tone or U+FE0F.
 * Everywhere else it does nothing but hide, and is escaped: between Latin, Cyrillic, Greek,
 * Hebrew or CJK letters, which no joiner changes ("от" ZWJ "казано" reads as "отказано"),
 * between two scripts, at either end, or beside a space, a mark of another script or an escape.
 * A combining mark alone does not admit one: a Latin letter with an accent is still Latin, and
 * an Indic virama is already its script's.
 *
 * **Not the variation selectors**, nor the other default-ignorable marks (`\p{Mn}`: U+034F, the
 * Mongolian and Khmer ones). An emoji's U+FE0F is one, and escaping them would break the emoji to
 * catch the rare text that hides behind them; they attach to a visible character without
 * changing what it says.
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
 * and terminals this project does not write. Rows written before `N-24` keep what they had.
 * The log lines `#record` writes beside the row carry the same escaped text: pino's JSON escapes
 * only U+0000 to U+001F, so a C1 or an override would reach the journal as the far end wrote it.
 * A test send (`test-send.ts`) stores nothing, and applies this to what it reports and logs.
 *
 * A literal backslash followed by `u` in the original reads the same as an escape. This is a
 * diagnosis for a person, not data to parse back.
 */
export function legible(text: string): string {
  return text.replace(UNSAFE, (found: string, at: number) => {
    if (found === '\r\n') return '\n';
    if (found === '\n' || found === '\t') return found;
    if ((found === ZWNJ || found === ZWJ) && joins(found, text, at)) return found;
    const point = found.codePointAt(0) ?? 0;
    const hex = point.toString(16);
    return point > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}

/** Whether the joiner at `at` stands where it joins: in a joining script, or in an emoji. */
function joins(joiner: string, text: string, at: number): boolean {
  const before = pointBefore(text, at);
  const after = pointAt(text, at + 1);
  if (JOINING_SCRIPTS.some((script) => script.test(before) && script.test(after))) return true;
  if (joiner !== ZWJ || !PICTURE.test(after)) return false;
  if (PICTURE.test(before)) return true;
  // A skin tone or U+FE0F only where it follows a picture itself: after a letter it is drawn as
  // nothing, and would carry a ZWJ in with it.
  return PICTURE_SUFFIX.test(before) && PICTURE.test(pointBefore(text, at - before.length));
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
