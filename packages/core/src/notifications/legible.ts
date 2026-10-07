/** CRLF first, so it is taken as one; then every control and every bidirectional control. */
const UNSAFE = /\r\n|[\p{Cc}\p{Bidi_Control}]/gu;

/**
 * A delivery error fit to store as `last_error` and to show to whoever reads it (`N-24`).
 *
 * An error quotes the far end — a webhook's response body, a program's last line, a relay's
 * reply — and the far end can say anything. Three things in what it says do harm:
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
 *   say something its sender did not.
 *
 * **Escaped, not removed.** Each becomes `\uXXXX`, so that a reader sees *something was there* —
 * a body that tried to reverse itself reads as one that tried, instead of as plain text with a
 * few characters quietly missing. That costs at most six characters for one, and every error that
 * quotes the far end already keeps 200 characters of it.
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
 *
 * A literal backslash followed by `u` in the original reads the same as an escape. This is a
 * diagnosis for a person, not data to parse back.
 */
export function legible(text: string): string {
  return text.replace(UNSAFE, (found) => {
    if (found === '\r\n') return '\n';
    if (found === '\n' || found === '\t') return found;
    return `\\u${(found.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
  });
}
