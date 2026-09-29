import type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  JsonSchema,
  SensorType,
} from '../contract.js';
import { MAX_PATTERN } from '../support/pattern.js';
import type { DbConnectOptions, DbDriver, DbResult, DbRow } from '../support/db/driver.js';

/**
 * What the three database sensor types share, which is everything but the driver (`T-18`).
 *
 * **One query, one connection, one set of channels.** PostgreSQL, MySQL and SQL Server differ in
 * how you connect and in how you tell the server to stop — and in nothing an operator configuring
 * a check would notice. Three copies of this file would be three chances for "the first cell" to
 * mean something different in each.
 *
 * **The query is the sensor.** Anything a database can answer becomes a channel here without
 * anybody writing a sensor type for it: replication lag, the oldest unprocessed row, a count of
 * failed jobs, the number of connections left before `max_connections`. That is the whole point
 * of a custom database sensor, and it is why the *execution time* is not the primary channel —
 * it matters, but if it were what you were watching you would have written a Port sensor.
 */

const MAX_CHANNELS = 10;

export interface DbMapping {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly column: string;
  readonly row: number;
  readonly scale: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (record: Record<string, unknown>, key: string, fallback = ''): string => {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
};

/** Exported for its own tests: a mapping read wrongly is a channel watching the wrong column. */
export function readDbMappings(params: Readonly<Record<string, unknown>>): DbMapping[] {
  const raw = params['extract'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DbMapping[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = text(entry, 'key').trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const scale = Number(entry['scale'] ?? 1);
    out.push({
      key,
      name: text(entry, 'name', key),
      unit: text(entry, 'unit'),
      column: text(entry, 'column'),
      row: Math.max(0, Math.trunc(Number(entry['row'] ?? 0))),
      scale: Number.isFinite(scale) && scale !== 0 ? scale : 1,
    });
  }
  return out;
}

export const DB_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  port: {
    type: 'integer',
    minimum: 0,
    maximum: 65_535,
    default: 0,
    title: 'Port',
    description: 'Zero uses this engine’s own, which the description above names.',
  },
  database: {
    type: 'string',
    maxLength: 128,
    default: '',
    title: 'Database',
    description:
      'The database to connect to. Point a monitoring account at the one it is watching and at ' +
      'nothing else — this sensor runs whatever query it is given, with whatever rights the ' +
      'credential has.',
  },
  query: {
    type: 'string',
    minLength: 1,
    maxLength: 8_192,
    title: 'Query',
    description:
      'One statement, run every scan. Anything the database can answer becomes a channel — ' +
      'replication lag, the oldest unprocessed row, how many connections are left. Make it ' +
      'cheap and make it read-only: it runs on every device this sensor is under, for ever.',
  },
  encrypt: {
    enum: ['prefer', 'require', 'disable'],
    default: 'prefer',
    title: 'Encryption',
    description:
      '`prefer` tries TLS and carries on without it, which is what a command-line client does ' +
      'and what almost every deployment is actually running. `require` refuses the downgrade.',
  },
  verifyTls: {
    type: 'boolean',
    default: false,
    title: 'Verify the certificate',
    description:
      'Off by default here, unlike every other sensor, and for a reason worth knowing: almost ' +
      'every database server ships with a self-signed certificate nobody replaced. The ' +
      'connection is still encrypted; it is authenticated against nobody. Turn this on where ' +
      'the server has a certificate you actually issued.',
  },
  connectTimeoutMs: {
    type: 'integer',
    minimum: 500,
    maximum: 120_000,
    default: 10_000,
    title: 'Connect timeout',
  },
  statementTimeoutMs: {
    type: 'integer',
    minimum: 500,
    maximum: 300_000,
    default: 30_000,
    title: 'Statement timeout',
    description:
      'Asked of the **server**, not enforced by closing the socket — a client that gives up and ' +
      'hangs up leaves the query running, and a check that did that every sixty seconds would ' +
      'become the outage it was meant to warn about.',
  },
  expectRows: {
    type: 'string',
    maxLength: 32,
    pattern: '^$|^\\d+$|^\\d+-\\d+$|^\\d+\\+$',
    default: '',
    title: 'Expected rows',
    description:
      'The check fails when the row count is outside this — `1` for a query that must return ' +
      'exactly one, `1+` for at least one, `0` for a query that must return none, `1-10` for a ' +
      'range. Empty accepts anything. A query that quietly started returning nothing is a real ' +
      'failure that a response time reports as perfectly healthy.',
  },
  extract: {
    type: 'array',
    maxItems: MAX_CHANNELS,
    default: [],
    title: 'Extra channels',
    description:
      'The first cell of the first row is always a channel. These are for the other columns of ' +
      'a query that answers several questions at once — one connection instead of five.',
    items: {
      // The singular, for `U-12`'s repeating control: the fieldset is named for the
      // parameter and an entry inside it wants this.
      title: 'Channel',
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: {
          type: 'string',
          minLength: 1,
          maxLength: 40,
          pattern: '^[A-Za-z0-9_.-]+$',
          title: 'Channel key',
          description: 'Stable. Renaming it starts a new channel with no history.',
        },
        name: { type: 'string', maxLength: 80, default: '', title: 'Channel name' },
        unit: { type: 'string', maxLength: 20, default: '', title: 'Unit' },
        column: {
          type: 'string',
          maxLength: MAX_PATTERN,
          default: '',
          title: 'Column',
          description: 'By name. Empty takes the column at this row’s position instead.',
        },
        row: { type: 'integer', minimum: 0, default: 0, title: 'Row (0 is the first)' },
        scale: { type: 'number', default: 1, title: 'Multiply by' },
      },
    },
  },
};

export function dbChannels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
  return [
    // The answer, not the timing. If the timing were what you were watching you would have
    // written a Port sensor.
    { key: 'value', name: 'Value', unit: '', isPrimary: true },
    ...readDbMappings(params).map((mapping) => ({
      key: mapping.key,
      name: mapping.name,
      unit: mapping.unit,
    })),
    { key: 'rows', name: 'Rows returned', unit: '' },
    { key: 'queryTime', name: 'Query time', unit: 'ms' },
    // Where an exhausted connection pool shows, and it shows nowhere else: a server at
    // `max_connections` refuses instantly or waits, and the query itself is unaffected either way.
    { key: 'connectTime', name: 'Connect time', unit: 'ms' },
  ];
}

/** Whether the row count is what this sensor was told to expect. */
export function rowsAccepted(rows: number, expect: string): boolean {
  if (expect === '') return true;
  const atLeast = /^(\d+)\+$/.exec(expect);
  if (atLeast !== null) return rows >= Number(atLeast[1]);
  const range = /^(\d+)-(\d+)$/.exec(expect);
  if (range !== null) return rows >= Number(range[1]) && rows <= Number(range[2]);
  return rows === Number(expect);
}

/**
 * A cell as a number, or null.
 *
 * `null` is a gap and not a zero — the rule the whole system is built on. A `count(*)` that
 * genuinely returned no rows has no value to report, which is different from a count of none.
 * Strings that hold numbers are read, because every one of these drivers returns `numeric`,
 * `bigint` and `decimal` as text to avoid losing precision.
 */
export function numberFromCell(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cellAt(result: DbResult, row: number, column: string, position: number): unknown {
  const record: DbRow | undefined = result.rows[row];
  if (record === undefined) return undefined;
  if (column !== '') return record[column];
  const name = result.columns[position];
  return name === undefined ? undefined : record[name];
}

/** The whole check, given a driver. The three types are this plus an id and a default port. */
export async function runDbCheck(driver: DbDriver, context: CheckContext): Promise<CheckExecution> {
  const host = context.target.host;
  if (host === '') throw new Error('the device has no host to connect to');
  const query = typeof context.params['query'] === 'string' ? context.params['query'].trim() : '';
  if (query === '') throw new Error('this sensor has no query to run');

  const credential = context.credentials['database'] ?? {};
  const username = typeof credential['username'] === 'string' ? credential['username'] : '';
  if (username === '') {
    throw new Error(
      'no database credential is configured on this device or anything above it, and ' +
        `${driver.name} will not accept a connection without one`,
    );
  }

  const declaredPort = Number(context.params['port'] ?? 0);
  const encryptRaw = context.params['encrypt'];
  const options: DbConnectOptions = {
    host,
    port: declaredPort > 0 ? declaredPort : driver.defaultPort,
    database: typeof context.params['database'] === 'string' ? context.params['database'] : '',
    username,
    password: typeof credential['password'] === 'string' ? credential['password'] : '',
    encrypt: encryptRaw === 'require' || encryptRaw === 'disable' ? encryptRaw : 'prefer',
    verifyTls: context.params['verifyTls'] === true,
    connectTimeoutMs: Number(context.params['connectTimeoutMs'] ?? 10_000),
    statementTimeoutMs: Number(context.params['statementTimeoutMs'] ?? 30_000),
  };

  // Checked once, here, rather than in each driver: three copies would be three chances to
  // narrow the signal and leave the mid-query check unreachable, which is what happened.
  if (context.signal.aborted) throw new Error('the check was cancelled before it connected');

  const startedAt = process.hrtime.bigint();
  const connection = await driver.connect(options, context.signal);
  const connectedAt = process.hrtime.bigint();

  let result: DbResult;
  try {
    result = await connection.query(query, context.signal);
  } finally {
    await connection.close();
  }
  const finishedAt = process.hrtime.bigint();

  const expect =
    typeof context.params['expectRows'] === 'string' ? context.params['expectRows'] : '';
  if (!rowsAccepted(result.rows.length, expect)) {
    throw new Error(
      `the query returned ${String(result.rows.length)} row` +
        `${result.rows.length === 1 ? '' : 's'} and this sensor expects ${expect} — a query that ` +
        'quietly started returning nothing looks perfectly healthy by response time alone',
    );
  }

  const readings: { key: string; value: number }[] = [];
  const missing: string[] = [];

  const first = numberFromCell(cellAt(result, 0, '', 0));
  if (first === null) missing.push('value');
  else readings.push({ key: 'value', value: first });

  for (const mapping of readDbMappings(context.params)) {
    const raw = numberFromCell(cellAt(result, mapping.row, mapping.column, readings.length));
    if (raw === null) missing.push(mapping.key);
    else readings.push({ key: mapping.key, value: Math.round(raw * mapping.scale * 1e6) / 1e6 });
  }

  const queryTime = ms(connectedAt, finishedAt);
  return {
    channels: [
      ...readings,
      { key: 'rows', value: result.rows.length },
      { key: 'queryTime', value: queryTime },
      { key: 'connectTime', value: ms(startedAt, connectedAt) },
    ],
    message:
      `${String(result.rows.length)} row${result.rows.length === 1 ? '' : 's'} in ` +
      `${String(queryTime)} ms` +
      (readings.length === 0
        ? ''
        : `; ${readings.map((r) => `${r.key}=${String(r.value)}`).join(' ')}`) +
      (missing.length === 0 ? '' : `; ${missing.join(', ')} was not a number`),
  };
}

const ms = (from: bigint, to: bigint): number => Math.round(Number(to - from) / 1e3) / 1e3;

/** The three types are this, an id, a name in the description, and a driver. */
export function databaseSensor(
  id: string,
  driverPath: () => Promise<DbDriver>,
  description: string,
): SensorType {
  return {
    id,
    category: 'Database',
    costHint: 'medium',
    credentialKinds: ['database'],
    // Where the set goes besides the host (`A-41`): a port, and whether it is encrypted and
    // checked.
    secretDestinations: { 'kind:database': ['encrypt', 'port', 'verifyTls'] },
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { ...DB_SCHEMA, port: { ...DB_SCHEMA['port'], description } as JsonSchema },
    },
    channels: dbChannels,
    async execute(context: CheckContext): Promise<CheckExecution> {
      return runDbCheck(await driverPath(), context);
    },
  };
}
