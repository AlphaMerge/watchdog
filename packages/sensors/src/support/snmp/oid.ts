/**
 * Object identifiers, as text and as numbers.
 *
 * Small enough to write and too important to guess at: a walk terminates by asking "is this
 * still under the OID I asked for", and a string `startsWith` gets that wrong — `1.3.6.1.2.1.2`
 * is not a prefix of `1.3.6.1.2.1.25`, but its text is. Comparing arc by arc is the only way to
 * be right, and it is what tells a walk it has left the subtree instead of returning half the
 * agent's MIB.
 */

/** Arcs are 32-bit unsigned in every encoding in practice; BER would allow more. */
const MAX_ARC = 4_294_967_295;

export class OidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidError';
  }
}

/**
 * A dotted OID as its arcs.
 *
 * Rejects rather than repairs. An OID arrives from a sensor's parameters, so a typo here becomes
 * a request for the wrong object — and an agent answering "no such object" for `1.3.6.1.2.1..1`
 * would send somebody looking at the device.
 */
export function parseOid(text: string): number[] {
  const trimmed = text.trim().replace(/^\./, '');
  if (trimmed === '') throw new OidError('an OID cannot be empty');

  const arcs = trimmed.split('.');
  return arcs.map((arc) => {
    if (!/^\d+$/.test(arc)) {
      throw new OidError(`"${text}" is not an OID: "${arc}" is not a number`);
    }
    const value = Number(arc);
    if (value > MAX_ARC) {
      throw new OidError(`"${text}" is not an OID: the arc "${arc}" is too large`);
    }
    return value;
  });
}

/** The canonical text form: no leading dot, no spaces. */
export function formatOid(arcs: readonly number[]): string {
  return arcs.join('.');
}

/** Normalises to the form the agent will be asked for, and validates on the way. */
export function normaliseOid(text: string): string {
  return formatOid(parseOid(text));
}

/**
 * Whether `oid` is `prefix` or sits underneath it.
 *
 * Arc by arc, because the text answer is wrong: `startsWith('1.3.6.1.2.1.2')` accepts
 * `1.3.6.1.2.1.25.1`, which is a different subtree. A walk using the text form would keep going
 * past the end of the table it was asked for.
 */
export function isPrefixOf(prefix: readonly number[], oid: readonly number[]): boolean {
  if (oid.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (oid[i] !== prefix[i]) return false;
  }
  return true;
}

/** Lexicographic by arc, which is SNMP's own ordering. Negative, zero or positive. */
export function compareOids(a: readonly number[], b: readonly number[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * The part of `oid` below `prefix` — a table row's index.
 *
 * `ifDescr.3` under `ifDescr` is `[3]`; a table with a composite index gives every arc of it.
 * Returns null when the OID is not under the prefix at all, which a caller walking a table
 * should treat as the end of it rather than as row zero.
 */
export function indexUnder(prefix: readonly number[], oid: readonly number[]): number[] | null {
  if (!isPrefixOf(prefix, oid)) return null;
  return oid.slice(prefix.length);
}
