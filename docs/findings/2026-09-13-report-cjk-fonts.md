# Japanese, Chinese and Korean in a PDF report: which font, and what it costs

**Date:** 2026-09-13
**Task:** `E-12` — a report in a script DejaVu does not cover
**Decision:** `ADR-006` Decision 2, extended — bundle WenQuanYi Micro Hei, allow a configured font
ahead of it
**Run:** [the committed measurements](2026-09-13-report-cjk-fonts-run.txt)

## The question

`E-06` embedded DejaVu Sans and found it has no CJK glyphs at all. It made the failure visible —
`東京` is written `U+6771 U+4EAC` and the document says so — which is honest and is not a report
anybody in Tokyo files. The ticket asked for a decision before an implementation: which font, and
what it costs the installer. `ADR-006` weighed 760 KB for DejaVu; every CJK font is a different
order of size.

## What was measured

Three candidates, taken from Debian bookworm's own packages so the bytes are ones anybody can fetch
again and compare, against DejaVu for reference. Each was asked, through `fontkit` — the library
`pdfkit` embeds with, so the answer is the one the renderer would act on — which characters of the
national standard sets it can draw. The sets were enumerated through Node's WHATWG decoders, with
the private-use slots those decoders map unassigned bytes to left out.

| | DejaVu Sans | Noto Sans CJK | Droid Sans Fallback | WenQuanYi Micro Hei |
| --- | --- | --- | --- | --- |
| file | 760 KB | **19.5 MB** (10 faces) | 4.0 MB | **5.2 MB** (2 faces) |
| gzip | 0.4 MB | 15.5 MB | 2.1 MB | 2.3 MB |
| licence | Bitstream Vera | OFL-1.1 | Apache-2.0 | Apache-2.0, or GPL-3+ with a font exception |
| JIS X 0208 kana, level 1 and 2 kanji | 0 of 6,524 | all | all | all |
| GB 2312 hanzi | 0 of 6,763 | all | all | all |
| GBK | 408 of 21,891 | 21,890 | 21,405 | 21,798 |
| Big5 | 34 of 13,094 | all | 13,060 | all |
| KS X 1001 Hangul | 0 of 2,350 | all | **1** | all |
| KS X 1001 Hanja | 0 of 4,888 | all | all | all |
| all 11,172 Hangul syllables | 0 | all | 3 | all |
| CJK Extension A | 0 of 6,592 | 6,582 | 6,582 | **2** |
| Latin-1 and Extended-A | all 319 | 221 | 1 | all |
| Cyrillic | all 96 | 66 | 0 | all |

**Droid Sans Fallback has no Korean**, which rules it out before anything else is weighed.
**WenQuanYi covers the JIS, GB 2312, Big5 and KS X 1001 sets as fully as Noto.** It falls behind on
93 GBK characters, on CJK Extension A, and on punctuation: DejaVu and WenQuanYi between them lack 29
of the 64 CJK symbols and punctuation marks, and among them is one a Japanese name really uses —
**〜, U+301C, the wave dash** of `9:00〜17:00`. `、。「」『』・ー！（）` and the fullwidth letters
and digits are all there; the other gaps are halfwidth Hangul letters and rarely used kana.

What each costs once used:

| | PDF of 10 kanji | 100 kanji | 1,000 kanji | 100 Hangul | a fresh worker, first PDF | memory once opened |
| --- | --- | --- | --- | --- | --- | --- |
| Noto Sans CJK | 57.5 KB | 81.0 KB | 305 KB | 40.6 KB | 100 – 145 ms | **80 MiB** |
| Droid Sans Fallback | 4.1 KB | 15.6 KB | 113 KB | — | 22 – 33 ms | 11 MiB |
| WenQuanYi Micro Hei | 6.6 KB | 20.3 KB | 134 KB | 10.3 KB | 70 – 94 ms | 22 MiB |

Noto's PDF carries about 50 KB whatever it holds; this run did not break down why. Every PDF here
was read back through its own `ToUnicode` map, and the text came back exact.

**And one measurement that a text round-trip cannot make: whether the glyphs are drawn.** The
`ToUnicode` map is written separately from the glyph outlines, so text can copy out correctly from
a document that draws nothing — and Noto Sans CJK's outlines are CFF, which `pdfkit` subsets by a
different path from DejaVu's TrueType. A sample of every candidate was rendered to an image by
macOS's own PDF renderer, which shares no code with `pdfkit`: Noto and WenQuanYi drew every line, and Droid drew
empty boxes for Hangul and for Latin — silently, which is the failure `ADR-006` Decision 2 exists to
prevent.

### Han unification, measured

One code point is drawn one way for a Japanese reader and another for a Chinese one. Noto Sans CJK
ships a face per region, and of the 20,976 basic ideographs its Japanese face has, **the Simplified
Chinese face draws 8,638 differently**, the Traditional 11,497, the Hong Kong 11,106 and the Korean
630. WenQuanYi is one design, and a Chinese one. Its shapes are legible to a Japanese reader and
are not the ones a Japanese reader would choose.

## The decision, and why

Three options were put to the project's owner with these numbers:

1. **Bundle Noto Sans CJK.** The best quality and the right regional shapes, at +15.5 MB on a
   21.3 MB release tarball (+73%), +19.5 MB in the repository's history for good, and 80 MiB in a
   formatting worker once opened.
2. **Configuration only.** Ship nothing; an operator who needs CJK installs a font and names it.
   Free, and out of the box a Tokyo installation still gets `U+6771`.
3. **Bundle WenQuanYi Micro Hei, and let a configured font go ahead of it.** Chosen.

**Why the third.** It is the only option under which a report nobody configured anything for draws
`東京` as `東京` — `+2.3 MB` on the tarball, 11% — and it covers Korean, which the other small font
does not. Its two weaknesses are real and both are answered by the same setting: its Han shapes are
Chinese, and it is unmaintained (0.2.0-beta, 2009). An installation that cares configures
`fonts-noto-cjk`'s Japanese face in `reports.pdfFonts`; the core draws with that first, and
WenQuanYi still catches whatever the configured face lacks.

## What was built

- **A font chain** (`packages/core/src/reports/fonts.ts`): DejaVu Sans, then each configured font,
  then WenQuanYi. **Every character is drawn by the first font that has it.** A font after DejaVu is
  opened the first time a character needs it and not before, so an installation whose sensors are
  all Latin never pays the 22 MiB.
- **Text is drawn in runs.** A name like `Маршрут 臺北 core` is three runs in two fonts. Each run
  is placed after the width of the last and lowered by the difference in the fonts' ascents, because
  `pdfkit` sets text by the top of its font and two fonts have two tops. A right-aligned heading is
  placed by its whole width. `readPdf` now reports each string's position and font, and the tests
  assert that the runs share one baseline exactly and that a heading ends on its column's edge to
  within a hundredth of a point.
- **`reports.pdfFonts`** in the core's configuration: `{ "path", "face" }` entries, in order. A
  font that cannot be opened is logged at startup with what is wrong — a collection opened without
  a face gets the list of faces it has — and skipped rather than a reason to refuse to start. The
  pool hands the list to every formatting worker, so a PDF formatted off the event loop (`P-204`)
  draws with the same fonts.
- **The notation stays** for a character no font has, now with an example none of them does:
  `U+20B9F`, 𠮟, which is in JIS X 0213 and in Noto Sans CJK's Japanese face and in neither font
  this repository ships — the case the setting exists for.

## What it costs a report that needed none of it

**Not one byte, and a few percent this run cannot tell from noise.** The first version of the chain asked it about
every character of every cell, and a 10-sensor, 720-hour table took 13% longer. Values and
timestamps are printable ASCII, which DejaVu draws in full, so they skip the chain; with that, the
same report rendered 3% slower and a 100-sensor graph report 4% — inside the noise of a run on a
machine that was not quiet (another session's `ms-server` was up) — and **both came out
byte-identical to the documents the previous commit produces**. Before and after were rendered
alternately in one process from a worktree of the previous commit, nine times each, so the load
landed on both.

A Japanese document costs more, because it is drawing something now: 13% on the table and 7% on the
graphs, against the previous commit writing every name as `U+` notation.

## What this does not settle

- **Windows fonts.** A Windows installation has CJK fonts of its own, and pointing
  `reports.pdfFonts` at one is the obvious configuration. Whether each permits embedding, and which
  face names its collections use, is not measured here — there is no Windows machine in this
  project yet (`H-06`). The startup log names a collection's faces when the one configured is wrong.
- **What WenQuanYi lacks still needs a configured font**: 〜 above, 𠮟 and the rest of CJK
  Extension B, and Extension A. Noto Sans CJK's Japanese face has 〜, 𠮟 and 6,582 of Extension A's
  6,592 — measured for 𠮟 and Extension A; 〜 is in every Noto Sans CJK face by its coverage of CJK
  punctuation, 64 of 64.
- **The core's startup check opens each configured font once**, to say what is wrong with it; for
  Noto that is a moment's 80 MiB on the main thread, released afterwards. It is not measured beyond
  that, because it happens once per start and only for an operator who configured one.
