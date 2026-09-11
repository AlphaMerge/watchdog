# ADR-005: Where a generated report lives

- **Status**: Accepted (Decision 3 of Phase 13's three open questions; Decisions 1 and 2 remain open)
- **Date**: 2026-09-11
- **Deciders**: Roman
- **Supersedes**: —
- **Relates to**: `ADR-001` Decision 1 (standalone service), `ADR-003` (uploaded files), `E-09`,
  `E-10`, and the two questions this ADR deliberately does **not** answer

## Context

`CAPABILITIES.MD §6` offers three delivery modes for a report: store, store and email, or email
only. `E-08` runs reports on a schedule and records what happened; `E-09` is what happens to the
document. Until now the bytes were discarded, and that was a deliberate hold rather than an
oversight — deciding where they live in a migration, quietly, is how a question this size gets
answered by accident.

**`ADR-003` names this case and refuses it.** Deciding that an uploaded map background lives in
PostgreSQL, it says: *"If a later feature wants files measured in hundreds of megabytes — packet
captures, report archives — that is a different question and it gets its own ADR rather than being
smuggled in under this one."* This is that ADR.

`§14` lists a `\Report PDFs` directory, which is how PRTG does it. That is a description of
somebody else's product, not a requirement.

### Three open questions, and this ADR answers one

`docs/TASKS.md` Phase 13 records three decisions gated on an ADR:

1. **A PDF without a browser** — headless Chromium against a PDF library.
2. **A graph without a browser** — a second renderer to keep in step with uPlot, against a
   deliberately different picture.
3. **Where a generated report lives.**

**Only 3 is settled here.** 1 and 2 are about what this system can produce and cost several hundred
megabytes of dependency either way; 3 is about what it does with what it already produces, and
`E-04` produces HTML and CSV today. Bundling them would hold a decision that is ready behind two
that are not.

## Decision 1 — A stored report lives in PostgreSQL, as `bytea`

**Decision.** A rendered report is stored as a row in `report_output`, keyed to the run that
produced it. Not a file under the service's data directory.

**Why.** The same deciding argument `ADR-003` gave, and it is stronger here rather than weaker: an
operator who backs up the database has backed up their reports. A report is the most durable thing
this system emits — the one artefact whose whole value is being readable months later by somebody
who was not there — so a restore that produces a list of reports whose files are all missing is a
worse outcome than for any other feature. One thing to install has a matching rule, one thing to
back up, and the alternative is a second procedure that exists only for this feature and is
therefore the one people skip.

Three supporting reasons:

- **Deletion is a foreign key.** `ON DELETE CASCADE` from `report_run` removes a report's output
  with the run, and `E-10`'s retention becomes a `DELETE` in the same loop that drops chunks. On
  disk it is a reaper, a class of orphan, and a bug where the reaper deletes something still being
  downloaded.
- **The row and the bytes cannot disagree.** A run row that says `stored` and a file that is not
  there is a state that only exists if there are two places to look.
- **`V2-06` is failover clustering.** Rows replicate; files on one node's disk do not.

**What this costs, said plainly**, because `ADR-003` was right to be nervous about it: large
objects in a relational database make backups slow and the buffer cache useless. The reason that
is acceptable *today* is Decision 2, and the reason it is honest to say so is that the bound is
already enforced and measured rather than hoped for.

**Compression is PostgreSQL's, not the application's.** A `bytea` column is `EXTENDED` storage by
default, so anything over a couple of kilobytes is compressed before it is stored, out of line,
transparently. Compressing in Node before the insert would make the database try and fail to
compress it again, hide the real size from `pg_total_relation_size`, and put an inflate on the path
of every download. An HTML data table is the most compressible thing imaginable — repeated tags,
repeated timestamps — and the database is better placed to do it than we are.

**Not `pg_largeobject`**, for the reason `ADR-003` gave: a second API with its own lifecycle, not
covered by `pg_dump` in the plain-text format without extra flags, and TOAST handles this size
without any of it.

## Decision 2 — Bounded by what `E-04` already refuses, not by a new number

**Decision.** No new size limit. A stored report is bounded by `MAX_CELLS` — the 200,000-value
ceiling `E-04` enforces on a rendered document — and by the formats this ADR admits.

**Why.** `ADR-003` needed an explicit 2 MiB because an upload is bytes a caller chose. A report is
bytes *this system* produced from a document it already refused to build if it was too large, so
the bound exists upstream and a second number here would be a second thing to keep in step. The
worst case is arithmetic rather than a guess: 200,000 cells of HTML is roughly 5 MB before
compression and well under a megabyte after it, and a realistic monthly report over a few dozen
sensors is tens of kilobytes.

**The `zip` output is bounded by the same thing**, being a container around documents that already
passed the check.

## Decision 3 — HTML, CSV and ZIP only. PDF is out of scope until Decision 1 of Phase 13

**Decision.** `report_output` admits `html`, `csv` and `zip`. A PDF is not stored because nothing
produces one.

**Why this is worth writing down rather than leaving implicit.** The size argument above holds
*because* the formats are text that the database compresses an order of magnitude. A PDF with an
embedded raster graph is neither small nor compressible, and a hundred of them a month is the
"hundreds of megabytes" case `ADR-003` explicitly sent to a future ADR. **When Phase 13's Decision
1 is made, this decision is reopened with it** — the answer may well be that PDFs live somewhere
else, and that is a coherent outcome rather than an inconsistency.

## Decision 4 — Email-only still stores, and then deletes

**Decision.** `delivery: 'email'` stores the output like any other mode, sends it, and deletes the
row once it has been delivered. It is not held in memory.

**Why.** A delivery that fails is retried, and a retry needs the bytes. The alternatives are to
re-render — minutes of work against the database serving live checks, and a *different document*
once a rollup or retention has moved underneath it — or to hold megabytes in memory across an
outage that might last hours. Storing briefly is the only one of the three that is both cheap and
correct, and it makes "email only" mean what an operator expects: nothing is kept afterwards.

A report whose delivery has permanently failed **keeps its output**. Deleting the evidence of a
failure is the opposite of what somebody investigating one needs, and `E-10`'s retention will
expire it on the same schedule as everything else.

## Consequences

- `E-10` becomes a `DELETE` bounded by an operator's setting, in the housekeeping loop that
  already drops chunks — the shape `S-14` set.
- Backups grow with retained reports. An installation keeping a year of daily reports over fifty
  sensors is adding tens of megabytes, which is noise beside the measurements; one keeping hourly
  reports over five hundred sensors is not, and `E-10`'s default has to be chosen with that in
  mind rather than set to "forever".
- The download route is the second in this system to answer bytes rather than JSON, after
  `G-05`'s background, and takes the same response-schema exemption for the same reason.
- **If Phase 13's Decision 1 admits PDFs, this ADR is revisited.** It is not a precedent for
  storing anything large; it is a decision about text.
