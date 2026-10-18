import {
  connect,
  type ConnectionOptions,
  type DetailedPeerCertificate,
  type PeerCertificate,
  type TLSSocket,
} from 'node:tls';
import { isIP, type LookupFunction } from 'node:net';
import { certificateListsAddress, serverIdentity } from '@ms/shared';
import { connectFailure, socketUnresolved } from '../checked-target.js';
import { PhasedError } from '../phased-error.js';

/**
 * One TLS handshake, and what it revealed (`T-11`, `T-12`).
 *
 * Shared by the certificate sensor and the security-check sensor because they ask the same
 * question of the same handshake and differ only in what they read off it — and because the one
 * genuinely awkward part, `rejectUnauthorized: false`, needs to be right in exactly one place.
 *
 * **The handshake deliberately does not verify.** That is the opposite of what a client should
 * do and it is correct here: a certificate sensor's *job* is to report an expired or mismatched
 * certificate, and a connection that refused to complete would report nothing at all — the
 * sensor would go Down with a TLS error instead of counting down the days. So the socket accepts
 * anything and the verdict is computed afterwards, from the certificate itself, where it can be
 * turned into channels rather than into a failure.
 */

export interface TlsTarget {
  readonly host: string;
  readonly port: number;
  /**
   * Who the certificate is asked to be for. Almost always the host; separate because a device
   * addressed by IP usually serves a named certificate. Sent as the server name (SNI) when it
   * is a name, and not sent when it is an address (`A-71`): the certificate is still checked
   * against it either way.
   */
  readonly servername: string;
  readonly timeoutMs: number;
  /**
   * The socket's `lookup`, when the device's name was resolved and checked against the probe's
   * target policy (`A-57`): it answers with the checked addresses, so the name is not resolved
   * a second time. `host` stays the name.
   */
  readonly lookup?: LookupFunction;
  /**
   * The device's IP version, where it names one (`A-85`), for what a failure says: a name with
   * no address of it did not resolve to that family. The connection is held to it by `lookup`
   * (`lookupFor`), never by telling the socket, which would then try one address alone.
   */
  readonly family?: 4 | 6;
  /**
   * When the check began resolving the name, where it did that itself. `elapsedMs` is counted
   * from here, and so is the timeout: the lookup and the handshake share `timeoutMs` and the
   * handshake time includes the lookup, both as they did when the socket made the lookup.
   */
  readonly startedAt?: bigint;
}

export interface TlsHandshake {
  /** Detailed, because `getPeerCertificate(true)` is what carries the chain. */
  readonly certificate: DetailedPeerCertificate;
  readonly protocol: string | null;
  readonly cipher: { name: string; standardName: string; version: string };
  /** What Node's own verifier concluded. Null when it was happy. */
  readonly authorizationError: string | null;
  readonly authorized: boolean;
  /** Milliseconds for the whole handshake — TCP and TLS together. */
  readonly elapsedMs: number;
}

/**
 * Where a handshake failed (`P-406`): before the connection was made (`connect`), or on it
 * (`handshake`). A name that did not resolve fails in the target guard, as `resolve`, and only
 * reaches here as `resolve` where nothing checked it first.
 */
export type TlsPhase = 'resolve' | 'connect' | 'handshake';

export class TlsError extends PhasedError {
  override readonly phase: TlsPhase;

  constructor(message: string, where: { phase: TlsPhase; host: string }, cause?: unknown) {
    super(message, where, cause);
    this.name = 'TlsError';
    this.phase = where.phase;
  }
}

/**
 * Connects, completes a handshake, and hangs up.
 *
 * The certificate chain is requested in full (`getPeerCertificate(true)`) because the chain is
 * half of what a certificate sensor is for: an expiring *intermediate* takes a site down exactly
 * as an expiring leaf does, and it is the one nobody is watching.
 */
export function handshake(
  target: TlsTarget,
  signal: AbortSignal,
  options: {
    readonly minVersion?: string;
    readonly maxVersion?: string;
    readonly ciphers?: string;
  } = {},
): Promise<TlsHandshake> {
  return new Promise<TlsHandshake>((resolve, reject) => {
    const started = target.startedAt ?? process.hrtime.bigint();
    let settled = false;

    const config: ConnectionOptions = {
      host: target.host,
      port: target.port,
      // **An address is not a server name, and none is sent for one** (`A-71`). RFC 6066
      // allows only a DNS name there, Node warns (DEP0123) that it will stop sending a literal,
      // and a server choosing a certificate by name has nothing to choose by an address with.
      // The mail sensors and the delivery client never sent one. A name is sent as before.
      ...(isIP(target.servername) === 0 ? { servername: target.servername } : {}),
      ...(target.lookup === undefined ? {} : { lookup: target.lookup }),
      // See the note above: verification is done *after* the fact so that a bad certificate is a
      // reading rather than a failed connection.
      rejectUnauthorized: false,
      // Node still forms a verdict it does not enforce, and `authorized` is that verdict: the
      // chain *and* who the certificate is for. Its own check of the second reads an IPv6
      // address as a name, so a device at one read "not trusted" under a certificate that
      // lists the address (`A-67`). The shared check asks the certificate about the address;
      // for a name or an IPv4 address it is Node's, so nothing else this reports has moved.
      // Asked about `target.servername` and not about whatever Node would fall back to once no
      // server name is sent: that fallback is the host, which is the same thing unless a sensor
      // declares one address for a device at another.
      checkServerIdentity: (_host, certificate) => serverIdentity(target.servername, certificate),
      ...(options.minVersion === undefined
        ? {}
        : { minVersion: options.minVersion as ConnectionOptions['minVersion'] }),
      ...(options.maxVersion === undefined
        ? {}
        : { maxVersion: options.maxVersion as ConnectionOptions['maxVersion'] }),
      ...(options.ciphers === undefined ? {} : { ciphers: options.ciphers }),
    };

    let socket: TLSSocket;
    try {
      socket = connect(config);
    } catch (error) {
      reject(
        new TlsError(
          `could not start a TLS connection to ${target.host}: ${text(error)}`,
          { phase: 'connect', host: target.host },
          error,
        ),
      );
      return;
    }
    // Made once the TCP connection is, so a failure says whether it was before or on it.
    let connected = false;
    socket.once('connect', () => {
      connected = true;
    });
    const at = (): { phase: TlsPhase; host: string } => ({
      phase: connected ? 'handshake' : 'connect',
      host: target.host,
    });

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      outcome();
    };

    const onAbort = (): void => {
      finish(() => {
        reject(new TlsError(`the check was cancelled while connecting to ${target.host}`, at()));
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(
      () => {
        finish(() => {
          reject(
            new TlsError(
              `${target.host}:${String(target.port)} did not complete a TLS handshake within ` +
                `${String(target.timeoutMs)} ms`,
              at(),
            ),
          );
        });
      },
      // What the lookup took is taken from what the handshake has.
      Math.max(1, target.timeoutMs - Number(process.hrtime.bigint() - started) / 1e6),
    );
    timer.unref();

    socket.once('secureConnect', () => {
      const elapsedMs = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100;
      const certificate = socket.getPeerCertificate(true);
      const cipher = socket.getCipher();
      // `authorizationError` is typed as a definite `Error`, and is `null` at runtime whenever
      // the verifier was happy — which is most of the time. The check stays; the cast is what
      // lets it be written.
      const error = socket.authorizationError as Error | null | undefined;
      finish(() => {
        resolve({
          certificate,
          protocol: socket.getProtocol(),
          cipher,
          authorizationError: error === undefined || error === null ? null : String(error),
          authorized: socket.authorized,
          elapsedMs,
        });
      });
    });

    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        reject(describe(error, target, at().phase));
      });
    });
  });
}

/** `phase` is where the socket had got to: `handshake` once the TCP connection was made. */
function describe(error: NodeJS.ErrnoException, target: TlsTarget, phase: TlsPhase): TlsError {
  const where = `${target.host}:${String(target.port)}`;
  const host = target.host;
  // A name whose every address failed is read by the one that got furthest, and names each
  // (`connectFailure`, `A-85`'s second check): the error Node ends the socket with says nothing.
  const { code, message, tried } = connectFailure(error);
  switch (code) {
    case 'ECONNREFUSED':
      return new TlsError(
        `nothing is listening at ${where}${tried}`,
        { phase: 'connect', host },
        error,
      );
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      // In the guard's words (`A-85`): no address of the device's family, or a resolver that
      // is not answering, each said as what it is.
      return new TlsError(
        socketUnresolved(code, target.family, `connecting to ${where}`) ??
          `the device’s host name did not resolve, connecting to ${where}`,
        { phase: 'resolve', host },
        error,
      );
    case 'ECONNRESET':
      return new TlsError(
        `${where} closed the connection during the TLS handshake — this is what a plain-text ` +
          'service does when something tries to speak TLS to it, and what a server does when it ' +
          'shares no protocol version with the client',
        { phase, host },
        error,
      );
    case 'ERR_SSL_UNSUPPORTED_PROTOCOL':
    case 'ERR_SSL_NO_PROTOCOLS_AVAILABLE':
    case 'ERR_SSL_VERSION_TOO_LOW':
      return new TlsError(
        `${where} does not accept this TLS version`,
        { phase: 'handshake', host },
        error,
      );
    default:
      // Before the connection was made, it is the connect that failed, not a handshake.
      return new TlsError(
        phase === 'connect'
          ? `could not connect to ${where}: ${message}${tried}`
          : `the TLS handshake with ${where} failed: ${text(error)}`,
        { phase, host },
        error,
      );
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The names in a certificate a browser would accept it for: the CN plus every DNS SAN. */
export function namesOf(certificate: PeerCertificate): string[] {
  const names = new Set<string>();
  const common: string | string[] | undefined = certificate.subject.CN;
  if (typeof common === 'string' && common !== '') names.add(common);
  else if (Array.isArray(common)) for (const entry of common) if (entry !== '') names.add(entry);
  // Absent on a certificate with no SANs at all, whatever the type says.
  const san: string = certificate.subjectaltname || '';
  for (const entry of san.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.toLowerCase().startsWith('dns:')) names.add(trimmed.slice(4).trim());
  }
  return [...names];
}

/**
 * The addresses a certificate lists, as IP subject alternative names, in the form Node writes
 * them (`A-75`). For saying what a certificate is for, never for deciding whether it is for an
 * address: that is `certificateListsAddress`, which asks OpenSSL of the DER rather than parse
 * this string.
 */
export function addressesOf(certificate: Pick<PeerCertificate, 'subjectaltname'>): string[] {
  const addresses = new Set<string>();
  // Absent on a certificate with no SANs at all, whatever the type says.
  const san: string = certificate.subjectaltname || '';
  for (const entry of san.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.toLowerCase().startsWith('ip address:')) {
      const address = trimmed.slice('ip address:'.length).trim();
      if (address !== '') addresses.add(address);
    }
  }
  return [...addresses];
}

/**
 * Whether a certificate name covers this host, wildcards included.
 *
 * A wildcard matches exactly one label and never a dot — `*.example.com` covers `a.example.com`
 * and not `a.b.example.com` — which is the rule browsers enforce and the one a naive
 * `startsWith` gets wrong in the direction that accepts too much.
 */
export function nameMatches(pattern: string, host: string): boolean {
  const name = pattern.trim().toLowerCase();
  const target = host.trim().toLowerCase();
  if (name === '') return false;
  if (name === target) return true;
  if (!name.startsWith('*.')) return false;

  const suffix = name.slice(1); // ".example.com"
  if (!target.endsWith(suffix)) return false;
  const label = target.slice(0, target.length - suffix.length);
  return label !== '' && !label.includes('.');
}

/** The whole chain, leaf first, following `issuerCertificate` until it repeats or runs out. */
export function chainOf(leaf: DetailedPeerCertificate): DetailedPeerCertificate[] {
  const chain: DetailedPeerCertificate[] = [];
  const seen = new Set<string>();
  // Typed as definite all the way down, but a chain genuinely ends: the last `issuerCertificate`
  // is either the root pointing at itself or an empty object, and both have to stop the walk.
  let current: DetailedPeerCertificate | undefined = leaf;

  while (current !== undefined && Object.keys(current).length > 0) {
    // A root is its own issuer, which is where this would otherwise loop for ever.
    // Present on any real certificate; `String(chain.length)` is the fallback for the `{}` an
    // anonymous cipher yields, which has no fingerprint to key on.
    const key = current.fingerprint256 || current.fingerprint || String(chain.length);
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(current);
    // `issuerCertificate` is declared as always present and is absent on the last certificate
    // of a chain. Dropping the guard above to satisfy the checker threw `Object.keys(undefined)`
    // on the first certificate with no issuer — caught by a test — so the widening stays and the
    // rule is turned off for the one line where the declaration is simply wrong.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- see above
    current = current.issuerCertificate as DetailedPeerCertificate | undefined;
  }
  return chain;
}

/** Whole days from now until `when`. Negative once it has passed. */
export function daysUntil(when: Date, now: Date = new Date()): number {
  return Math.floor((when.getTime() - now.getTime()) / 86_400_000);
}

export interface CertificateVerdict {
  /** The soonest expiry anywhere in the chain, in whole days. Negative once past. */
  readonly daysRemaining: number;
  readonly daysSinceIssued: number;
  readonly hostMatches: boolean;
  /** Every name the leaf is valid for. */
  readonly names: readonly string[];
  /** Every address the leaf lists (`A-75`): what the mismatch note names beside the names. */
  readonly addresses: readonly string[];
  readonly issuer: string;
  readonly chainLength: number;
  /** The subject whose expiry is soonest, when that is *not* the leaf. */
  readonly soonestSubject: string | null;
}

/**
 * Everything a certificate sensor reports, from a certificate and who it was asked to be for.
 *
 * Pure, and separate from the handshake, because this is the half worth testing exhaustively and
 * the half that cannot be exercised against a real server without a time machine: an *expired*
 * certificate is the case that matters most, and no version of `openssl req` before 3.2 will
 * issue one. Fabricating the certificate is not a compromise here — the input is a plain object
 * either way, and what is being tested is the arithmetic and the name matching.
 *
 * **The soonest expiry is taken across the whole chain.** An expiring intermediate takes a site
 * down exactly as an expiring leaf does, renews on somebody else's schedule, and is the one
 * nobody is watching.
 *
 * **`hostMatches` for an address is whether the certificate lists that address** (`A-71`), as
 * an IP subject alternative name, by the rule every verifying client here uses
 * (`certificateListsAddress`: OpenSSL asked, a zone taken off). It read 0 for every device given
 * by address, in either family, because only names were compared — so a certificate that was
 * exactly right read as a mismatch beside `trusted` 1. A name is compared as it always was, and
 * an address is still compared with the names too: a certificate whose common name is spelt as
 * the address read 1 before this and still does.
 */
export function inspectCertificate(
  leaf: DetailedPeerCertificate,
  servername: string,
  now: Date = new Date(),
): CertificateVerdict {
  const chain = chainOf(leaf);

  let soonest = leaf;
  let soonestDays = daysUntil(new Date(leaf.valid_to), now);
  for (const certificate of chain) {
    const days = daysUntil(new Date(certificate.valid_to), now);
    if (days < soonestDays) {
      soonestDays = days;
      soonest = certificate;
    }
  }

  const names = namesOf(leaf);
  return {
    daysRemaining: soonestDays,
    daysSinceIssued: -daysUntil(new Date(leaf.valid_from), now),
    hostMatches:
      names.some((name) => nameMatches(name, servername)) ||
      certificateListsAddress(servername, leaf),
    names,
    addresses: addressesOf(leaf),
    // A certificate's subject fields are `string | string[]`: a name may legitimately appear
    // more than once, and the type reflects that even though it almost never happens.
    issuer: one(leaf.issuer.CN) ?? one(leaf.issuer.O) ?? 'an unnamed issuer',
    chainLength: chain.length,
    soonestSubject: soonest === leaf ? null : (one(soonest.subject.CN) ?? 'unnamed'),
  };
}

/** The first value of a subject field, which may be one string or several. */
function one(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  const first = value?.[0];
  return first === undefined || first === '' ? undefined : first;
}
