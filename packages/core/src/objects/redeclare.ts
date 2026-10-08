import type { ChannelDraft } from './sensor-type-gate.js';

/**
 * What an edit to a sensor's parameters does to the channels it already has (`P-303`).
 *
 * **Only create wrote a channel's declaration**, and an update replaces `params` and declared
 * nothing. So an edit that changed what a channel is — `snmp.custom.string`'s `lookup`, an
 * `snmp.custom` channel's name or unit, an `snmp.table` column's lookup — left the row as the
 * create wrote it: judged by the old lookup, labelled with the old name, for good.
 *
 * **Re-declared where the edit changed it, and only there.** A field is written when the edit
 * changes what the type declares for it (the stored parameters' answer against the new one) and
 * the row does not hold the new value already. An edit that leaves a channel's declaration alone
 * leaves its row alone, so a lookup an operator pointed the channel at stays where they put it,
 * until an edit that is itself about that channel's lookup. A key the stored answer does not name
 * — a table column taken out and put back — is changed in every field by the edit that puts it
 * back. Limits are never written: only a `fixedChannels` type declares them (`P-293`), and its
 * answer is the same for every parameter (`P-296`), so no edit changes one, and an operator's
 * row (`limits_source = 'operator'`) is not touched by anything here.
 *
 * **A channel is never turned from a counter into a gauge or back** (`T-02`). The two store
 * different things on one series: a counter's samples are rates, a gauge's are the raw value.
 * Re-declaring would put both on one line with one unit — "octets/s" relabelled "octets", or the
 * reverse, over the whole history — with a jump of orders of magnitude at the edit, an hour's
 * rollup averaging a rate with a running total, and limits written for one judged against the
 * other. Leaving the row would be worse: a counter stored as cumulative totals, `P-80`'s failure.
 * So that edit is refused, and a new sensor is the way to the other mode; the old one keeps a
 * history that means one thing. A counter's *width* is re-declared like any other field: the
 * stored samples are rates either way, and the reading's own width wins at ingestion regardless.
 *
 * **A channel an edit adds or removes is not written here.** An added key (a table column) is
 * created on its first reading with the shape the stored parameters declare (`P-297`); a removed
 * one keeps its row and its history, and stops receiving readings.
 *
 * **Which channel is primary moves with the declaration** (`P-309`): a table edit that puts
 * another column first makes that column primary, as a create of those parameters would. Against
 * the rows rather than the stored answer, because nothing but a create or a clone writes
 * `is_primary` (no operator chooses it), so a row that is not the declared primary is one an
 * earlier declaration left behind. One primary always: the declared one is promoted and every
 * other row demoted together, a removed key included, so the one-primary-per-sensor index is
 * never violated and never left with none. **Except when the declared primary has no row yet** —
 * a column the edit adds and puts first, or `exe.script.advanced`'s `primaryChannel` renamed:
 * the edit does not create channels, so the current primary is kept rather than leaving the
 * sensor with none until a reading arrives. The reading that creates that row makes it primary
 * (`P-314`, `ChannelResolver`), in its own transaction, with the sensor held as an edit holds it;
 * one such row a reading created before that is moved at the next start (`P-323`).
 *
 * **Without the stored answer, a lookup is left as it is** (`P-311`). When the type cannot say
 * what the stored parameters declared — it throws for them, as one stored by an older build can
 * make it — the edit has only the rows to compare against, and the lookup is the one declared
 * field an operator also writes (`PATCH …/channels/:key`): a row's lookup that differs from the
 * new declaration may be the operator's choice or the old declaration, and nothing says which.
 * So it is kept, and the plan names the channel so the caller can say so. The other fields have
 * no other writer, so the row is the old declaration and is compared as before, and a mode change
 * is still refused against the row.
 */

/** The part of a channel row an edit can re-declare. */
export interface ChannelDeclaration {
  readonly name: string;
  readonly unit: string;
  readonly lookupId: string | null;
  readonly counterBits: number | null;
  /** Whether this is the sensor's primary channel (`P-309`). */
  readonly isPrimary: boolean;
}

export interface StoredChannel extends ChannelDeclaration {
  readonly key: string;
}

export interface ChannelRedeclaration {
  readonly key: string;
  readonly before: ChannelDeclaration;
  readonly after: ChannelDeclaration;
}

export interface ModeChange {
  readonly key: string;
  readonly from: 'counter' | 'gauge';
  readonly to: 'counter' | 'gauge';
}

export type RedeclarationPlan =
  | { readonly kind: 'refused'; readonly modeChanges: readonly ModeChange[] }
  | {
      readonly kind: 'redeclare';
      readonly changes: readonly ChannelRedeclaration[];
      /**
       * The channels whose lookup the new declaration differs from and that were left as they
       * are, because the stored answer could not be had (`P-311`). Empty whenever it could.
       */
      readonly lookupsKept: readonly string[];
    };

function declarationOf(draft: ChannelDraft): ChannelDeclaration {
  // As `createChannels` writes them: no unit is '', no lookup or counter is NULL.
  return {
    name: draft.name,
    unit: draft.unit ?? '',
    lookupId: draft.lookup ?? null,
    counterBits: draft.counterBits ?? null,
    isPrimary: draft.isPrimary === true,
  };
}

function declarationOfRow(row: StoredChannel): ChannelDeclaration {
  return {
    name: row.name,
    unit: row.unit,
    lookupId: row.lookupId,
    counterBits: row.counterBits,
    isPrimary: row.isPrimary,
  };
}

const modeOf = (shape: ChannelDeclaration): 'counter' | 'gauge' =>
  shape.counterBits === null ? 'gauge' : 'counter';

/**
 * Compares the stored parameters' declaration (`null` when the type cannot answer for them, as
 * if it named no key, except that no lookup is written: `P-311`) with the edit's, against the
 * rows.
 */
export function planRedeclaration(
  stored: readonly ChannelDraft[] | null,
  next: readonly ChannelDraft[],
  rows: readonly StoredChannel[],
): RedeclarationPlan {
  const was = new Map((stored ?? []).map((draft) => [draft.key, declarationOf(draft)]));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const modeChanges: ModeChange[] = [];
  const changes: ChannelRedeclaration[] = [];
  const lookupsKept: string[] = [];

  // The primary the edit declares, where it has a row to be; otherwise the rows keep theirs.
  const declaredPrimary = next.find((draft) => draft.isPrimary === true)?.key;
  const primaryKey =
    declaredPrimary !== undefined && byKey.has(declaredPrimary) ? declaredPrimary : null;
  const primaryOf = (row: StoredChannel): boolean =>
    primaryKey === null ? row.isPrimary : row.key === primaryKey;

  for (const draft of next) {
    const row = byKey.get(draft.key);
    if (row === undefined) continue;
    const after = declarationOf(draft);
    const before = declarationOfRow(row);
    const previous = was.get(draft.key) ?? null;
    // Whether this edit is what changes the field: its declaration moved, and the row does not
    // already hold where it moved to.
    const moved = (field: keyof ChannelDeclaration): boolean =>
      (previous === null || previous[field] !== after[field]) && before[field] !== after[field];

    if (
      modeOf(before) !== modeOf(after) &&
      (previous === null || modeOf(previous) !== modeOf(after))
    ) {
      modeChanges.push({ key: draft.key, from: modeOf(before), to: modeOf(after) });
      continue;
    }

    // Not when the stored answer is missing: the row's lookup may be an operator's (`P-311`).
    const relook = moved('lookupId') && stored !== null;
    if (moved('lookupId') && !relook) lookupsKept.push(draft.key);

    const written: ChannelDeclaration = {
      name: moved('name') ? after.name : before.name,
      unit: moved('unit') ? after.unit : before.unit,
      lookupId: relook ? after.lookupId : before.lookupId,
      // Only between two widths: a mode that would change was refused above, and a row whose
      // mode already differs from a declaration this edit did not change is left as it is.
      counterBits:
        before.counterBits !== null && after.counterBits !== null && moved('counterBits')
          ? after.counterBits
          : before.counterBits,
      isPrimary: primaryOf(row),
    };
    if (
      written.name !== before.name ||
      written.unit !== before.unit ||
      written.lookupId !== before.lookupId ||
      written.counterBits !== before.counterBits ||
      written.isPrimary !== before.isPrimary
    ) {
      changes.push({ key: draft.key, before, after: written });
    }
  }

  // A row the edit no longer declares is not re-declared, but it stops being primary when the
  // declared primary has a row to take over (`P-309`).
  const declared = new Set(next.map((draft) => draft.key));
  for (const row of rows) {
    if (declared.has(row.key) || primaryOf(row) === row.isPrimary) continue;
    const before = declarationOfRow(row);
    changes.push({ key: row.key, before, after: { ...before, isPrimary: primaryOf(row) } });
  }

  return modeChanges.length > 0
    ? { kind: 'refused', modeChanges }
    : { kind: 'redeclare', changes, lookupsKept };
}
