import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { send } from '../../api/client';
import type { ChannelRecord, DeclaredChannel } from '../../api/types';
import {
  defaultFor,
  fieldsOf,
  readAt,
  writeAt,
  type ChannelMode,
  type FieldModel,
  type JsonSchema,
  type Kept,
  type KeptChannel,
} from '../../forms/schema';

/**
 * A column put back after an earlier edit took it out (`U-40`).
 *
 * An edit that removes a table column keeps the column's channel: its row, its history, and what
 * it stores (`P-310`). An entry that puts the column back is one the stored parameters do not
 * name, so `U-34`'s lock, which reads the stored parameters, leaves it open, and the core then
 * refuses the save with a 409 when the column comes back as the other mode (`P-303`).
 *
 * **Which channel an entry lands on is the core's to say.** The key is the sensor type's
 * (`snmp.table` derives `col6` from column `6`), and deriving it here would be a second copy of
 * every type's rule, or a hook on the type the web would have to know about. So the core is
 * asked: `POST /sensor-types/{id}/channels` answers which channels a set of parameters would
 * declare, for any type. The form sends the stored parameters with the array holding only the
 * entry in question, so the answer is that entry's channels and nothing else's; and the stored
 * parameters, not the form's, so a half-finished field elsewhere does not stop the answer, and no
 * secret being typed leaves the browser for a question about a column.
 *
 * **The sensor's channel rows say what is kept.** A declared channel with a row is one the sensor
 * has; the row's `counterBits` is what it stores, the answer's is what the entry would make it.
 */

/** One question to put to the core: the channels the entry at `array` lands on. */
export interface KeptAsk {
  /** The array's path in the parameters. */
  readonly array: string;
  /** What the answer is filed under: the entry's key and the fixed values that decide its mode. */
  readonly id: string;
  /** The stored parameters with the array holding this entry alone. */
  readonly params: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fixed fields of an entry schema, through its objects (`U-34` allows them on a leaf). */
function fixedFields(fields: readonly FieldModel[]): FieldModel[] {
  return fields.flatMap((field) =>
    field.kind === 'object' ? fixedFields(field.children) : field.createOnly ? [field] : [],
  );
}

/**
 * The arrays an entry of which can land on a kept channel: those whose entry schema names its key
 * (`x-entryKey`) and holds a fixed field. Through objects, not into arrays: an array inside an
 * entry has a path with that entry's position in it, which the stored parameters do not share.
 */
function keyedArrays(fields: readonly FieldModel[]): FieldModel[] {
  return fields.flatMap((field) => {
    if (field.kind === 'object') return keyedArrays(field.children);
    const items = field.items;
    if (field.kind !== 'array' || items?.['x-entryKey'] === undefined) return [];
    return fixedFields(fieldsOf(items)).length > 0 ? [field] : [];
  });
}

/**
 * Where an answer about `entry` is filed, or `undefined` for an entry with no key yet.
 *
 * **The entry's key and its fixed values, nothing else.** The key says which channel it lands on
 * (`x-entryKey` is "what the entry is", `U-34`) and the fixed values what it would store, which is
 * why they are fixed. Its name or unit typed afterwards does not ask again, and a locked entry —
 * whose fixed values cannot change — keeps its answer while the rest of it is edited.
 */
export function keptId(array: string, items: JsonSchema, entry: unknown): string | undefined {
  const key = items['x-entryKey'];
  if (key === undefined || !isRecord(entry) || entry[key] === undefined) return undefined;
  const fixed = fixedFields(fieldsOf(items)).map(
    (field) => readAt(entry, field.path) ?? defaultFor(field) ?? null,
  );
  return JSON.stringify([array, entry[key], fixed]);
}

/**
 * Every question the form has to ask: one per entry, at each keyed array, whose key the stored
 * parameters do not have (an entry that matches a stored one is `U-34`'s and needs no answer).
 */
export function keptAsks(
  schema: JsonSchema,
  stored: Record<string, unknown>,
  values: Record<string, unknown>,
): KeptAsk[] {
  const asks = new Map<string, KeptAsk>();
  for (const field of keyedArrays(fieldsOf(schema))) {
    const items = field.items;
    const key = items?.['x-entryKey'];
    if (items === undefined || key === undefined) continue;
    const held = readAt(stored, field.path);
    const storedKeys = new Set(
      (Array.isArray(held) ? (held as unknown[]) : []).filter(isRecord).map((one) => one[key]),
    );
    const entries = readAt(values, field.path);
    for (const entry of Array.isArray(entries) ? (entries as unknown[]) : []) {
      if (!isRecord(entry) || storedKeys.has(entry[key])) continue;
      const id = keptId(field.path, items, entry);
      if (id === undefined || asks.has(id)) continue;
      asks.set(id, { array: field.path, id, params: writeAt(stored, field.path, [entry]) });
    }
  }
  return [...asks.values()];
}

const modeOf = (counterBits: number | null): ChannelMode =>
  counterBits === null ? 'gauge' : 'counter';

/** The channels an answer declares that the sensor has a row for, and what each would become. */
export function keptOf(
  declared: readonly DeclaredChannel[],
  rows: readonly ChannelRecord[],
): KeptChannel[] {
  return declared.flatMap((channel) => {
    const row = rows.find((one) => one.key === channel.key);
    return row === undefined
      ? []
      : [
          {
            key: channel.key,
            stores: modeOf(row.counterBits),
            declares: modeOf(channel.counterBits),
          },
        ];
  });
}

/** Long enough that typing a column's number is one question, short enough to feel answered. */
export const KEPT_DEBOUNCE_MS = 300;

/**
 * What `SchemaForm`'s `keptFor` answers on the sensor page (`U-40`): asks the core about every
 * entry with no stored counterpart, once its entry settles, and files each answer by `keptId`.
 *
 * Asks nothing when `rows` is not given or is empty — no channel, nothing kept — and an answer that
 * fails (an entry not yet valid, a core not reachable) is not asked again until the question
 * changes; until then the entry stays open and the core's 409 is still there to say it.
 */
export function useKeptChannels(
  typeId: string | undefined,
  schema: JsonSchema,
  stored: Record<string, unknown>,
  values: Record<string, unknown>,
  rows: readonly ChannelRecord[] | null | undefined,
): (array: string, entry: unknown) => Kept {
  const [answers, setAnswers] = useState<ReadonlyMap<string, readonly DeclaredChannel[]>>(
    () => new Map(),
  );
  const asking = rows !== null && rows !== undefined && rows.length > 0 && typeId !== undefined;
  const asks = useMemo(
    () => (asking ? keptAsks(schema, stored, values) : []),
    [asking, schema, stored, values],
  );
  // Every question already put, by what was sent: answered or refused, it is not sent again.
  const asked = useRef(new Set<string>());
  const pending = asks.filter((ask) => !answers.has(ask.id));
  const pendingKey = JSON.stringify(pending.map((ask) => [ask.id, ask.params]));

  useEffect(() => {
    if (typeId === undefined) return undefined;
    const due = (JSON.parse(pendingKey) as [string, Record<string, unknown>][]).filter(
      ([id, params]) => !asked.current.has(JSON.stringify([id, params])),
    );
    if (due.length === 0) return undefined;
    const timer = setTimeout(() => {
      for (const [id, params] of due) {
        asked.current.add(JSON.stringify([id, params]));
        send<{ channels: DeclaredChannel[] }>(
          'POST',
          `/sensor-types/${encodeURIComponent(typeId)}/channels`,
          { params },
        )
          .then((answer) => {
            setAnswers((held) => new Map(held).set(id, answer.channels));
          })
          .catch(() => {
            // Nothing to say: the entry stays open, and a save is still the core's to refuse.
          });
      }
    }, KEPT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pendingKey, typeId]);

  const items = useMemo(() => {
    const byArray = new Map<string, JsonSchema>();
    for (const field of keyedArrays(fieldsOf(schema))) {
      if (field.items !== undefined) byArray.set(field.path, field.items);
    }
    return byArray;
  }, [schema]);

  return useCallback(
    (array: string, entry: unknown): Kept => {
      const schemaOf = items.get(array);
      if (rows === null || rows === undefined || schemaOf === undefined) return undefined;
      const id = keptId(array, schemaOf, entry);
      const declared = id === undefined ? undefined : answers.get(id);
      return declared === undefined ? undefined : keptOf(declared, rows);
    },
    [answers, items, rows],
  );
}
