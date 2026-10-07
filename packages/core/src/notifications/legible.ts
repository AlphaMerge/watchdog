/**
 * CRLF first, so it is taken as one; then every control, every format character (which holds
 * every bidirectional control) and the two Unicode line and paragraph separators.
 */
const UNSAFE = /\r\n|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The two joiners, kept between letters of scripts and emoji that need them (`N-27`). */
const JOINERS = new Set(['\u200c', '\u200d']);

/** A neighbour a joiner may join: not ASCII, and visible — not escaped here, not a space. */
const JOINABLE = /^[^\p{ASCII}\p{Cc}\p{Cf}\p{Cs}\p{Z}]$/u;

/**
 * A delivery error fit to store as `last_error` and to show to whoever reads it (`N-24`), and to
 * hand back to whoever sent a test notification (`N-27`).
 *
 * An error quotes the far end — a webhook's response body, a program's last line, a relay's
 * reply — and the far end can say anything. Four things in what it says do harm:
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
 * **Except the two joiners between characters that use them.** ZWNJ (U+200C) and ZWJ (U+200D)
 * are format characters too, and they are how Persian, Arabic and Indic text is written and how
 * an emoji sequence is one picture: escaped everywhere, a Persian relay's refusal would read
 * broken. Each is kept where both its neighbours are visible characters other than ASCII —
 * the only place either does its job — and escaped anywhere else, where it does nothing but
 * hide: between two Latin letters, at either end, or beside a space or another escape.
 *
 * **Not the variation selectors**, nor the rest of `\p{Default_Ignorable_Code_Point}`. They are
 * marks (`\p{Mn}`), not format characters, and an emoji's U+FE0F is one; escaping them would
 * break the emoji to catch the rare text that hides behind them. A diagnosis for a person needs
 * the visible text to be the text, and they attach to a visible character without changing it.
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
    if (JOINERS.has(found) && joins(text, at)) return found;
    const point = found.codePointAt(0) ?? 0;
    const hex = point.toString(16);
    return point > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}

/** Whether the joiner at `at` stands between two characters it can join. */
function joins(text: string, at: number): boolean {
  const low = at >= 2 ? text.charCodeAt(at - 1) : -1;
  const before =
    low >= 0xdc00 && low <= 0xdfff ? text.slice(at - 2, at) : text.slice(Math.max(0, at - 1), at);
  const next = text.codePointAt(at + 1);
  const after = next === undefined ? '' : String.fromCodePoint(next);
  return JOINABLE.test(before) && JOINABLE.test(after);
}
