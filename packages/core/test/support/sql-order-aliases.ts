/**
 * Finds a query that sorts by its own computed output column where it meant the input column
 * (`P-389`).
 *
 * A bare name in `ORDER BY` or `DISTINCT ON` resolves to an output column before an input one, and
 * so does an ordinal. `SELECT id::text AS id … ORDER BY id` therefore sorts the text, and `'1000'`
 * comes before `'999'`. `P-385` found that twice, in the pause sweep and in `AccessService`, and
 * both were wrong only across a power of ten, which no fresh test database reaches. An expression
 * in those clauses (`lower(id)`, `t.id`) resolves input columns only, and so does a window's or an
 * aggregate's `ORDER BY`, so those are not this shape.
 *
 * **What is reported:** in one query level of one template literal, an output column that the
 * same level names bare, or by ordinal, in `ORDER BY` or `DISTINCT ON`, and that is either
 * - computed from a column of its own name: `t.x::text AS x`, `lower(name) AS name`, and
 *   `t.x::text` with no alias, which PostgreSQL also calls `x`; or
 * - cast to text under any name: `o.id::text AS object_id`.
 *
 * A column under another name (`o.id AS object_id`) sorts as the column does, and one computed
 * from something else and not made text (`count(*)::int AS count`, `0 AS depth`) was named to be
 * sorted by, so neither is reported.
 *
 * **What is not seen:** a column that a CTE or subquery computed and an outer level sorts by (the
 * outer level reads it as an input column, and nothing here knows its type); a query whose select
 * list and `ORDER BY` are in different literals, or built with `${…}`; an alias written without
 * `AS`; and text made some other way than a cast (`concat`, `to_char`, `||`).
 *
 * It reads the source text with a small lexer rather than the TypeScript compiler, so it needs no
 * database, no build and no dependency, and the whole of `packages/core/src` takes a fraction of a
 * second.
 */

/** A template literal: its text with each `${…}` replaced by `$_`, and the line it starts on. */
export interface TemplateLiteral {
  readonly line: number;
  readonly text: string;
}

/** One output column a query level sorts by, computed rather than read. */
export interface SortedAlias {
  /** The line of the template literal it is in. */
  readonly line: number;
  /** The expression and its alias, whitespace collapsed: `sensor_id::text AS sensor_id`. */
  readonly column: string;
  /** Where it is named: `DISTINCT ON`, `ORDER BY`, or both. */
  readonly clauses: readonly string[];
}

/** Keywords after which a `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Every template literal in a TypeScript source file, nested ones included, in source order of
 * their ends. Comments, quoted strings and regular expressions are skipped, so a backtick in any
 * of them does not start one.
 */
export function templateLiterals(source: string): TemplateLiteral[] {
  const found: TemplateLiteral[] = [];
  let i = 0;
  const lineStarts = [0];
  for (let k = 0; k < source.length; k++) if (source.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const lineAt = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  /** Skips a quoted string starting at `i`, leaving `i` past its closing quote. */
  const skipQuoted = (quote: string): void => {
    i++;
    while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
    i++;
  };

  /** Reads a template literal starting at its opening backtick, leaving `i` past its close. */
  const template = (): void => {
    const start = i;
    i++;
    let text = '';
    const special = /[`\\$]/g;
    while (i < source.length) {
      special.lastIndex = i;
      const at = special.exec(source)?.index ?? source.length;
      text += source.slice(i, at);
      i = at;
      if (source[i] === '`') break;
      if (source[i] === '\\') {
        text += source.slice(i, i + 2);
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        i += 2;
        code(true);
        text += '$_';
      } else if (i < source.length) {
        text += '$';
        i++;
      }
    }
    i++;
    found.push({ line: lineAt(start), text });
  };

  /** Moves `i` past a run of what `pattern` (sticky) matches. */
  const skip = (pattern: RegExp): void => {
    pattern.lastIndex = i;
    if (pattern.test(source)) i = pattern.lastIndex;
  };
  const SPACE = /\s+/y;
  const WORD = /[A-Za-z_$0-9]+/y;

  /** Reads code up to the end, or past the `}` that closes a `${`. */
  const code = (inSubstitution: boolean): void => {
    let depth = 0;
    // What came last that was not white space: a regular expression can follow punctuation or a
    // keyword, and a division follows a value.
    let previous = '';
    while (i < source.length) {
      const ch = source[i] ?? '';
      const next = source[i + 1] ?? '';
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
        skip(SPACE);
      } else if (ch === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end;
      } else if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end === -1 ? source.length : end + 2;
      } else if (ch === "'" || ch === '"') {
        skipQuoted(ch);
        previous = 'value';
      } else if (ch === '`') {
        template();
        previous = 'value';
      } else if (
        ch === '/' &&
        (previous === '' || previous === 'punct' || previous === 'keyword')
      ) {
        i++;
        let inClass = false;
        while (i < source.length && (inClass || source[i] !== '/') && source[i] !== '\n') {
          if (source[i] === '\\') i++;
          else if (source[i] === '[') inClass = true;
          else if (source[i] === ']') inClass = false;
          i++;
        }
        i++;
        while (/[a-z]/i.test(source[i] ?? '')) i++;
        previous = 'value';
      } else if (/[A-Za-z_$0-9]/.test(ch)) {
        const start = i;
        skip(WORD);
        previous = BEFORE_REGEX.has(source.slice(start, i)) ? 'keyword' : 'value';
      } else {
        if (ch === '{') depth++;
        if (ch === '}') {
          if (depth === 0 && inSubstitution) {
            i++;
            return;
          }
          depth--;
        }
        i++;
        previous = ch === ')' || ch === ']' || ch === '}' ? 'value' : 'punct';
      }
    }
  };

  code(false);
  return found;
}

type Token =
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'other'; readonly value: string };
/** A parenthesised group, or the whole statement: its tokens and groups in order. */
interface Group {
  readonly items: (Token | Group)[];
}

const isGroup = (item: Token | Group | undefined): item is Group =>
  item !== undefined && 'items' in item;
const isWord = (item: Token | Group | undefined, ...words: string[]): boolean =>
  item !== undefined &&
  !isGroup(item) &&
  item.kind === 'word' &&
  (words.length === 0 || words.includes(item.value));
const isPunct = (item: Token | Group | undefined, value: string): boolean =>
  item !== undefined && !isGroup(item) && item.kind === 'other' && item.value === value;

/** SQL text as nested groups of tokens, with comments and string literals dropped. */
function parse(sql: string): Group {
  const root: Group = { items: [] };
  const stack: Group[] = [root];
  let i = 0;
  const top = (): Group => stack[stack.length - 1] ?? root;
  while (i < sql.length) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1] ?? '';
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'") {
      // `''` inside a string is a quote, which this reads as the string ending and another
      // starting: either way, nothing in it is a token.
      i++;
      while (i < sql.length && sql[i] !== "'") i++;
      i++;
      top().items.push({ kind: 'other', value: "'…'" });
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end;
      top().items.push({ kind: 'word', value: sql.slice(i + 1, stop) });
      i = stop + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (/[A-Za-z_0-9$]/.test(sql[i] ?? '')) i++;
      top().items.push({ kind: 'word', value: sql.slice(start, i).toLowerCase() });
    } else if (/[0-9]/.test(ch)) {
      const start = i;
      while (/[0-9.]/.test(sql[i] ?? '')) i++;
      top().items.push({ kind: 'number', value: sql.slice(start, i) });
    } else if (ch === '(') {
      const group: Group = { items: [] };
      top().items.push(group);
      stack.push(group);
      i++;
    } else if (ch === ')') {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (ch === ':' && next === ':') {
      top().items.push({ kind: 'other', value: '::' });
      i += 2;
    } else if (ch === '$') {
      // `$1`, or the `$_` a `${…}` became.
      i++;
      while (/[0-9_]/.test(sql[i] ?? '')) i++;
      top().items.push({ kind: 'other', value: '$' });
    } else {
      top().items.push({ kind: 'other', value: ch });
      i++;
    }
  }
  return root;
}

/** Splits a run of items on its top-level commas. */
function commaSeparated(items: readonly (Token | Group)[]): (Token | Group)[][] {
  const parts: (Token | Group)[][] = [[]];
  for (const item of items) {
    if (!isGroup(item) && item.value === ',') parts.push([]);
    else parts[parts.length - 1]?.push(item);
  }
  return parts.filter((part) => part.length > 0);
}

/** The text of a run of items, for a message: `t.x::text`, `coalesce(t.y, '…')`. */
function render(items: readonly (Token | Group)[]): string {
  const operator = (item: Token | Group | undefined): boolean =>
    item !== undefined && !isGroup(item) && /^[-+*/<>=~!@#%^&|]$/.test(item.value);
  let text = '';
  let previous: Token | Group | undefined;
  for (const item of items) {
    const glued =
      previous === undefined ||
      ['::', '.'].some((value) => isPunct(item, value) || isPunct(previous, value)) ||
      isPunct(item, ',') ||
      (isGroup(item) && isWord(previous)) ||
      (operator(item) && operator(previous));
    text += `${glued ? '' : ' '}${isGroup(item) ? `(${render(item.items)})` : item.value}`;
    previous = item;
  }
  return text;
}

/** Words that end a select list at its own level. */
const SELECT_LIST_END = new Set([
  'from',
  'into',
  'where',
  'group',
  'having',
  'window',
  'order',
  'limit',
  'offset',
  'fetch',
  'for',
  'union',
  'intersect',
  'except',
]);
/** Words that end an `ORDER BY` list at its own level. */
const ORDER_END = new Set(['limit', 'offset', 'fetch', 'for', 'union', 'intersect', 'except']);
/** What may follow a sort key that is still a bare name. */
const SORT_MODIFIERS = new Set(['asc', 'desc', 'nulls', 'first', 'last', 'collate']);

interface OutputColumn {
  /** The alias, or the name PostgreSQL gives a column or a cast of one; empty otherwise. */
  readonly name: string;
  readonly expression: readonly (Token | Group)[];
  /** The expression is a column (`x`, `t.x`), so it sorts as the column does under any name. */
  readonly column: boolean;
  /** The expression reads a column called `name`: `t.x::text AS x`, `lower(x) AS x`. */
  readonly readsItsName: boolean;
  /** The expression is cast to text last: `o.id::text AS object_id`, `CAST(n AS varchar)`. */
  readonly text: boolean;
}

/** The types a cast makes a value sort as text in. */
const TEXT_TYPES = new Set(['text', 'varchar', 'char', 'character', 'bpchar', 'name', 'citext']);

/** Whether the expression's outermost operation is a cast to a text type. */
function castToText(items: readonly (Token | Group)[]): boolean {
  const [first, second] = items;
  if (items.length === 2 && isWord(first, 'cast') && isGroup(second)) {
    const as = second.items.findIndex((item) => isWord(item, 'as'));
    return as !== -1 && isWord(second.items[as + 1], ...TEXT_TYPES);
  }
  const cast = items.findLastIndex((item) => isPunct(item, '::'));
  return cast !== -1 && isWord(items[cast + 1], ...TEXT_TYPES);
}

/** `x`, `t.x`, `s.t.x`: words joined by dots. Its last word, or undefined. */
function columnPath(items: readonly (Token | Group)[]): string | undefined {
  if (items.length % 2 === 0) return undefined;
  for (let k = 0; k < items.length; k++) {
    if (k % 2 === 0 ? !isWord(items[k]) : !isPunct(items[k], '.')) return undefined;
  }
  return (items[items.length - 1] as Token).value;
}

/**
 * Whether `items` read a column called `name` anywhere: as a word that is not a function's name,
 * and not a type after `::` or inside `CAST(… AS type)`.
 */
function reads(items: readonly (Token | Group)[], name: string): boolean {
  return items.some((item, k) => {
    if (isGroup(item)) return reads(item.items, name);
    if (item.kind !== 'word' || item.value !== name) return false;
    if (isGroup(items[k + 1])) return false;
    return !isPunct(items[k - 1], '::') && !isWord(items[k - 1], 'as');
  });
}

/** A select list's item: its expression, and the name its output column has. */
function outputColumn(part: readonly (Token | Group)[]): OutputColumn {
  const as = part.length >= 3 && isWord(part[part.length - 2], 'as');
  const last = part[part.length - 1];
  const expression = as ? part.slice(0, -2) : part;
  const path = columnPath(expression);
  let name = as && isWord(last) ? (last as Token).value : (path ?? '');
  if (name === '') {
    // `t.x::text` with no alias is still called `x`, so `ORDER BY x` finds the text.
    const cast = expression.findIndex((item) => isPunct(item, '::'));
    if (cast > 0) name = columnPath(expression.slice(0, cast)) ?? '';
  }
  return {
    name,
    expression,
    column: path !== undefined,
    readsItsName: name !== '' && reads(expression, name),
    text: castToText(expression),
  };
}

/**
 * The output columns of every select list (and `RETURNING`) at this level, in order. A `UNION`'s
 * branches are all read, so an alias is taken from whichever branch has it.
 */
function outputColumns(items: readonly (Token | Group)[]): OutputColumn[][] {
  const lists: OutputColumn[][] = [];
  for (let k = 0; k < items.length; k++) {
    if (!isWord(items[k], 'select', 'returning')) continue;
    const returning = isWord(items[k], 'returning');
    let start = k + 1;
    if (isWord(items[start], 'all')) start++;
    if (isWord(items[start], 'distinct')) {
      start++;
      if (isWord(items[start], 'on') && isGroup(items[start + 1])) start += 2;
    }
    let end = start;
    while (end < items.length) {
      const item = items[end];
      if (!returning && isWord(item) && SELECT_LIST_END.has((item as Token).value)) break;
      if (isPunct(item, ';')) break;
      end++;
    }
    lists.push(commaSeparated(items.slice(start, end)).map(outputColumn));
    k = end - 1;
  }
  return lists;
}

type SortKey = { readonly name: string } | { readonly ordinal: number };

/**
 * The sort keys at this level that resolve to an output column: a bare name or an ordinal in
 * `ORDER BY`, and in `DISTINCT ON`'s list.
 */
function sortKeys(items: readonly (Token | Group)[]): { clause: string; key: SortKey }[] {
  const keys: { clause: string; key: SortKey }[] = [];
  const read = (clause: string, part: readonly (Token | Group)[]): void => {
    const [first, ...rest] = part;
    const plain = rest.every((item) => isWord(item) && SORT_MODIFIERS.has((item as Token).value));
    if (!plain || first === undefined || isGroup(first)) return;
    if (first.kind === 'word') keys.push({ clause, key: { name: first.value } });
    if (first.kind === 'number') keys.push({ clause, key: { ordinal: Number(first.value) } });
  };
  for (let k = 0; k < items.length; k++) {
    if (isWord(items[k], 'distinct') && isWord(items[k + 1], 'on')) {
      const list = items[k + 2];
      if (isGroup(list)) {
        for (const part of commaSeparated(list.items)) read('DISTINCT ON', part);
      }
    }
    if (isWord(items[k], 'order') && isWord(items[k + 1], 'by')) {
      let end = k + 2;
      while (end < items.length) {
        const item = items[end];
        if (isWord(item) && ORDER_END.has((item as Token).value)) break;
        if (isPunct(item, ';')) break;
        end++;
      }
      for (const part of commaSeparated(items.slice(k + 2, end))) read('ORDER BY', part);
      k = end - 1;
    }
  }
  return keys;
}

/**
 * Every output column, computed from a column of its own name or cast to text, that its own query
 * level sorts by, in one SQL text. A level is the statement and each parenthesised group in it: a
 * CTE, a subquery, and also a function call or a window, which have no select list and so report
 * nothing.
 */
export function sortedAliases(sql: string, line = 0): SortedAlias[] {
  const found: SortedAlias[] = [];
  const visit = (group: Group): void => {
    const lists = outputColumns(group.items);
    const hits = new Map<string, Set<string>>();
    for (const { clause, key } of sortKeys(group.items)) {
      const columns =
        'name' in key
          ? lists.flat().filter((column) => column.name === key.name)
          : lists.map((list) => list[key.ordinal - 1]).filter((column) => column !== undefined);
      for (const column of columns) {
        if (column.column || !(column.readsItsName || column.text)) continue;
        const named = column.name === '' ? '' : ` AS ${column.name}`;
        const text = `${render(column.expression)}${named}`;
        hits.set(text, (hits.get(text) ?? new Set<string>()).add(clause));
      }
    }
    for (const [column, clauses] of hits) {
      found.push({ line, column, clauses: [...clauses].sort() });
    }
    for (const item of group.items) if (isGroup(item)) visit(item);
  };
  visit(parse(sql));
  return found;
}
