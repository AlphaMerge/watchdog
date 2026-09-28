# Every way the services exit while starting, and whether waiting fixes it (P-215)

- **Date**: 2026-09-28
- **What**: a read of `packages/core/src/main.ts` `serve()` and `packages/probe/src/main.ts` `main()`
  from process start to `lifecycle.ready()`, at `ac2056a`, plus `packages/shared/src/lifecycle/`.
  Code reading, not a measurement. The measurement is the second half of `P-215`.

## Why this comes first

`P-213` made both units' memory ceiling kill rather than throttle, and a service that cannot fit
under its ceiling is now killed, restarted and killed again for as long as nothing changes. The
obvious fix is a start limit, and it has a hazard: **`StartLimitBurst` counts every restart, not
only the ones caused by the ceiling.** Today `Restart=on-failure` every five seconds is the
*only* thing that waits for anything at boot. A start limit that stops the ceiling loop would stop
every other loop too, including ones that would have fixed themselves.

So the question for each exit is not which subsystem it is in, but **would waiting fix it?** A
start limit is right for the exits where it would not, and wrong for the ones where it would.

## The probe

`lifecycle.ready()` is sent at `main.ts:506`, **before the probe has heard from the core**. The
core client is started and not awaited. A probe that cannot reach the core still scans and spools
(`WORKFLOW.MD §10`), reconnecting inside the process on its own backoff, so the one dependency
that is routinely unavailable at boot is never a failed start.

| Exit | Where | Waiting fixes it? |
| --- | --- | --- |
| Configuration invalid | `bootstrap` → `process.exit(78)` | No |
| Spool directory cannot be created or opened | `mkdir`, `ResultSpool.open` (`main.ts:100`) | No — permissions or a full disk, neither of which clears in five seconds |
| Worker pool cannot start | `pool.start()` (`main.ts:187`) | No — a catalogue that will not load does not load on the next try |
| Trap or syslog port cannot be bound | `trapListener.start()`, `syslogListener.start()` | No — `EACCES` is a missing capability; `EADDRINUSE` is another process, and systemd has already waited for the previous instance to exit |
| On-demand query runner | `queries.start()` | No |
| **Working set exceeds `MemoryMax`** | after READY, as the pool grows | **No** — this is the loop |

**Every start-time exit of the probe is permanent.** Nothing about it relies on systemd to retry.
A start limit on the probe costs nothing that waiting would have recovered.

## The core

`lifecycle.ready()` is sent at `main.ts:1357`, after everything is serving.

| Exit | Where | Waiting fixes it? |
| --- | --- | --- |
| Configuration invalid | `bootstrap` → `process.exit(78)` | No |
| **PostgreSQL not accepting connections** | `db.check()` (`main.ts:216`) | **Yes** — a database in crash recovery, or started a moment later |
| PostgreSQL rejects the credentials, or the database does not exist | `db.check()` | No |
| Migration fails, or the schema is refused | `migrateOnStart` / `refuseSchema` (`main.ts:233–239`) | No |
| **Migration outlasts `TimeoutStartSec`** — not an exit: systemd kills it | `migrateOnStart` | **Yes** — it only needed longer |
| Lookups, device templates, declared limits or schedules will not load | `main.ts:271–446` | No — files and rows that were wrong are still wrong |
| API port cannot be bound | `api.start()` (`main.ts:1068`) | No |
| First administrator's password file cannot be written | `main.ts:989` | No |
| Probe endpoint cannot start (certificates, port) | `probeEndpoint.start()` (`main.ts:1177`) | No |
| **Working set exceeds `MemoryMax`** | after READY | **No** — the same loop |

**The core has two start failures that waiting fixes: the first query, and a long migration.**
The first version of this audit counted only the first, because it read for exits, and a
migration that runs too long never exits — the supervisor kills it. It was found in review.

**The first query.** Once `db.check()`
has succeeded the database is up, and nothing after it is transient in practice.

`After=postgresql.service` does not remove it. On Debian, `postgresql.service` is a oneshot
wrapper that reports started before `postgresql@<version>-main` accepts connections, and ordering
never waits for crash recovery. That rejection reaches `main().catch` → `process.exit(1)`, and
the next restart five seconds later is today's whole mechanism for waiting it out.

**A long migration.** `autoMigrate` defaults to `true` (`schema.ts:920`) and the shipped
`deploy/examples/core.json` sets it, so every upgrade migrates inside the start window, after the
database answers and before READY. Nothing extended the timeout there, so a migration longer
than what was left of `TimeoutStartSec=60` — an index on the samples hypertable of a large
installation — was killed mid-way, restarted into the same migration, and killed again: **an
upgrade that could never finish**. A start limit would only have made that stop in `failed`.

What a kill mid-migration leaves behind, checked in `migrator.ts` rather than assumed:

- **Transactional migrations — every one but two — are rolled back.** `up` and the
  `schema_migration` row are one transaction; a killed process drops its connection, PostgreSQL
  rolls the transaction back, and the next start applies the migration from clean. The advisory
  lock is session-level and goes with the connection.
- **`003-timeseries` and `004-rollups` are `transactional: false`** — `create_hypertable` and the
  TimescaleDB calls cannot run inside one — so a kill leaves them partly applied and unrecorded.
  Both are written to be re-run: `CREATE TABLE IF NOT EXISTS`, `if_not_exists => true`,
  `CREATE OR REPLACE`, and an idempotent `ALTER TABLE … SET`. The next start completes them. They
  run once, at first install, against an empty database.

## What else fell out

- **A configuration error already has its own exit code, and nothing uses it.** `bootstrap` exits
  78 (`EX_CONFIG`) and neither unit sets `RestartPreventExitStatus=`, so a typo in `core.json`
  restarts every five seconds for ever, logging the same line each time. That is the clearest
  "waiting will not fix it" in either service, and systemd can already be told so.
- **systemd cannot tell the loop apart by cause.** `RestartPreventExitStatus=SIGKILL` would stop
  after the *first* kill, including a probe caught once by a surge that would have come back by
  itself — the case `P-213` chose to keep. `StartLimitBurst` tells loops apart by **speed**, not
  cause. A start limit is only correct if the loops it must ignore are slow and the loops it must
  catch are fast, and that has to be arranged, not assumed.
- **`RestartSteps` and `RestartMaxDelaySec` are not available.** They need systemd 254; the
  smoke box is Debian 12 with 252, and RHEL 9 also ships 252.

## The design this points at

1. **Both units: `RestartPreventExitStatus=78`.** A configuration error stops at once and says so,
   instead of after six starts.
2. **The core waits for PostgreSQL inside the process**, at `db.check()` only: transient errors
   (connection refused, SQLSTATE `57P03` "the database system is starting up") are retried,
   bounded, **logged on every attempt with the reason**, and reported to systemd as `STATUS=`
   with `EXTEND_TIMEOUT_USEC` so that `TimeoutStartSec` does not end the wait. Credentials and a
   missing database fail at once. After this, every exit of the core's start is permanent too.
3. **Migrations report progress for as long as they run.** Each migration reports as it starts
   and every 15 s after, and the core turns each report into `Lifecycle.starting` — 45 s more,
   and `applying migration 51 (report-pdf), 340 s so far` in `systemctl status`. **Not one fixed
   slice per migration**, which only moves the deadline: a migration longer than the slice would
   be killed exactly as before. One that is genuinely stuck on a lock stays stuck in plain view,
   named, with its elapsed time, instead of being killed half-way and started again.
4. **Both units: a start limit in `[Unit]`**, with an interval chosen against two periods: the
   ceiling loop's round, which it must stop, and the database wait's bound, which it must not. The
   wait makes each failed database round minutes long, and the ceiling loop is seconds to a minute
   long. The limit is set in the gap between them.

The round period under `MemoryMax` is what `P-213`'s live run measures, and it decides step 4.
Steps 1–3 do not depend on it.

## The numbers that set step 4

**The ceiling loop: 10–14 s a round.** From `P-213`'s live run
([`2026-09-28-memory-ceiling.md`](2026-09-28-memory-ceiling.md), raw in
`2026-09-28-memory-max-live.jsonl`), with `MemoryMax` pinned at 132 MiB, kill to kill: 12.9, 11.3,
10.7, 9.9 and 14.4 s with `RestartSec=5s`. That is the fast end — a ceiling that low is reached
almost at once. A probe whose working set is too big for the stock 6 GiB reaches it later, after
more of its start-up: `P-206` measured about 171 MiB/s early in start-up, and a peak of
2.5–3.5 GiB.

**The database wait: chosen, not measured.** `DATABASE_WAIT_MS` is 5 minutes, so a database that
stays down makes rounds of at least 305 s.

**What systemd counts.** It refuses a start once `StartLimitBurst` starts have *already* happened
inside `StartLimitIntervalSec` — the sixth, for a burst of five — so stopping a loop takes **five
whole rounds inside the window**. The first design here divided by four and said a five-minute
window stops anything under 75 s. It stops anything under 60 s, and a probe that lasts a minute
before the ceiling takes it runs for ever under it: 9–14 alarms an hour, the same as no limit at
all. That was caught by modelling the rule rather than the arithmetic, before anything shipped.

**The limit: `StartLimitIntervalSec=600`, burst 5.** Five rounds in ten minutes stops any loop
under **two minutes a round** — every ceiling loop measured with eight times the margin, and the
slower ones a 6 GiB probe would make. A database that stays down puts at most **two** starts in any
ten-minute window, against the six it would take. Longer than two minutes a round is a probe that
works for a while between kills — closer to a leak than to a service that cannot start — and
restarting it is right. `database-wait.test.ts` pins both halves, so changing either constant
fails a test.

## What the loop costs in alarms, and what the limit buys

`probe-restart-scenario.test.ts` has two halves. A **pure** suite plays each loop against the core's
30-second Probe Health sweep at every phase — the loop begun at each of its five rounds, the sweep
at every second of its thirty — and asserts the worst case. A **database** suite plays two of those
phases through the real sweep, the real `ms.probe.link` lookup, the state machine, the trigger
engine and the scheduler, with a state trigger as installed (Down, `initialLatencySeconds` 0), and
asserts that the pipeline raises exactly one notification per outage the sweep observed.

Alarms in an hour, least–most over every phase:

| The restarted probe | No start limit | A 5-minute window | **Shipped: 10 minutes** |
| --- | --- | --- | --- |
| never gets as far as connecting | 1 | 1 | **1** |
| the measured loop, connected ~5 s a round | 36–45 | 1–2 | **1–2** |
| connected 15 s a round | 26–32 | 1–3 | **1–3** |
| connected 30 s a round | 13–20 | 1–3 | **1–3** |
| connected 60 s a round | 9–14 | 9–14 | **1–4** |

**Two alarms is not a rare case.** With the shipped limit the measured loop raises two at 41% of
phases. The first version of the scenario ran one phase through the pipeline, got 1, and asserted
`<= 2`: it passed on a lucky phase. The pure suite now asserts that two happens, so that nobody reads
the bound as "one" and tightens an assertion to match a run.

**One outage, one alarm is not met at the unit level.** `CLAUDE.md` makes it non-negotiable, and a
start limit does not deliver it: it turns 9–53 alarms an hour into 1–4. No unit-level or link-level
change delivers it either. Holding the link Down until a connection has lasted 15–30 s
(`connectedForMs`, which the link already carries) fixed only the shortest loop and made the
60-second one *worse*, 4 → 6, because it adds a Down stretch at the start of every connection for
the sweep to see. What is left belongs in the alarm engine, as flap suppression, and is **`M-18`**.

**The link is judged by a lookup, so nothing softens it.** Lookups are immediate
(`state-machine.md` §2.2) — no two-step rule — and `initialLatencySeconds` defaults to 0, so a probe
connected at one sweep and gone at the next is Up then Down, and each Down is a notification.

**The count is set by aliasing, and one period gives the wrong answer in both directions.**
Against a thirty-second sweep, a constant ten-second round lands on the same phase of every third
round for ever and sees nothing at all; 11.3 s sees 42 an hour, 14 s sees 18. The measured rounds
jitter, and the scenario replays the sequence, not a period.

**The rows below the first two are modelled, not measured.** Their rounds are the measured jitter
scaled to a longer connection. Only the measured loop's rounds come from a live run. How many
alarms the throttled loop `P-213` replaced made was not modelled: its probe kept its socket open
while stalled, and when the core closes an idle link is a separate question.

## What is verified, and what is not yet

**The units parse, on both systemd versions an installation meets.** `systemd-analyze verify`, run
in the smoke images already on the machine — Debian 12's systemd 252 and Ubuntu 24.04's 255 — with
stub binaries in place of `/opt/ms/bin/*` so that it reports on directives rather than on a missing
install: **no warnings for either unit**. The one mistake that would make this ticket a silent
no-op is `StartLimitIntervalSec=` in `[Service]`, where systemd warns and then ignores it. A copy of
`ms-probe.service` with exactly that mistake was verified alongside, and both versions caught it:

```
systemd 252: mutant.service:34: Unknown key 'StartLimitIntervalSec' in section [Service], ignoring.
systemd 255: mutant.service:34: Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring.
```

**The code paths are tested.** Build, lint and the shared, probe and core suites pass (249, 320
and 2,695 tests before the rebase onto `H-12`; 258, 341 and every core unit test after it),
including the database wait, migration progress and both halves of the restart scenario.

## The live run, 2026-09-28

`scripts/sizing/memory-limit-live.sh`, in the smoke test's clean Debian 12 box under the shipped
units; raw records in `2026-09-28-start-limit-live.jsonl`. The first two attempts failed in Docker
Desktop's BuildKit (`DeadlineExceeded` resolving `FROM debian:bookworm`) before reaching this
ticket's code; with the image pulled into the local store the build went through. It ran in a
window with every other session holding and `ms-server` stopped, starting about 16:59:36 UTC. Load
at the start was 3.89 / 10.79 / 16.10 on 8 CPUs, the tail of the work that had just drained; the
restart loop ran about three minutes later. The box is small: its probe schedules no sensors and
its working set is about 200 MiB, so the ceilings below are small too.

**The probe's loop ends where an operator sees it.** With the ceiling at 90% of the working set and
swap available, the kernel killed the probe about 0.6 s into each start, before it connected:

| Kill | at (s) | since the last |
| ---- | -----: | -------------: |
| 1    | 143.3  |              — |
| 2    | 149.0  |            5.7 |
| 3    | 154.6  |            5.6 |
| 4    | 160.3  |            5.7 |
| 5    | 166.1  |            5.8 |

Each round is the 5 s `RestartSec` plus the 0.6 s to the kill, uniform to ±0.1 s, which is not what
a round stretched by load looks like. At 171.3 s systemd logged *Start request repeated too
quickly* and *Failed with result 'oom-kill'*: `failed`, 28 s after the first kill, `NRestarts` 5.
It stayed there for the remaining 37 s of the stage. `reset-failed` and a start brought it back at
210 s, connected by 214 s. Probe Health went Down on the sweep after the first kill and stayed
Down: the probe never connected between kills, so this shape raises one alarm, which is the
scenario test's answer for a loop that never links up. The 10–14 s shape that connects each round,
where the scenario's one-or-two comes from, is `P-213`'s measurement and was not reproduced in this
box.

The stage without swap did not loop here. The probe was killed once as the ceiling was lowered
(`Failed with result 'signal'`), and the restarted process fitted, at 96.5% of 252 MiB, for the
rest of the stage. A fresh process is smaller than the one whose working set set the ceiling. That
is `P-213`'s question, not this one.

**The core waits for its database past `TimeoutStartSec`.** Started with PostgreSQL stopped, it
logged a warning at every attempt (1, 2, 4, then every 5 s) naming `127.0.0.1:5432/monitoring`. At
90 s it was still `activating/start`, 30 s past `TimeoutStartSec=60`, with
`systemctl status` reading *waiting for PostgreSQL at 127.0.0.1:5432/monitoring: nothing is
listening yet (attempt 20, 87 s)* and **no restarts**. PostgreSQL was started at 93 s; the core
logged the database reachable and was `active/running` 1 s later. Without `EXTEND_TIMEOUT_USEC`
systemd would have killed it at 60 s.

**Manual starts count toward the burst.** After `reset-failed ms-probe`, six
`systemctl restart ms-probe` a second apart: the first five succeeded and the sixth was refused
with *start request repeated too quickly*. `administration.md` says so, and says to
`reset-failed` before the next start when iterating on a configuration or just after an install
or upgrade.

**A refused configuration was not exercised, and the harness was at fault.** The case writes an
unreadable `core.json` and restarts the core, expecting exit 78 and no restarts. The core never read
the file: its restart was refused by the start limit (`Failed with result 'start-limit-hit'`). The
smoke test's own starts, the harness restarting the services, and the database case had already put
five starts inside ten minutes. The verdict recorded `failed`, restarts 0, exit status 0, which
looks like a pass unless you read the result; it now records the result too. The harness now runs
`systemctl reset-failed ms-core ms-probe` before every case that starts a unit, and after the smoke
test, so that each case counts only its own starts. **Anything else that drives the services
through several starts in ten minutes, `H-15`'s rehearsal included, needs the same.**
The whole run is to be repeated with that fix, and `P-215` is ticked when it shows exit 78.
