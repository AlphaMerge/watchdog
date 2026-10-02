import { isIPv4 } from 'node:net';
import type { DeviceKind, Fingerprint, OpenPort } from '@ms/shared';

/** The device kinds this build knows. A probe naming another is a newer probe, and is refused. */
const KINDS: ReadonlySet<string> = new Set<DeviceKind>([
  'windows',
  'linux',
  'network',
  'printer',
  'hypervisor',
  'nas',
  'unknown',
]);

/**
 * The optional fields something downstream calls a string method on: the matcher lower-cases
 * `vendor` and strips `sysObjectId`, provisioning trims `sysName` and `reverseName` and slices
 * `sysDescr`. A number in any of them is a 500 wherever it is next read.
 */
const TEXT_FIELDS: ReadonlySet<string> = new Set([
  'reverseName',
  'sysDescr',
  'sysObjectId',
  'sysName',
  'httpServer',
  'vendor',
  // Why the probe's target policy stopped identification (`A-63`). Read as a string by the
  // summary, which shows it to an operator.
  'refused',
]);

/** A fingerprint that can be matched, or the field that stops it and why (`D-12`). */
export type FingerprintCheck =
  | { readonly ok: true; readonly fingerprint: Fingerprint }
  | { readonly ok: false; readonly field: string; readonly problem: string };

/**
 * Whether a value is a fingerprint this build can match, and it normalised if so.
 *
 * **The one definition, for a fingerprint a probe reported and one an operator submitted**
 * (`D-12`). Until then the plan route took any object and handed it to the matcher, which read
 * `ports.map` on nothing and answered 500, while a stored fingerprint went through a reader of its
 * own. Two readers is how the route came to have none.
 *
 * **Strict about what anything downstream depends on and permissive about the rest.** `address`
 * is what a stored row is matched by, `kind` is what `D-03` maps to a sensor set, each port's
 * number is what a template's port criteria test, and the text fields above are read as strings.
 * `null` in a text field or in `ports` is taken as absent, because that is what it says, and is
 * removed rather than kept, because provisioning tests those fields against `undefined`.
 * Everything else is carried through as it arrived, because a newer probe reporting a field this
 * build has never heard of is exactly the case the wire schema left open on purpose — dropping it
 * would lose information a later release knows how to read, and the column is `jsonb`. For the
 * same reason a confidence that is not a number reads as 0 and evidence keeps only its strings:
 * neither can break a match.
 */
export function checkFingerprint(value: unknown): FingerprintCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, field: '', problem: 'must be an object' };
  }
  const record = value as Record<string, unknown>;
  const address = record['address'];
  if (typeof address !== 'string' || !isIPv4(address)) {
    return { ok: false, field: 'address', problem: 'must be an IPv4 address, dotted-quad' };
  }
  const kind = record['kind'];
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    return { ok: false, field: 'kind', problem: `must be one of ${[...KINDS].join(', ')}` };
  }
  for (const field of TEXT_FIELDS) {
    const text = record[field];
    if (text !== undefined && text !== null && typeof text !== 'string') {
      return { ok: false, field, problem: 'must be a string' };
    }
  }
  const ports: unknown = record['ports'] ?? [];
  if (!Array.isArray(ports)) return { ok: false, field: 'ports', problem: 'must be an array' };
  for (const [index, port] of (ports as unknown[]).entries()) {
    const number: unknown =
      typeof port === 'object' && port !== null ? (port as Record<string, unknown>)['port'] : null;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 65_535) {
      return {
        ok: false,
        field: `ports[${String(index)}].port`,
        problem: 'must be an integer from 1 to 65535',
      };
    }
  }
  const confidence = Number(record['confidence']);
  const evidence = record['evidence'];
  return {
    ok: true,
    fingerprint: {
      ...Object.fromEntries(
        Object.entries(record).filter(([key, one]) => !(one === null && TEXT_FIELDS.has(key))),
      ),
      address,
      kind: kind as DeviceKind,
      confidence: Number.isFinite(confidence) ? Math.min(100, Math.max(0, confidence)) : 0,
      ports: ports as OpenPort[],
      evidence: Array.isArray(evidence)
        ? (evidence as unknown[]).filter((one): one is string => typeof one === 'string')
        : [],
    },
  };
}

/** A stored or reported fingerprint, or null when it is not one this build can match. */
export function readFingerprint(value: unknown): Fingerprint | null {
  const check = checkFingerprint(value);
  return check.ok ? check.fingerprint : null;
}
