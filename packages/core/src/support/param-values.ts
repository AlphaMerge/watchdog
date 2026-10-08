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
 */
export function withoutParamValues(
  text: string,
  params: Readonly<Record<string, unknown>>,
  secretPaths: readonly string[],
): string {
  const secrets = new Set(secretPaths);
  const values: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (node.length >= 3 || (node !== '' && secrets.has(path))) values.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path === '' ? key : `${path}.${key}`);
      }
    }
  };
  walk(params, '');
  let scrubbed = text;
  for (const value of values.sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.split(value).join('[a parameter]');
  }
  return scrubbed;
}

/**
 * The error with every string the parameters hold taken out of its message, keeping its name and
 * any string `code`; the error itself when there was nothing to take out, or when it is no
 * `Error` at all.
 */
export function errorWithoutParamValues(
  cause: unknown,
  params: Readonly<Record<string, unknown>>,
  secretPaths: readonly string[],
): unknown {
  if (!(cause instanceof Error)) return cause;
  const message = withoutParamValues(cause.message, params, secretPaths);
  if (message === cause.message) return cause;
  const scrubbed = new Error(message);
  scrubbed.name = cause.name;
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
