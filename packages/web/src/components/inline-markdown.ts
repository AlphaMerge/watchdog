/**
 * The inline Markdown a schema's description is written in (`U-89`).
 *
 * **The catalogue writes its descriptions in Markdown.** `docs/sensor-reference.md` is generated
 * from them and renders `` `SELECT` `` as code and `*sets*` as emphasis; the form printed both as
 * typed, backticks and asterisks and all, which is how the Credentials tab was found when it was
 * walked in a browser (`U-23`). So the UI reads the same three things the generated page shows —
 * code spans, emphasis and strong emphasis — and nothing else: a description is a sentence or two
 * beside a field, and a link, a list or a heading in one would be a description that wants to be
 * documentation.
 *
 * **CommonMark's rules for what opens and closes, so a star that is not emphasis stays a star.**
 * `*.domain patterns` and `$.nodes[*].load` are in descriptions as written, and they are literal on
 * the generated page because a delimiter has to be flanking the right way to open or close
 * (spec 6.2); the same rules here keep them literal here. What is left out is what no description
 * needs: `***` runs, the rule of three, nesting the same delimiter in itself.
 *
 * Text only, never HTML: the result is drawn as React elements, so nothing a description says is
 * ever parsed as markup.
 */

export type InlineNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'em' | 'strong'; readonly children: readonly InlineNode[] };

type Token =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | {
      readonly kind: 'delimiter';
      readonly char: '*' | '_';
      readonly length: number;
      readonly opens: boolean;
      readonly closes: boolean;
    };

const WHITESPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
/** What a backslash makes literal (spec 2.4): ASCII punctuation, and nothing else. */
const ESCAPABLE = /[!-/:-@[-`{-~]/u;

/** `text` as the nodes it draws. */
export function parseInline(text: string): readonly InlineNode[] {
  const tokens = tokenise(text);
  return build(tokens, 0, tokens.length);
}

function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain !== '') tokens.push({ kind: 'text', text: plain });
    plain = '';
  };

  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const next = text.charAt(at + 1);

    if (char === '\\' && ESCAPABLE.test(next)) {
      plain += next;
      at += 2;
      continue;
    }

    if (char === '`') {
      const length = runAt(text, at, '`');
      const closing = closingRun(text, at + length, length);
      if (closing === -1) {
        // No run of the same length closes it: the backticks are what they look like.
        plain += '`'.repeat(length);
      } else {
        flush();
        tokens.push({ kind: 'code', text: codeText(text.slice(at + length, closing)) });
        at = closing + length;
        continue;
      }
      at += length;
      continue;
    }

    if (char === '*' || char === '_') {
      const length = runAt(text, at, char);
      const before = at === 0 ? ' ' : text.charAt(at - 1);
      const after = at + length >= text.length ? ' ' : text.charAt(at + length);
      const left = flanksLeft(before, after);
      const right = flanksLeft(after, before);
      // `_` does not open or close inside a word, so `MS_VAR_NAME` is a name (spec 6.2, 2–4, 6–8).
      const opens = char === '*' ? left : left && (!right || PUNCTUATION.test(before));
      const closes = char === '*' ? right : right && (!left || PUNCTUATION.test(after));
      flush();
      // A run of three or more is left as it is: nothing here writes `***`.
      const usable = length <= 2;
      tokens.push({
        kind: 'delimiter',
        char,
        length,
        opens: usable && opens,
        closes: usable && closes,
      });
      at += length;
      continue;
    }

    plain += char;
    at += 1;
  }
  flush();
  return tokens;
}

/**
 * Whether a delimiter run with `before` and `after` round it is left-flanking (spec 6.2): not
 * followed by whitespace, and either not followed by punctuation or preceded by whitespace or
 * punctuation. Asked the other way round, it says whether the run is right-flanking.
 */
function flanksLeft(before: string, after: string): boolean {
  if (WHITESPACE.test(after)) return false;
  return !PUNCTUATION.test(after) || WHITESPACE.test(before) || PUNCTUATION.test(before);
}

/** How many of `char` there are from `at` on. */
function runAt(text: string, at: number, char: string): number {
  let end = at;
  while (text.charAt(end) === char) end += 1;
  return end - at;
}

/** Where the next run of exactly `length` backticks from `from` starts, or -1. */
function closingRun(text: string, from: number, length: number): number {
  let at = text.indexOf('`', from);
  while (at !== -1) {
    const run = runAt(text, at, '`');
    if (run === length) return at;
    at = text.indexOf('`', at + run);
  }
  return -1;
}

/** A code span's text: line breaks as spaces, and one space off each end when both have one. */
function codeText(raw: string): string {
  const text = raw.replace(/\r\n|\r|\n/gu, ' ');
  return text.startsWith(' ') && text.endsWith(' ') && text.trim() !== ''
    ? text.slice(1, -1)
    : text;
}

function build(tokens: readonly Token[], from: number, to: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  const text = (value: string): void => {
    const last = nodes.at(-1);
    if (last?.kind === 'text') nodes[nodes.length - 1] = { kind: 'text', text: last.text + value };
    else nodes.push({ kind: 'text', text: value });
  };

  let at = from;
  while (at < to) {
    const token = tokens[at];
    if (token === undefined) break;
    if (token.kind === 'delimiter') {
      const closer = token.opens ? closerFor(tokens, at, to) : -1;
      if (closer === -1) {
        text(token.char.repeat(token.length));
      } else {
        nodes.push({
          kind: token.length === 2 ? 'strong' : 'em',
          children: build(tokens, at + 1, closer),
        });
        at = closer;
      }
    } else if (token.kind === 'code') {
      nodes.push(token);
    } else {
      text(token.text);
    }
    at += 1;
  }
  return nodes;
}

/**
 * The delimiter that closes the one at `at`: the next of the same character and length that can
 * close, past any opened and not yet closed in between. -1 when none does.
 */
function closerFor(tokens: readonly Token[], at: number, to: number): number {
  const opener = tokens[at];
  if (opener?.kind !== 'delimiter') return -1;
  let depth = 0;
  for (let index = at + 1; index < to; index += 1) {
    const token = tokens[index];
    if (
      token?.kind !== 'delimiter' ||
      token.char !== opener.char ||
      token.length !== opener.length
    ) {
      continue;
    }
    if (token.closes) {
      if (depth === 0) return index;
      depth -= 1;
    } else if (token.opens) {
      depth += 1;
    }
  }
  return -1;
}
