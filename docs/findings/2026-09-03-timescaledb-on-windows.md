# Finding: TimescaleDB on Windows (S-11)

- **Date**: 2026-09-03; **re-checked 2026-09-09** against 2.30.0, and one table below corrected
- **Question**: does the Windows release story need a plain-PostgreSQL fallback engine?
- **Answer**: **no, on availability grounds.** TimescaleDB ships Windows binaries for the
  PostgreSQL versions this project targets, and they contain every feature it depends on.
- **Still open**: performance on Windows, which needs a Windows host and is what remains of
  `S-11`.

## What was checked, and how

`S-11` asks to "install and benchmark on Windows Server. Decide TimescaleDB vs plain-Postgres
fallback." The decision half turns on a question that does not need a Windows host — *is there a
build at all, and does it carry the features we use?* — and that is answerable from the release
channel itself.

**Windows builds are current, not legacy.** The latest release at the time of writing, 2.29.2,
publishes:

    timescaledb-postgresql-16-windows-amd64.zip
    timescaledb-postgresql-17-windows-amd64.zip
    timescaledb-postgresql-18-windows-amd64.zip

and the eight most recent releases all do. PostgreSQL 17 is what this project is measured and
tested on, so the version we target is covered.

**The package carries the licensed half.** Unpacking `timescaledb-postgresql-17-windows-amd64.zip`
gives:

| File | |
| --- | --- |
| `timescaledb.dll`, `timescaledb-2.29.2.dll` | the Apache-2.0 extension |
| **`timescaledb-tsl-2.29.2.dll`** | the Timescale License module — where compression lives |
| `timescaledb--2.29.2.sql` and the upgrade scripts | the extension SQL |
| `setup.exe` | the installer that places them beside a PostgreSQL install |

That `-tsl-` module is the one that matters. `CLAUDE.md` accepts the Timescale License for
**native compression and nothing else**, and compression is a TSL feature — so a Windows package
without that DLL would have meant a Windows installation losing the 12.5× this project depends on.

**Every symbol this project uses is present in the Windows package.** The table below is the
2026-09-09 re-check, against 2.30.0; the 2026-09-03 version of it listed five functions and was
wrong in both directions — it named `add_compression_policy`, which this project deliberately does
*not* use, and it omitted four symbols that it does.

| Symbol | Licence | In the Windows package |
| --- | --- | --- |
| `create_hypertable` | Apache 2.0 | `timescaledb--2.30.0.sql` |
| `time_bucket` | Apache 2.0 | `timescaledb--2.30.0.sql` (20 overloads) |
| `drop_chunks` | Apache 2.0 | `timescaledb--2.30.0.sql` |
| `show_chunks` | Apache 2.0 | `timescaledb--2.30.0.sql` |
| `timescaledb_information.chunks` | Apache 2.0 | `timescaledb--2.30.0.sql` (view) |
| `compress_chunk` | Timescale | SQL, and `compress_chunk_impl` in `timescaledb-tsl-2.30.0.dll` |
| `decompress_chunk` | Timescale | SQL, and `decompress_chunk_impl` in the same DLL |
| `timescaledb.compress`, `…_segmentby`, `…_orderby` | Timescale | table options, in `timescaledb-2.30.0.dll` |
| `timescaledb.license` | — | the GUC, in `timescaledb-2.30.0.dll` |

That is the whole of this project's dependency surface, and **it is now asserted rather than
described**: `storage-engine.test.ts` scans the engine and migrations 003/004 with their comments
stripped, fails if a symbol outside this table appears, and fails if one in it stops being used.
It also fails on `add_job`, `alter_job`, `add_compression_policy`, `add_retention_policy`,
`add_continuous_aggregate_policy`, `time_bucket_gapfill` and `timescaledb.continuous` — the TSL
features `CLAUDE.md` does *not* accept the licence for. Compaction and retention are driven by
the housekeeping loop in `packages/core` for exactly that reason.

The comment-stripping is the load-bearing part and was mutation-tested: `add_job` named in a
comment is not reported, the same name in SQL is.

## What this settles, and what it does not

**Settled: no `PlainPostgresEngine` is required for Windows.** `S-12` costed that fallback — four
engine methods plus a second migration list, with pre-created partitions as the only genuinely new
work — and this finding means that cost does not have to be paid on availability grounds. The
`StorageEngine` seam stays worth having for the reason `S-12` gives (a storage engine that can be
swapped), but Windows is not the thing forcing it.

**Not settled: performance.** Nothing here ran a query. TimescaleDB on Windows could be slower
than on Linux, and that would be worth knowing — but it would be a performance note, not a reason
for a different engine. Measuring it needs a Windows Server host, and so does the rest of `S-11`.

**Not settled: the installer's assumptions.** `setup.exe` places the extension beside an existing
PostgreSQL installation. Whether that composes with how an operator installs PostgreSQL on
Windows, and what it needs in `postgresql.conf` (`shared_preload_libraries`, the licence setting)
is unverified here — `scripts/smoke/provision-postgres.sh` does the Linux equivalent and has no
Windows counterpart.

## The 2026-09-09 re-check

`S-11` says to re-run this before a Windows release, because an upstream that stopped publishing
Windows builds would flip the finding. Re-run today, six days on:

- **2.30.0 was published 2026-09-08** and ships `timescaledb-postgresql-{16,17,18}-windows-amd64.zip`.
  So do the nine releases behind it. PostgreSQL 17 — what this project is measured and tested on —
  is covered by every one of them.
- **The channel does drop versions**, which is why this check is worth repeating rather than
  believing: PostgreSQL 15 had a Windows build through 2.28.3 and has had none since 2.29.0. It
  was the same shape of change that would remove ours.
- **The 2.30.0 PostgreSQL 17 package still carries the licensed module** —
  `timescaledb-tsl-2.30.0.dll`, 8.2 MiB zip, sha256
  `28a5af30d06158f4c34ae9682e178b0cd8beb515155d9a6d47b77158c03e5274` — and every symbol in the
  table above.

Nothing here changes the decision. What changed is the table, and that the table is now a test.

## Method

    curl -s 'https://api.github.com/repos/timescale/timescaledb/releases?per_page=10'
    # → assets per release, filtered for windows

    curl -sL <asset url> -o ts-win.zip && unzip -q ts-win.zip
    ls timescaledb/*.dll timescaledb/*.control
    grep -cE '^ *CREATE( OR REPLACE)? FUNCTION [^(]*\bshow_chunks\(' timescaledb--2.30.0.sql
    # the compression table options and the licence GUC are in the C module, not the SQL:
    strings -a timescaledb-2.30.0.dll     | grep -E '^(compress|compress_(segment|order)by|timescaledb\.license)$'
    strings -a timescaledb-tsl-2.30.0.dll | grep -E 'compress_chunk_impl|decompress_chunk_impl'

Re-runnable, and worth re-running before a Windows release: an upstream that stopped publishing
Windows builds would flip this finding, and the fallback `S-12` costed would come back.
