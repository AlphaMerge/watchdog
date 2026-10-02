import {
  connect,
  type ConnectionOptions,
  type DetailedPeerCertificate,
  type PeerCertificate,
  type TLSSocket,
} from 'node:tls';
import type { LookupFunction } from 'node:net';

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
  /** SNI. Almost always the host; separate because a device addressed by IP still needs one. */
  readonly servername: string;
  readonly timeoutMs: number;
  /**
   * The socket's `lookup`, when the device's name was resolved and checked against the probe's
   * target policy (`A-57`): it answers with the checked addresses, so the name is not resolved
   * a second time. `host` stays the name.
   */
  readonly lookup?: LookupFunction;
  /**
   * When the check began resolving the name, where it did that itself. `elapsedMs` is counted
   * from here, so the handshake time still includes the lookup, as it did when the socket made
   * it.
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

export class TlsError extends Error {
  readonly host: string;
  constructor(message: string, host: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TlsError';
    this.host = host;
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
      servername: target.servername,
      ...(target.lookup === undefined ? {} : { lookup: target.lookup }),
      // See the note above: verification is done *after* the fact so that a bad certificate is a
      // reading rather than a failed connection.
      rejectUnauthorized: false,
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
          target.host,
          error,
        ),
      );
      return;
    }

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
        reject(
          new TlsError(`the check was cancelled while connecting to ${target.host}`, target.host),
        );
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      finish(() => {
        reject(
          new TlsError(
            `${target.host}:${String(target.port)} did not complete a TLS handshake within ` +
              `${String(target.timeoutMs)} ms`,
            target.host,
          ),
        );
      });
    }, target.timeoutMs);
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
        reject(describe(error, target));
      });
    });
  });
}

function describe(error: NodeJS.ErrnoException, target: TlsTarget): TlsError {
  const where = `${target.host}:${String(target.port)}`;
  switch (error.code) {
    case 'ECONNREFUSED':
      return new TlsError(`nothing is listening at ${where}`, target.host, error);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new TlsError(
        `the device’s host name did not resolve, connecting to ${where}`,
        target.host,
        error,
      );
    case 'ECONNRESET':
      return new TlsError(
        `${where} closed the connection during the TLS handshake — this is what a plain-text ` +
          'service does when something tries to speak TLS to it, and what a server does when it ' +
          'shares no protocol version with the client',
        target.host,
        error,
      );
    case 'ERR_SSL_UNSUPPORTED_PROTOCOL':
    case 'ERR_SSL_NO_PROTOCOLS_AVAILABLE':
    case 'ERR_SSL_VERSION_TOO_LOW':
      return new TlsError(`${where} does not accept this TLS version`, target.host, error);
    default:
      return new TlsError(
        `the TLS handshake with ${where} failed: ${text(error)}`,
        target.host,
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
  readonly issuer: string;
  readonly chainLength: number;
  /** The subject whose expiry is soonest, when that is *not* the leaf. */
  readonly soonestSubject: string | null;
}

/**
 * Everything a certificate sensor reports, from a certificate and a name.
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
    hostMatches: names.some((name) => nameMatches(name, servername)),
    names,
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
