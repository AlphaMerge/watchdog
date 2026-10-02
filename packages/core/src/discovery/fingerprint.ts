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
 * The longest each free-text field a source fills is kept at, in characters (`A-69`).
 *
 * **Every one is a remote probe's word.** Our probe cuts what it collects (`sysDescr` at 1,000,
 * `sysName` at 255, the `Server` header and a banner at 200), and until this the core took
 * whatever arrived: a probe that is not ours could put a megabyte in a device's name. Each limit
 * is the probe's own cut where it has one, so nothing a correct probe sends is shortened here.
 * The keys are also what counts as a finding: any of them, said, is one.
 */
export const FINGERPRINT_TEXT_LIMITS = {
  /** A DNS name is at most 253 characters. */
  reverseName: 255,
  /** The probe's cut. `DisplayString` allows 255 and agents exceed it. */
  sysDescr: 1_000,
  /** Dotted decimal. A vendor's `sysObjectID` is a few dozen characters. */
  sysObjectId: 256,
  /** `DisplayString (SIZE (0..255))`, and the probe's cut. */
  sysName: 255,
  /** The probe's cut of a `Server` header. */
  httpServer: 200,
  /** A company's name, from the classifier's own table. */
  vendor: 100,
} as const;

/** The probe's cut of the first line a service volunteered. */
export const BANNER_MAX_LENGTH = 200;
/** The classifier writes under ten notes a host; this is room for a later one to write more. */
export const EVIDENCE_MAX_ITEMS = 32;
/** A note quotes a reverse name or a `Server` header, and a refusal is one too. */
export const EVIDENCE_ITEM_MAX_LENGTH = REFUSAL_MAX_LENGTH;
/** As many as `identify-start` may ask about, so the most one answer can say is open. */
export const PORTS_MAX_ITEMS = 64;

/**
 * A probe's text, fit to store, to put in a list an operator reads, and to log: one line, bounded.
 *
 * **It is input from a remote probe.** Every control character becomes a space, a line break
 * first among them, so one host's text cannot start what looks like another entry in a list or
 * another line in a log; runs of space are one; and it is cut at `max` characters. Undefined
 * when nothing is left, or when it was not text.
 */
export function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    // eslint-disable-next-line no-control-regex -- the point of this function is control chars.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max);
  return clean === '' ? undefined : clean;
}

/**
 * A probe's refusal as the summary shows it: one line, at most `REFUSAL_MAX_LENGTH` characters.
 * Undefined when nothing is left: a refusal that says nothing is not one.
 */
export function refusalText(value: unknown): string | undefined {
  return boundedText(value, REFUSAL_MAX_LENGTH);
}

/**
 * Whether a fingerprint carries anything identification found: a kind other than `unknown`, an
 * open port, or any of the fields a source fills (`reverseName`, `sysDescr`, `sysObjectId`,
 * `sysName`, `httpServer`, `vendor`), read as they are kept. `confidence` and `evidence` are not
 * findings: a refusal carries its own sentence as evidence.
 */
function hasFindings(
  kept: Readonly<Record<string, string>>,
  kind: string,
  ports: readonly unknown[],
): boolean {
  return kind !== 'unknown' || ports.length > 0 || Object.keys(kept).length > 0;
}

/**
 * One reported port as it is kept: whatever it carried, with a banner that is one bounded line
 * or absent. A banner that is not text is dropped, since it is shown to an operator as text.
 */
function keptPort(port: unknown): OpenPort {
  const { banner: said, ...rest } = port as Record<string, unknown>;
  const banner = boundedText(said, BANNER_MAX_LENGTH);
  return { ...rest, ...(banner === undefined ? {} : { banner }) } as unknown as OpenPort;
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
 *
 * **And bounded, because it is a remote probe's word** (`A-69`). Every text field this build
 * knows is made one line and cut at its length in `FINGERPRINT_TEXT_LIMITS`, a port's banner at
 * `BANNER_MAX_LENGTH` and an evidence note at `EVIDENCE_ITEM_MAX_LENGTH`; `ports` keeps its first
 * `PORTS_MAX_ITEMS` and `evidence` its first `EVIDENCE_MAX_ITEMS`. A stored row is read through
 * this too, so what a reader gets is bounded whatever was written, and reading writes nothing
 * back. A field this build has never heard of is still carried at any size: the frame it arrived
 * in is the only bound on it.
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
  // **Every free-text field is bounded here, and made one line** (`A-69`). A field that cleans
  // to nothing is absent, as a `null` one is. The arrays are bounded too: a port past the
  // sixty-fourth is more than a probe was asked about and is dropped, not refused, so the host
  // keeps what was found on it.
  const kept: Record<string, string> = {};
  for (const [field, max] of Object.entries(FINGERPRINT_TEXT_LIMITS)) {
    const text = boundedText(record[field], max);
    if (text !== undefined) kept[field] = text;
  }
  const keptPorts = (ports as unknown[]).slice(0, PORTS_MAX_ITEMS).map(keptPort);
  // **A refusal is believed only of a host nothing was found on** (`A-63`). The probe says
  // `refused` of an address it asked nothing of, so one that arrives beside a kind, a port or a
  // system description contradicts itself, and neither half is taken on trust: the host is
  // counted by its findings, which are what a template matches, and the claim is moved to
  // `refusalIgnored`, which the summary shows for that address. `refusalIgnored` from a probe
  // is cleaned like `refused` and kept only where there are findings for it to be about.
  const claimed = refusalText(record['refused']);
  const setAside = refusalText(record['refusalIgnored']);
  const found = hasFindings(kept, kind, keptPorts);
  const ignored = found ? (claimed ?? setAside) : undefined;
  const refused = found ? undefined : claimed;
  const refusal = {
    ...(refused === undefined ? {} : { refused }),
    ...(ignored === undefined ? {} : { refusalIgnored: ignored }),
  };
  return {
    ok: true,
    fingerprint: {
      // What this build does not know is carried as it arrived. Every text field it does know
      // is taken out here and put back below as it is kept.
      ...Object.fromEntries(Object.entries(record).filter(([key]) => !TEXT_FIELDS.has(key))),
      ...kept,
      ...refusal,
      address,
      kind: kind as DeviceKind,
      confidence: Number.isFinite(confidence) ? Math.min(100, Math.max(0, confidence)) : 0,
      ports: keptPorts,
      evidence: Array.isArray(evidence)
        ? (evidence as unknown[])
            .map((one) => boundedText(one, EVIDENCE_ITEM_MAX_LENGTH))
            .filter((one): one is string => one !== undefined)
            .slice(0, EVIDENCE_MAX_ITEMS)
        : [],
    },
  };
}

/** A stored or reported fingerprint, or null when it is not one this build can match. */
export function readFingerprint(value: unknown): Fingerprint | null {
  const check = checkFingerprint(value);
  return check.ok ? check.fingerprint : null;
}
