# The fonts a report is drawn with

`ADR-006` Decision 2: every string a PDF report draws is drawn in a font embedded in the document —
**DejaVu Sans** first, and **WenQuanYi Micro Hei** for the characters DejaVu does not have
(`E-12`). They are here as files rather than as npm dependencies because a font is a static
artefact we want to have reviewed once, and because the release tarball already carries a
package's `assets` directory beside its `dist` (`scripts/package.sh`).

**Why they are not optional.** `pdfkit`'s built-in fonts encode WinAnsi and nothing else. Asked to
write `Маршрут` one of them emits truncated code points **without throwing** — a Cyrillic sensor
name would reach a filed PDF as mojibake with nothing having failed anywhere. A report that
mangles the name of the sensor it is about is worse than one that refuses to render.

| File                      | What it is                                                                  |
| ------------------------- | --------------------------------------------------------------------------- |
| `DejaVuSans.ttf`          | DejaVu Sans 2.37, 6,253 glyphs, 759,720 bytes                               |
| `LICENSE-DejaVu.txt`      | DejaVu's licence, shipped because the licence requires it                   |
| `wqy-microhei.ttc`        | WenQuanYi Micro Hei 0.2.0-beta, two faces of 49,531 glyphs, 5,177,387 bytes |
| `COPYRIGHT-WenQuanYi.txt` | Its copyright and licence statement, as Debian distributes it               |
| `LICENSE-Apache-2.0.txt`  | The Apache License 2.0, under which we use it                               |

**How the two are used.** Every character is drawn by the first font that has a glyph for it:
DejaVu, then any font the operator configured in `reports.pdfFonts`, then WenQuanYi
(`packages/core/src/reports/fonts.ts`). A report whose names are all Latin never opens the second
file. What neither font has — `U+20B9F` 𠮟, the wave dash 〜 — is written as its Unicode notation
and the document says so, and a configured font such as Noto Sans CJK is how an installation
covers those. `docs/findings/2026-09-13-report-cjk-fonts.md` has the coverage of both, measured,
and why this font was chosen over Noto Sans CJK and Droid Sans Fallback.

## DejaVu Sans

### Where these bytes came from

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

### The licence, in one paragraph

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

## WenQuanYi Micro Hei

### Where these bytes came from

`wqy-microhei.ttc` is the font file from Debian bookworm's `fonts-wqy-microhei 0.2.0-beta-3.1`,
unaltered — the name included. Debian's package is upstream's `wqy-microhei-0.2.0-beta.tar.gz`
from the WenQuanYi project on SourceForge; the font's own name table reports `Version 0.2.0-beta`.

```
sha256  2420e8078af796b19a3f6ef13de527a1a91c1e7171eea115926c614ced1009b3
verify  ./scripts/dev.sh "apt-get update -qq && apt-get download fonts-wqy-microhei && \
          dpkg-deb -x fonts-wqy-microhei_*.deb x && sha256sum x/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
```

It is a collection of two faces, `WenQuanYiMicroHei` and `WenQuanYiMicroHeiMono`, sharing one set of
glyphs; a report draws with the first. The font's own `OS/2` table permits embedding and
subsetting.

**It is not maintained.** 0.2.0-beta carries copyright years of 2008–2009, and it is still the
release Debian packages. That is acceptable for
a font — nothing about drawing `東` goes out of date — and it is one of the two reasons
`reports.pdfFonts` exists. The other is that its Han shapes are the Chinese ones.

### The licence

WenQuanYi Micro Hei is offered under **either** the Apache License 2.0 **or** the GNU GPL version 3
or later with a font-embedding exception. **We use it under the Apache License 2.0**, which permits
redistribution, embedding and subsetting and asks of us:

- a copy of the licence travels with it — `LICENSE-Apache-2.0.txt`, Debian's copy of the standard
  text, and in the release tarball;
- its copyright and attribution notices are kept — `COPYRIGHT-WenQuanYi.txt`, Debian's statement
  of them verbatim, which also records what the font was derived from: Google's Droid fonts
  (Apache 2.0) and punctuation from the Ume font;
- a changed file says it was changed — we do not change it.

Debian's package carries no `NOTICE` file for it, and the upstream release notes name only the two
licence texts, so there is no `NOTICE` to carry.
