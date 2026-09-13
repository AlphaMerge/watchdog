import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import {
  BUNDLED_FALLBACK_FONT,
  FontChain,
  PRIMARY_FONT,
  checkReportFonts,
  configureReportFonts,
  reportFonts,
  type ReportFontSource,
} from '../src/reports/fonts.js';

/**
 * The fonts a PDF report draws with (`E-12`).
 *
 * The fonts here are the two the repository ships, and nothing else: a test that needed Noto Sans
 * CJK installed would pass on one machine. Where a test needs "a font the operator configured",
 * it configures the **Mono face of the bundled collection** — a real, different face, whose name
 * in the finished PDF says which one drew.
 */

const MONO: ReportFontSource = { path: BUNDLED_FALLBACK_FONT.path, face: 'WenQuanYiMicroHeiMono' };
const MISSING: ReportFontSource = { path: '/nonexistent/NotoSansCJK-Regular.ttc', face: '' };

const TOKYO = 0x6771; // 東
const SEOUL = 0xc11c; // 서
/** 𠮟 — in JIS X 0213 and in Noto Sans CJK JP, and in neither font this repository ships. */
const SHIKARU = 0x20b9f;

describe('the fonts a PDF report draws with', () => {
  after(() => {
    configureReportFonts([]);
  });

  it('draws with DejaVu first, and reaches WenQuanYi for what DejaVu does not have', () => {
    const chain = new FontChain([PRIMARY_FONT, BUNDLED_FALLBACK_FONT]);
    assert.equal(chain.indexFor(0x41), 0, 'A');
    assert.equal(chain.indexFor(0x43b), 0, 'Cyrillic л stays in DejaVu');
    assert.equal(chain.indexFor(TOKYO), 1);
    assert.equal(chain.indexFor(SEOUL), 1, 'and Hangul, which the smaller candidate font lacked');
    assert.equal(chain.indexFor(SHIKARU), -1);
    assert.equal(chain.has(SHIKARU), false);
    assert.equal(chain.has(0x0a), true, 'a line feed is the layout’s, not a font’s');
  });

  it('opens a second font only when a character needs it', () => {
    // WenQuanYi costs a worker 22 MiB opened; an installation whose sensors are all Latin should
    // never pay it.
    const chain = new FontChain([PRIMARY_FONT, BUNDLED_FALLBACK_FONT]);
    // Everything a Latin-only PDF asks of the chain: its first font, and what draws a letter.
    assert.equal(chain.primary.key, 'body');
    assert.equal(chain.indexFor(0x41), 0);
    assert.deepEqual(chain.runs('core-sw-01 0.50 —'), [{ font: 0, text: 'core-sw-01 0.50 —' }]);
    assert.deepEqual(
      chain.opened().map((font) => font.key),
      ['body'],
    );
    chain.indexFor(TOKYO);
    assert.deepEqual(
      chain.opened().map((font) => font.key),
      ['body', 'fallback-1'],
    );
  });

  it('splits a name into the runs each font draws, keeping a space with its run', () => {
    const chain = new FontChain([PRIMARY_FONT, BUNDLED_FALLBACK_FONT]);
    assert.deepEqual(chain.runs('Маршрут 東京 本社 core'), [
      { font: 0, text: 'Маршрут ' },
      { font: 1, text: '東京 本社 ' },
      { font: 0, text: 'core' },
    ]);
    assert.deepEqual(chain.runs('core-sw-01'), [{ font: 0, text: 'core-sw-01' }]);
    assert.deepEqual(chain.runs(''), [{ font: 0, text: '' }]);
  });

  it('puts a configured font ahead of the bundled one, so the operator’s choice draws', () => {
    // The reason an operator configures one at all: WenQuanYi's Han shapes are the Chinese ones.
    const chain = new FontChain([PRIMARY_FONT, MONO, BUNDLED_FALLBACK_FONT]);
    assert.equal(chain.indexFor(TOKYO), 1);
    assert.equal(chain.font(1)?.font.postscriptName, 'WenQuanYiMicroHeiMono');
    assert.equal(chain.indexFor(0x41), 0, 'and DejaVu still draws what it has');
  });

  it('skips a configured font that cannot be opened, once, and draws with the next', () => {
    const unavailable: string[] = [];
    const chain = new FontChain([PRIMARY_FONT, MISSING, BUNDLED_FALLBACK_FONT], (source, error) => {
      unavailable.push(`${source.path}: ${error.message}`);
    });
    assert.equal(chain.indexFor(TOKYO), 2);
    assert.equal(chain.indexFor(SEOUL), 2);
    assert.equal(unavailable.length, 1, unavailable.join('\n'));
    assert.match(unavailable[0] ?? '', /cannot be read/u);
  });

  it('refuses to draw at all without its first font, and says where it looked', () => {
    const chain = new FontChain([MISSING, BUNDLED_FALLBACK_FONT]);
    assert.throws(() => chain.primary, /the report font is missing at \/nonexistent\//u);
  });

  it('says precisely what is wrong with a configured font, for the startup log', () => {
    assert.deepEqual(checkReportFonts([MONO, { path: PRIMARY_FONT.path, face: '' }]), []);
    const problems = checkReportFonts([
      MISSING,
      { path: BUNDLED_FALLBACK_FONT.path, face: '' },
      { path: BUNDLED_FALLBACK_FONT.path, face: 'NotoSansCJKjp-Regular' },
      { path: new URL(import.meta.url).pathname, face: '' },
    ]).map((one) => one.problem);
    assert.equal(problems.length, 4);
    assert.match(problems[0] ?? '', /\/nonexistent\/NotoSansCJK-Regular\.ttc cannot be read/u);
    // A collection needs a face, and the useful answer names the faces there are.
    assert.match(
      problems[1] ?? '',
      /is a font collection; choose a face: WenQuanYiMicroHei, WenQuanYiMicroHeiMono/u,
    );
    assert.match(problems[2] ?? '', /has no face called NotoSansCJKjp-Regular/u);
    assert.match(problems[3] ?? '', /is not a font this system can read/u);
  });

  it('draws every PDF in a thread with what that thread was configured with', () => {
    configureReportFonts([]);
    const bundled = reportFonts();
    assert.equal(bundled.indexFor(TOKYO), 1);
    assert.equal(reportFonts(), bundled, 'one chain, kept');
    configureReportFonts([MONO]);
    const configured = reportFonts();
    assert.notEqual(configured, bundled, 'a new configuration is a new chain');
    assert.equal(configured.indexFor(TOKYO), 1);
    assert.equal(configured.font(1)?.font.postscriptName, 'WenQuanYiMicroHeiMono');
    assert.equal(configured.font(2)?.font.postscriptName, 'WenQuanYiMicroHei');
  });
});
