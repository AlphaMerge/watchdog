import type { SensorTypeSummary } from '../api/types';

/**
 * Reading the catalogue: what a `paramsSchema` says, and what a search over it finds.
 *
 * Separate from the component because the interesting decisions here are all judgements about
 * what somebody typing into a box meant — which of three kinds of thing they were naming, and
 * which of forty-three types is worth showing first. A rendered test would prove a `<tr>` exists;
 * these prove the ordering, which is the part that can quietly be wrong.
 *
 * **Substring, not fuzzy.** `snmp.traf` finds `snmp.traffic` and `veri` finds `verifyTls`, and
 * nothing finds anything by an accident of letter order. On a page whose whole content is
 * identifiers, a match the reader cannot explain is worse than no match.
 */

/** What the schema says about one parameter, in the terms the table renders. */
export interface ParameterSummary {
  readonly name: string;
  /** The schema's `title` — the human name the add-sensor form labels this field with. */
  readonly title: string;
  readonly type: string;
  readonly required: boolean;
  /** `writeOnly`: the annotation that keeps this value out of every read path (`P-05`). */
  readonly writeOnly: boolean;
  /** The default as JSON, or null when the schema states none. */
  readonly defaultJson: string | null;
}

interface SchemaProperty {
  readonly type?: string;
  readonly title?: string;
  readonly writeOnly?: boolean;
  readonly default?: unknown;
}

export function parametersOf(type: SensorTypeSummary): ParameterSummary[] {
  const properties = (type.paramsSchema['properties'] ?? {}) as Record<string, SchemaProperty>;
  const required = new Set((type.paramsSchema['required'] ?? []) as string[]);
  return Object.keys(properties).map((name) => {
    const property: SchemaProperty = properties[name] ?? {};
    return {
      name,
      title: property.title ?? '',
      type: property.type ?? '—',
      required: required.has(name),
      writeOnly: property.writeOnly === true,
      defaultJson: property.default === undefined ? null : JSON.stringify(property.default),
    };
  });
}

/** A type the query kept, with the reason it was kept. */
export interface TypeMatch {
  readonly type: SensorTypeSummary;
  readonly parameters: readonly ParameterSummary[];
  /**
   * Parameter names the query matched, *when they are the only reason this type is here*. That
   * is what makes a hit worth opening: somebody who typed `verifyTls` wants the row, not the
   * card that happens to contain it.
   *
   * Empty when the id or the category matched, even if a parameter did too. Half the SNMP
   * types have a parameter titled "SNMP version", so a search for `snmp` would otherwise open
   * all nine cards and tell each of them it "matches version" — an answer to a question nobody
   * asked, and the mile of tables this page was collapsed to avoid.
   */
  readonly matchedParameters: readonly string[];
}

/**
 * Which types survive `query`, best first.
 *
 * The ranking is the whole point of the function. An id that *starts* with what was typed is
 * almost always the thing being looked for, so `snmp` puts the nine SNMP types above the four
 * that merely mention SNMP in a parameter. Within a rank the server's alphabetical order is
 * kept, so the list does not reshuffle itself as a search is narrowed one keystroke at a time.
 */
export function searchTypes(types: readonly SensorTypeSummary[], query: string): TypeMatch[] {
  const needle = query.trim().toLowerCase();
  const ranked = types.map((type) => {
    const parameters = parametersOf(type);
    if (needle === '') return { rank: 0, match: { type, parameters, matchedParameters: [] } };

    const at = type.id.toLowerCase().indexOf(needle);
    if (at !== -1) return { rank: at === 0 ? 0 : 1, match: bare(type, parameters) };
    if (type.category.toLowerCase().includes(needle))
      return { rank: 2, match: bare(type, parameters) };

    const matchedParameters = parameters
      .filter((p) => contains(p.name, needle) || contains(p.title, needle))
      .map((p) => p.name);
    const rank = matchedParameters.length > 0 ? 3 : NO_MATCH;
    return { rank, match: { type, parameters, matchedParameters } };
  });

  return ranked
    .filter((entry) => entry.rank !== NO_MATCH)
    .sort((a, b) => a.rank - b.rank || a.match.type.id.localeCompare(b.match.type.id))
    .map((entry) => entry.match);
}

const NO_MATCH = Number.POSITIVE_INFINITY;

/** A hit whose reason is its own name, so there is nothing about a parameter to report. */
function bare(type: SensorTypeSummary, parameters: readonly ParameterSummary[]): TypeMatch {
  return { type, parameters, matchedParameters: [] };
}

function contains(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

/** The three things on this page that have names worth completing. */
export type SuggestionKind = 'type' | 'category' | 'parameter';

export interface Suggestion {
  readonly kind: SuggestionKind;
  /** What lands in the search box when this is picked — and so what gets searched for. */
  readonly value: string;
  /** The right-hand hint: what picking it will show. */
  readonly detail: string;
}

/** Categories first: one pick narrows forty-three types to nine, which no id can do. */
const KIND_ORDER: Record<SuggestionKind, number> = { category: 0, type: 1, parameter: 2 };

/**
 * What to offer for `query`.
 *
 * **An empty box lists every category, in full.** It is the only complete, short answer to "what
 * is in here?" that fits in a dropdown — eleven categories against forty-three types and three
 * hundred parameters — so it is the browse menu, and truncating a browse menu to a limit would
 * hide exactly the category somebody could not name. Once anything is typed the limit applies:
 * suggestions are then a shortlist, and a shortlist longer than the screen is a list.
 *
 * Prefix matches beat substring matches across all three kinds, so typing `snmp` offers the SNMP
 * category before `snmp.traffic` and long before the types with an `snmpVersion` parameter.
 */
export function suggest(
  types: readonly SensorTypeSummary[],
  query: string,
  limit = 10,
): Suggestion[] {
  const needle = query.trim().toLowerCase();
  const categories = countBy(types.map((type) => type.category));

  if (needle === '') {
    return [...categories.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, count]) => ({
        kind: 'category' as const,
        value: category,
        detail: plural(count, 'type'),
      }));
  }

  const parameters = countBy(
    types.flatMap((type) => unique(parametersOf(type).map((parameter) => parameter.name))),
  );

  const candidates: { suggestion: Suggestion; at: number }[] = [
    ...[...categories.entries()].map(([category, count]) => ({
      suggestion: { kind: 'category' as const, value: category, detail: plural(count, 'type') },
      at: category.toLowerCase().indexOf(needle),
    })),
    ...types.map((type) => ({
      suggestion: {
        kind: 'type' as const,
        value: type.id,
        detail: `${type.category} · ${type.costHint}`,
      },
      at: type.id.toLowerCase().indexOf(needle),
    })),
    ...[...parameters.entries()].map(([name, count]) => ({
      suggestion: {
        kind: 'parameter' as const,
        value: name,
        detail: `parameter · ${plural(count, 'type')}`,
      },
      at: name.toLowerCase().indexOf(needle),
    })),
  ];

  return candidates
    .filter((candidate) => candidate.at !== -1)
    .sort(
      (a, b) =>
        Number(a.at > 0) - Number(b.at > 0) ||
        KIND_ORDER[a.suggestion.kind] - KIND_ORDER[b.suggestion.kind] ||
        a.suggestion.value.localeCompare(b.suggestion.value),
    )
    .slice(0, limit)
    .map((candidate) => candidate.suggestion);
}

/**
 * Where `query` sits inside `text`, for the mark the reader needs to see why a row is here.
 *
 * Null rather than a zero-length range when there is nothing to mark: the caller renders plain
 * text then, and a `<mark>` around nothing is a screen-reader announcement of an emphasis that
 * is not there.
 */
export function matchRange(text: string, query: string): readonly [number, number] | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return null;
  const at = text.toLowerCase().indexOf(needle);
  return at === -1 ? null : [at, at + needle.length];
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
