import type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  JsonSchema,
  SensorType,
} from '../contract.js';
import { MAX_PATTERN } from '../support/pattern.js';
import type { LookupFunction } from 'node:net';
import { targetVerdict } from '@ms/shared';
import { restrictionOf } from '../credentials/index.js';
import {
  checkedTarget,
  DEFAULT_TARGET_POLICY,
  familyOf,
  guardOf,
  lookupFor,
  refuseLocalSocket,
} from '../support/checked-target.js';
import { CredentialsWithheldError, PIN_REFUSALS, pinnedLookup } from '../support/pinned-target.js';
import {
  codeOf,
  DbError,
  DbRedirectRefusedError,
  DbRoutedUnresolvedError,
  type DbConnectOptions,
  type DbDriver,
  type DbResult,
  type DbRow,
} from '../support/db/driver.js';

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

/**
 * The keys every database sensor reports of its own, which `dbChannels` declares besides
 * `extract`'s (`P-348`). The schema refuses them as an `extract` key.
 */
export const DB_OWN_KEYS = ['value', 'rows', 'queryTime', 'connectTime'] as const;

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
    'x-patternMessage':
      'must be empty, a count such as 1, a range such as 1-10, or a count and a plus, such as 1+',
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
          // Not one of the sensor's own keys (`P-348`): a result would carry two readings under
          // it, of which the core keeps one, and `dbChannels` would declare it twice.
          pattern: `^(?!(?:${DB_OWN_KEYS.join('|')})$)[A-Za-z0-9_.-]+$`,
          'x-patternMessage':
            `must be letters, digits, "_", "." and "-", and not one of ${DB_OWN_KEYS.join(', ')}, ` +
            'the sensor’s own channels',
          title: 'Channel key',
          description:
            'Stable. Renaming it starts a new channel with no history. Not ' +
            `${DB_OWN_KEYS.map((key) => `\`${key}\``).join(', ')}: the sensor’s own channels.`,
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

/**
 * The whole check, given a driver. The three types are this plus an id and a default port.
 * `platform` is the probe's, and a test's to name.
 */
export async function runDbCheck(
  driver: DbDriver,
  context: CheckContext,
  platform: NodeJS.Platform = process.platform,
): Promise<CheckExecution> {
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
  const port = declaredPort > 0 ? declaredPort : driver.defaultPort;
  const encryptRaw = context.params['encrypt'];
  const connectTimeoutMs = Number(context.params['connectTimeoutMs'] ?? 10_000);

  // Checked once, here, rather than in each driver: three copies would be three chances to
  // narrow the signal and leave the mid-query check unreachable, which is what happened.
  if (context.signal.aborted) throw new Error('the check was cancelled before it connected');

  // The clock starts before the name is resolved, as it did when the driver resolved it: the
  // connect time has always included the lookup.
  const startedAt = process.hrtime.bigint();
  const spentMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;
  // **Resolved once and checked against the probe's target policy** (`A-62`), every answer of
  // it. The driver is then handed a socket whose lookup answers with the checked addresses, and
  // the name is not resolved again. A device given as an address is checked as it stands and
  // resolves nothing.
  // **Over the device's IP version** (`A-85`), where the drivers always took whichever family
  // the name had: `auto` still does, and `v4` or `v6` asks the guard for that family alone and
  // connects over it, under `none` too, where the driver is handed a socket whose lookup asks
  // the system for that family alone, and walks every address of it.
  const family = familyOf(context.target.ipVersion);
  const pinned = context.target.pinned;
  // **A PostgreSQL host that begins with `/` is a Unix socket directory on the probe's own
  // machine** (`A-70`). `pg` connects to the socket inside it (`lib/client.js`: a host whose
  // first character is `/`). There is no name to resolve, so it is not sent to the resolver,
  // which failed it as a name with no address. **It is the probe's own machine, and is held
  // to what the policy says of that**: refused wherever loopback is, since the same server
  // at 127.0.0.1 would be, and handed to the driver as it stands wherever loopback is allowed.
  const socketPath = driver.id === 'postgresql' && host.startsWith('/');
  // **Except on Windows, whatever the core decided** (`A-74`'s review). Node opens a path there
  // as a named pipe, and one that begins `//` or `/\` as a pipe on another machine: the
  // premise that it is this machine does not hold, and a set bounded to loopback would go out.
  if (socketPath && platform === 'win32') {
    throw new DbError(
      `${driver.name} at ${host}: a host that begins with / is a socket directory, and this ` +
        'probe runs on Windows, where such a path is opened as a named pipe, which may be on ' +
        'another machine, so nothing was sent. Give the device the server’s name or address.',
      'connect',
      host,
    );
  }
  const local = socketPath && pinned === undefined;
  if (local) {
    refuseLocalSocket(host, context.target.policy, 'connect to', context.target.policyException);
  }
  const checked = local
    ? null
    : await checkedTarget({
        ...guardOf(context.target),
        family,
        timeoutMs: connectTimeoutMs,
        signal: context.signal,
        verb: 'connect to',
        doing: `connecting to ${host}:${String(port)}`,
      });
  // The one address a credential set was checked against (`A-41c`), or the policy's addresses.
  const lookup =
    pinned === undefined ? lookupFor(host, checked).lookup : pinnedLookup(host, pinned);

  // **Where the set may go bounds where a redirect may take it** (`A-41b`). The probe is told
  // the set's own `allowedTargets`, so it can say whether the server the login was handed on
  // to is inside them. A name the targets do not cover by name is not resolved to find out:
  // undecided is refused, as it is everywhere a pin is not made.
  const targets = restrictionOf('database', credential).targets;
  const guarded = (context.target.policy ?? DEFAULT_TARGET_POLICY) !== 'none';
  const withheld = (message: string): CredentialsWithheldError =>
    new CredentialsWithheldError(message, {
      sensorId: context.sensorId,
      target: host,
      phase: 'connect',
      kind: 'database',
    });
  const redirect = async (other: string): Promise<LookupFunction | undefined> => {
    // A set held to one address is not sent to a second.
    if (pinned !== undefined) throw withheld(PIN_REFUSALS.redirected(host, other));
    // **A failed check, and not a refusal the core is asked to believe** (`A-70`). No pin was
    // made, so the core decided this device itself (an address inside the targets, or a name a
    // name entry covers) and left the probe nothing: it honours a mark only for a sensor it
    // did leave, and counts any other as unearned. The sensor reads Down with the sentence.
    if (targets.length > 0 && targetVerdict(other, targets) !== 'inside') {
      throw new DbRedirectRefusedError(host, other);
    }
    // And the probe's target policy, on a lookup of the routed name's own, over the device's
    // family (`A-85`): the login goes on over the path the device is reached by.
    const onward = await checkedTarget({
      ...guardOf(context.target),
      host: other,
      family,
      timeoutMs: Math.max(1, connectTimeoutMs - spentMs()),
      signal: context.signal,
      verb: 'follow a redirect to',
      doing: `following a redirect from ${host} to ${other}`,
      unresolved: (error) =>
        new DbRoutedUnresolvedError(
          `${host}:${String(port)}`,
          other,
          codeOf(error ?? {}),
          family === 0 ? undefined : family,
          host,
        ),
    });
    // Under `none`, which a set's bounds still ask this of, nothing was checked: the routed name
    // is resolved by the socket, over the device's family alone.
    return lookupFor(other, onward, family).lookup;
  };

  const options: DbConnectOptions = {
    host,
    port,
    database: typeof context.params['database'] === 'string' ? context.params['database'] : '',
    username,
    password: typeof credential['password'] === 'string' ? credential['password'] : '',
    encrypt: encryptRaw === 'require' || encryptRaw === 'disable' ? encryptRaw : 'prefer',
    verifyTls: context.params['verifyTls'] === true,
    connectTimeoutMs,
    statementTimeoutMs: Number(context.params['statementTimeoutMs'] ?? 30_000),
    ...(lookup === undefined
      ? {}
      : {
          lookup,
          // **The lookup and the connect share the one timeout**, as they did when the driver
          // made the lookup: what it took is taken from what the connect has.
          connectWithinMs: Math.max(1, connectTimeoutMs - spentMs()),
        }),
    // **A server the device hands the login on to is another host** (SQL Server's redirect),
    // and it is asked about **whenever anything is checked at all**: a device given as an
    // address too, which has no lookup and whose redirect would otherwise be the driver's to
    // resolve and follow unchecked. Absent only where nothing is: `none`, and a set with no
    // bounds.
    ...(!local && (guarded || targets.length > 0 || pinned !== undefined) ? { redirect } : {}),
    ...(pinned === undefined ? {} : { pinned }),
    // **The device's family** (`A-85`): where nothing above answers the socket's lookup
    // (`none`), the driver is handed a socket that resolves the name for it alone, and SQL
    // Server's routed server is reached over it, a device given as an address included, whose
    // own connect is to that address as it stands. Not for a socket path, which has no family.
    ...(family === 0 || local ? {} : { family }),
  };

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
    // **Every connection goes to the address a set was checked against** (`A-62`): the driver
    // is handed a socket whose lookup answers with it, and never resolves the name. A probe
    // below `databaseAddressPinning` does not, and the core does not send it such a set.
    pinnedKinds: ['database'],
    secretDestinations: { 'kind:database': ['encrypt', 'port', 'verifyTls'] },
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { ...DB_SCHEMA, port: { ...DB_SCHEMA['port'], description } as JsonSchema },
    },
    // Every reading is `value`, an `extract` key (`readDbMappings`, which `dbChannels` declares
    // from too) or `rows`, `queryTime`, `connectTime`; a column name never becomes a key. So an
    // `extract` entry an edit took out is retired (`P-320`).
    declaresEveryChannel: true,
    channels: dbChannels,
    async execute(context: CheckContext): Promise<CheckExecution> {
      return runDbCheck(await driverPath(), context);
    },
  };
}
