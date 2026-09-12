# The font a report is drawn with

`ADR-006` Decision 2: every string a PDF report draws is drawn in **DejaVu Sans**, embedded in the
document. It is here as a file rather than as an npm dependency because a font is a static artefact
we want to have reviewed once, and because the release tarball already carries a package's `assets`
directory beside its `dist` (`scripts/package.sh`).

**Why it is not optional.** `pdfkit`'s built-in fonts encode WinAnsi and nothing else. Asked to
write `Маршрут` one of them emits truncated code points **without throwing** — a Cyrillic sensor
name would reach a filed PDF as mojibake with nothing having failed anywhere. A report that
mangles the name of the sensor it is about is worse than one that refuses to render.

| File                 | What it is                                                  |
| -------------------- | ----------------------------------------------------------- |
| `DejaVuSans.ttf`     | DejaVu Sans 2.37, 6,253 glyphs, 759,720 bytes               |
| `LICENSE-DejaVu.txt` | The font's licence, shipped because the licence requires it |

**What it does not cover.** DejaVu Sans has Latin, Greek, Cyrillic, Armenian, Georgian, Hebrew,
Arabic and a great deal of punctuation and symbols — and **no CJK at all**. `ADR-006` Decision 2
named Tokyo as a place whose names the standard fonts cannot represent, and this font cannot
represent them either: a Japanese sensor name has no glyphs here. `E-06` therefore does not rely on
the font's coverage being enough — characters it cannot draw are written as their Unicode notation
(`U+6771`) and the document says once that it happened, so the failure is visible instead of six
empty boxes. `E-12` is the ticket for covering those scripts properly, which means a second font of
a different order of size.

## Where these bytes came from

`DejaVuSans.ttf` is Debian's `fonts-dejavu-core 2.37-6` build, taken from this repository's own
development toolchain image — the same image that compiles and tests everything else here, so it
is a source this project already relies on, and one anybody can re-fetch and compare against.

```
sha256  abdc775b21b1bc470d50c97e790d276f2054b7504e56e5bd3e64f48d68582322
verify  ./scripts/dev.sh "sha256sum /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
```

**A note on which 2.37 this is.** Upstream's own 2.37 release file is not byte-identical to
Debian's rebuild — 757,076 bytes against 759,720 — while reporting the same version and the same
6,253 glyphs with the same table set. Distributions rebuild the font from source, so this is
expected rather than alarming; it is written down because "DejaVu Sans 2.37" names two files, and
a checksum that did not match the one somebody else downloaded would otherwise look like tampering.

`LICENSE-DejaVu.txt` is the project's own licence document, which every distribution of DejaVu
carries unchanged.

## The licence, in one paragraph

DejaVu is **not** under the SIL Open Font Licence, which `ADR-006` Decision 2 originally said and
`E-06` corrected. It is the **Bitstream Vera Fonts licence**, with DejaVu's own changes placed in
the public domain and imported Arev glyphs under a matching notice. It permits reproduction,
distribution and embedding without conditions on the documents produced, and it asks three things
of us, all of which hold here:

- the copyright and permission notices travel with the font — hence `LICENSE-DejaVu.txt` beside it,
  and in the release tarball;
- a **modified** font must be renamed to something containing neither "Bitstream" nor "Vera" —
  we do not modify it (`pdfkit` subsets it into each document, which is embedding, not modifying
  the Font Software we distribute);
- the font may be sold as part of a larger package but not sold by itself — which is what shipping
  it inside a monitoring system is.
