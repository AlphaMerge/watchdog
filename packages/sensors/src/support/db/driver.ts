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

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbError';
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

export function describeDbError(error: unknown, options: DbConnectOptions, engine: string): Error {
  const where = `${options.host}:${String(options.port)}`;
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'ECONNREFUSED') return new DbError(`nothing is listening at ${where}`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new DbError(`the device’s host name did not resolve, connecting to ${where}`);
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new DbError(
      `${where} accepted no connection within ${String(options.connectTimeoutMs)} ms — a ` +
        'firewall dropping the packets looks exactly like this',
    );
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
    );
  }
  if (code === '3D000' || code === 'ER_BAD_DB_ERROR') {
    return new DbError(`${engine} at ${where} has no database called “${options.database}”`);
  }
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return new DbError(
      `the certificate at ${where} is self-signed and this sensor verifies certificates — most ` +
        'database servers ship with exactly such a certificate, so turning verification off ' +
        'here is usually the right answer and is still encrypted',
    );
  }
  return new DbError(`${engine} at ${where}: ${message}`);
}
