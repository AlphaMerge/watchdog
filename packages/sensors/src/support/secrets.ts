import { credentialKind, secretFields } from '../credentials/index.js';

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
 * **What it is, exactly, and no more:** every *exact* value of a `writeOnly` parameter of the
 * sensor's type, and of a `writeOnly` field of a credential the check was given, replaced wherever
 * it appears in the message. It does not catch a secret that was encoded, split, hashed, or quoted
 * with escapes; a script that prints its key base64-encoded prints it. And it skips values shorter
 * than `MIN_SCRUBBED_LENGTH`: a three-character community string would otherwise turn every
 * occurrence of those three letters in every message into a marker, and a message nobody can read
 * is a diagnosis lost for a secret that was never much of one.
 */

/** Values shorter than this are left in the text; see above. */
export const MIN_SCRUBBED_LENGTH = 4;

export const SCRUBBED = '••••••';

/**
 * What a type scrubs somebody else's words with before it clips them (`S-21`): the catalogue's,
 * or nothing where a test called the type directly.
 */
export function scrubberOf(context: {
  readonly scrub?: ((text: string) => string) | undefined;
}): (text: string) => string {
  return context.scrub ?? ((text: string): string => text);
}

/** Replaces every secret with the marker. Longest first, so one secret inside another goes too. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < MIN_SCRUBBED_LENGTH) continue;
    out = out.split(secret).join(SCRUBBED);
  }
  return out;
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
  const out = new Set<string>();
  for (const path of writeOnlyPaths) {
    stringsIn(valueAt(params, path.split('.')), out);
  }
  for (const [kind, values] of Object.entries(credentials)) {
    const definition = credentialKind(kind);
    if (definition === undefined) {
      stringsIn(values, out);
      continue;
    }
    for (const field of secretFields(definition)) stringsIn(values[field], out);
  }
  out.delete('');
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
