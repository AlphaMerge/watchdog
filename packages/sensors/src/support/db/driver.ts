import { isIP, type LookupFunction } from 'node:net';
import { isCredentialsWithheld, type PinnedAddress } from '../pinned-target.js';
import { TargetRefusedError } from '../checked-target.js';

/**
 * What a database sensor needs from an engine, and nothing else (`T-18`).
 *
 * **Three engines, one shape, three files that import a library each.** The same isolation
 * `support/ssh/session.ts` gives `ssh2`: exactly one module imports each driver, so replacing one
 * is a file rather than a search, and a probe that never runs a MySQL check never loads `mysql2`.
 *
 * **No pool, deliberately, and this is the opposite of the SNMP and SSH decision.** Those pool
 * because a session costs a handshake and a device is checked every minute; a database connection
 * costs the *server* a backend process and a slot against `max_connections`, and a monitoring
 * system holding one open per sensor is a monitoring system that takes a database down on the day
 * it is needed. Connecting per scan also makes the connect time a real reading — exhausted
 * connection slots show there and nowhere else.
 */

export interface DbConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly encrypt: 'require' | 'prefer' | 'disable';
  readonly verifyTls: boolean;
  readonly connectTimeoutMs: number;
  /**
   * How long the *server* may spend on the statement.
   *
   * Server-side, and that word is the whole point: a client that gives up and closes its socket
   * leaves the query running. A monitoring check that times out every sixty seconds and leaves a
   * heavy query behind each time is a monitoring system that becomes the outage.
   */
  readonly statementTimeoutMs: number;
  /**
   * The lookup the connection's socket is given (`A-62`): it answers the device's name with the
   * addresses that were checked against the probe's target policy, or with the one address a
   * credential set pinned (`A-41c`), and the name is not resolved again. `host` stays the name,
   * which is what TLS names and checks.
   *
   * Absent, the driver connects as it always has: the device is an address, or nothing is
   * checked.
   */
  readonly lookup?: LookupFunction;
  /** The address a credential set pinned, when one did: the far end must be it. */
  readonly pinned?: PinnedAddress;
  /**
   * What the connect has left of `connectTimeoutMs` once the lookup has been taken out: the two
   * share the one timeout. Absent, all of it. `connectTimeoutMs` stays what a message quotes.
   */
  readonly connectWithinMs?: number;
  /**
   * The lookup for a server the device redirected the connection to (SQL Server does), checked
   * as the device was and on a lookup of its own; undefined when it needs none. Rejects when
   * the redirect may not be followed.
   */
  readonly redirect?: (host: string) => Promise<LookupFunction | undefined>;
}

/** One row, values as the driver produced them. */
export type DbRow = Readonly<Record<string, unknown>>;

export interface DbResult {
  readonly rows: readonly DbRow[];
  /** In declaration order, which is what "the first cell" means. */
  readonly columns: readonly string[];
}

export interface DbConnection {
  query(sql: string, signal: AbortSignal): Promise<DbResult>;
  close(): Promise<void>;
}

export interface DbDriver {
  readonly id: 'postgresql' | 'mysql' | 'mssql';
  readonly name: string;
  readonly defaultPort: number;
  connect(options: DbConnectOptions, signal: AbortSignal): Promise<DbConnection>;
}

/**
 * Where in a check a database failure happened, where the failure says: the device's name
 * (`resolve`), reaching the server (`connect`), its TLS (`handshake`), the login the credential
 * was refused at (`authenticate`), and the query (`query`). A database the login names that the
 * server does not have is `connect`: no session was made.
 */
export type DbPhase = 'resolve' | 'connect' | 'handshake' | 'authenticate' | 'query';

export class DbError extends Error {
  /** The phase the check failed in, when the failure is of one phase and no other. */
  readonly phase: DbPhase | undefined;
  /** The device's host, where the failure was the server's (`P-406`). */
  readonly host: string | undefined;

  constructor(message: string, phase?: DbPhase, host?: string) {
    super(message);
    this.name = 'DbError';
    this.phase = phase;
    this.host = host === '' ? undefined : host;
  }
}

/** What `DbRedirectRefusedError` says. It names both servers, and never the secret. */
export const REDIRECT_OUTSIDE_TARGETS = (host: string, other: string): string =>
  `${host} routed the login to ${other}, which is outside the allowed targets of the database ` +
  'credentials this sensor uses, so nothing was sent there. Adding that server to the targets ' +
  'by its address, its name or *.domain, or giving the device the server that answers, lets ' +
  'the login through.';

/**
 * A login the server handed on to a server its credential set's targets do not cover, on a
 * device the set's targets do cover (`A-70`). Nothing was sent to the routed server.
 *
 * **A failed check, and not `CredentialsWithheldError`.** The core believes a probe's refusal
 * only for a sensor its configuration left to that probe: a named device facing targets that
 * name only addresses. This device is an address inside the targets, or a name a name entry
 * covers, so the core decided it and left the probe nothing. Marked as withheld, the result
 * would be one the core has no reason to believe: it reads it as the failed scan it is without
 * the mark and counts the mark against the probe, on Probe Health's refused results, as it
 * would a probe that was hiding a failure. The probe did nothing wrong, so it says what
 * happened as what it is: the device answered, and where it sent the login is not somewhere
 * these credentials go. The sensor reads Down with this sentence, and nothing is counted.
 */
export class DbRedirectRefusedError extends DbError {
  /** The device's host, as the device names it. */
  readonly target: string;
  /** The server the login was routed to. */
  readonly routedTo: string;

  constructor(target: string, routedTo: string) {
    super(REDIRECT_OUTSIDE_TARGETS(target, routedTo), 'connect');
    this.name = 'DbRedirectRefusedError';
    this.target = target;
    this.routedTo = routedTo;
  }
}

/** What `pg` says when its connect timer ends a connection. */
const PG_TIMED_OUT = 'timeout expired';

/**
 * What every driver's connect timeout reads as, whichever driver's timer it was.
 *
 * **It names the server that did not answer**, which after a SQL Server redirect is not the
 * device: the device answered, and routed the login to one that then said nothing. Naming the
 * device there sends an operator to the machine that is working.
 */
function connectTimedOut(
  where: string,
  options: DbConnectOptions,
  routedTo: string | undefined,
): DbError {
  const within = `within ${String(options.connectTimeoutMs)} ms`;
  const firewall = 'a firewall dropping the packets looks exactly like this';
  return new DbError(
    routedTo === undefined
      ? `${where} accepted no connection ${within} — ${firewall}`
      : `${where} routed the login to ${routedTo}, which accepted no connection ${within} — ` +
          firewall,
    'connect',
    options.host,
  );
}

/** What `tedious`'s connect timer says of a connection it had been redirected on. */
const TDS_REDIRECTED = /^Failed to connect to (\S+) \(redirected from /;

/**
 * A name a login was routed to that did not resolve, as the redirect's own lookup found
 * (`runDbCheck`): the guard's words for it are about "the device's host name", which this
 * is not.
 */
export class DbRoutedUnresolvedError extends DbError {
  constructor(where: string, routedTo: string, code: string) {
    super(
      `${where} routed the login to ${routedTo}, a host name that did not resolve` +
        (code === '' ? '' : ` (${code})`),
      'connect',
    );
    this.name = 'DbRoutedUnresolvedError';
  }
}

/**
 * The server a connect that timed out had been routed to, or undefined when it was the device.
 * From the connector's own error, which carries it (`tdsConnector`), or from the words of
 * `tedious`'s timer (`lib/connection.js`, `initialiseConnection`), which has no field for it.
 */
function routedOf(chain: readonly unknown[]): string | undefined {
  for (const one of chain) {
    const carried = (one as { routedTo?: unknown } | null)?.routedTo;
    if (typeof carried === 'string' && carried !== '') return carried;
    const said = one instanceof Error ? TDS_REDIRECTED.exec(one.message) : null;
    if (said?.[1] !== undefined) return said[1];
  }
  return undefined;
}

/**
 * A server that answered a request for encryption by saying it has none, to a sensor whose
 * encryption is `require` (`A-70`). No login was sent.
 */
export class DbEncryptionRefusedError extends DbError {
  constructor(where: string) {
    super(
      `${where} answered that it does not encrypt, and this sensor requires encryption, so no ` +
        'login was sent. That answer travels in clear text: a server that does encrypt and ' +
        'reads so here has something on the path rewriting it. Set Encryption to `prefer` ' +
        'only if the server really has no TLS.',
      'connect',
    );
    this.name = 'DbEncryptionRefusedError';
  }
}

/**
 * A driver failure, with the part an operator can act on.
 *
 * Every one of these engines reports "wrong password", "no such database" and "this host will not
 * accept you" as a code rather than a sentence, and the sentence it does give is often about TLS
 * when the cause is authentication.
 */
export function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : typeof code === 'number' ? String(code) : '';
}

/** The error and what it was made from: `tedious` wraps a socket's error in one of its own. */
function chainOf(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visit = (at: unknown): void => {
    if (!(at instanceof Error) || chain.length >= 8) return;
    chain.push(at);
    // `tedious`'s own connect gathers one failure per address tried into an `AggregateError`
    // ("Could not connect (sequence)"), and the socket's code is on those and nowhere else.
    if (at instanceof AggregateError) for (const one of at.errors as unknown[]) visit(one);
    visit(at.cause);
  };
  visit(error);
  return chain.length === 0 ? [error] : chain;
}

/** The codes a driver puts around a socket's own, which say nothing of what went wrong. */
const WRAPPERS = new Set(['', 'ESOCKET']);

/** A certificate or TLS failure's code: Node's and OpenSSL's, or `mysql2`'s for all of them. */
const TLS_CODE = /^(?:HANDSHAKE_SSL_ERROR$|CERT_|UNABLE_TO_|ERR_TLS_|ERR_SSL_)/;

export function describeDbError(
  error: unknown,
  options: DbConnectOptions,
  engine: string,
  /** What the check was doing: a driver's connect timer is read as one only while connecting. */
  phase: DbPhase = 'connect',
): Error {
  const where = `${options.host}:${String(options.port)}`;
  const chain = chainOf(error);
  // **A refusal is not a database's failure, and keeps its class** (`A-62`): the runner reads a
  // set that was withheld as Unknown, and the policy's refusal says the address and the policy.
  // And so does a redirect that was not followed (`A-70`): its sentence is the whole diagnosis.
  for (const one of chain) {
    if (isCredentialsWithheld(one) || one instanceof TargetRefusedError) return one;
    if (one instanceof DbRedirectRefusedError || one instanceof DbEncryptionRefusedError) {
      return one;
    }
    if (one instanceof DbRoutedUnresolvedError) return one;
  }
  const code = chain.map(codeOf).find((one) => !WRAPPERS.has(one)) ?? '';
  const message = error instanceof Error ? error.message : String(error);

  // **Named for the server that failed**, which after a redirect is the routed one: the
  // device answered, and it is where it sent the login that nothing listens or resolves.
  const routedTo = phase === 'connect' ? routedOf(chain) : undefined;
  // Every failure here says where it was and the device's host (`P-406`).
  const host = options.host;
  if (code === 'ECONNREFUSED') {
    return new DbError(
      routedTo === undefined
        ? `nothing is listening at ${where}`
        : `${where} routed the login to ${routedTo}, where nothing is listening`,
      'connect',
      host,
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    // The device's own name, or a name it routed to, which is still the connect: the device's
    // name resolved, as `DbRoutedUnresolvedError` says of the guard's lookup.
    return new DbError(
      routedTo === undefined
        ? `the device’s host name did not resolve, connecting to ${where}`
        : `${where} routed the login to ${routedTo}, a host name that did not resolve`,
      routedTo === undefined ? 'resolve' : 'connect',
      host,
    );
  }
  const socketTimedOut = code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT';
  // **A socket that times out mid-query was connected** (`A-70`): the same code, in the other
  // phase, is a server that stopped answering, and "accepted no connection" would be false.
  if (socketTimedOut && phase === 'query') {
    return new DbError(
      `${engine} at ${where}: the connection was made and the query got no answer before the ` +
        'socket timed out — the server stopped answering, or something between dropped the ' +
        'connection without closing it',
      'query',
      host,
    );
  }
  // **Each driver's own connect timer says it differently** (`A-70`), and neither said how
  // long or where. `tedious` ends a connect with a `ConnectionError` coded `ETIMEOUT`, one
  // letter short of the socket's (`lib/connection.js`, `initialiseConnection`); `pg` destroys
  // its stream with an error that has a message and no code at all (`lib/client.js`,
  // `connectionTimeoutMillis`). Read so only while connecting: `tedious` puts the same code
  // on a request that timed out, which is the statement timeout and is another sentence.
  if (
    phase === 'connect' &&
    (socketTimedOut ||
      code === 'ETIMEOUT' ||
      (code === '' && chain.some((one) => one instanceof Error && one.message === PG_TIMED_OUT)))
  ) {
    return connectTimedOut(where, options, routedTo);
  }
  // 28P01 and 28000 are "invalid authorisation" in PostgreSQL and MySQL; 18456 is SQL Server's.
  if (
    code === '28P01' ||
    code === '28000' ||
    code === 'ER_ACCESS_DENIED_ERROR' ||
    /\b18456\b/.test(message)
  ) {
    return new DbError(
      `${engine} at ${where} refused the credential for “${options.username}” — the database ` +
        'credential on this device or above it is wrong, or the account is not allowed from here',
      'authenticate',
      host,
    );
  }
  // **SQL Server refused the login, and `tedious` does not say why** (`P-406`): it codes every
  // error the server sends during the login `ELOGIN` and keeps the last one's words, which for
  // a wrong password and for a database it does not have alike are "Login failed for user" —
  // the 18456 that told them apart stays on the token (`lib/token/handler.js`, `onErrorMessage`).
  // So it is the login that failed, said in the server's words, and not "the credential".
  if (code === 'ELOGIN') {
    return new DbError(`${engine} at ${where}: ${message}`, 'authenticate', host);
  }
  if (code === '3D000' || code === 'ER_BAD_DB_ERROR') {
    return new DbError(
      `${engine} at ${where} has no database called “${options.database}”`,
      'connect',
      host,
    );
  }
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return new DbError(
      `the certificate at ${where} is self-signed and this sensor verifies certificates — most ` +
        'database servers ship with exactly such a certificate, so turning verification off ' +
        'here is usually the right answer and is still encrypted',
      'handshake',
      host,
    );
  }
  // **`mysql2` and `tedious` take no identity check of ours** (`A-70`), and Node's own reads an
  // IPv6 address as a name no certificate has (`serverIdentity` in `@ms/shared`). So a device
  // given as an IPv6 address cannot be verified through either, and is refused, whatever its
  // certificate lists. Said, because Node's sentence blames the certificate.
  // By Node's code where the driver keeps it (`tedious`), and by Node's words where it does
  // not: `mysql2` copies the message onto an error coded `HANDSHAKE_SSL_ERROR`.
  if (
    isIP(options.host) === 6 &&
    engine !== 'PostgreSQL' &&
    (chain.some((one) => codeOf(one) === 'ERR_TLS_CERT_ALTNAME_INVALID') ||
      message.includes("does not match certificate's altnames"))
  ) {
    return new DbError(
      `${engine} at ${where}: the certificate could not be checked against an IPv6 address — ` +
        'this driver cannot verify one, whatever the certificate lists. Give the device a ' +
        `name the certificate is for, or its IPv4 address. (${message})`,
      'handshake',
      host,
    );
  }
  // **Every other certificate or TLS failure on the way in is the handshake** (`P-406`), in the
  // driver's words: Node's code where the driver keeps it (`pg`, `tedious`), and `mysql2`'s
  // `HANDSHAKE_SSL_ERROR`, which it writes over whatever Node's was
  // (`lib/commands/client_handshake.js`), for every one of them.
  if (phase === 'connect' && chain.some((one) => TLS_CODE.test(codeOf(one)))) {
    return new DbError(`${engine} at ${where}: ${message}`, 'handshake', host);
  }
  // The driver's own words, in the phase the check was in.
  return new DbError(`${engine} at ${where}: ${message}`, phase, host);
}
