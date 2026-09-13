# ADR-006: A PDF and a graph, without a browser

- **Status**: Accepted — this settles Decisions 1 and 2 of Phase 13's three open questions.
  `E-05` and `E-06` are unblocked
- **Date**: 2026-09-12
- **Deciders**: Roman
- **Supersedes**: —
- **Relates to**: `ADR-001` Decision 8 (uPlot for dense charts) and Decision 10 (native service,
  no compiled addons), `ADR-005` (where a stored report lives), `E-05`, `E-06`, `H-06`

## Context

`docs/TASKS.md` opened Phase 13 with three decisions gated on an ADR. `ADR-005` answered the
third — where a generated report lives — and deliberately left these two, because they are about
several hundred megabytes of dependency and the third was not.

1. **A PDF without a browser.** The obvious way to render one is to drive headless Chromium, and
   that is a large dependency an operator has to install, patch and supervise — on Windows too,
   where `H-06` is already the hard half. A PDF library is small and cannot lay out HTML.
2. **A graph without a browser**, and it is not the same question. The UI draws with uPlot in a
   canvas; a report needs the same series as a picture on the server. That is either a second
   renderer to keep in step with the first, or a decision that a report's graph is deliberately a
   different picture.

`E-04` has since shipped, and it changes the shape of both questions. It produces a
**`ReportDocument`** — a format-agnostic model of a report — and renders it to HTML and to CSV as
two formattings of one document, with a test asserting the two agree cell for cell. Neither
question below is "how do we turn our HTML into a PDF" any more. Both are "what does a third
renderer over that model cost".

### What was measured, 2026-09-12

Everything in this ADR that is a number was measured rather than recalled.

| | |
| --- | --- |
| `pdfkit` | 0.20.2, MIT, published 2026-09-07 — active. **26 MB installed, 18 packages, and no compiled addon and no `install`/`postinstall` hook anywhere in its tree.** Installed with `--ignore-scripts` and used to generate a PDF, which is the exact condition `ADR-001` Decision 10 requires of a release build |
| `pdf-lib` | 1.17.1, last published **2022**. It edits existing PDFs rather than laying documents out; not a candidate |
| Chrome for Testing | 153.0.8010.36 — **195 MB compressed for `linux64`, 205 MB for `win64`**, per platform, before extraction |
| `canvas` | 3.2.3, and it is a **N-API native addon** — a compiled binary in the tarball |
| `chartjs-node-canvas` | 5.0.0, last published March 2025, and it depends on `canvas` |
| `svg-to-pdfkit` | 0.1.8, last published **2022**. The obvious bridge from an SVG chart into a PDF, and it is stale |
| `DejaVuSans.ttf` | **760 KB**, Bitstream Vera licence — *this row said OFL-1.1 when the ADR was written; see the correction under Decision 2* |

**And one measurement that decided a sub-question.** `pdfkit`'s standard fonts encode WinAnsi and
nothing else. Asked to write `Bürorouter`, it emits `<42fc726f726f75746572>` — `ü` as `fc`, which
is correct. Asked to write `Маршрут` it emits `<41c430440448440443442>`, which is not even a whole
number of bytes: the code points are being truncated. **It does not throw.** A Cyrillic sensor name
would reach a filed PDF as mojibake and nothing would have failed.

## Decision 1 — A PDF is laid out by us, with `pdfkit`. Not by a browser

**Decision.** `E-06` renders a `ReportDocument` to PDF through `pdfkit`, drawing the header block,
the table and the footer itself. **Headless Chromium is refused.**

**Why the deciding argument is not the size.** 195 MB is a number that invites haggling, and the
haggling misses the point: what Chromium is *for* is arbitrary-HTML fidelity, and we would be
paying for it in order to lay out a table we generated ourselves. The document is not arbitrary
HTML. It is a header block, a table of numbers with repeating column headers, and a footer —
`E-04` decided its whole structure and `MAX_CELLS` already bounds its size. Buying a browser to
draw that is buying a compiler to add two numbers.

The size is what makes it *unaffordable* rather than merely unnecessary, and four things compound:

- **`ADR-001` Decision 1 says PostgreSQL is the only thing an operator installs.** A browser is a
  second thing — and unlike PostgreSQL it is not one they already know how to run, patch or watch.
- **`ADR-001` Decision 10 ships an esbuild bundle plus `node_modules` in a tarball or an MSI, with
  npm install scripts off.** Puppeteer's browser arrives through a `postinstall` download. Turning
  install scripts on to satisfy it is precisely what that decision says not to do, and the
  alternative — putting 205 MB of extracted Chromium inside the MSI — makes `H-06` a different
  ticket than the one that was scoped.
- **It is per platform.** Linux x64, Linux arm64 and Windows x64 are three downloads, so
  "the installer grew by 200 MB" is optimistic.
- **A browser rendering operator-controlled content is a security surface**, and `E-04` is careful
  about exactly that content: sensor names are user text, which is why the HTML escapes them and
  the CSV defuses formulas. Handing that to a browser is not obviously worse, but it is a great
  deal more of it.

**What this costs, said plainly.** We own pagination. A data table that runs past one page needs
its column headers repeated, its column widths chosen from the content, and a page break that does
not land between a row and its own timestamp. That is real work and it is the reason `E-06` is
sized `L`. It is also *bounded* work with an exact specification — the document model already says
what the columns are — and it is testable without a browser, which the Chromium path is not: a
Chromium-rendered PDF can only be checked by looking at it.

**Not writing the PDF ourselves either**, which is the third option and is where the `ZIP` writer's
precedent stops. That writer is ~140 lines because ZIP's local header, deflated entry and central
directory are a complete specification over `node:zlib`. PDF is not that shape: text positioning,
font metrics, encodings, embedded font subsetting and a cross-reference table are each larger than
all of ZIP, and the first non-Latin character turns it into a font project. `pdfkit` is 26 MB of
pure JavaScript that costs the installer nothing, and it is the right size of dependency in a way
Chromium is not and a hand-rolled writer is not either.

## Decision 2 — A report ships a font. The standard 14 are not enough

**Decision.** `E-06` embeds **DejaVu Sans** (759,720 bytes) and uses it for every string a report
draws. It does not rely on `pdfkit`'s built-in Helvetica.

> **Corrected 2026-09-13 while implementing `E-06`.** This decision said DejaVu Sans is under
> **OFL-1.1**. It is not: it is under the **Bitstream Vera Fonts licence**, with DejaVu's own
> changes in the public domain and imported Arev glyphs under a matching notice. The decision
> survives the correction unchanged — that licence also permits embedding without conditions on
> the document — but it asks two things OFL-1.1 does not put the same way, and both are now
> honoured: the permission notice travels with the font (`packages/core/assets/fonts/`, and the
> release tarball carries the directory), and a *modified* font would have to be renamed, which is
> why we ship the distribution's file unaltered. The font is not sold by itself, which the licence
> also forbids.

**Why, and this is the measurement above rather than a worry.** The standard fonts encode WinAnsi.
Every device and sensor name in a report is text an operator typed, and an installation in Sofia,
Athens or Tokyo types names the standard fonts cannot represent — **silently**, as mojibake in a
filed document, with nothing failing anywhere. `E-04` already has a test asserting an umlaut
survives into a ZIP entry name for this exact class of reason; a report that mangles the name of
the sensor it is about is worse than one that refuses to render.

760 KB against a 26 MB dependency is not a number worth arguing about, and the licence permits
embedding without conditions on the document.

> **Extended 2026-09-13 by `E-06`, and this is the half the decision got wrong.** The paragraph
> above names Sofia, Athens *and Tokyo*. DejaVu Sans answers the first two and **cannot answer the
> third**: it has no CJK glyphs at all, and a font without a glyph draws `.notdef` — an empty box —
> without `pdfkit` complaining. Embedding this font therefore removes the silent-mojibake failure
> for Latin, Greek and Cyrillic and leaves it exactly in place for Japanese, Chinese and Korean,
> which is what the first rendered test of a CJK sensor name showed.
>
> `E-06` does not pretend otherwise. It asks the font, through `fontkit`, whether it can draw each
> character of every string an operator typed, writes the ones it cannot as their Unicode notation
> (`U+6771`), and says once in the document's header that this happened. **Visible and lossless
> beats blank**, and it is the same rule as the rest of this system: a gap is drawn as a gap.
>
> Covering those scripts properly is a second font of a different order of size — Noto Sans CJK is
> tens of megabytes, against the 760 KB this decision weighed — so it is a decision of its own
> rather than a patch to this one. `E-12` holds it. **Chromium would not have solved this**: it falls
back to system fonts, and a minimal Linux server has none installed — the toolchain image this was
measured in has exactly one. It would have had the same failure, later, and harder to attribute.

> **Extended again 2026-09-13 by `E-12`: a second font ships, and an operator may name a third.**
> Measured (`docs/findings/2026-09-13-report-cjk-fonts.md`): Noto Sans CJK covers every CJK
> standard set and draws each region's shapes, and costs 19.5 MB (+15.5 MB, 73%, on the release
> tarball) and 80 MiB in a worker; Droid Sans Fallback is 4 MB and has no Korean; **WenQuanYi Micro
> Hei is 5.2 MB (+2.3 MB, 11%), covers all of JIS X 0208, GB 2312, Big5 and KS X 1001 including
> Hangul, and costs 22 MiB once opened.** It ships, under its Apache 2.0 option, and every
> character is drawn by the first of DejaVu Sans, the fonts in `reports.pdfFonts`, and WenQuanYi
> that has a glyph for it. A font after DejaVu is opened only when a character needs it, and a
> report with none is byte-identical to one before `E-12`.
>
> **What this decision accepts.** WenQuanYi's Han shapes are the Chinese ones — Noto's Japanese and
> Simplified Chinese faces differ on 8,638 of 20,976 basic ideographs — and the font has not had a
> release since 2009. Both are answered by the same setting rather than by the installer carrying
> 15 MB more for every installation: an operator whose readers need Japanese shapes names
> `fonts-noto-cjk`'s Japanese face, and WenQuanYi still draws what that face lacks. What neither
> bundled font has, such as the wave dash `〜`, is still written as its notation and said once.

## Decision 3 — A report's graph is drawn by us, as one model with two drawings

**Decision.** `E-05` computes the chart's geometry in `@ms/shared` and draws it twice: **as SVG**
for the HTML report, and **as `pdfkit` primitives** for the PDF. No headless browser, no
`node-canvas`, no rasterisation.

**Why this is not a second renderer to keep in step with uPlot.** The premise in the original
question is half wrong, and `E-04` proved which half. The decisions that must not drift are
already ours and already pure — `packages/web/src/charts/groups.ts` holds the one-chart-per-unit
rule (which is the dual-axis answer, and the single most common charting mistake), colour following
the entity rather than its rank, and what an all-gap channel means. **uPlot draws pixels; it
decides nothing.** So the thing to share is that model, and the thing to duplicate is a drawing
routine, which is the cheap half.

`groups.ts` therefore **moves to `@ms/shared`**, where the core and the web app both read it. That
is `CLAUDE.md`'s rule about resolving a thing in one place, applied to charts rather than to
inheritance, and it is the part of `E-05` that matters more than the drawing.

**And a report's graph is deliberately a different picture.** It is static, paged, fixed-width, has
no hover, no zoom and no live refresh, and will be printed. Matching uPlot pixel for pixel would be
an expensive way to be wrong about all of those. What must match is **the numbers**, and that is
already settled: `E-04` reads through the same `HistoryService` and the same `planSeries` the sensor
page uses, so a report and the graph an operator checks it against cannot disagree about an hour.
Looking different while agreeing exactly is the correct outcome.

**Why SVG rather than a raster.** It is text, so it embeds directly in the HTML report with nothing
fetched — which `E-04` requires, because a remote asset in an emailed document is a read receipt
nobody agreed to. It has no dependency at all. It prints at the reader's resolution rather than at
ours. And it is **assertable**: a test can read a path and say the line breaks where the data has a
gap, which is `CLAUDE.md`'s no-data-is-not-zero rule reaching the one place it is easiest to lose.
A PNG can only be compared to another PNG.

**Not `node-canvas`.** It is a compiled N-API addon, so it puts a native binary in the tarball for
every platform — the thing `ADR-001` Decision 10 goes out of its way to avoid, and which it
currently achieves for the whole SNMP and SSH stacks. `chartjs-node-canvas` depends on it and would
inherit the problem along with a second charting library.

**Not `svg-to-pdfkit`** as the bridge between the two drawings. It has not been published since
2022, and it would mean generating SVG only to parse it back. The chart model emits `pdfkit` draw
calls directly, which is fewer moving parts than converting between two representations we control
both ends of.

**What this costs, said plainly.** We own axis tick selection, label placement and collision, and
the null-gap path. Tick selection in particular is a small algorithm that is easy to get almost
right — a y-axis labelled 0, 33, 67, 100 is a chart nobody trusts. This is why `E-05` is sized `L`
and why it is the last of the three to be worth starting.

## Decision 4 — `E-07` goes before either of them

**Decision.** XML output is not gated by this ADR and should land first.

**Why it is worth saying in an ADR at all.** `E-07` is a third formatting of a document model that
already exists, with no dependency, no font and no geometry — a day's work that completes `§6`'s
format list to three of four. Both decisions above are `L` tickets. Sequencing the cheap complete
thing ahead of the two expensive ones is not a scheduling detail here; it is the difference between
"reports produce HTML, CSV and XML today" and "reports are half-built until the pictures land".

## Consequences

- **The installer does not grow by a browser.** It grows by 26 MB of pure JavaScript and 760 KB of
  font, and `ADR-001` Decision 10's scripts-off release build keeps working unchanged — which was
  verified rather than assumed.
- **`H-06` stays the ticket it was scoped as.** Windows packaging gains a font file and nothing
  else; it does not gain a browser to install, patch or sandbox.
- **`groups.ts` moves to `@ms/shared`**, and the web app imports it from there. That is a small
  refactor with a test suite already behind it, and it must land with `E-05` rather than after.

  > **Done 2026-09-13 by `E-05`**, with two things this consequence did not foresee. `@ms/web` had
  > never depended on `@ms/shared`, whose entry point is service code — `pino`, `ajv`, `node:net`
  > — so the charts are published as their own browser-safe subpath, `@ms/shared/charts`, with a
  > test that nothing in it imports outside its directory; the web bundle grew by 0.09 kB. And the
  > palette's rules moved with the grouping, which exposed that the web app's JavaScript copy of the
  > light palette had **already drifted** from its stylesheet: the eight hues matched, the neutrals
  > did not. There is now one palette in code and a test holding the stylesheet to it.
  >
  > **The time axis's candidates stay in the core**, and this is the one place the geometry is not
  > wholly in `@ms/shared`: which instants are round in a zone is calendar knowledge, and the
  > calendar already lives in `reports/span.ts`. The shared layout decides which candidates fit.
- **We own pagination and axis ticks**, and both are testable without a browser. That is the
  trade: more of our own code, all of it assertable, against a large dependency whose output can
  only be checked by looking at it.
- **`ADR-005` Decision 3 is unblocked and should be revisited when `E-06` lands.** It admits
  `html`, `csv` and `zip` to `report_output` and says explicitly that the list reopens when a PDF
  exists. A PDF of a data table is text and vector graphics — compressible, and bounded by the same
  `MAX_CELLS` — so the expectation is that it joins the enum under the same reasoning rather than
  needing somewhere else to live. **That is an expectation, not this decision**: it gets checked
  against a real rendered PDF before the enum changes.
- **If a future report needs arbitrary operator-supplied HTML rendered to PDF** — a custom template,
  say — this decision does not cover it and should be reopened rather than stretched. What is
  decided here is that *our own* document does not need a browser.
