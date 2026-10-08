import { encodedForms } from '@ms/shared';

/**
 * Keeping a sensor's parameter values out of what is said about a type's error (`P-297`, `P-305`).
 *
 * **Extracted at the second caller.** `P-297`'s review wrote it for the ingestion path's warning,
 * and `P-305` needs the same thing at the sensor-type gate, where a type's own error reaches an
 * API reply as well as the log. A type's `throw new Error(\`bad column ${column}\`)` puts a value
 * in its message, and a `writeOnly` parameter is a credential: on an edit, one the caller never
 * sent, carried from what is stored.
 */

/**
 * `text` with every string the parameters hold taken out of it.
 *
 * Every string of three characters or more goes, and a secret whatever its length; a shorter one
 * would take pieces out of ordinary words, and is not a value anyone could recognise. Longest
 * first, so a value inside another goes with it.
 *
 * **A secret goes in every form it is echoed in, not only as spelled** (`P-305` review): the
 * forms `encodedForms` names (`A-42`), percent-encoded, `+` for a space, base64 and base64url,
 * HTML- and JSON-escaped. A type that throws `cannot use ${JSON.stringify(params)}`, or builds a
 * URL with the secret in it and quotes the URL, would otherwise hand the stored credential to
 * whoever reads the reply. A secret is any string at or beneath a `writeOnly` path, so an object
 * or array there is covered whole. The rest of the parameters are taken out as spelled only: they
 * are the caller's own, and what is at stake for them is a log line, not a credential.
 */
export function withoutParamValues(
  text: string,
  params: Readonly<Record<string, unknown>>,
  secretPaths: readonly string[],
): string {
  // A path is a secret when it is one; everything beneath one inherits it in the walk.
  const secrets = new Set(secretPaths);
  const isSecret = (path: string): boolean => secrets.has(path);
  const values = new Set<string>();
  const walk = (node: unknown, path: string, secret: boolean): void => {
    if (typeof node === 'string') {
      if (node === '') return;
      if (secret) {
        for (const form of encodedForms(node)) values.add(form);
      } else if (node.length >= 3) {
        values.add(node);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, path, secret);
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        const at = path === '' ? key : `${path}.${key}`;
        walk(value, at, secret || isSecret(at));
      }
    }
  };
  walk(params, '', false);
  let scrubbed = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.split(value).join('[a parameter]');
  }
  return scrubbed;
}

/**
 * The error with every string the parameters hold taken out of its message and its stack, keeping
 * its name and any string `code`; the error itself when there was nothing to take out, or when it
 * is no `Error` at all.
 */
export function errorWithoutParamValues(
  cause: unknown,
  params: Readonly<Record<string, unknown>>,
  secretPaths: readonly string[],
): unknown {
  if (!(cause instanceof Error)) return cause;
  const message = withoutParamValues(cause.message, params, secretPaths);
  const stack =
    cause.stack === undefined ? undefined : withoutParamValues(cause.stack, params, secretPaths);
  if (message === cause.message && stack === cause.stack) return cause;
  const scrubbed = new Error(message);
  scrubbed.name = cause.name;
  // The original's frames, scrubbed: a fresh error's own stack would point here, and a logger
  // serialising the cause would otherwise print the unscrubbed one.
  if (stack === undefined) delete scrubbed.stack;
  else scrubbed.stack = stack;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'string') Object.assign(scrubbed, { code });
  return scrubbed;
}

/** `SensorTypeError`'s code, any other error's own `code` if it has a string one, or its name. */
export function errorKindOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    if (cause instanceof Error) return cause.name;
  }
  return typeof cause;
}
