import { constants, inflateSync } from 'node:zlib';

/**
 * Reading a PDF back with something that is not the writer (`E-06`).
 *
 * `ADR-006` Decision 1 argued that laying the document out ourselves is *testable* where a
 * Chromium-rendered PDF is not — "a Chromium PDF can only be checked by looking at it". This is
 * that claim's other half: a small reader that takes the bytes and returns, per page, the strings
 * a person would see, so a test can assert that a gap is drawn as `—`, that the column headings
 * repeat on page four, and that a Cyrillic sensor name survived the trip.
 *
 * **It reads the document the way a reader does**, through the `ToUnicode` CMap: the content
 * stream holds glyph ids, and the CMap is what maps them back to characters. So this also proves
 * the thing `ADR-006` Decision 2 exists for — that the text can be selected and copied out
 * correctly — which a test that only checked the drawing calls could not.
 *
 * Deliberately small: no xref parsing, no object graph, no encryption, no inherited resources. It
 * is a test helper for documents this repository produced, not a PDF library.
 */

export interface PdfReadout {
  /** The strings drawn on each page, in drawing order. */
  readonly pages: readonly (readonly string[])[];
  /** Every distinct font resource the document embeds, by its PostScript name. */
  readonly fonts: readonly string[];
  /** `/Count` from the page tree, which is what a viewer shows. */
  readonly pageCount: number;
}

/** Every stream in the file, inflated when it is compressed. */
function streams(raw: string): string[] {
  const found: string[] = [];
  const marker = /stream\r?\n/gu;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    // The `\r\n` before `endstream` is a delimiter rather than data, and zlib refuses trailing
    // bytes it was not expecting; `Z_SYNC_FLUSH` is what makes a stream that ends where the PDF
    // says it ends inflate rather than throw.
    const body = Buffer.from(raw.slice(start, end).replace(/\r?\n$/u, ''), 'latin1');
    let text: string;
    try {
      text = inflateSync(body, { finishFlush: constants.Z_SYNC_FLUSH }).toString('latin1');
    } catch {
      text = body.toString('latin1');
    }
    found.push(text);
    // Past the whole keyword: `endstream` ends in `stream`, so resuming at `end` finds that same
    // word again and walks the file twice over, one window out of step.
    marker.lastIndex = end + 'endstream'.length;
  }
  return found;
}

/** Glyph id to character, read out of every `ToUnicode` CMap in the document. */
function unicodeMap(all: readonly string[]): Map<number, string> {
  const map = new Map<number, string>();
  /**
   * One destination, which is one *or more* characters.
   *
   * **A ligature is one glyph and several characters**: DejaVu's `ffi` is a single glyph whose
   * `ToUnicode` destination is `<0066 0066 0069>`, and the font's own substitution table means
   * "Traffic" is drawn with it. A reader that only accepted a four-digit destination skipped that
   * entry and shifted every mapping after it by one, which decodes as almost-words — the first
   * version of this file read the report's own column heading as "Trakc in".
   */
  const hex = (value: string): string =>
    String.fromCodePoint(
      ...(value.replaceAll(/\s+/gu, '').match(/.{4}/gu) ?? []).map((part) =>
        Number.parseInt(part, 16),
      ),
    );
  for (const stream of all) {
    if (!stream.includes('begincmap')) continue;
    for (const block of stream.match(/beginbfchar[\s\S]*?endbfchar/gu) ?? []) {
      for (const pair of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/gu)) {
        map.set(Number.parseInt(pair[1] ?? '0', 16), hex(pair[2] ?? ''));
      }
    }
    for (const block of stream.match(/beginbfrange[\s\S]*?endbfrange/gu) ?? []) {
      // **Both forms, in one pass.** A bfrange entry is either `<lo> <hi> <dst>` — a run of
      // consecutive characters — or `<lo> <hi> [<d> <d> …>]`, one destination per glyph. Reading
      // only the second and letting the regex skip the first is how a map comes out one entry
      // shifted, which decodes as almost-right words: `Traffic` as `Trakc`.
      const entries = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:\[([^\]]*)\]|<([0-9a-fA-F]+)>)/gu;
      for (const range of block.matchAll(entries)) {
        const from = Number.parseInt(range[1] ?? '0', 16);
        const to = Number.parseInt(range[2] ?? '0', 16);
        if (range[3] !== undefined) {
          const values = [...range[3].matchAll(/<([0-9a-fA-F\s]*)>/gu)];
          for (const [offset, value] of values.entries())
            map.set(from + offset, hex(value[1] ?? ''));
          continue;
        }
        const start = Number.parseInt(range[4] ?? '0', 16);
        for (let glyph = from; glyph <= to; glyph += 1) {
          map.set(glyph, String.fromCodePoint(start + (glyph - from)));
        }
      }
    }
  }
  return map;
}

/** One page's drawn strings, decoded through the CMap. */
function textOf(content: string, map: Map<number, string>): string[] {
  const drawn: string[] = [];
  for (const run of content.matchAll(/\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/gu)) {
    const body = run[1] ?? `<${run[2] ?? ''}>`;
    let text = '';
    for (const piece of body.matchAll(/<([0-9a-fA-F]*)>/gu)) {
      for (const glyph of (piece[1] ?? '').match(/.{4}/gu) ?? []) {
        text += map.get(Number.parseInt(glyph, 16)) ?? '�';
      }
    }
    if (text !== '') drawn.push(text);
  }
  return drawn;
}

export function readPdf(bytes: Buffer): PdfReadout {
  const raw = bytes.toString('latin1');
  if (!raw.startsWith('%PDF-')) throw new Error('not a PDF');
  const all = streams(raw);
  const map = unicodeMap(all);
  const pages = all.filter((stream) => stream.includes('BT')).map((stream) => textOf(stream, map));
  const fonts = [...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_]+)/gu)].map(
    (match) => match[1] ?? '',
  );
  const count = /\/Count\s+(\d+)/u.exec(raw);
  return { pages, fonts: [...new Set(fonts)], pageCount: Number(count?.[1] ?? '0') };
}
