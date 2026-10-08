import type { ChannelDef, SensorCatalogue } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { errorKindOf, errorWithoutParamValues } from '../support/param-values.js';
import { limitsFromDeclaration, type ChannelLimits } from './limits.js';

/**
 * Putting a sensor type's declared thresholds onto channels that already exist (`S-18`).
 *
 * **Without this, a default would only ever reach installations created after the build that
 * declared it** — which is the worst of both: the same version of the same software alarms on a
 * new install and stays silent on the one that has been running for a year, and nothing on
 * screen says why. Every upgrade path in this project is "the schema moves forward"; this is the
 * same idea for a value the schema cannot express.
 *
 * **A declaration taken away is the same upgrade in the other direction** (`P-291`). A build
 * that stops declaring a channel's limits clears the ones an earlier build put there, and hands
 * the channel back to `unset`: otherwise an install that ran the older build alarms on a
 * threshold the documentation says is gone, and a fresh one does not. Only a `declared` row is
 * cleared, so an operator's limit stays whatever it holds.
 *
 * **What it will not touch is the point.** `limits_source = 'operator'` is a decision somebody
 * made, and that includes deciding to clear a threshold — which writes `{}`, indistinguishable
 * from a channel nobody has configured, and the reason `S-18` needed a column rather than a look
 * at the value. Only `unset` and `declared` are written, so a default may be *changed* by a later
 * build and may never be *restored* over a removal.
 *
 * Runs once at startup rather than in the housekeeping loop: an operator upgrading for a fix to
 * their alarming wants it when the service comes up, not within the hour. After the first pass
 * the query matches nothing, which is cheap enough to keep it there.
 */

/** A channel's lookup and counter width, as its sensor's type declares them (`P-80`). */
export interface ChannelShape {
  readonly lookup: string | null;
  readonly counterBits: number | null;
}

/**
 * What a sensor's type declares for its channels, and whether it could say (`P-306`).
 *
 * `undeclared` is set when the type could not answer for the sensor's stored parameters, so
 * `shapes` is its answer to `{}` or nothing: a channel created from it may lack the lookup or
 * counter width the sensor really declares, for good. The resolver counts the channels it creates
 * that way, for Core Health, since the warning below is said once a type and kind of error.
 */
export interface DeclaredShapes {
  readonly shapes: ReadonlyMap<string, ChannelShape>;
  readonly undeclared: boolean;
  /**
   * The key the sensor's own answer makes primary, or null (`P-314`): when it declares none, and
   * whenever `undeclared` is set. A fallback's primary is a placeholder's (`snmp.table`'s `{}`
   * answer makes `value` primary, which no sensor with columns reports), so the resolver must not
   * move a sensor's primary onto it.
   */
  readonly primary: string | null;
}

/**
 * The rest of a channel's declaration, for channels the ingestion path creates (`P-80`).
 *
 * `ChannelResolver` is the only way a key a sensor type newly declares reaches the `channel`
 * table on a sensor that already exists, and its INSERT wrote limits but not `lookup_id` or
 * `counter_bits`. So on any installation that predates a new channel, a lookup channel got
 * `lookup_id = NULL` and empty limits — which `evaluateChannel` falls straight through, judging
 * it by nothing at all. `delivering` (`P-74`), `checksCompleting` (`P-76`) and `poolState`
 * (`P-62`) are all lookup channels with no limits, so the headline alarm of each of those tickets
 * existed only on installations created by that build. A counter with no `counter_bits` is the
 * same shape of wrong: the rate conversion is skipped, the stored sample is a cumulative total,
 * and a limit written for a rate latches Down for the life of the probe process.
 *
 * **Asked with the sensor's own stored parameters, not with `{}`** (`P-297`). Unlike limits,
 * which only a `fixedChannels` type may declare (`P-293`), lookups and counters are what
 * parameters choose: `snmp.custom` is a counter only in `counter` mode, `snmp.custom.string`
 * carries the lookup its parameters name, and each `snmp.table` column is a channel with its own.
 * `{}` answers those with a placeholder that declares neither, and a column added by editing a
 * table sensor reaches the `channel` table only through this path. Reading the fixed types alone
 * would be worse: `snmp.traffic` is not one, and its counters and its status lookup do not depend
 * on parameters, so they would be lost. And the resolver already reads the sensor's row to learn
 * its type, so the parameters cost a column, on a path that runs when a channel is first seen.
 *
 * Every channel the sensor's answer declares, keyed by channel key; a key it does not name has
 * neither. Only when that answer cannot be had — a type that throws for these stored parameters,
 * or breaks its own declaration with them (`P-296`) — is the type's `{}` answer used, which is
 * what every sensor got before.
 *
 * **That fallback is said, not swallowed** (`P-297` review). It is still caught — a type that
 * cannot answer must not cost the batch its other readings — but a channel it creates may get no
 * lookup and no counter width for good, since an edit declares no channels and the row is never
 * written again: `P-80`'s failure, on one sensor. So `logger` warns, once for each type and kind
 * of error (its `code`, or its name): the type, the sensor, and the error with every value of the
 * sensor's parameters taken out of its message, since those can be secrets. Once rather than per
 * sensor, because one broken type would otherwise write a line for every sensor of it on every
 * new channel; and by kind rather than by message, because a message can differ per sensor and
 * the set of them would have no bound. **And counted** (`P-306`): the answer says `undeclared`,
 * so every channel the resolver creates from it is on Core Health's `channelsCreatedUndeclared`,
 * the number an operator watches; this line says which type, and why.
 */
export function declaredChannelLookup(
  catalogue: SensorCatalogue,
  options: { readonly logger?: Logger } = {},
): (
  sensorType: string,
  params: Readonly<Record<string, unknown>>,
  sensorId: number,
) => DeclaredShapes {
  const warned = new Set<string>();
  const warn = (sensorType: string, sensorId: number, cause: unknown): void => {
    const logger = options.logger;
    if (logger === undefined) return;
    const code = errorKindOf(cause);
    const once = `${sensorType} ${code}`;
    if (warned.has(once)) return;
    warned.add(once);
    logger.warn(
      {
        sensorType,
        sensorId,
        phase: 'declare-channels-on-ingest',
        err: { code, message: messageOf(cause, sensorType) },
        fallback: bare.has(sensorType) ? 'the type’s answer to {}' : 'nothing',
      },
      'a sensor type could not declare its channels for a sensor’s stored parameters, so a ' +
        'channel ingestion created for it may have no lookup or counter width; later errors ' +
        'of this kind from this type are not logged again',
    );
  };
  const messageOf = (cause: unknown, sensorType: string): string =>
    cause instanceof Error ? cause.message : `${sensorType} threw ${typeof cause}`;
  const shapesOf = (defs: readonly ChannelDef[]): ReadonlyMap<string, ChannelShape> =>
    new Map(
      defs.map((def) => [
        def.key,
        { lookup: def.lookup ?? null, counterBits: def.counter?.bits ?? null },
      ]),
    );
  const none: ReadonlyMap<string, ChannelShape> = new Map();
  // A type this build does not register declares nothing, and nothing is what it is given: not
  // a fallback, so not counted.
  const unregistered: DeclaredShapes = { shapes: none, undeclared: false, primary: null };
  const bare = new Map<string, ReadonlyMap<string, ChannelShape>>();
  for (const id of catalogue.ids()) {
    try {
      bare.set(id, shapesOf(catalogue.channelsFor(id, {})));
    } catch {
      // A type whose channels need parameters: it has no answer to fall back on.
    }
  }
  return (sensorType, params, sensorId) => {
    if (!catalogue.has(sensorType)) return unregistered;
    try {
      const defs = catalogue.channelsFor(sensorType, params);
      return {
        shapes: shapesOf(defs),
        undeclared: false,
        // The first, so one row at most is promoted whatever a broken type answers: the index
        // allows one, and the catalogue refuses only a `{}` answer that declares two.
        primary: defs.find((def) => def.isPrimary === true)?.key ?? null,
      };
    } catch (cause) {
      warn(
        sensorType,
        sensorId,
        errorWithoutParamValues(cause, params, catalogue.writeOnlyPaths(sensorType)),
      );
      return { shapes: bare.get(sensorType) ?? none, undeclared: true, primary: null };
    }
  };
}

/**
 * What a type declares for one channel, or null (`S-18`).
 *
 * The same question the start-up pass asks, in the shape the channel resolver needs — so a
 * channel created lazily by ingestion and one created with its sensor get the same answer from
 * the same place. Two lookups would eventually disagree, and the disagreement would be invisible.
 */
export function declaredLimitsLookup(
  catalogue: SensorCatalogue,
): (sensorType: string, channelKey: string) => ChannelLimits | null {
  const { declared } = declarationsIn(catalogue);
  return (sensorType, channelKey) => declared.get(`${sensorType} ${channelKey}`) ?? null;
}

interface Declarations {
  /** Every (type, channel) a registered type declares limits for, keyed `type key`. */
  readonly declared: Map<string, ChannelLimits>;
  /** Every type this build registers: the ones whose declarations it can speak for. */
  readonly registered: readonly string[];
}

/**
 * What the catalogue declares, built once and read many times.
 *
 * **Only a `fixedChannels` type is read, and its `{}` answer is every sensor's** (`P-293`). The
 * catalogue refuses `limits` from any other type — at registration on a channel `{}` names, and
 * at `channelsFor` on one only real parameters produce — so such a type declares none, and its
 * `{}`, a placeholder, is never asked about one. That is what leaves `clearWithdrawn` nothing to
 * guess: a key no fixed answer declares is a key no sensor of this build has a limit on.
 */
function declarationsIn(catalogue: SensorCatalogue): Declarations {
  const declared = new Map<string, ChannelLimits>();
  for (const id of catalogue.ids()) {
    if (catalogue.declaration(id).fixedChannels !== true) continue;
    // Cannot throw: the catalogue refuses a fixed type whose `channels({})` does.
    for (const def of catalogue.channelsFor(id, {})) {
      if (def.limits === undefined) continue;
      declared.set(`${id} ${def.key}`, limitsFromDeclaration(def.limits));
    }
  }
  return { declared, registered: catalogue.ids() };
}

export interface DeclaredLimitsOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly catalogue: SensorCatalogue;
}

export interface DeclaredLimitsReport {
  /** Channels whose limits this pass wrote. Zero on every start after the first. */
  readonly applied: number;
  /**
   * Channels whose declared limits this pass cleared because their type no longer declares any
   * for that key (`P-291`). Zero on every start after the first, since a cleared row is `unset`.
   */
  readonly cleared: number;
  /** Channels left alone because a person had decided about them. */
  readonly operatorOwned: number;
  /** Sensor types with declarations that no channel in this installation matched. */
  readonly unmatched: readonly string[];
}

interface Row {
  readonly id: number;
  readonly type: string;
  readonly key: string;
}

export async function applyDeclaredLimits(
  options: DeclaredLimitsOptions,
): Promise<DeclaredLimitsReport> {
  const logger = options.logger.child({ component: 'declared-limits' });

  // Built from the catalogue rather than from a list here, so a type that gains a declaration
  // needs no change on this side — the rule in `CLAUDE.md` that adding a sensor type is a
  // one-file job.
  const declarations = declarationsIn(options.catalogue);
  const { declared } = declarations;

  // Before the early return below: a catalogue that declares nothing at all may be one whose
  // last declaration was just removed, and that is a clearing to do, not nothing to do.
  const cleared = await clearWithdrawn(options, declarations);
  if (cleared > 0) {
    logger.info(
      { cleared },
      'cleared declared channel limits their sensor types no longer declare',
    );
  }

  if (declared.size === 0) return { applied: 0, cleared, operatorOwned: 0, unmatched: [] };

  const types = [...new Set([...declared.keys()].map((one) => one.split(' ')[0] ?? ''))];

  const candidates = await options.db.query<Row>(
    // `limits_source` carries the whole decision, so this reads no values and compares none.
    `SELECT c.id, sc.type, c.key
     FROM channel c
     JOIN sensor_config sc ON sc.object_id = c.sensor_id
     WHERE c.limits_source <> 'operator' AND sc.type = ANY($1::text[])`,
    [types],
  );

  const ids: number[] = [];
  const values: string[] = [];
  const matched = new Set<string>();
  for (const row of candidates) {
    const key = `${row.type} ${row.key}`;
    const limits = declared.get(key);
    if (limits === undefined) continue;
    matched.add(key);
    ids.push(row.id);
    values.push(JSON.stringify(limits));
  }

  let applied = 0;
  if (ids.length > 0) {
    // Written only where it would change something: a build that declares the same thresholds it
    // declared last time must not touch every health channel on every start, because writing a
    // channel bumps its sensor's version and invalidates every open ETag (`S-13`).
    const changed = await options.db.query<{ id: number }>(
      `UPDATE channel AS c
       SET limits = d.limits, limits_source = 'declared'
       FROM unnest($1::bigint[], $2::jsonb[]) AS d(id, limits)
       WHERE c.id = d.id AND c.limits IS DISTINCT FROM d.limits
       RETURNING c.id`,
      [ids, values],
    );
    applied = changed.length;
  }

  const operatorOwned = await countOperatorOwned(options, types);
  const unmatched = [...declared.keys()]
    .filter((key) => !matched.has(key))
    .map((key) => key.replace(' ', '.'))
    .sort();

  if (applied > 0) {
    logger.info(
      { applied, operatorOwned },
      'applied the sensor types’ declared channel limits to existing channels',
    );
  }
  return { applied, cleared, operatorOwned, unmatched };
}

/**
 * Takes away a declared limit whose type stopped declaring it (`P-291`).
 *
 * **Per channel, not per bound.** A type that still declares a channel's limits but dropped one
 * of its bounds needs nothing here: the pass above writes the whole declaration over the whole
 * column, so the dropped bound goes with the rewrite. What it cannot reach is a key with no
 * declaration left at all, because it only ever looks a key *up*.
 *
 * Back to `{}` and `unset` rather than to `{}` and `declared`: `{}` and `unset` is what a channel
 * created by this build holds, and `unset` is what lets a later build declare a limit for it
 * again. `declared` with nothing in it would be a claim about a declaration that does not exist.
 *
 * **Every key of a registered type that `declared` does not hold** (`P-293`). For a
 * `fixedChannels` type, `{}` is every sensor's answer, so a key it does not declare — named bare,
 * or gone outright, as Probe Health's dropped keys are — has no limit on any sensor of this
 * build. Any other type declares no limit anywhere, which the catalogue holds it to, so every
 * declared row of it is an earlier build's. A type this build does not register is left alone:
 * it says nothing either way, and a build profile that leaves a type out is not withdrawing what
 * the type declares.
 */
async function clearWithdrawn(
  options: DeclaredLimitsOptions,
  { declared, registered }: Declarations,
): Promise<number> {
  if (registered.length === 0) return 0;
  const types: string[] = [];
  const keys: string[] = [];
  for (const one of declared.keys()) {
    const space = one.indexOf(' ');
    types.push(one.slice(0, space));
    keys.push(one.slice(space + 1));
  }
  // `limits_source = 'declared'` is the whole guard: an operator's row is `operator`, whatever
  // it holds and however it came to hold it, and an `unset` row has nothing to clear. Like the
  // pass above, this reads no values: who wrote the row decides, not what is in it.
  const rows = await options.db.query<{ id: number }>(
    `UPDATE channel AS c
     SET limits = '{}'::jsonb, limits_source = 'unset'
     FROM sensor_config sc
     WHERE sc.object_id = c.sensor_id
       AND c.limits_source = 'declared'
       AND sc.type = ANY($1::text[])
       AND NOT EXISTS (
         SELECT 1 FROM unnest($2::text[], $3::text[]) AS d(type, key)
         WHERE d.type = sc.type AND d.key = c.key
       )
     RETURNING c.id`,
    [registered, types, keys],
  );
  return rows.length;
}

/** How many channels a person owns the thresholds of — reported, never acted on. */
async function countOperatorOwned(
  options: DeclaredLimitsOptions,
  types: readonly string[],
): Promise<number> {
  const rows = await options.db.query<{ count: string }>(
    `SELECT count(*) AS count
     FROM channel c
     JOIN sensor_config sc ON sc.object_id = c.sensor_id
     WHERE c.limits_source = 'operator' AND sc.type = ANY($1::text[])`,
    [types],
  );
  return Number(rows[0]?.count ?? 0);
}
