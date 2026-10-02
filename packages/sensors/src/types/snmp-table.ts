import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { SNMP_SECRET_DESTINATIONS, snmpParamsSchema } from '../support/snmp/schema.js';
import { MAX_PATTERN } from '../support/pattern.js';
// Type-only, and therefore erased: no `net-snmp` reaches the core, which loads this catalogue
// for schemas and channel declarations and never runs a check.
import type { Extracted } from '../support/pattern.js';
import type { SnmpSession, SnmpVarbind } from '../support/snmp/session.js';

/**
 * One row of an arbitrary SNMP table, with a channel per column (`T-04`).
 *
 * **A sensor is a row, and its channels are the columns.** That is the only layout the channel
 * model supports, and the reason is worth stating because the other one looks equally natural:
 * channels are declared by `channels(params)` *before the sensor has ever run*, which is what
 * lets the core create them at sensor-creation time with a primary, a lookup and a counter
 * width. A sensor whose channels were the *rows* could not declare any of that — the rows are on
 * the device — so its channels would be created from the wire on first scan, with no primary,
 * no lookup and no counter arithmetic. Columns are typed in at add time; rows are discovered.
 * So columns are channels.
 *
 * **The row is found by what it is called, not only by where it sits.** A table index is an
 * arbitrary integer an agent is free to reassign — `hrStorageTable` renumbers when a filesystem
 * is mounted, `ifTable` when a module is reseated — and a sensor pinned to index 3 then watches
 * a different disk with nothing to say it happened. Naming the column that identifies a row and
 * the value to find in it costs one walk per scan and survives that. Both are offered because
 * both are right sometimes: a static table read by index is one request.
 *
 * **What is missing is the picker.** PRTG walks the table at add time and shows the rows to
 * choose from. The core cannot: it has no route to the device, only the probe has, and the
 * protocol is one-way for everything except the handshake. That is `R-09`, and until it exists
 * an operator reads the table with `snmpwalk` and types what they find. The sensor itself is
 * unaffected — it resolves the row every scan either way.
 */

/** Enough for any table worth watching in one sensor, and a bound on the request it builds. */
const MAX_COLUMNS = 20;

/** An OID fragment relative to the table: `6`, or `1.6` for a column nested below the entry. */
const RELATIVE_OID = '^[0-9]+(\\.[0-9]+)*$';

/**
 * The same, for a parameter whose default is empty.
 *
 * The empty alternative is not decoration: a `default` of `''` under a pattern that rejects it is
 * a type nobody can fill in, and the catalogue's own "validates against its own defaults" test
 * refuses to ship one. Both optional OID parameters here default to empty, meaning "not set".
 */
const OPTIONAL_OID = '^$|^[0-9]+(\\.[0-9]+)*$';

type MatchMode = 'exact' | 'contains' | 'regex';

interface TableColumn {
  /** Relative to the table OID, as typed. */
  readonly relative: string;
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly counting: boolean;
  readonly lookup: string;
}

/**
 * The channel key for a column.
 *
 * Derived from the column rather than asked for, because a key is "stable within the sensor and
 * never the label" — deriving it means renaming a channel keeps its history, and means two
 * columns cannot be given the same key and collide with the one-key-per-sensor constraint at
 * insert time.
 */
function channelKey(relative: string): string {
  return `col${relative.replace(/\./g, '_')}`;
}

function readColumns(params: Readonly<Record<string, unknown>>): TableColumn[] {
  const raw = params['columns'];
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const columns: TableColumn[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const relative = typeof record['column'] === 'string' ? record['column'].trim() : '';
    if (relative === '') continue;

    const key = channelKey(relative);
    // The same column listed twice is one channel. Silently, because it is idempotent rather
    // than lossy — the alternative is a unique-constraint violation at sensor creation.
    if (seen.has(key)) continue;
    seen.add(key);

    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    const lookup = typeof record['lookup'] === 'string' ? record['lookup'].trim() : '';
    columns.push({
      relative,
      key,
      name: name === '' ? `Column ${relative}` : name,
      unit: typeof record['unit'] === 'string' ? record['unit'] : '',
      counting: record['mode'] === 'counter',
      lookup,
    });
  }
  return columns;
}

const COLUMN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['column', 'name'],
  properties: {
    column: {
      type: 'string',
      pattern: RELATIVE_OID,
      maxLength: 64,
      title: 'Column',
      description:
        'The column’s position under the table OID, not a whole OID — `6` for ' +
        '1.3.6.1.2.1.25.2.3.1.6 under the table 1.3.6.1.2.1.25.2.3.1. No row index: the row is ' +
        'chosen once, below, and applies to every column here.',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      title: 'Channel name',
      description: 'What this column is called on the graph — “Used”, “Errors in”.',
    },
    unit: {
      type: 'string',
      maxLength: 50,
      default: '',
      title: 'Unit',
      description:
        'Shown on the axis. For a counter this is the unit *per second*, since that is what ' +
        'gets stored: enter “octets” and the channel reads “octets/s”.',
    },
    mode: {
      enum: ['gauge', 'counter'],
      default: 'gauge',
      title: 'Reading type',
      description:
        'A gauge is stored as it is read. A counter only ever goes up and is stored as a rate — ' +
        'the difference between two readings over the time between them. Choosing counter for a ' +
        'gauge produces nonsense, so the sensor says when the device disagrees.',
    },
    lookup: {
      type: 'string',
      maxLength: 100,
      default: '',
      title: 'Lookup',
      description:
        'For a column holding a status code rather than a measurement: the id of a lookup that ' +
        'turns the number into a state and a phrase, for example ms.snmp.if-oper-status. ' +
        'Without one the reading is judged by limits, which is the wrong tool for a status code.',
    },
  },
};

export const snmpTable: SensorType = {
  id: 'snmp.table',
  category: 'SNMP',
  // A walk when the row is matched by name, and one request when it is not. Never a child
  // process, but it holds a session for the length of a table walk on a large table.
  costHint: 'medium',
  secretDestinations: SNMP_SECRET_DESTINATIONS,
  credentialKinds: ['snmp'],
  pinnedKinds: ['snmp'],

  paramsSchema: snmpParamsSchema(
    {
      tableOid: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        pattern: '^\\.?[0-9]+(\\.[0-9]+)*$',
        title: 'Table OID',
        description:
          'The table’s entry OID — 1.3.6.1.2.1.25.2.3.1 for hrStorageEntry, 1.3.6.1.2.1.2.2.1 ' +
          'for ifEntry. Every column below is read relative to this, so a column that lives in ' +
          'a different subtree — ifXTable beside ifTable — needs a second sensor.',
      },
      columns: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_COLUMNS,
        title: 'Columns',
        description:
          'The columns to read from the chosen row. Each becomes a channel; the first is the ' +
          'one the sensor is judged by. Order is yours to set and is what the graph legend ' +
          'follows.',
        items: COLUMN_SCHEMA,
      },
      indexColumn: {
        type: 'string',
        pattern: OPTIONAL_OID,
        maxLength: 64,
        default: '',
        title: 'Naming column',
        description:
          'The column that says what a row *is* — `3` for hrStorageDescr, `2` for ifDescr. Its ' +
          'value is matched against the one below to find the row, and it is shown in the ' +
          'sensor message every scan, which is how you tell you are still watching the right ' +
          'row. Leave it empty to pin the sensor to a row index instead.',
      },
      rowMatch: {
        type: 'string',
        maxLength: MAX_PATTERN,
        default: '',
        title: 'Row value',
        description:
          'What to look for in the naming column — “/var”, “GigabitEthernet0/1”. The first row ' +
          'that matches is the one this sensor reads, and it is resolved on every scan, so the ' +
          'sensor follows the row when the device renumbers its table.',
      },
      rowMatchMode: {
        enum: ['exact', 'contains', 'regex'],
        default: 'exact',
        title: 'How to match',
        description:
          '`exact` compares the whole value, ignoring case and surrounding spaces. `contains` ' +
          'looks for the text anywhere in it. `regex` is a regular expression, matched against ' +
          'the first 4 KB of each row’s value.',
      },
      rowIndex: {
        type: 'string',
        pattern: OPTIONAL_OID,
        maxLength: 128,
        default: '',
        title: 'Row index',
        description:
          'The row’s index — `1`, or several arcs for a table indexed by an address. Used alone ' +
          'when no row value is given: fast, one request per scan, and wrong the moment the ' +
          'device renumbers the table with nothing to say so. Given *with* a row value it is ' +
          'only a hint, checked first so an unchanged table costs one request instead of a walk.',
      },
    },
    ['tableOid', 'columns'],
  ),

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const columns = readColumns(params);
    if (columns.length === 0) {
      // Only reachable with no parameters at all: `columns` is required and has at least one
      // entry, so no stored sensor has none. The catalogue asks every type for its shape with
      // `{}` at registration and wants exactly one primary channel — this is that answer.
      return [{ key: 'value', name: 'Value', isPrimary: true }];
    }

    return columns.map((column, at) => ({
      key: column.key,
      name: column.name,
      // The stored sample for a counter is a rate (`T-02`), so a channel labelled with the raw
      // unit would be labelled wrong on its own axis.
      unit: column.counting && column.unit !== '' ? `${column.unit}/s` : column.unit,
      // The first column, because the operator ordered them and the first is the one they led
      // with. A sensor is judged by one channel and this is the only defensible guess.
      ...(at === 0 ? { isPrimary: true } : {}),
      ...(column.lookup === '' ? {} : { lookup: column.lookup }),
      // 64 declared, and the reading corrects it — the device may return a Counter32 (`T-02`).
      // A 32-bit wrap read as a 64-bit counter looks exactly like a reset.
      ...(column.counting ? { counter: { bits: 64 as const } } : {}),
    }));
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    // Imported inside `execute`: the core loads this catalogue for schemas and channel
    // declarations and never runs a check, so it must not pay for a UDP stack
    // (`docs/adding-a-sensor-type.md`).
    const {
      snmpCheck,
      numberOf,
      stringOf,
      isException,
      normaliseOid,
      parseOid,
      indexUnder,
      compilePattern,
      extract,
    } = await import('../support/snmp/index.js');

    const host = context.target.host;
    const table = normaliseOid(text(context.params['tableOid']));
    const columns = readColumns(context.params);
    if (columns.length === 0) {
      throw new Error('this sensor declares no columns to read');
    }

    const indexColumn = text(context.params['indexColumn']).trim();
    const rowMatch = text(context.params['rowMatch']).trim();
    const rowIndex = text(context.params['rowIndex']).trim();
    const rowMatchMode = matchModeOf(context.params['rowMatchMode']);

    if (rowMatch !== '' && indexColumn === '') {
      throw new Error(
        `this sensor looks for "${rowMatch}" but names no column to look in — set the naming ` +
          'column to the one that identifies a row, such as 3 for hrStorageDescr',
      );
    }
    const matching = rowMatch !== '' && indexColumn !== '';
    if (!matching && rowIndex === '') {
      throw new Error(
        `this sensor names no row of ${table} — give a row index, or a naming column and the ` +
          'value to look for in it',
      );
    }
    // Checked before the request, so a bad pattern fails without troubling the device and fails
    // with the same sentence every scan rather than intermittently.
    if (matching && rowMatchMode === 'regex') compilePattern(rowMatch);

    const nameOid = indexColumn === '' ? null : `${table}.${indexColumn}`;

    return snmpCheck(context, async (session, signal) => {
      // 1. Which row. Resolved every scan on purpose when a value was given: the whole reason to
      //    name a row is that its index may move, so caching the index would reintroduce it.
      let index = rowIndex;
      let resolvedBy = 'index';
      if (matching && nameOid !== null) {
        const matches = rowMatcher(rowMatchMode, rowMatch, extract, nameOid);
        const found = await findRow(session, signal, nameOid, matches, rowIndex, {
          stringOf,
          isException,
          indexUnder,
          parseOid,
        });
        if (found === null) {
          throw new Error(
            `no row of ${table} on ${host} has a ${nameOid} ${describeMode(rowMatchMode)} ` +
              `"${rowMatch}"`,
          );
        }
        index = found;
        resolvedBy = 'name';
      }

      // 2. The whole row in one request. The instances are known once the index is, so this is
      //    a Get rather than a walk however many columns there are.
      const columnOids = columns.map((column) => `${table}.${column.relative}.${index}`);
      const asked = nameOid === null ? columnOids : [...columnOids, `${nameOid}.${index}`];
      const varbinds = await session.get(asked, signal);

      const values = varbinds.slice(0, columns.length);
      if (values.length === 0 || values.every((varbind) => isException(varbind))) {
        // The asked-for OID and not just the row, because the other way to reach this is a
        // column typed as a whole OID rather than as a position under the table — the mistake
        // somebody makes first, and one the schema cannot catch, since `1.3.6.1.2.1.25.2.3.1.6`
        // is a syntactically valid relative position. Printed, the doubled prefix is obvious.
        throw new Error(
          `${host} has no row ${index} in ${table} — it answered every column with "no such ` +
            `object", which is what an agent says about a row index that does not exist. It ` +
            `was asked for ${columnOids[0] ?? table}`,
        );
      }

      const readings: CheckExecution['channels'] = [];
      const notes: string[] = [];

      for (const [at, column] of columns.entries()) {
        const varbind = values[at];
        const where = `${table}.${column.relative}.${index}`;
        if (varbind === undefined || isException(varbind)) {
          // Omitted, not zeroed. CLAUDE.md: no-data is not zero, and a column an agent does not
          // implement must break the line rather than draw it to the floor.
          notes.push(`${column.name} (${where}) is not implemented on this device`);
          continue;
        }

        const isCounter = varbind.type === 'Counter' || varbind.type === 'Counter64';
        if (column.counting && !isCounter) {
          notes.push(
            `${column.name} is read as a counter and the device returned a ${varbind.type}`,
          );
        }
        if (!column.counting && isCounter) {
          notes.push(
            `${column.name} is a ${varbind.type}, which only ever goes up — set its reading ` +
              'type to counter to graph it as a rate',
          );
        }

        if (column.counting) {
          // Exact text, not a number: a Counter64 past 2^53 loses its low bits as a double, and
          // the core divides the difference between two of these (`T-02`).
          const exact = stringOf(varbind);
          if (exact === null || !/^\d+$/.test(exact)) {
            notes.push(`${column.name} returned ${varbind.type}, which is not a counter`);
            continue;
          }
          readings.push({
            key: column.key,
            value: Number(exact),
            counter: exact,
            counterBits: varbind.type === 'Counter' ? 32 : 64,
          });
          continue;
        }

        const value = numberOf(varbind);
        if (value === null) {
          notes.push(
            `${column.name} returned ${varbind.type}, which is not a number — a text column ` +
              'belongs on an SNMP Custom String sensor',
          );
          continue;
        }
        readings.push({ key: column.key, value });
      }

      if (readings.length === 0) {
        throw new Error(
          `row ${index} of ${table} on ${host} produced no readings: ${notes.join('; ')}`,
        );
      }

      const label =
        nameOid === null ? null : stringOfRow(varbinds[columns.length], { stringOf, isException });

      return {
        channels: readings,
        message: [describeRow(index, resolvedBy, label), ...notes].join('; '),
      };
    });
  },
};

/** A parameter as text, without `String()` on an unknown — which lints and stringifies objects. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function matchModeOf(value: unknown): MatchMode {
  return value === 'contains' || value === 'regex' ? value : 'exact';
}

function describeMode(mode: MatchMode): string {
  return mode === 'exact' ? 'of' : mode === 'contains' ? 'containing' : 'matching';
}

interface Helpers {
  stringOf: (varbind: SnmpVarbind) => string | null;
  isException: (varbind: SnmpVarbind) => boolean;
  indexUnder: (prefix: readonly number[], oid: readonly number[]) => number[] | null;
  parseOid: (text: string) => number[];
}

/**
 * Whether a row's naming value is the one this sensor wants.
 *
 * `regex` goes through `extract`, which runs the match inside a `node:vm` context with a
 * watchdog — an operator-supplied pattern against device-supplied text is the one place in a
 * check that cannot be interrupted any other way (see `support/pattern.ts`). It costs about
 * 100 µs a row against 0.2 µs for a direct match, which is why `exact` and `contains` are plain
 * string comparisons and why a pattern that backtracks fails the check on the *first* row rather
 * than being retried on every one of them.
 */
function rowMatcher(
  mode: MatchMode,
  wanted: string,
  extract: (text: string, pattern: string | null, mode: 'number' | 'match') => Extracted,
  nameOid: string,
): (value: string) => boolean {
  if (mode === 'contains') {
    const needle = wanted.toLowerCase();
    return (value) => value.toLowerCase().includes(needle);
  }
  if (mode === 'regex') {
    return (value) => {
      const found = extract(value, wanted, 'match');
      if (found.kind === 'too-slow') {
        throw new Error(
          `matching /${wanted}/ against ${nameOid} was still running after ` +
            `${String(found.afterMs)} ms and was stopped — the pattern backtracks on what this ` +
            'device returns; a nested quantifier such as (a+)+ is the usual cause',
        );
      }
      return found.kind === 'value';
    };
  }
  const exact = wanted.trim().toLowerCase();
  return (value) => value.trim().toLowerCase() === exact;
}

/**
 * The index of the row whose naming column matches, or null.
 *
 * Checks the hinted index first, so a device that has *not* renumbered costs one request rather
 * than a walk of the whole table — which is the common case, and the walk is what makes naming a
 * row expensive. Only when the hint disagrees does it look properly.
 */
async function findRow(
  session: SnmpSession,
  signal: AbortSignal,
  nameOid: string,
  matches: (value: string) => boolean,
  hint: string,
  h: Helpers,
): Promise<string | null> {
  if (hint !== '') {
    const found = await session.get([`${nameOid}.${hint}`], signal).catch(() => []);
    const varbind = found[0];
    if (varbind !== undefined && !h.isException(varbind) && matches(h.stringOf(varbind) ?? '')) {
      return hint;
    }
  }

  // Not swallowed the way `snmp.traffic` swallows its three attempts: this is the only path to
  // the row, so a walk that failed is the check's failure and carries the diagnosis.
  const rows = await session.walk(nameOid, signal);
  const prefix = h.parseOid(nameOid);
  for (const varbind of rows) {
    const value = h.stringOf(varbind);
    if (value === null || !matches(value)) continue;
    const suffix = h.indexUnder(prefix, h.parseOid(varbind.oid));
    if (suffix !== null && suffix.length > 0) return suffix.join('.');
  }
  return null;
}

function stringOfRow(
  varbind: SnmpVarbind | undefined,
  h: Pick<Helpers, 'stringOf' | 'isException'>,
): string | null {
  if (varbind === undefined || h.isException(varbind)) return null;
  const value = h.stringOf(varbind);
  return value === null || value.trim() === '' ? null : value.trim();
}

/** What an operator reads under the graph: which row, how it was found, and what it is called. */
function describeRow(index: string, resolvedBy: string, label: string | null): string {
  const parts = [`row ${index}`];
  if (label !== null) parts.push(`"${label}"`);
  if (resolvedBy === 'name') parts.push('found by name');
  return parts.join(' ');
}
