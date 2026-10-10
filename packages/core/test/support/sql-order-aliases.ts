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
 * **What is reported**, in one template literal:
 * - An output column that its own query level names bare, or by ordinal, in `ORDER BY` or
 *   `DISTINCT ON`, and that is either computed from a column of its own name (`t.x::text AS x`,
 *   `lower(name) AS name`, and `t.x::text` with no alias, which PostgreSQL also calls `x`), or
 *   made text under any name (`o.id::text AS object_id`).
 * - **A text column a CTE or a subquery in `FROM` makes, sorted by the level that reads it**
 *   (`P-392`): `WITH page AS (SELECT id::text AS id …) SELECT id FROM page ORDER BY id`. There
 *   the outer level reads it as an input column, so qualifying the name (`page.id`) does not help:
 *   the column is text. The fix is to sort inside, or to carry the number out as well. A CTE is
 *   followed into every level below the one that names it; a subquery only into its own.
 *
 * *Made text* is a cast to a text type as the expression's last operation (`::text`,
 * `CAST(… AS varchar)`; not `ARRAY[x::text]`), or `to_char` as its outermost call, which turns a
 * number or a time into text (`P-392`). An alias may be written without `AS` (`id::text id`).
 *
 * A column under another name (`o.id AS object_id`) sorts as the column does, and one computed
 * from something else and not made text (`count(*)::int AS count`, `0 AS depth`) was named to be
 * sorted by, so neither is reported.
 *
 * **What is not seen**, and why it is left:
 * - A column whose type the text does not say: a table's own text column, a view's, a function's
 *   result, a CTE whose columns are renamed by a list (`x(id) AS (…)`). This reads SQL text and
 *   knows no catalogue; a table's text column sorted as text is also what it means.
 * - A query whose select list and `ORDER BY` are in different literals, or are built with `${…}`.
 * - Text joined by `concat`, `concat_ws`, `format` or `||` under another name (`P-392`). Their
 *   operands are nearly always text already — a label, a key built from names — and with no types
 *   to read, reporting them reported every such key in the tests and none that sorted a number.
 *   Under its own name (`'p-' || id AS id`) it is still reported, as computed from that column.
 * - A level that sorts a CTE's text column without naming the CTE in its own text (through a view,
 *   or a CTE named in a `${…}`).
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

/**
 * Whether the expression's outermost operation is a cast to a text type: the type is its last
 * word, or has only a length after it (`varchar(20)`). `ARRAY[x::text]` and `x::text[]` are arrays,
 * and `a || b::text` casts `b` alone, since `::` binds tighter than any operator before it.
 */
function castToText(items: readonly (Token | Group)[]): boolean {
  const [first, second] = items;
  if (items.length === 2 && isWord(first, 'cast') && isGroup(second)) {
    const as = second.items.findIndex((item) => isWord(item, 'as'));
    return as !== -1 && isWord(second.items[as + 1], ...TEXT_TYPES);
  }
  const cast = items.findLastIndex((item) => isPunct(item, '::'));
  if (cast === -1 || !isWord(items[cast + 1], ...TEXT_TYPES)) return false;
  const after = items.slice(cast + 2);
  if (!(after.length === 0 || (after.length === 1 && isGroup(after[0])))) return false;
  // One operand before it — a column, a call, a group, a literal, earlier casts — and no operator.
  return items
    .slice(0, cast)
    .every(
      (item) =>
        isGroup(item) || item.kind !== 'other' || ['.', '::', "'…'", '$'].includes(item.value),
    );
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

/**
 * Words that can end an expression, so a word after one is not an alias written without `AS`
 * (`CASE … END`, `IS NULL`), and words that end a multi-word type (`double precision`).
 */
const NOT_AN_ALIAS = new Set([
  'end',
  'null',
  'true',
  'false',
  'precision',
  'varying',
  'zone',
  'unknown',
  'distinct',
  'all',
]);
/** Words after which the next word is part of the expression, not an alias. */
const BEFORE_AN_OPERAND = new Set([
  'is',
  'not',
  'and',
  'or',
  'as',
  'in',
  'like',
  'ilike',
  'between',
  'when',
  'then',
  'else',
  'case',
  'from',
  'similar',
  'to',
  'interval',
  'array',
  'with',
  'time',
  'at',
  'collate',
]);

/** Whether `part` ends in an alias written without `AS`: `id::text id`, `count(*) n`. */
function bareAlias(part: readonly (Token | Group)[]): boolean {
  if (part.length < 2) return false;
  const last = part[part.length - 1];
  const before = part[part.length - 2];
  if (!isWord(last) || NOT_AN_ALIAS.has((last as Token).value)) return false;
  if (isPunct(before, '.') || isPunct(before, '::')) return false;
  if (isWord(before) && BEFORE_AN_OPERAND.has((before as Token).value)) return false;
  // After a value: a word, a call or a group, a number, a string or a parameter. After an operator
  // (`a * b`), the word is the operand.
  return (
    isWord(before) ||
    isGroup(before) ||
    (!isGroup(before) && before?.kind === 'number') ||
    isPunct(before, "'…'") ||
    isPunct(before, '$')
  );
}

/** Whether the expression is `to_char(…)`: a number or a time made text (`P-392`). */
function madeText(items: readonly (Token | Group)[]): boolean {
  const [first, second] = items;
  return items.length === 2 && isWord(first, 'to_char') && isGroup(second);
}

/** A select list's item: its expression, and the name its output column has. */
function outputColumn(part: readonly (Token | Group)[]): OutputColumn {
  const as = part.length >= 3 && isWord(part[part.length - 2], 'as');
  const bare = !as && bareAlias(part);
  const last = part[part.length - 1];
  const expression = as ? part.slice(0, -2) : bare ? part.slice(0, -1) : part;
  const path = columnPath(expression);
  let name = (as || bare) && isWord(last) ? (last as Token).value : (path ?? '');
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
    text: castToText(expression) || madeText(expression),
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

type SortKey =
  { readonly name: string; readonly qualifier?: string } | { readonly ordinal: number };

/**
 * The sort keys at this level that resolve to an output column: a bare name or an ordinal in
 * `ORDER BY`, and in `DISTINCT ON`'s list.
 */
function sortKeys(items: readonly (Token | Group)[]): { clause: string; key: SortKey }[] {
  const keys: { clause: string; key: SortKey }[] = [];
  const read = (clause: string, part: readonly (Token | Group)[]): void => {
    // `q.x`, kept for a CTE's or a subquery's column (`P-392`): it resolves the input column,
    // which is no help when that column is itself text.
    const qualified = isWord(part[0]) && isPunct(part[1], '.') && isWord(part[2]);
    const [first, ...rest] = qualified ? part.slice(2) : part;
    const plain = rest.every((item) => isWord(item) && SORT_MODIFIERS.has((item as Token).value));
    if (!plain || first === undefined || isGroup(first)) return;
    if (qualified) {
      const qualifier = (part[0] as Token).value;
      keys.push({ clause, key: { name: first.value, qualifier } });
      return;
    }
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

/** A CTE, or a subquery in `FROM`, as the level that reads it sees it. */
interface Input {
  /** What this level calls it: the CTE's name or an alias, or the subquery's ('' for none). */
  readonly name: string;
  /** What a finding calls it: the CTE's own name, or the subquery's alias. */
  readonly label: string;
  readonly columns: readonly OutputColumn[];
}

/** Words that follow a subquery in `FROM` and are not its alias. */
const NOT_A_FROM_ALIAS = new Set([
  ...SELECT_LIST_END,
  'on',
  'using',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'full',
  'cross',
  'natural',
  'lateral',
  'with',
]);

/** The CTEs this level defines, and the subqueries in its `FROM`, each with its columns. */
function inputsOf(items: readonly (Token | Group)[]): { ctes: Input[]; subqueries: Input[] } {
  const ctes: Input[] = [];
  const subqueries: Input[] = [];
  const columnsOf = (group: Group): OutputColumn[] => outputColumns(group.items).flat();
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    // `name AS (…)`, `name AS MATERIALIZED (…)`, `name AS NOT MATERIALIZED (…)`.
    if (isWord(item) && isWord(items[k + 1], 'as')) {
      let at = k + 2;
      if (isWord(items[at], 'not')) at++;
      if (isWord(items[at], 'materialized')) at++;
      const body = items[at];
      if (isGroup(body) && outputColumns(body.items).length > 0) {
        const name = (item as Token).value;
        ctes.push({ name, label: name, columns: columnsOf(body) });
      }
    }
    // `FROM (…) alias`, `JOIN (…) AS alias`, `, LATERAL (…) alias`.
    if (
      isGroup(item) &&
      outputColumns(item.items).length > 0 &&
      (isWord(items[k - 1], 'from', 'join', 'lateral') || isPunct(items[k - 1], ','))
    ) {
      const alias = isWord(items[k + 1], 'as') ? items[k + 2] : items[k + 1];
      const named = isWord(alias) && !NOT_A_FROM_ALIAS.has((alias as Token).value);
      const name = named ? (alias as Token).value : '';
      subqueries.push({ name, label: name === '' ? 'a subquery' : name, columns: columnsOf(item) });
    }
  }
  return { ctes, subqueries };
}

/**
 * The CTE as this level reads it, under its own name and each alias it is given here (`FROM page
 * p`, `JOIN page AS q`), or nothing when this level does not name it. Where it is defined
 * (`name AS (…)`, `name AS [NOT] MATERIALIZED (…)`) is not a read.
 */
function readHere(items: readonly (Token | Group)[], cte: Input): Input[] {
  const defines = (k: number): boolean =>
    isWord(items[k + 1], 'as') &&
    (isGroup(items[k + 2]) || isWord(items[k + 2], 'not', 'materialized'));
  const seen: Input[] = [];
  items.forEach((item, k) => {
    if (!isWord(item, cte.name) || defines(k)) return;
    seen.push(cte);
    const alias = isWord(items[k + 1], 'as') ? items[k + 2] : items[k + 1];
    if (isWord(alias) && !NOT_A_FROM_ALIAS.has((alias as Token).value)) {
      seen.push({ ...cte, name: (alias as Token).value });
    }
  });
  return seen;
}

/** `x` or `q.x`: the name a plain column reads, and what qualifies it. */
function pathOf(items: readonly (Token | Group)[]): { name: string; qualifier?: string } | null {
  if (items.length === 1 && isWord(items[0])) return { name: (items[0] as Token).value };
  if (items.length === 3 && isWord(items[0]) && isPunct(items[1], '.') && isWord(items[2])) {
    return { name: (items[2] as Token).value, qualifier: (items[0] as Token).value };
  }
  return null;
}

/**
 * Every output column, computed from a column of its own name or cast to text, that its own query
 * level sorts by, in one SQL text. A level is the statement and each parenthesised group in it: a
 * CTE, a subquery, and also a function call or a window, which have no select list and so report
 * nothing.
 */
export function sortedAliases(sql: string, line = 0): SortedAlias[] {
  const found: SortedAlias[] = [];
  const visit = (group: Group, inherited: readonly Input[]): void => {
    const lists = outputColumns(group.items);
    const { ctes, subqueries } = inputsOf(group.items);
    // What this level reads: the CTEs in scope that it names, and its own `FROM` subqueries.
    const visible = [...inherited, ...ctes];
    const read = [...visible.flatMap((cte) => readHere(group.items, cte)), ...subqueries];
    const hits = new Map<string, Set<string>>();
    const hit = (text: string, clause: string): void => {
      hits.set(text, (hits.get(text) ?? new Set<string>()).add(clause));
    };
    /** A text column of what this level reads, called `name` and from `qualifier` if given. */
    const fromInputs = (name: string, qualifier: string | undefined, clause: string): void => {
      for (const input of read) {
        if (qualifier !== undefined && input.name !== qualifier) continue;
        for (const column of input.columns) {
          if (column.name !== name || !column.text) continue;
          hit(`${render(column.expression)} AS ${column.name} (from ${input.label})`, clause);
        }
      }
    };
    for (const { clause, key } of sortKeys(group.items)) {
      if ('name' in key && key.qualifier !== undefined) {
        fromInputs(key.name, key.qualifier, clause);
        continue;
      }
      const columns =
        'name' in key
          ? lists.flat().filter((column) => column.name === key.name)
          : lists.map((list) => list[key.ordinal - 1]).filter((column) => column !== undefined);
      for (const column of columns) {
        if (column.column) {
          // The level's own column is a plain one: it sorts as what it reads does.
          const path = pathOf(column.expression);
          if (path !== null) fromInputs(path.name, path.qualifier, clause);
          continue;
        }
        if (!(column.readsItsName || column.text)) continue;
        const named = column.name === '' ? '' : ` AS ${column.name}`;
        hit(`${render(column.expression)}${named}`, clause);
      }
      // A name no output column has resolves to an input column (`*`, or not selected at all).
      if ('name' in key && columns.length === 0) fromInputs(key.name, undefined, clause);
    }
    for (const [column, clauses] of hits) {
      found.push({ line, column, clauses: [...clauses].sort() });
    }
    for (const item of group.items) if (isGroup(item)) visit(item, visible);
  };
  visit(parse(sql), []);
  return found;
}
