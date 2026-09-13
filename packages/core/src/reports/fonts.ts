import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { create, type Font, type FontCollection } from 'fontkit';

/**
 * The fonts a PDF report draws with, in order (`E-12`, `ADR-006` Decision 2).
 *
 * **A chain, and every character is drawn by the first font in it that has a glyph.** DejaVu Sans
 * comes first and draws everything it can — Latin, Greek, Cyrillic, the digits of every value —
 * exactly as it did before this file existed. Whatever an operator configured comes next
 * (`reports.pdfFonts`), and WenQuanYi Micro Hei comes last, so that a sensor called `東京ルーター`
 * or `서울 코어` is drawn as itself in a report nobody configured anything for. A character no
 * font in the chain has is still written as `U+20B9F`, by `drawable`, as `E-06` did it.
 *
 * **Why an operator's font goes before the bundled one rather than replacing it.** Han unification:
 * one code point is drawn one way in Japan and another in China, and WenQuanYi's shapes are the
 * Chinese ones — Noto Sans CJK's Japanese and Simplified Chinese faces differ on 8,638 of the
 * 20,992 basic ideographs (`docs/findings/2026-09-13-report-cjk-fonts.md`). An installation whose
 * readers are in Tokyo configures the Japanese face and gets Japanese shapes; anything that face
 * lacks still falls through to a font that has it, instead of to a box.
 *
 * **Opened only when a character needs it.** DejaVu is opened for every PDF. The next font is
 * opened the first time a character DejaVu lacks turns up, and not before: WenQuanYi costs a
 * worker 22 MiB and Noto Sans CJK 80 MiB once opened, which an installation whose sensors are all
 * called `core-sw-01` should never pay.
 */

/** A font file, and the face in it when the file is a collection. */
export interface ReportFontSource {
  readonly path: string;
  /** The PostScript name inside a collection; empty for a file with one face. */
  readonly face: string;
}

/** One opened font, as the drawing code needs it. */
export interface ChainFont {
  /** The name it is registered under with `pdfkit`. */
  readonly key: string;
  readonly source: ReportFontSource;
  readonly bytes: Buffer;
  readonly font: Font;
  /**
   * The ascent in `pdfkit`'s thousand-unit scale. `pdfkit` places text by the top of the font it
   * is set in, and two fonts have two tops — so a line drawn in two fonts needs this to put both
   * halves on one baseline.
   */
  readonly ascender: number;
}

/** A stretch of text drawn in one font: an index into the chain. */
export interface TextRun {
  readonly font: number;
  readonly text: string;
}

const asset = (name: string): string =>
  fileURLToPath(new URL(`../../../assets/fonts/${name}`, import.meta.url));

/** DejaVu Sans, which draws everything it can (`E-06`). */
export const PRIMARY_FONT: ReportFontSource = { path: asset('DejaVuSans.ttf'), face: '' };

/** WenQuanYi Micro Hei, which draws what nothing before it could (`E-12`). */
export const BUNDLED_FALLBACK_FONT: ReportFontSource = {
  path: asset('wqy-microhei.ttc'),
  face: 'WenQuanYiMicroHei',
};

/**
 * `fontkit`'s `create`, with the answer its type leaves out: `null` is what it returns for a face
 * name the collection does not contain.
 */
const createFont = (bytes: Buffer, face: string): Font | FontCollection | null =>
  create(bytes, face === '' ? undefined : face);

/**
 * Opens one font, or says precisely why it cannot be.
 *
 * `fontkit` is what `pdfkit` embeds and subsets with, so asking it what a font has is asking the
 * code that will decide what gets drawn.
 */
export function openFont(source: ReportFontSource, key: string): ChainFont {
  let bytes: Buffer;
  try {
    bytes = readFileSync(source.path);
  } catch (cause) {
    throw new Error(`the font file ${source.path} cannot be read`, { cause });
  }
  let opened: Font | FontCollection | null;
  try {
    opened = createFont(bytes, source.face);
  } catch (cause) {
    throw new Error(`${source.path} is not a font this system can read`, { cause });
  }
  if (opened === null || !('hasGlyphForCodePoint' in opened)) {
    // A collection opened without a face, or with a face it does not contain — and the useful
    // thing to say is which faces there are.
    const whole = create(bytes);
    const faces = 'fonts' in whole ? whole.fonts.map((font) => font.postscriptName).join(', ') : '';
    throw new Error(
      source.face === ''
        ? `${source.path} is a font collection; choose a face: ${faces}`
        : `${source.path} has no face called ${source.face}; it has ${faces}`,
    );
  }
  return {
    key,
    source,
    bytes,
    font: opened,
    ascender: (opened.ascent * 1_000) / opened.unitsPerEm,
  };
}

const NOT_FOUND = -1;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;

/** Tab, line feed and carriage return are handled by the layout, not by any font. */
const isLayoutCharacter = (code: number): boolean =>
  code === 0x09 || code === 0x0a || code === 0x0d;

export class FontChain {
  readonly #sources: readonly ReportFontSource[];
  /** `undefined` not yet opened; `null` could not be opened, and will not be tried again. */
  readonly #fonts: (ChainFont | null | undefined)[];
  readonly #onUnavailable: (source: ReportFontSource, error: Error) => void;
  /** Which font draws a code point, once asked. A report asks about the same few hundred. */
  readonly #lookup = new Map<number, number>();
  /** Whether the first font draws every printable ASCII character; decided once, when asked. */
  #asciiInPrimary: boolean | undefined;

  constructor(
    sources: readonly ReportFontSource[],
    onUnavailable: (source: ReportFontSource, error: Error) => void = () => undefined,
  ) {
    if (sources.length === 0) throw new Error('a font chain needs at least one font');
    this.#sources = sources;
    this.#fonts = sources.map(() => undefined);
    this.#onUnavailable = onUnavailable;
  }

  /**
   * The first font, which must open.
   *
   * A missing primary font is a broken installation rather than a bad request, so it throws with
   * the path it looked in: the release tarball ships `packages/core/assets` beside `dist`
   * (`scripts/package.sh`), and an installation without it can render everything except a PDF.
   */
  get primary(): ChainFont {
    const font = this.#open(0);
    if (font === null) {
      const path = this.#sources[0]?.path ?? '';
      throw new Error(
        `the report font is missing at ${path}; a release ships it beside dist, and without it ` +
          'this installation can render HTML, CSV and XML but not PDF',
      );
    }
    return font;
  }

  /** The font at a place in the chain, opening it if this is the first time it is needed. */
  font(index: number): ChainFont | null {
    return this.#open(index);
  }

  /** Every font this chain has opened so far. */
  opened(): ChainFont[] {
    return this.#fonts.filter((font): font is ChainFont => font !== undefined && font !== null);
  }

  /** The first font that can draw a code point, or `-1` when none can. */
  indexFor(code: number): number {
    if (isLayoutCharacter(code)) return 0;
    const known = this.#lookup.get(code);
    if (known !== undefined) return known;
    let found = NOT_FOUND;
    for (let index = 0; index < this.#sources.length; index += 1) {
      if (this.#open(index)?.font.hasGlyphForCodePoint(code) === true) {
        found = index;
        break;
      }
    }
    this.#lookup.set(code, found);
    return found;
  }

  has(code: number): boolean {
    return this.indexFor(code) !== NOT_FOUND;
  }

  /**
   * Text as the stretches each font draws.
   *
   * **A space stays with the run it is in** when that run's font has one, so `東京 本社` is one
   * run rather than three. Anything no font has is left in the run it interrupts — `drawable`
   * has already replaced those with their notation by the time text reaches here, so this only
   * decides where an unreachable glyph would have gone.
   */
  runs(text: string): TextRun[] {
    // **The common case, without walking the chain.** Every value and timestamp in a table is
    // printable ASCII, and a report has hundreds of thousands of them: asking the chain about each
    // character made a Latin-only table 13% slower to render than before this file existed.
    if (PRINTABLE_ASCII.test(text) && this.#primaryDrawsAscii()) return [{ font: 0, text }];
    const runs: TextRun[] = [];
    let current = 0;
    let buffer = '';
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      let index = this.indexFor(code);
      if (index === NOT_FOUND) index = current;
      if (
        index !== current &&
        code === 0x20 &&
        buffer !== '' &&
        this.#open(current)?.font.hasGlyphForCodePoint(code) === true
      ) {
        index = current;
      }
      if (index !== current && buffer !== '') {
        runs.push({ font: current, text: buffer });
        buffer = '';
      }
      current = index;
      buffer += character;
    }
    if (buffer !== '' || runs.length === 0) runs.push({ font: current, text: buffer });
    return runs;
  }

  #primaryDrawsAscii(): boolean {
    if (this.#asciiInPrimary === undefined) {
      let all = true;
      for (let code = 0x20; code <= 0x7e && all; code += 1) all = this.indexFor(code) === 0;
      this.#asciiInPrimary = all;
    }
    return this.#asciiInPrimary;
  }

  #open(index: number): ChainFont | null {
    const already = this.#fonts[index];
    if (already !== undefined) return already;
    const source = this.#sources[index];
    if (source === undefined) return null;
    try {
      const font = openFont(source, index === 0 ? 'body' : `fallback-${String(index)}`);
      this.#fonts[index] = font;
      return font;
    } catch (error) {
      this.#fonts[index] = null;
      this.#onUnavailable(source, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }
}

let configured: readonly ReportFontSource[] = [];
let chain: FontChain | null = null;

/**
 * The fonts an operator configured, for every PDF this thread renders from now on.
 *
 * Called once at startup in the core and once in each formatting worker, with the same list.
 */
export function configureReportFonts(fonts: readonly ReportFontSource[]): void {
  configured = fonts.map((font) => ({ path: font.path, face: font.face }));
  chain = null;
}

/** The chain every PDF in this thread draws with: DejaVu, what was configured, WenQuanYi. */
export function reportFonts(): FontChain {
  chain ??= new FontChain([PRIMARY_FONT, ...configured, BUNDLED_FALLBACK_FONT]);
  return chain;
}

/**
 * Opens every configured font once, and says which cannot be used and why.
 *
 * For the core's startup log. **Not a reason to refuse to start**: a font that cannot be read is
 * skipped by the chain and the next font draws instead, which is worse typography and not a broken
 * report — and the core monitors things, which a report font is not one of.
 */
export function checkReportFonts(
  fonts: readonly ReportFontSource[],
): { readonly source: ReportFontSource; readonly problem: string }[] {
  const problems: { source: ReportFontSource; problem: string }[] = [];
  for (const source of fonts) {
    try {
      openFont(source, 'check');
    } catch (error) {
      problems.push({ source, problem: error instanceof Error ? error.message : String(error) });
    }
  }
  return problems;
}
