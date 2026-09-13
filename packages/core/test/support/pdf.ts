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

export interface PlacedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly font: string;
}

export interface PdfReadout {
  /** The strings drawn on each page, in drawing order. */
  readonly pages: readonly (readonly string[])[];
  /**
   * The same strings with where they were set and in which font (`E-12`): `y` is the baseline, in
   * PDF units from the bottom of the page, and `font` the embedded font's name without its subset
   * tag. A line drawn in two fonts is two of these, and whether they share a `y` is whether they
   * share a baseline.
   */
  readonly placed: readonly (readonly PlacedText[])[];
  /** Every distinct font resource the document embeds, by its PostScript name. */
  readonly fonts: readonly string[];
  /** `/Count` from the page tree, which is what a viewer shows. */
  readonly pageCount: number;
}

/** One `N 0 obj … endobj`: its dictionary, and its stream inflated when it has one. */
interface PdfObject {
  readonly dict: string;
  readonly stream: string | null;
}

/** Every object in the file, by number. */
function objects(raw: string): Map<number, PdfObject> {
  const found = new Map<number, PdfObject>();
  const marker = /(\d+) 0 obj\b/gu;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const endobj = raw.indexOf('endobj', start);
    if (endobj < 0) break;
    const keyword = /stream\r?\n/gu;
    keyword.lastIndex = start;
    const streamAt = keyword.exec(raw);
    if (streamAt === null || streamAt.index > endobj) {
      found.set(Number(match[1]), { dict: raw.slice(start, endobj), stream: null });
      marker.lastIndex = endobj + 'endobj'.length;
      continue;
    }
    const bodyStart = streamAt.index + streamAt[0].length;
    const end = raw.indexOf('endstream', bodyStart);
    if (end < 0) break;
    // The `\r\n` before `endstream` is a delimiter rather than data, and zlib refuses trailing
    // bytes it was not expecting; `Z_SYNC_FLUSH` is what makes a stream that ends where the PDF
    // says it ends inflate rather than throw.
    const body = Buffer.from(raw.slice(bodyStart, end).replace(/\r?\n$/u, ''), 'latin1');
    let text: string;
    try {
      text = inflateSync(body, { finishFlush: constants.Z_SYNC_FLUSH }).toString('latin1');
    } catch {
      text = body.toString('latin1');
    }
    found.set(Number(match[1]), { dict: raw.slice(start, streamAt.index), stream: text });
    // Past the whole keyword and the object: `endstream` ends in `stream`, and a compressed body
    // can contain any bytes at all — resuming anywhere inside it walks the file out of step.
    const close = raw.indexOf('endobj', end);
    marker.lastIndex = (close < 0 ? end : close) + 'endobj'.length;
  }
  return found;
}

/** Glyph id to character, read out of one `ToUnicode` CMap. */
function unicodeMap(stream: string): Map<number, string> {
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
  {
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

/**
 * One page's drawn strings, each decoded through the map of the font it was set in.
 *
 * **Per font, not one map for the document** (`E-12`). Each embedded subset numbers its glyphs
 * from one, so a document drawn in DejaVu and WenQuanYi has two glyph 3s; a single merged map read
 * the report's own title as `東京nthly`. The `Tf` operator says which font the strings after it are
 * in, and the page's resources say which font object that name is.
 */
interface PageFont {
  readonly name: string;
  readonly map: Map<number, string>;
}

function textOf(content: string, fonts: ReadonlyMap<string, PageFont>): PlacedText[] {
  const drawn: PlacedText[] = [];
  let font: PageFont = { name: '', map: new Map() };
  let x = 0;
  let y = 0;
  const operators =
    /([-\d.]+)\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)\s+Tm|\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/gu;
  for (const operator of content.matchAll(operators)) {
    if (operator[2] !== undefined) {
      x = Number(operator[2]);
      y = Number(operator[3]);
      continue;
    }
    if (operator[4] !== undefined) {
      font = fonts.get(operator[4]) ?? { name: '', map: new Map() };
      continue;
    }
    const map = font.map;
    const body = operator[5] ?? `<${operator[6] ?? ''}>`;
    let text = '';
    for (const piece of body.matchAll(/<([0-9a-fA-F]*)>/gu)) {
      for (const glyph of (piece[1] ?? '').match(/.{4}/gu) ?? []) {
        text += map.get(Number.parseInt(glyph, 16)) ?? '\uFFFD';
      }
    }
    if (text !== '') drawn.push({ text, x, y, font: font.name });
  }
  return drawn;
}

const ref = (dict: string, key: string): number | null => {
  const match = new RegExp(`/${key}\\s+(\\d+) 0 R`, 'u').exec(dict);
  return match === null ? null : Number(match[1]);
};

export function readPdf(bytes: Buffer): PdfReadout {
  const raw = bytes.toString('latin1');
  if (!raw.startsWith('%PDF-')) throw new Error('not a PDF');
  const all = objects(raw);
  const fontFor = (fontObject: number): PageFont => {
    const dict = all.get(fontObject)?.dict ?? '';
    const toUnicode = ref(dict, 'ToUnicode');
    return {
      name: /\/BaseFont\s*\/(?:[A-Z]{6}\+)?([A-Za-z0-9\-_]+)/u.exec(dict)?.[1] ?? '',
      map: unicodeMap(toUnicode === null ? '' : (all.get(toUnicode)?.stream ?? '')),
    };
  };
  const root = [...all.values()].find((object) => /\/Type\s*\/Pages\b/u.test(object.dict));
  const kids = [
    ...(/\/Kids\s*\[([^\]]*)\]/u.exec(root?.dict ?? '')?.[1] ?? '').matchAll(/(\d+) 0 R/gu),
  ].map((kid) => Number(kid[1]));
  const placed = kids.map((id) => {
    const page = all.get(id)?.dict ?? '';
    const resourcesRef = ref(page, 'Resources');
    const resources = resourcesRef === null ? page : (all.get(resourcesRef)?.dict ?? '');
    const fonts = new Map<string, PageFont>();
    const fontBlock = /\/Font\s*<<([^>]*)>>/u.exec(resources)?.[1] ?? '';
    for (const entry of fontBlock.matchAll(/\/([A-Za-z0-9]+)\s+(\d+) 0 R/gu)) {
      fonts.set(entry[1] ?? '', fontFor(Number(entry[2])));
    }
    const contents = ref(page, 'Contents');
    return textOf(contents === null ? '' : (all.get(contents)?.stream ?? ''), fonts);
  });
  const fonts = [...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_]+)/gu)].map(
    (match) => match[1] ?? '',
  );
  const count = /\/Count\s+(\d+)/u.exec(raw);
  return {
    pages: placed.map((page) => page.map((one) => one.text)),
    placed,
    fonts: [...new Set(fonts)],
    pageCount: Number(count?.[1] ?? '0'),
  };
}
