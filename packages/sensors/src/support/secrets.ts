import { encodedForms, MIN_SCRUBBED_LENGTH, SCRUBBED, scrubSecrets } from '@ms/shared';
import { credentialKind, secretFields } from '../credentials/index.js';
import { authorizationFor } from './http/auth.js';

// The scrubber itself lives in `@ms/shared` since `A-44`, where a notification program's output
// is scrubbed by the same code, and `encodedForms` since `P-305`'s review, where the core cuts a
// stored secret out of a sensor type's error. Re-exported, so everything that imports them from
// here is unchanged.
export { encodedForms, MIN_SCRUBBED_LENGTH, SCRUBBED, scrubSecrets };

/**
 * Keeping a check's secrets out of what it says (`S-19`).
 *
 * A check's message is the most widely read thing it produces: the state log shows it to every
 * account that can read the sensor, a notification carries it to whoever the template names, and
 * a report prints it. And a message is very often somebody else's words — a script's last lines of
 * output, a database driver's error, an SSH server's banner — which may include the password the
 * check just used. So every message leaves the probe with each secret the check held replaced by a
 * marker, whatever type produced it.
 *
 * **What it is, and no more:** every value of a `writeOnly` parameter of the sensor's type, and
 * of a `writeOnly` field of a credential the check was given, replaced wherever it appears in the
 * message. Each value also in the forms a server echoes a request back in (`A-42`, `encodedForms`):
 * percent-encoded (upper- and lower-case hex, and as a form encodes a space), base64 (padded,
 * unpadded and URL-safe), HTML-escaped and JSON-escaped. An `http` credential adds the
 * base64 of `username:password` that basic authentication sends.
 *
 * It does not catch a secret split, truncated, hashed, re-cased or encoded twice, base64 of a
 * secret inside a longer encoded string (other than basic authentication's), hex, or an HTML or
 * JSON escape spelled another way (`&#x27;` for `&#39;`, `\u0022` for `\"`). A script that prints
 * its key reversed prints it. And it skips values shorter than `MIN_SCRUBBED_LENGTH`: a
 * three-character community string would otherwise turn every occurrence of those three letters
 * in every message into a marker, and a message nobody can read is a diagnosis lost for a secret
 * that was never much of one.
 */

/**
 * What a type scrubs somebody else's words with before it clips them (`S-21`): the catalogue's,
 * or nothing where a test called the type directly.
 */
export function scrubberOf(context: {
  readonly scrub?: ((text: string) => string) | undefined;
}): (text: string) => string {
  return context.scrub ?? ((text: string): string => text);
}

/**
 * Every secret a check holds: the values at its type's `writeOnly` paths, and the `writeOnly`
 * fields of each credential it was handed.
 *
 * A `writeOnly` path that holds an object or an array gives every string beneath it. A credential
 * of a kind this build does not know gives every string it holds — a kind nobody described is
 * one nobody said was safe to print.
 */
export function secretsOfCheck(
  writeOnlyPaths: readonly string[],
  params: Readonly<Record<string, unknown>>,
  credentials: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string[] {
  const exact = new Set<string>();
  for (const path of writeOnlyPaths) {
    stringsIn(valueAt(params, path.split('.')), exact);
  }
  for (const [kind, values] of Object.entries(credentials)) {
    const definition = credentialKind(kind);
    if (definition === undefined) {
      stringsIn(values, exact);
      continue;
    }
    for (const field of secretFields(definition)) stringsIn(values[field], exact);
    // The one secret the check itself encodes before sending: basic authentication's pair,
    // which a server echoing its request headers echoes as it arrived.
    if (kind === 'http') {
      const basic = /^Basic (.+)$/.exec(authorizationFor(values) ?? '');
      if (basic?.[1] !== undefined) exact.add(basic[1]);
    }
  }
  exact.delete('');
  const out = new Set<string>();
  for (const secret of exact) {
    for (const form of secret.length < MIN_SCRUBBED_LENGTH ? [secret] : encodedForms(secret)) {
      out.add(form);
    }
  }
  return [...out];
}

function valueAt(source: Readonly<Record<string, unknown>>, segments: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function stringsIn(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) stringsIn(child, out);
}
