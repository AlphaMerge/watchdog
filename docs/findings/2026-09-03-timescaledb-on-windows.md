# Finding: TimescaleDB on Windows (S-11)

- **Date**: 2026-09-03
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

**Every function this project uses is declared in the Windows extension SQL**, checked against
`timescaledb--2.29.2.sql` in the package:

| Function | Licence | In the Windows package |
| --- | --- | --- |
| `create_hypertable` | Apache 2.0 | yes |
| `time_bucket` | Apache 2.0 | yes |
| `drop_chunks` | Apache 2.0 | yes |
| `compress_chunk` | Timescale | yes |
| `add_compression_policy` | Timescale | yes |

That is the whole of this project's dependency surface — the three Apache functions the storage
engine uses, plus the one accepted TSL feature and the policy that drives it.

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

## Method

    curl -s https://api.github.com/repos/timescale/timescaledb/releases?per_page=8
    # → assets per release, filtered for windows

    curl -sL <asset url> -o ts-win.zip && unzip -q ts-win.zip
    find . -name '*.dll' -o -name '*.control'
    grep -c 'FUNCTION.*\bcompress_chunk\b' timescaledb--2.29.2.sql

Re-runnable, and worth re-running before a Windows release: an upstream that stopped publishing
Windows builds would flip this finding, and the fallback `S-12` costed would come back.
