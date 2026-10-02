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
  // Why the probe's target policy stopped identification (`A-63`), and the same claim set
  // aside. Read as strings by the summary, which shows them to an operator.
  'refused',
  'refusalIgnored',
]);

/**
 * The longest refusal kept. The probe's sentence is about 300 characters; this is room for a
 * long name in it and nothing like room for a document.
 */
export const REFUSAL_MAX_LENGTH = 500;

/**
 * A probe's refusal, fit to put in a list an operator reads and a log line: one line, bounded.
 *
 * **It is input from a remote probe**, and it reaches the run's summary as text. Every control
 * character becomes a space, a newline first among them, so one host's text cannot start what
 * looks like another entry in a list or another line in a log; runs of space are one; and it is
 * cut. Undefined when nothing is left: a refusal that says nothing is not one.
 *
 * **The only free-text field bounded here.** `sysDescr`, `sysName`, `reverseName`, `httpServer`,
 * `vendor`, the banners and `evidence` are cut by the probe that collects them and taken at any
 * length by this check; that is a ticket of its own, not this one's.
 */
export function refusalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    // eslint-disable-next-line no-control-regex -- the point of this function is control chars.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, REFUSAL_MAX_LENGTH);
  return clean === '' ? undefined : clean;
}

/** What a source fills in. Any of them, said, is a finding. */
const FOUND_FIELDS = [
  'reverseName',
  'sysDescr',
  'sysObjectId',
  'sysName',
  'httpServer',
  'vendor',
] as const;

/**
 * Whether a fingerprint carries anything identification found: a kind other than `unknown`, an
 * open port, or any of the fields a source fills (`reverseName`, `sysDescr`, `sysObjectId`,
 * `sysName`, `httpServer`, `vendor`). `confidence` and `evidence` are not findings: a refusal
 * carries its own sentence as evidence.
 */
function hasFindings(record: Record<string, unknown>, kind: string, ports: unknown[]): boolean {
  if (kind !== 'unknown' || ports.length > 0) return true;
  return FOUND_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === 'string' && value.trim() !== '';
  });
}

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
  // **A refusal is believed only of a host nothing was found on** (`A-63`). The probe says
  // `refused` of an address it asked nothing of, so one that arrives beside a kind, a port or a
  // system description contradicts itself, and neither half is taken on trust: the host is
  // counted by its findings, which are what a template matches, and the claim is moved to
  // `refusalIgnored`, which the summary shows for that address. `refusalIgnored` from a probe
  // is cleaned like `refused` and kept only where there are findings for it to be about.
  const claimed = refusalText(record['refused']);
  const setAside = refusalText(record['refusalIgnored']);
  const found = hasFindings(record, kind, ports as unknown[]);
  const ignored = found ? (claimed ?? setAside) : undefined;
  const refused = found ? undefined : claimed;
  const refusal = {
    ...(refused === undefined ? {} : { refused }),
    ...(ignored === undefined ? {} : { refusalIgnored: ignored }),
  };
  return {
    ok: true,
    fingerprint: {
      ...Object.fromEntries(
        Object.entries(record).filter(
          ([key, one]) =>
            key !== 'refused' &&
            key !== 'refusalIgnored' &&
            !(one === null && TEXT_FIELDS.has(key)),
        ),
      ),
      ...refusal,
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
