# Task Backlog

Ticket-sized work items derived from `PLAN.md`. Each is meant to be a self-contained unit a
Claude Code session can pick up, complete and verify without holding the whole system in
context.

**Format**: `[ ] ID — Title` · _Phase_ · _Est._ · Depends on · Done when.
Estimates are S (< half a day), M (1–2 days), L (3–5 days), XL (> 1 week — should probably be
split before starting).

Update the checkbox when a task lands. Add new tasks rather than expanding existing ones.

---

## Phase 0 — Foundations

- [x] **F-01 — Scaffold the monorepo** · S · — · `packages/{core,probe,shared,web}` with npm
      workspaces, TypeScript project references, strict mode, ESLint + Prettier, `npm run build`
      and `npm test` green at the root.
- [x] **F-02 — Dev Docker Compose** · S · F-01 · `docker-compose.dev.yml` starts PostgreSQL +
      TimescaleDB, MailHog, an SNMP simulator and a syslog sender. Documented in the README as
      **development only**.
- [x] **F-03 — Config loading and structured logging** · S · F-01 · Layered config (defaults →
      file → env), schema-validated at boot with clear errors. `pino` logger with request/check
      correlation ids.
- [x] **F-04 — Graceful lifecycle** · S · F-03 · Both processes handle SIGTERM: stop accepting
      work, drain in flight, flush, exit 0 within a bounded time.
- [x] **F-05 — systemd units** · M · F-04 · `ms-core.service` and `ms-probe.service` with
      `Restart=on-failure`, `WatchdogSec` + `sd_notify` heartbeats, a dedicated service user and
      cgroup limits.
- [x] **F-06 — WinSW service wrapper** · M · F-04 · Windows service definitions wrapping
      `node.exe`, with log rotation and failure actions. Explicitly not `node-windows`.
- [x] **F-07 — Package and install script** · M · F-05, F-06 · esbuild bundle + native
      `node_modules`, versioned tarball, `install.sh` that creates the user, lays out directories,
      installs units and starts services.
- [x] **F-08 — CI pipeline** · M · F-07 · Build, typecheck, lint, unit tests, plus an install
      smoke test on a clean Linux VM asserting both services reach "running".
- [x] **F-09 — Core↔probe transport skeleton** · L · F-03 · mTLS framed message channel with
      heartbeat, reconnect with backoff, and a versioned handshake. No business payloads yet.

## Phase 1 — Object model and storage

- [x] **S-01 — Migration tooling** · S · F-01 · Forward and rollback migrations, applied at boot
      behind a flag, version recorded in the DB.
- [x] **S-02 — Object tree schema** · M · S-01 · `object` (id, parent_id, kind, name, tags[],
      priority, comments, timestamps), `sensor_config`, `channel`, `credential_set`. Indexes for
      subtree queries.
- [x] **S-03 — Tree CRUD API** · M · S-02 · Create/read/update/delete/move/clone for probe,
      group, device and sensor, with cycle prevention and cascade rules.
- [x] **S-04 — Setting inheritance resolver** · L · S-02 · Resolve any inheritable setting to
      the nearest ancestor defining it; explicit override; revert-to-inherit discards the local
      value. Table-driven tests over deep and wide trees. _The most-used logic in the system —
      get it right here._
- [x] **S-05 — Sample and state hypertables** · M · S-01 · `sample(time, channel_id, value)` and
      `sensor_state(time, sensor_id, state, message, cause)` as TimescaleDB hypertables with
      chunk-interval tuning.
      **Added by S-03:** do **not** put a foreign key from `sample.channel_id` to `channel`.
      With `ON DELETE CASCADE` it would pull millions of hypertable rows into the delete
      transaction while the exclusive tree lock is held, turning "delete this test group" into
      a multi-minute freeze of every structural operation — and it would break in production
      rather than in test. Orphaned samples are reaped by S-06's retention job, which walks the
      data anyway. If S-05 decides otherwise, `DeleteReport.deleted` grows a `samples` count in
      the same change.
      **S-05 outcome:** no foreign key on either hypertable, for that reason. `sample.value` is
      `NOT NULL` so a gap can only ever be a missing row. Both tables carry a unique index on
      `(key, time)`, which makes probe replay (R-03) idempotent via `ON CONFLICT DO NOTHING`.
      Chunks are one day for `sample` and seven for `sensor_state`; measurements in
      `docs/findings/2026-08-25-timeseries-sizing.md`.
- [x] **S-06 — Rollup tiers, compression and retention** · L · S-05 · `sample_5m`, `sample_1h`,
      `sample_1d` written by us — **not** continuous aggregates; native compression on raw and
      5-minute data; per-class retention. Verified against hand-computed expectations including
      across gaps.
      **Directed by the storage spike** (`docs/findings/2026-08-25-rollup-storage-spike.md`, and
      the ADR-001 Decision 4 amendment): continuous aggregates, `add_job`,
      `add_compression_policy` and `add_retention_policy` are all Timescale-License. We accept
      that licence for native compression alone — 12.5x on disk, no Apache substitute — and
      write the tiers, the retention sweep and the loop that drives them ourselves, so moving
      off TimescaleDB would cost compression and nothing else. Consequences: the tiers carry
      `sum` and `count`, never a precomputed average, so 5m composes into 1h into 1d exactly;
      there is no real-time aggregation, so a watermark says how far each tier is materialised;
      and late data (R-03 replay) re-rolls through a backfill queue rather than being lost.
      This job also reaps orphaned samples, as S-05 directed.
      **S-06 outcome:** migration 004; `packages/core/src/timeseries/`. Rolling up a five-minute
      bucket across all 15,000 channels of the v1 target takes 155 ms of its 300,000 ms period,
      and compression at the production chunk shape is 10.1x — the ratio depends on readings per
      channel per chunk, not on channel count, which is worth knowing before anyone repeats the
      measurement. Numbers in `docs/findings/2026-08-25-rollup-measurements.md`. Two bugs the
      tests caught are written up there too: a backfill window wider than one pass being deleted
      part-read, and `ON CONFLICT DO UPDATE` being unable to shrink a bucket whose source rows
      had gone.
- [ ] **S-07 — Ingestion pipeline** · L · S-05 · Batched writes with a bounded queue, a
      backpressure signal to probes, and per-batch metrics. Target 100k samples/min sustained,
      p99 write < 100 ms.
      **Added by S-06:** when a batch's oldest sample precedes the five-minute watermark — which
      is what a probe replaying its spool looks like — call `Housekeeper.noteLateSamples(from,
      to, reason)`. Without it those readings land in raw, correct and invisible, and no rollup
      ever looks at that window again. Cheap enough to call for any batch that qualifies; a
      redundant window costs one row and one pass.
- [x] **S-08 — Historic data query API** · M · S-06 · Automatic rollup selection for the
      requested resolution; reject > 500-day ranges (shorten to 365); force ≥ 60-minute averaging
      on 40–500 day ranges.
      **Added by S-06:** we have no real-time aggregation, so reading a rollup tier alone
      silently omits everything newer than that tier's watermark — up to the last few minutes
      for 5m, the last hour for 1h. Every tier read must union the unmaterialised tail from the
      tier below, and the average must come from `sum(value_sum) / sum(sample_count)`, never from
      an average of averages.
      **S-08 outcome:** `packages/core/src/timeseries/{query,history}.ts` and
      `GET /api/v1/sensors/{id}/history`. The rules are a pure function of the request, tested
      without a database. `segmentsFor` splits a range across however many sources hold it, so
      **the answer does not depend on how far the rollup has got** — the same range read fully
      materialised and with the watermark wound back into the middle of it is identical, straddling
      bucket included. A tier read is 2.7x faster than raw for the same buckets while reading 60x
      fewer rows (`docs/findings/2026-08-25-historic-query-measurements.md`). A *default*
      resolution is steered onto a width a tier can compose — 45 minutes rather than 44 — while an
      explicit one is honoured as asked and `source` says where it came from.
- [ ] **S-09 — Gap semantics** · M · S-08 · No-data distinct from zero in storage, query results
      and wire format. Averaging never interpolates across a gap.
      **Mostly delivered already, deliberately:** storage cannot hold a gap as anything but a
      missing row (`sample.value` is `NOT NULL`, S-05); ingestion refuses to store channel values
      from a failed check and counts what it discarded (S-07); rollups produce no bucket where
      there were no readings (S-06); and the history response is a dense array per channel where
      **`null` is a gap and never a zero**, which is the shape that makes it hard for a client to
      plot a line to the floor by accident (S-08). What is left for this task is the UI side —
      graphs breaking the line rather than joining across a null — plus a scenario test that
      walks a gap end to end from a Down sensor to a rendered chart.
      **Half done by U-04:** the history panel draws a column per bucket and a gap is *not
      rendered* — not a zero-height bar, which would still be a mark on the baseline. `extentOf`
      skips nulls, so a gap cannot pull the scale to zero either, and that is unit-tested. U-04
      also extended the rule to *current* values: a reading older than three scan intervals is
      withheld rather than shown, because a stale number is no-data wearing a value.
      **Finished on the UI side by U-05:** the uPlot panels keep `spanGaps` false and no code path
      turns a null into a number, so an outage is a break in the line rather than a dip to the
      floor; the tooltip says "no reading" and the table view a dash. What remains is only the
      end-to-end scenario test — a gap walked from a Down sensor to a rendered chart.
- [x] **S-10 — Audit log** · M · S-03 · Every create/update/delete recorded with actor,
      timestamp and diff; queryable per object.
      **S-10 outcome:** migration 005, `packages/core/src/audit/`, and
      `GET /api/v1/objects/{id}/audit`. Three decisions worth knowing about:
      **No foreign key to `object`.** The most important entry an audit log holds is the one
      recording a deletion, and a foreign key would take it away with its subject. The route
      therefore has no existence check and never 404s — refusing history for something deleted
      would hide exactly the change someone came looking for.
      **Sensor parameters by key, never by value.** A parameter could hold a credential, and a
      long-lived table with its own retention would make a present-tense exposure permanent —
      redacting later cannot unwrite history. A test greps the whole table for a canary.
      **Resolved by P-05:** `writeOnly` parameters are stripped at `ObjectService.#redact` before
      the sink sees anything, so values are now recorded for the parameters that are not secrets.
      The changed-key list is still computed on the unredacted pair, because a rotated secret
      redacts to the same absence on both sides and would otherwise be invisible.
      **Added by U-07:** the global list `GET /api/v1/audit`, with category, actor and time
      filters. `objectId` there is one object exactly and never a subtree — the entry most worth
      reading is a deletion, whose subject has no parent left to be found through.

      **Both sinks.** `CompositeAuditSink` writes the table and the structured log, inside the
      mutation's transaction — the table is what the history tab reads, the log is the plain-text
      audit component `CAPABILITIES.MD` §9 lists and the copy that survives someone dropping the
      database. Retention is `housekeeping.retention.auditDays`, 730 by default: twice the raw
      data, because "who changed this" is asked long after the readings either side of the
      change have been rolled up.
- [ ] **S-11 — Resolve TimescaleDB on Windows** · M · S-06 · Spike: install and benchmark on
      Windows Server. Decide TimescaleDB vs plain-Postgres fallback and record the outcome in
      ADR-001. _Blocks the Windows release story._
      **Added by S-12:** if the answer is a fallback, the work is bounded and half-measured
      already. A `PlainPostgresEngine` needs four methods — `date_bin` for bucketing (verified
      identical to `time_bucket`), partition introspection, a no-op compaction reporting
      `compaction: false`, and `DROP TABLE` on a partition — plus a **second migration list**,
      because migrations are checksummed and cannot be parameterised by engine without making
      every existing installation look drifted. Creating partitions ahead of time is the only
      genuinely new work, and it belongs in the housekeeping loop. See
      `docs/findings/2026-08-25-storage-engine-boundary.md`.
- [x] **S-12 — Time-series repository interface** · M · S-08 · All time-series access behind one
      interface so the storage engine can be swapped without touching callers.
      **S-12 outcome:** `TimeSeriesStore` is the interface callers depend on;
      `SqlTimeSeriesStore` implements it over PostgreSQL and takes a `StorageEngine` for the four
      things plain PostgreSQL cannot do — bucketing, finding aged chunks, compacting them, and
      dropping them. A second engine is a four-method object, not a reimplementation.
      **The boundary is enforced by a test**, not by review: `storage-engine.test.ts` scans every
      file under `src` for `time_bucket`, `create_hypertable`, `drop_chunks`, `compress_chunk`
      and their neighbours, and fails if any appears outside the engine and migrations 003/004.
      **The seam is exercised twice, not asserted once**: the same store driven by a `date_bin`
      engine rolls up and reads back byte-identical results, and `date_bin` matches `time_bucket`
      exactly for all three tier widths. `Database.check()` no longer probes for the extension,
      and the housekeeping loop asks `capabilities()` once so an engine that cannot compact is
      never asked twice.
      Full inventory, substitutes and the migration constraint:
      `docs/findings/2026-08-25-storage-engine-boundary.md`.

### Known gaps left by S-03

Found by an adversarial review of the S-03 implementation and deliberately not fixed there,
because each is a decision rather than a defect:

- [x] **S-13 — Conditional GET for inherited content** · S · S-03 · `GET /objects/{id}` serves
      304 only when `?include=` is empty, because an ETag is the object's own version and
      inherited settings and credentials change without bumping it. Give the inheritance-bearing
      responses a validator that covers the chain (a hash of the resolved values, or the maximum
      version along the ancestor path) so the common UI read can be conditional again.
      **S-13 outcome:** the ETag becomes `W/"<version>-<chain>"` when the response carries
      inherited content, where `<chain>` is a digest of `(id, version)` for the object and every
      ancestor. Both halves are read by different requests: `If-None-Match` compares the whole
      string, so an ancestor's change invalidates the cache, while `If-Match` reads only the
      version — a PATCH to this object should not be blocked because something moved three levels
      up. Measured at **3.6x cheaper and zero bytes** for a repeat read of a seven-level chain.
      **The maximum version along the path, which this entry suggested, would have been wrong.**
      Versions are per-object counters, so re-parenting an ancestor can change every inherited
      value while leaving the maximum exactly where it was — there is a test that constructs
      precisely that case. The digest covers chain *membership* as well as chain versions.
      It also folds in the build version, because the last input to a resolved setting is its
      registry default, and that lives in code rather than in a row.
- [x] **S-16 — Cheaper create** · S · S-03 · Building a 5,000-object tree serially took 24 of its
      30-second budget; it now takes 21, and the database work per create went from 1.92 ms to
      1.55 ms (`docs/findings/2026-08-25-tree-build-measurement.md`).
      **S-16 outcome, and it corrected the task's own premise.** This was filed as "nine round
      trips, remove two of them". Timing every statement across 400 creates showed the SQL is
      1.55 ms of roughly 4.2 ms per object end to end — **the request layer costs more than all
      the statements together** — so counting round trips was measuring the wrong thing.
      What actually paid was narrowing the parent read. `create` read the parent's whole detail —
      side-table joins and a `count(*)` of its children — to use one column, and that count grows
      with the parent: a new sensor under a device with four hundred of them counted four hundred
      rows to check a *kind*. Reading two values took that statement from 0.371 ms to 0.146 ms.
      Folding `object_parent_kind_is_valid` into the same read removed a round trip and moved the
      end-to-end number by less than the run-to-run noise, because that round trip was a trivial
      function call.
      **The detail re-read cannot be removed**, which the task assumed it could. Every side-table
      write bumps the object's version by trigger, so `RETURNING` from the object insert yields
      version 1 while the committed object is at 2 — and the response carries that version as its
      ETag, so a stale one answers the client's first `If-Match` PATCH with a 412.
      Channel inserts were batched into one statement while in the area: worth nothing until P-05
      declared any channels, and worth five round trips per sensor from the moment it did.
      **P-05 added one back:** the owner's version has to be re-read after the insert, because
      the ETag trigger fires too late for the insert's own `RETURNING` to see it.
      The lever that remains is fewer *requests*, not fewer statements — a batch create endpoint,
      which the `batch()` seam already supports. Not filed: a pipelining client finishes in 5.9 s.
- [ ] **S-15 — State-history retention that cannot lose current state** · M · S-06, M-15 ·
      `sensor_state` is deliberately excluded from S-06's retention sweep. A sensor that has sat
      Up for three years has exactly one row, three years old; `drop_chunks` would take it and
      the sensor would have no known state at all, breaking uptime and SLA — which CLAUDE.md
      requires be computed from state history. Retention here has to carry the latest row per
      sensor forward before dropping a chunk, and needs a test that ages a quiet sensor past the
      horizon and asserts its state survives.
- [x] **S-14 — Sibling ordering** · S · S-03 · PRTG has manual "move up / move down" ordering
      within a parent; children here sort by `(name, id)`. An operator migrating a hand-ordered
      tree will notice on day one. One nullable `sort_order` column and a changed `ORDER BY`,
      plus a third cursor branch.
      **S-14 outcome:** migration 006, `POST /objects/{id}/order` with
      `{ move: up | down | first | last }`, and `sort=manual` on the listing. Nullable because
      "the operator has not expressed an opinion" and "the operator put this first" are different
      facts — null sorts last and falls back to name, so a tree nobody has arranged reads exactly
      as it did before the column existed.
      **The tree endpoint always honours it**, which the task did not mention but is where an
      operator actually looks. Its walk builds a sort path per level, so the position had to
      become part of that path: `sibling_key()` renders it as fixed-width digits rather than a
      punctuation sentinel, because a sentinel like `~` is at the mercy of the database's
      collation, where non-alphanumerics can be ignored at the primary weight and would sort
      *before* the arranged siblings instead of after them.
      `sort=manual` requires a `parentId` — an arrangement is a fact about one parent's children,
      and ordering a filtered slice of the whole tree by it would interleave positions from
      unrelated groups into something deterministic and meaningless.
      No unique index on `(parent_id, sort_order)`: reordering writes a permutation in one
      statement and PostgreSQL checks a non-deferrable unique index per row as it goes, so the
      halfway state of a legal permutation would violate it — and a partial index cannot be
      deferred. Name and id break every tie regardless.
      Only rows that actually move are written, so dragging one item in a long list does not bump
      the version of every sibling that stayed put. A move that changes nothing is a no-op with no
      version bump and no audit entry.

## Phase 2 — Scheduler and first sensors

- [x] **P-01 — Hashed timing wheel** · L · F-09 · 1-second resolution, monotonic-clock driven,
      phase-spread by `hash(sensorId) % interval`, resilient to clock jumps. Unit tests assert
      dispatch times under simulated load.
      **P-01 outcome:** `packages/probe/src/scheduler/wheel.ts`, wired into the probe and running
      empty until R-04 pushes it a subtree. **5,000 sensors over a simulated hour: 300,000
      dispatches in 90 ms, every sensor exactly 60 firings, worst gap exactly 60 seconds**
      (`docs/findings/2026-08-25-timing-wheel-measurements.md`). Not ±1s but exact — the wheel
      dispatches on integer ticks, so firings are congruent by construction; the ±1s budget is
      spent on the tick's own lateness, measured at a p95 under 250 ms against the real timer.
      The clock is injected, which is what makes the load and clock-jump tests possible at all:
      an hour of scheduling is 90 ms and a suspended machine is one assignment. `advance()` is
      public for the same reason.
      **A missed period is coalesced, not replayed** — a sensor stalled for thirty periods is due
      once, now, and the skipped ticks are counted. Phase survives the catch-up. A wall-clock
      step dispatches nothing and is counted and logged; measuring that drift against a fixed
      epoch reported one NTP step three times, so it is measured between consecutive checks
      instead.
      The first firing is the next tick on the sensor's phase rather than a whole interval away:
      waiting would leave a new sensor silent for up to a day, and the phase is what keeps a
      500-sensor push from stampeding.
      The class surface is eight members (`add`/`remove`/`has`/`size`/`start`/`stop`/`stats`/
      `advance`), which is the narrowness ADR-001 Decision 2 asked for; no interface is extracted
      because nothing needs a second implementation — see what S-12 had to say about interfaces
      with one.
- [x] **P-02 — Worker pool runner** · L · P-01 · Bounded `worker_threads` pool, per-check
      timeout, `AbortSignal` cancellation, worker recycling after a crash.
      **P-02 outcome:** `packages/probe/src/runner/`, wired to the wheel. Two of Phase 2's four
      exit criteria are now covered by tests: *a deliberately hung check does not delay any other
      check*, and *killing a worker mid-check loses exactly one result and recycles cleanly*.
      **A timeout reports when it happens, not when the check gives up.** The result goes out the
      instant the deadline passes, so a sensor stuck on a dead connection reports Down on
      schedule rather than a minute late; reclaiming the worker is handled separately, and a late
      reply for an already-settled check is ignored.
      **Abort is cooperative first, terminate second.** A check that honours its signal returns
      and its worker is reusable immediately — no restart, nothing counted. One that ignores it
      gets its worker terminated after a grace period. Both paths are tested, which is what the
      registry-by-path seam is for: "a check that ignores its abort" exists in the test tree and
      nowhere in shipped code.
      **Skip-if-still-running is free**, as P-01 predicted: a sensor already queued or running is
      refused and counted, and the wheel has already scheduled its next scan.
      Worker start failures are bounded — three consecutive early exits disable the pool with one
      error rather than respawning at the speed of the event loop. A deliberate recycle sets a
      `retired` flag so the pool does not count its own termination as a crash and spawn a second
      replacement; without it the pool drifted one worker over its bound on every hung check.
      Left for R-02/R-03: results are logged rather than spooled and sent.
- [ ] **P-03 — Child-process runner** · M · P-02 · For shell-outs and user scripts: separate
      process, hard kill timer, resource limits, optional separate OS user.
      **Added by N-10:** `runProgram` in `@ms/shared` already does the bounded-execution half —
      `spawn` with no shell, a `SIGTERM`-then-`SIGKILL` timeout against the whole **process
      group** (a script that backgrounds something otherwise outlives its own kill), output
      bounded but still drained so a chatty program cannot hang on a full pipe, a built rather
      than inherited environment, and optional `uid`/`gid`. It is in `shared` rather than in
      `core` precisely so this task and `T-19` use it instead of writing a second one. What is
      left here is the probe's side: the `CheckPool`-shaped submit/callback contract, and
      resource limits beyond a timeout.
      **Added by P-02:** the pool's contract is the shape to copy — submit returns immediately,
      results arrive by callback, the deadline settles the result rather than waiting for the
      process, and a process that will not die on `SIGTERM` is killed the way a worker that
      ignores its abort is terminated. `CheckRegistry` is the seam both runners resolve through.
- [ ] **P-04 — Backpressure and lag metrics** · M · P-02 · Skip-if-still-running, deferred-check
      counter, scheduler lag histogram (p50/p95/p99), pool utilisation.
      **Added by P-01:** `TimingWheel.stats()` already carries the scheduler half — tick lag
      percentiles over the last 1,024 ticks, dispatch count, skipped ticks and clock jumps. Only
      the wheel can measure its own lag, because only it knows the instant each tick should have
      run at.
      **Added by P-02:** `CheckPool.stats()` carries the rest — busy workers, queue depth,
      deferred and refused counts, worker crashes, and percentiles for both queue wait and check
      duration. Skip-if-still-running is implemented; what is left for this task is surfacing all
      of it on Probe Health.
- [x] **P-05 — `SensorType` plugin contract and registry** · L · P-02 · Interface per ADR
      decision 7 (`id`, `category`, `paramsSchema`, `channels()`, `execute()`, `costHint`), startup
      registration, and a documented guide for adding a type. _Highest-leverage task in the backlog._
      **Added by S-10:** `writeOnly` redaction is what lets the audit log record parameter
      *values* rather than only which keys changed. Until it exists, `audit/diff.ts` deliberately
      records names alone.
      **Added by S-07:** channels are created by `ChannelResolver` the first time a sensor
      reports them, taking `name` and `unit` from the wire and leaving `is_primary` false —
      nothing yet declares which channel is a sensor's primary one, and a bulk insert cannot
      guess without risking the one-primary-per-sensor index. The registry is what should
      declare it.
      **Added by S-03:** parameters marked `writeOnly: true` in a type's `paramsSchema` are
      redacted from every read path, and A-10 tests it. Until then `sensor_config.params` is
      returned verbatim, so an operator who pastes an SNMP community into `params` has put it
      somewhere every read returns — the one credential surface S-03 could not close. Swap
      `permissiveSensorTypeGate` for the real registry in `main.ts`.
      **P-05 outcome.** Shipped as a new workspace package, `@ms/sensors`, because both services
      need the contract and only one may call `execute`: the core reads `paramsSchema`,
      `channels()` and the `writeOnly` marks, the probe's pool workers load the catalogue by path.
      One type stays one file, which is what ADR Decision 7 is for. `standardCatalogue()` is
      **empty** — the first four types are P-08…P-11 — so the core now refuses to create any
      sensor and says so at boot rather than accepting configuration for a check that cannot run.
      The credential hole is closed at one boundary, `ObjectService.#redact`, so a new endpoint
      cannot forget it; `redactedParams` carries the names so a form can still show "set".
      Rotation stays auditable because the changed-key list is computed *before* redaction —
      both sides otherwise redact to the same absence and a rotated secret would look like no
      change at all. `GET /api/v1/sensor-types` publishes the schemas the add-sensor form is
      generated from. Guide: `docs/adding-a-sensor-type.md`.
      **Found while doing it, both now fixed:** declaring channels made sensor creation return a
      stale `version`, because writing `channel` fires the ETag trigger after the insert returned
      — the same trap S-16 documented for `sensor_config`. And the build-hygiene test only
      checked compiled *tests*, so a deleted `src` module kept shipping in the tarball; widening
      it to `src` across every package immediately found `timeseries/repository.js`, orphaned by
      the S-12 rename and shipped ever since.
- [ ] **P-06 — Protocol simulator harness** · L · F-02 · Mock SNMP agents, scriptable-latency
      HTTP server, SSH server, syslog sender, flow exporter. Shipped as a package, used by every
      sensor test.
- [ ] **P-07 — ICMP spike and decision** · M · P-06 · Benchmark system-`ping` wrapper vs raw
      socket at 1,000 targets for throughput, accuracy and privilege cost. Record the outcome in
      ADR-001.
- [x] **P-08 — Ping sensor** · M · P-05, P-07 · Availability, RTT, packet loss channels;
      configurable count, size, timeout.
      **P-08 outcome.** Built against the ADR's already-made decision (system `ping` binary)
      rather than waiting for P-07, which is the *benchmark* that would justify the optional
      raw-socket path, not a prerequisite for the default one. We spawn the binary ourselves
      instead of using the `ping` npm wrapper the ADR suggests: it exposes no `AbortSignal`, and
      a check that cannot be cancelled has its worker terminated on every timeout. Recorded as an
      amendment to Decision 7's dependency table.
      **Two channels, not the three named here.** `rtt` (primary) and `loss`. Availability would
      be a channel that can only ever hold one value: a run with no replies has no round-trip
      time, so it throws, and CLAUDE.md is explicit that a Down sensor records *no* channel
      values — leaving availability reading 100 on every sample it ever had. `loss` already
      carries it.
      **The parsing is a pure function** with real captured output from Linux, BSD and Windows as
      fixtures, because that is where the risk is for the most-used sensor type. It found one
      thing worth knowing: Windows counts an ICMP "Destination host unreachable" as a *received*
      packet and reports `Received = 2, Lost = 0 (0% loss)` for a host that is not there. Loss is
      computed from timed echo replies; believing the summary would report perfect health for an
      unreachable target.
      **Added for it:** `CheckContext` gained `target` — a check with no target cannot check
      anything, and the host belongs to the parent device, not to sensor params. That surfaced
      the probe redeclaring `CheckContext` and `CheckExecution` instead of importing them from
      `@ms/sensors`; the copies are gone.
      **Not yet running anywhere.** `R-04` is what tells a probe which sensors it owns, so the
      wheel still has nothing to dispatch. The type is exercised end-to-end against loopback in
      `packages/sensors/test/icmp-ping.test.ts`.
- [x] **P-16 — The development toolchain has no `ping`** · S · — · `scripts/dev.sh` runs the
      probe in `node:24-bookworm`, which ships no `iputils-ping`, and ADR-001 makes the system
      `ping` binary the default ICMP path. P-08 therefore cannot be developed or tested in the
      container the rest of the work happens in. Either build a thin toolchain image with the
      package, or have the probe report a missing ICMP binary once at startup rather than as an
      identical failure on every check. Found while standing the dev target up, not by a test.
      **Done both ways.** `dev/toolchain/Dockerfile` is `node:24-bookworm` plus `iputils-ping`
      and `iproute2`, and the compose service builds from it — which is what let P-08 be tested
      at all. The sensor also names the missing binary rather than failing anonymously, since a
      probe in a minimal production container hits the same wall.
- [ ] **P-09 — HTTP sensor** · M · P-05 · Status code, response time, size channels; timeout,
      redirect and TLS-verification options.
- [ ] **P-10 — Port sensor** · S · P-05 · TCP connect with timing; optional banner match.
- [ ] **P-11 — DNS sensor** · S · P-05 · Resolve a record type, validate the value, time the
      query; configurable resolver.
- [ ] **P-12 — Core Health sensor** · M · P-05, S-07 · CPU, memory, ingestion queue depth, DB
      write latency, notification queue depth, config age.
      **Added by S-07:** `Ingestor.stats()` and `IngestionService.stats()` carry the ingestion
      half of ADR decision 11 — queue depth, refused and failed batches, duplicate readings, and
      write latency percentiles over the last 1,024 writes.
      **Added by N-04:** `AlarmScheduler.stats` carries the notification half — sweeps, steps
      fired, wakes, idle wakes and when it intends to look again. `AlarmEngine.stats` adds queued
      requests and the steps that fired with no template configured, which is what an operator
      wondering why a trigger is silent needs to see.
      **Added by U-02:** `StateBroadcaster.stats` is the live-stream half — subscribers
      attached, events published and delivered, subscribers cut off for falling behind, and the
      state changes published while nobody was watching. The one that matters is the cut-off
      count: it is a browser being handed a tree it cannot keep up with, and it is invisible from
      anywhere else.
      **Added by N-13:** `DeliveryHealthReader` is the notification half, and is already served
      at `GET /notification-health` so an operator has an answer before this ticket lands. The
      channels it should become: pending notifications, of those how many are being retried, the
      age of the oldest undelivered one (the number that goes wrong first), notifications given up
      on in the last hour, and discards. Its `status` already applies the rule this sensor wants —
      Down when an alarm was given up on or when one has been undeliverable past
      `notifications.retry.staleAfterSeconds`. Read it rather than recomputing, so the sensor and
      the API cannot disagree about whether delivery is working.
      **Added by S-06:** the housekeeping loop is a subsystem with a queue, so CLAUDE.md requires
      it to report here. The channels that matter are rollup lag per tier — `now()` minus
      `rollup_watermark.watermark`, which is the number that goes wrong first and silently — plus
      the depth of `rollup_backfill` and `channel_reap`, and the pass duration.
      `Housekeeper.runOnce()` already returns all of it in `HousekeepingReport`.
- [ ] **P-13 — Probe Health sensor** · M · P-04 · Scheduler lag, deferred checks, pool
      utilisation, connection state, spool depth, version skew.
- [ ] **P-14 — `prom-client` metrics endpoint** · S · P-04 · Everything in P-04, P-12 and P-13
      exposed for external scraping too.
- [x] **P-15 — 5,000-sensor benchmark** · L · P-08…P-11, P-06 · Sustained 1-hour run: **p95
      dispatch jitter < 1 s on 8 cores**. Results recorded in the repo. _Architecture go/no-go
      gate._

      **P-15: go, with one number changed.**
      `docs/findings/2026-08-26-scheduler-benchmark.md`, reproduced by
      `packages/probe/test/perf/scheduler-benchmark.test.ts`.

      Jitter is measured **end to end** — due to check-started — because a sensor whose check sat
      in a queue for four seconds fired four seconds late whatever the wheel did. The checks
      sleep rather than burn CPU, because that is what a real check does.

      **The wheel is not the bottleneck at any pool size that matters**: its own p95 lag stayed
      between 4 and 10 ms against a 1,000 ms budget, including in the runs where end-to-end
      jitter was sixteen seconds. `ADR-001` Decision 2 is vindicated against a real timer and
      real load, not just `P-01`'s simulated clock.

      **The pool default was wrong by a factor of sixteen**, and this is what found it. It was
      `availableParallelism() - 1` — a CPU-shaped number for work that is not CPU-bound — which
      refused 21% of checks and delayed the rest by a p95 of **15.8 s**. Changed to a flat 48,
      chosen from a measured sweep, and *not* derived from the core count: the governing quantity
      is the **dispatch batch**, because the wheel fires once a second and hands over a whole
      second's worth at once. 83 sensors in one go, draining in tranches of
      `ceil(batch / slots)`. 48 is two tranches; 64 measured no better for 38 MB more; 128 bought
      200 ms for another 550 MB with an unstable p99; 256 was worse everywhere, the wheel's own
      lag rising to 676 ms as the threads contended with its timer.

      **The sustained hour closes the gate.** 5,000 sensors at 60 s for an hour against the new
      default: **300,095 checks dispatched, 300,095 completed, 0 refused**, p95 dispatch jitter
      **216 ms** against the 1,000 ms budget (p50 8 ms, p99 225 ms; wheel 11 ms, queue wait
      209 ms). The p99 sits 9 ms above the p95 — a distribution with no tail rather than one that
      was not sampled, which is the thing 30-second points could not have shown. Resident memory
      grew 515 MB over the hour, of which the sweep attributes ~290 MB to the pool itself and the
      rest to the working set of five thousand scheduled sensors.

      Left open, with the measurement behind them: `P-18` (demand-driven pool sizing — a fixed 48
      costs ~290 MB whether the probe watches 5,000 sensors or 50) and the fact that our own
      `icmp.ping` is a three-second check, which at the v1 target would want 250 slots. Neither
      is urgent; both are what Phase 6 walks into.
- [ ] **P-18 — Demand-driven worker pool sizing** · M · P-15 · Grow the check pool when the queue
      is persistently non-empty and shrink it when idle, within a configured bound, so a probe
      pays for the slots its workload needs rather than for a fixed default. `P-15` measured the
      cost of getting it wrong in both directions: 7 slots refused 21% of checks and delayed the
      rest by 15.8 s, while a flat 48 costs ~290 MB of resident memory on a probe watching fifty
      sensors. The sweep in `scheduler-benchmark.test.ts` is the harness to prove it against.
- [ ] **P-19 — Bulk provisioning path** · M · S-16, D-04 · Create a subtree in one request rather
      than one object per request. `docs/findings/2026-08-25-tree-build-measurement.md` records
      the serial 5,000-object build eroding from 21.0 s to 29.3 s across Phase 3, recovered to
      23.7 s by guarding `M-08`'s ancestor query. What remains is per-object work that is
      genuinely needed (`M-02`'s `sensor_runtime` row); the answer is to stop paying an HTTP
      request and a transaction for each of five thousand objects, which discovery needs anyway.

## Phase 3 — State machine

- [x] **M-01 — Write the state and pause precedence tables** · S · — · Document every transition
      and the evaluation order of the four pause sources _before_ writing code. Reviewed against
      `WORKFLOW.MD §4–5`.
      **M-01 outcome.** `docs/state-machine.md` is the specification, and
      `packages/core/src/state/tables.ts` is the same thing as data — no state machine, just the
      tables `M-02` implements against, so the spec cannot be mistranscribed into it.
      **A layered model, not a matrix.** Pause → simulated → probe → no-reading → worst(query,
      channel) → acknowledgement, first match winning. An 8 × 15 grid is neither what the system
      does nor something a reviewer can check by eye; the transition list in §4 is derived from
      the layers rather than authored beside them, because two hand-maintained lists disagree
      eventually and the wrong one is always the one not under test.
      **The pause sources are a set, not a priority chain.** A sensor is paused while *any* is
      set; the order only decides which cause is reported. That is the distinction `PLAN.md`
      names as this phase's principal risk: as a chain, resuming the parent would resume a sensor
      somebody had also paused by hand. All sixteen combinations are written out *and* computed
      from the rule, and a test asserts the two agree — two derivations catch a mistake in
      either, one checked against itself catches nothing.
      **Decided here, and marked as such in the document:** pause beats a lost probe and a
      simulated error; a failed scan produces no channel-derived state, because it produced no
      channel values; the channel cause wins a tie with the scan cause, because "response time
      over 500 ms" tells an operator more than "the scan failed"; `down_acknowledged` still
      triggers dependency pausing, because an acknowledgement is a statement about notifications
      and not about the outage; an expired acknowledgement reports cause `user`.
      **Seven transitions the `WORKFLOW.MD §4` diagram does not draw** are listed with what
      requires each, so the review is auditable rather than asserted. Nothing in the diagram is
      missing from the table.
      **16 tests**, including two that read the enums back out of a migrated database: a state
      the code can produce and the column cannot store is a write that fails while recording an
      outage.
- [x] **M-02 — Core state machine** · L · M-01, P-05 · The six v1 states (Up, Warning, Down,
      Down (Acknowledged), Paused, Unknown), all transitions between them, cause attribution on
      every change. Unusual and Down (Partial) are `[V2]`; leave room in the type for them.
      **Added by S-07:** the wire already carries what this needs — a result's `outcome`,
      `message` and `durationMs` reach `IngestionService.acceptResults` and are deliberately
      dropped there, because deciding a state is this task's job, not the probe's. Hook in at
      that point. `sensor_state` writes want the same batching the readings get, so extend
      `Ingestor` with a second row type rather than opening a second pipeline.

      **M-02 outcome.** `packages/core/src/state/` — `machine.ts` is the layered model of
      `docs/state-machine.md` §2 as a pure function with no database, clock or logger, so the
      whole of Phase 3's principal risk is driven from a table; `runtime.ts` is the rows;
      `service.ts` is the cache that makes deciding a state a map lookup at the v1 target.
      Migration 008 adds `sensor_runtime`: current state, cause, message, since, the failure
      count, the four pause flags, the acknowledgement and the simulated-error flag — one row
      per sensor, created **by trigger on `sensor_config`** so a clone or a discovery run cannot
      produce a sensor whose pause `UPDATE` silently matches nothing. It carries no
      `object_touch_owner` trigger: a scan is not a configuration change, and if it bumped
      `object.version` every interval, `R-04` would push a fresh configuration to every probe
      once a minute. For the same reason state is on `ObjectSummary` (listings are never
      conditionally cached) and **not** on `ObjectDetail`, whose ETag is a configuration
      validator; `GET /sensors/:id/state` is the whole answer for one sensor, `no-store`.

      Three things the conformance test found rather than review: `M-01`'s transition table was
      silent about re-entering a state with a different cause, which §5 invariant 10 requires
      (now `TRANSITIONS`, and `state-machine.md` §4.2); an expiring acknowledgement must report
      `user`, not `scan`; and "cleared by recovery" cannot mean "the state is not Down", because
      a lost probe reads Unknown and clearing there un-suppresses an outage nobody has fixed.

      Measured (`test/perf/ingestion-performance.test.ts`): 2.53M samples/min with the machine
      against 2.76M without — **8.3% of throughput**, 25× the 100,000/min exit criterion, p99
      write 38.8 ms against a 100 ms budget. A fleet where every sensor changes state on every
      scan writes 1,900 transitions at a p99 of 28.2 ms.

      Left unwired on purpose, each with a layer, a column and a test: the pause flags
      (`M-08`…`M-11`), the acknowledgement (`M-13`), the simulated error (`M-14`), the channel
      verdict (`M-04`/`M-06`) and probe reachability (`R-05`, and deliberately not persisted).
      `state-machine.md` §7 is the table.
- [x] **M-03 — Two-step failure and retry policy** · M · M-02 · Per-sensor policy from
      immediate-down through warn-N-intervals-then-down; default one warning interval.

      **M-03 outcome.** No new setting: `scan.retryWarnings` (0–10, default 1) was already
      declared in `settings/registry.ts` and inheritable — what was missing is that nothing read
      it. `SensorStateService` now resolves it per sensor through the ordinary chain, so a group
      can say "warn for three intervals" for everything beneath it and one sensor can override.

      The policy cache is kept **apart from** the runtime cache rather than folded into it: the
      runtime is a write-through cache of a table this service owns, the policy is a read-through
      cache of configuration anyone can change from anywhere in the tree. Conflating them would
      make an edit to a group force a re-read of state that edit did not touch, and would make
      the write-failure rewind drop policies for no reason.

      Invalidation is everything-at-once on `setting.set`, `setting.reverted` and `object.moved`,
      not the objects that changed. The setting is inheritable, so working out which sensors an
      edit affects means walking the tree inside the mutation's transaction — while re-resolving
      them costs **one** query for the whole next batch, because `resolveForObjects` answers for
      a set. The precise version would cost more than the imprecise one. The move case is the one
      a "forget what changed" invalidator would miss entirely: nothing about the sensor was
      edited, only which ancestors it has.

      Two things settled in `state-machine.md` §2.1, both left open by `M-01`: **N counts scans,
      not elapsed time** — the setting is a count of failures, and a sensor whose interval
      changes should not silently change how long it tolerates one. And **a policy change takes
      effect at the sensor's next scan**, like an edited limit, because the policy is a rule about
      results. Re-evaluating on the spot needs a subtree pass that `M-08` genuinely needs (a pause
      must not wait for a scan) and this does not.

      One transition the table was silent about, found by driving the machine at it rather than
      by reading: `down` → `warning` with cause `scan`, reachable only by relaxing the policy past
      the current failure count. It is what the operator asked for, so the table gained it
      (`state-machine.md` §4.2).

      A stored value that is not a count falls back to the default and says so. It can only come
      from a hand-edited row, and the failure it prevents is silent: `consecutiveFailures > NaN`
      is false for every value, so the sensor would sit at Warning for ever.
- [x] **M-04 — Channel limits** · M · M-02 · Upper/lower error and warning limits, custom limit
      messages, immediate effect (not subject to the two-step rule).

      **M-04 outcome.** `packages/core/src/state/limits.ts`, pure like `machine.ts` and for the
      same reason — the interesting cases are boundaries and combinations, both cheap to
      enumerate against a function and expensive to arrange against a database. **No migration:**
      migration 001 already provisioned `channel.limits` as jsonb, so this defined its shape,
      validated it at the boundary, and normalised it on read so the response schema could stop
      being `additionalProperties: true`.

      Four decisions `WORKFLOW.MD` does not state, now in `state-machine.md` §2.2: the
      comparison is **strict** (a reading at the limit has not exceeded it, or "at most 100%"
      could not be expressed); **zero is a limit, not an absence**; the **worst channel decides
      here**, because a result carries every channel at once and a limit can only be compared
      against the reading in that same result; and the **message comes from whichever side
      produced the state**, chosen by `cause` so there is no second rule to disagree with it.

      Contradictory limits — a warning past its error limit, a lower above an upper — are refused
      when set, with the reason. A threshold that could never fire is a mistake, and accepting it
      silently means an operator believes they are covered when they are not.

      **Immediate effect has two meanings and both are tested.** A reading past an error limit is
      Down on the very first sample, with no two-step. And an *edited* limit acts on the next
      scan rather than the next restart: ingestion caches what it resolves, so
      `ResultCacheInvalidator` rides the audit sink — the same place `R-04`'s config push sits —
      and forgets the sensor's channels. It invalidates twice, immediately and again after the
      transaction settles, because the sink runs *inside* the transaction and a batch resolving
      in that window would re-cache the pre-commit value. It also drops the whole cache on a
      subtree delete, which closes a pre-existing hole: a spooled result for a deleted sensor
      used to resolve to a channel id that no longer existed and write an orphaned reading
      instead of being counted as a drop.

      A limit change is audited (`channel.limits.set`), diffed field by field. A sensor that went
      Down with cause `limit` is only answerable if the log says who set the limit and to what.
- [x] **M-05 — Multi-channel state rollup** · S · M-04 · Sensor state = worst channel state
      combined with the query-failure state.

      **Absorbed by M-04, not skipped.** The worst-of-channels roll-up is `rollUp` in
      `state/limits.ts` and the combination with the query state is §2.3 in `evaluate`, which
      `M-02` already built. There was no second place to put it: a result carries every channel
      the check produced, and evaluating one channel in isolation is not something the system
      ever does. Tested in `channel-limits.test.ts` ("channel rollup") and through the pipeline
      in `state-ingestion.test.ts`.
- [x] **M-06 — Lookups** · L · M-04 · Definition format, `SingleInt` and `Range` types,
      `undefinedState`, custom definitions overriding built-ins by id, validation and error
      reporting.

      **M-06 outcome.** `packages/core/src/lookups/` — `definition.ts` (the shape, the mapping
      and the rules a schema cannot express), `catalogue.ts`, `loader.ts`, `built-in.ts`.
      Migration 009 adds `channel.lookup_id`; a sensor type may declare one per channel
      (`ChannelDef.lookup`) and an operator may override it through the same `PATCH` that sets
      limits.

      **Not PRTG's `.ovl` XML.** `CAPABILITIES.MD §15` puts config-file compatibility out of
      scope and every other boundary here is a JSON Schema. The concepts are PRTG's — `SingleInt`,
      `Range`, `undefinedState`, custom overriding built-in by id — and the encoding is ours.
      Built-ins are **TypeScript modules**, for the reason migrations are: a lookup shipped as a
      data file is one more thing the packaging step can forget, and a missing one surfaces as a
      sensor that never leaves Unknown. Operator definitions are JSON under `<dataDir>/lookups`.

      Three decisions `CAPABILITIES.MD §1.2` leaves open, now in `state-machine.md` §2.2.1:
      **`undefinedState` is required with no default** — whether an undocumented status code is
      fine or a problem depends entirely on the device, so the author has to say; **a bad
      definition is refused, not repaired**, and served with its reason by `GET /lookups`,
      because a lookup that silently failed to load leaves its channels judged by nothing; and
      **a channel naming a lookup nobody loaded reads `warning`**, not silence (a broken
      configuration would read as healthy), not a fall back to limits (the reason to configure a
      lookup is that a threshold is the wrong tool), and not `down` (the check succeeded — what
      is broken is our ability to read the answer, the same distinction §2 draws for a lost
      probe).

      Also settled: a channel is judged by a lookup **or** its limits, never both; ranges are
      half-open so adjacent bands neither overlap nor gap; overlapping ranges and duplicate
      values are refused, because which entry wins would otherwise be authoring order.

      **Deferred deliberately:** reloading lookups without a restart. Re-judging every channel
      that uses one is a decision worth making explicitly rather than as a side effect of saving
      a file, and `GET /lookups` makes the current state visible either way. `BitField`,
      `Boolean` and `desiredValue` are `[V2]` per `CAPABILITIES.MD §1.2`.
- [x] **M-07 — Scaling factors and spike filter** · S · M-04, M-06 · Multiplication/division,
      decimal places, min/max spike discard.

      **M-07 outcome.** `packages/core/src/ingestion/scaling.ts`, at the seam `M-04` marked in
      `IngestionService.#prepare`. No migration: `scale_mul`, `scale_div`, `decimals`,
      `spike_min` and `spike_max` have been on `channel` since migration 001, with the `CHECK`
      constraints already in place.

      Three decisions, now in `state-machine.md` §2.2.0. **Scaling comes before the spike
      filter**, because bounds and limits are all numbers an operator types in the channel's own
      unit, and two units in one form is a bug that reads as "the filter is ignoring my
      setting". **The scaled value is what is stored** — one number, so a chart can never
      disagree with the alarm that fired; storing raw and scaling on read would work, since every
      rollup aggregate is linear, but two representations of one measurement is exactly how you
      get "the graph says 40 and the alarm says 320". The cost is that changing a factor does not
      rewrite history, so the graph steps; that is true of every monitoring system and it is
      visible rather than subtle. **A discarded reading is a gap, not a zero**, and decides
      nothing about the sensor's state either — a wrapped counter must not be able to breach a
      limit.

      "Auto / all / fixed" collapses to two modes: `decimals` null is automatic (as many digits
      as the value needs, no trailing zeros, which is what "all" would mean for a float we
      already store at full precision) and an integer is fixed.

      The invalidator now forgets a sensor's channels on **any** `channel.*` mutation, matched by
      prefix. It was a list of two action names, and `M-07` had already fallen off it before its
      own test caught the stale factor.
- [x] **M-08 — Manual pause** · M · M-02 · Indefinite, 5m/15m/1h/3h/1d presets, until-datetime,
      optional message. Persists across core restart. A cloned object is created manually paused
      with the message `cloned from #<sourceId>` (`S-03`).

      **M-08 outcome.** Migration 010 adds `object_pause`; `packages/core/src/state/pause.ts` is
      the rules, `objects/pause-repository.ts` the storage and the derivation,
      `objects/pause-expiry.ts` the sweep. `POST`/`DELETE`/`GET /objects/:id/pause`.

      **Two facts, not one.** `object_pause` is what an operator asked for — one row per paused
      object, a deadline, a message, who. `sensor_runtime`'s four flags are what that works out
      to per sensor, derived from those rows on every pause, resume, **move** and **create**.
      Deriving on write is a chain walk per pause instead of a chain walk per sensor per scan,
      and it recomputes *from scratch*: clearing one pause does not mean a sensor is unpaused,
      because another ancestor may still hold it.

      **Manual pause applies to any object.** Nobody pauses a sensor during maintenance; they
      pause the device, the group or the probe. That makes the parent cascade unavoidable here
      rather than in `M-12`, which keeps the precedence *integration* across all four sources
      and the exhaustive table test. The three cases a "toggle the flag" implementation misses
      are all covered: a sensor **created** under a paused device is born paused, a subtree
      **moved** under (or out of) one is re-derived, and a **clone** arrives paused.

      **A paused sensor is not in its probe's configuration at all.** `WORKFLOW.MD §3` skips it
      before the check is enqueued, and the cheapest way to skip a check is never to schedule it:
      no new protocol field, no probe-side rule to keep in step with the core's four sources, and
      a probe cannot scan something it was not told about.

      **Immediately, unlike a failure policy.** `M-03` could defer to the next scan because a
      policy is a rule about results; a pause is not. `SensorStateService.reevaluate` writes the
      transitions inside the pause's own transaction — so the sensors change state, the log
      records it, and the probe is told, or none of it happens.

      **A timed pause is computed from the clock and swept every 30 s.** Every read is already
      right the moment the deadline passes; the sweep exists for the three things that are writes
      — the transition, the log entry, the config push. Not a timer per pause: a process holding
      five thousand timers loses all of them on a restart, and a pause outliving the core is the
      normal case rather than the exception.

      Resuming is refused for an object held only by a cascade (`WORKFLOW.MD §5`), and the 409
      names the object to resume instead — "you cannot do that" without "here is what you can do"
      is the least useful error a UI can render. `M-12`'s "cascade-paused children cannot be
      resumed individually" is therefore already in place for the two sources that exist.

- [x] **M-09 — Schedules** · L · M-08 · **`M-08` left the flag:**
      `sensor_runtime.paused_by_schedule`, plus `PauseRepository.recompute` to model a second
      derived source on, and `SensorStateService.reevaluate` to make a window opening or closing
      take effect at the moment it does. Reusable schedule objects; weekly grid **and** period-list
      (`ww:hh:mm-ww:hh:mm`) authoring; suppress monitoring, notifications and reports.

      **M-09 outcome.** Migration 011 adds `schedule`; `packages/core/src/schedules/` holds the
      model (`definition.ts`), the storage and derivation (`repository.ts`), the recompute
      (`pauses.ts`), the CRUD service, the audit-sink hook (`sync.ts`) and the sweep.
      `GET`/`POST`/`PUT`/`DELETE /schedules`. Assigning one is not a route of its own — see
      below.

      **A library table, not a branch of the tree.** A schedule is referenced by many objects and
      belongs to none; giving it a place in the tree would give it a parent whose settings it
      inherits, a position among siblings and a pause of its own. `[V2]`'s templates and report
      definitions want the same shape.

      **The assignment is an ordinary inheritable setting** (`schedule.id`), so a group sets it,
      a device overrides it, a sensor reverts, and the settings form renders it for free — one
      inheritance chain resolved in one place, as `CLAUDE.md` requires. Setting it to `null`
      explicitly is a meaningful override: "monitor me always", which is how one device inside a
      scheduled group is exempted. The price is that jsonb carries no foreign key, so the delete
      path checks for references itself and names the objects still using it.

      **One canonical form, two editors.** Half-open intervals in minutes from Monday 00:00,
      sorted, disjoint and merged. A period that wraps past Sunday midnight — `fr:19:00-mo:06:00`,
      the shape every maintenance window has — is stored as the two intervals it really is, so
      the evaluator is a containment test with no wraparound case. The grid is a rendering of the
      same intervals, with `gridIsExact` false when minute-level edges cannot be drawn on hourly
      cells, so a UI can say that switching editors will round rather than letting somebody find
      out by saving.

      **Polarity is stored, because the two source documents disagreed.** `CAPABILITIES.MD §5`
      describes a grid whose marked cells are when monitoring runs; `WORKFLOW.MD §8` gave its
      period-list example as a maintenance window, which is the complement. Both are things
      operators write, one is the negation of the other, and an editor that silently inverted
      what somebody typed would be worse than either reading. `WORKFLOW.MD §8` now says so.
      Validation refuses a schedule that resolves to no monitored minutes at all in either
      polarity — that is a permanent outage with a name, and the way somebody discovers it months
      later is the failure this subsystem exists to prevent.

      **A schedule carries its own time zone**, `null` meaning the core's own. Office hours that
      do not move with daylight saving are not office hours, so the evaluation goes through
      `Intl` rather than offset arithmetic; both transitions are table-tested, including the
      autumn one where an hour happens twice and the naive next-boundary arithmetic is an hour
      out.

      **Derived downward, not upward.** `resolveForObjects` answers "what does this sensor
      inherit" by walking from each of five thousand sensors to the root; `applyPauses` walks
      from each *assignment* — of which an installation has a handful — down to the sensors it
      covers, stopping where a nearer assignment takes over. Same rule, opposite direction, and a
      test asserts the two agree rather than trusting that they do.

      **On the wall-clock minute, not a computed deadline.** A deadline worked out an hour ago is
      an hour wrong the moment a country changes its clocks, and the boundaries that matter most
      are the ones nobody is awake for. Aligning to the minute cannot drift and costs one
      `LIMIT 1` a minute in an installation that assigns no schedules. That guard asks two
      questions, not one: a test found that "nothing is assigned" is not "nothing to do", because
      clearing the last assignment leaves the flags it set standing.

      **Immediate on every write path that can invalidate it** — assigning, reverting, editing
      the schedule, moving a device — because `ScheduleSync` rides the audit sink and therefore
      runs inside the mutation's own transaction. `object.created` is deliberately excluded:
      discovery creates sensors in thousands and a full recompute per create is the regression
      `P-04`'s budget caught in `M-08`. A sensor created inside a closed window is paused by the
      next sweep instead — bounded, stated, and `M-12`'s to close properly with a subtree-scoped
      recompute if it matters.

      **Notifications and reports are not suppressed here**, because neither exists yet. The
      schedule is resolved and exposed (`GET /objects/:id/pause` names it, and `nextChangeAt`
      says when it lifts) so `N-12` and `[V2]`'s reports consult one answer rather than deriving
      a second.

      Also fixed on the way past: `PauseView.source` reported a manual pause ahead of a parent
      cascade, which is the opposite of the order `WORKFLOW.MD §5` evaluates them in and the
      exact class of bug `M-01`'s tables exist to prevent.
- [x] **M-10 — Maintenance windows** · M · M-09 · One-off start/end datetimes; early cancel by
      setting the end to the past.

      **M-10 outcome.** Migration 012 adds one column, `object_pause.starts_at`.
      `POST /objects/:id/pause` takes `from` with `until`; `objects/pause-expiry.ts` became
      `objects/pause-sweep.ts`, because it now opens windows as well as closing pauses.

      **A window is a pause that has not started yet** — one column, not a second table and not a
      fifth pause source. `WORKFLOW.MD §8` already called it "the one-off equivalent" of a
      schedule, and `M-08` wrote `object_pause` expecting it: its upsert comment says "replacing
      is extending a maintenance window". Everything a window needs was therefore already built —
      the cascade, the resume refusal, the config push, the expiry — and a separate table would
      have duplicated all four. `paused_at` keeps meaning when the row was written;
      `starts_at` is when it takes effect, and every read of a pause now checks both ends.

      **`effective()` returns a window that has not started; `ownActive` says whether it is in
      force.** That split is what makes cancelling a window before it begins the same action as
      ending one that has: `paused` is false while it is pending, `resumable` is true, and an
      operator who booked the wrong weekend does not have to wait for it to start to call it off.

      **The sweep runs at both ends, and reconciles.** It looks for pauses that ended and pauses
      that *began* in the interval since its last pass, recomputing each under its own object so
      the state history carries that window's message — "quarterly patching" is what an operator
      reads on the sensor, and a batched recompute could only have said nothing. The first pass
      after a restart looks back to the epoch, which reconciles every window that opened while the
      core was down without a "have I applied this" column that could disagree with the rows.

      **On the half minute rather than every half minute.** A window given as 22:00 should start
      at 22:00: monitoring that runs into a planned outage is the alarm pausing exists to prevent.
      Aligning the tick costs exactly what not aligning it costs. Lateness at the other end only
      delays a resume, which is the safe side of the same trade.

      **Early cancel is the resume, not an end time in the past.** `CAPABILITIES.MD §5` describes
      PRTG's mechanism; ours reaches the same outcome with the action that already exists, and the
      refusal on a past deadline now names it. Two ways to spell one operation is what `M-01`'s
      tables exist to prevent, and `DELETE /objects/:id/pause` was already the button.

      Two audit entries, deliberately: one when somebody schedules the outage, one when it
      happens. "Who booked the change window" and "when did monitoring actually stop" are
      different questions, and a `from` in the first is what distinguishes it from an ordinary
      pause.
- [x] **M-11 — Dependencies** · L · M-08 · **`M-08` left the flag:**
      `sensor_runtime.paused_by_dependency`. _Use parent_, _select object_, _master object for
      parent device_; recursive cascade; **master keeps scanning while dependents are paused**;
      delay-after-recovery; manual/schedule pauses do not cascade via dependency.

      **M-11 outcome.** Migration 013 adds one column, `sensor_runtime.dependency_clear_at`.
      `packages/core/src/dependencies/` holds the modes (`mode.ts`), the SQL (`repository.ts`),
      the reactor (`pauses.ts`) and the audit-sink hook. `PUT /objects/:id/dependency`. The last
      of `M-08`'s four flags is now set by something.

      **Three modes, one setting.** `dependency.masterId` is an ordinary inheritable value, so
      *use parent* is not defining it, *select object* is defining it, and *master object for
      parent device* is defining it **on the parent device** rather than on the sensor. That last
      one is the whole trick: the setting lands on the device, every sensor under it inherits
      that sensor as their master, and the master is excluded from its own dependency — which is
      exactly what makes it keep scanning while its dependents are paused. PRTG carried that bug
      through v19.1, and here it falls out of one `a.master_id <> o.id` rather than a special
      case.

      **Driven by state changes, not by a clock.** A schedule recomputes on the minute because
      time is what moves it; a dependency moves when a master's state moves, which happens in the
      ingestion path thousands of times a minute. So the first question asked of every batch is
      whether any sensor that changed is the master of anything — one indexed lookup — and an
      installation with no dependencies never gets past it. The reaction runs **inside the
      ingestor's own transaction**: a dependent whose result arrived between the master's Down
      committing and the pause being written would raise the alarm the dependency exists to
      suppress.

      **The cascade is a fixpoint, not a recursion.** Each round of the recompute propagates one
      level and the loop runs until nothing moves, so dependents of a paused dependent pause too.
      Bounded, so a cycle that got in some other way is a logged error rather than a transaction
      that never returns.

      **A loop is refused where it is made.** If A's master is B and B's master is A, whichever
      fails first pauses the other, the paused one stops scanning, and neither can ever recover:
      a permanent outage produced by two dropdown selections with nothing able to notice it. The
      check walks the effective-master chain and exempts the master itself, because "master for
      parent device" puts the master inside the subtree it governs and that is not a loop.

      **The delay lives in a column, not a timer** — `docs/state-machine.md §6` asked `M-11`
      where. A deadline on the master survives a restart and cannot be lost by a process that
      dies mid-flap, and the flap question answers itself: a fresh failure discards the deadline,
      a fresh recovery writes a new one, nothing accumulates. A delay of **zero releases in the
      recovery's own transaction**; a non-zero one is released by the pause sweep, which is
      already the thing that notices deadlines.

      **A master must be a sensor.** Devices and groups have no state of their own — `M-02` put
      state on sensors — so "the device is Down" is not yet a fact anything could read. Refusing
      is honest; accepting would create a dependency that silently never fires. Widen it when a
      device-level rollup exists.

      Only a genuine `down` or `down_acknowledged` triggers the pause, so pausing a master by
      hand or by schedule does not cascade via dependency (`WORKFLOW.MD §5`); the acknowledged
      case is included because an acknowledgement is a statement about notifications, not about
      the target. `M-17`'s alarm-storm scenario is what will hold all of this to *one outage, one
      alarm*.
- [x] **M-12 — Pause precedence integration** · M · M-08…M-11 · Parent cascade → dependency →
      schedule → manual, exhaustively tested. Cascade-paused children cannot be resumed
      individually, and the API says so clearly.

      **M-12 outcome.** `packages/core/test/pause-precedence.test.ts` arranges all sixteen
      combinations against a real tree, through the mechanism that really sets each flag — a row
      in `object_pause`, a master going Down, a window closing, an operator clicking pause — and
      **never writes a flag by hand**. For each it asserts the four flags, the state, the reported
      cause, the pause view's `source`, and that the sensor is in its probe's configuration iff it
      is not paused.

      **Why this is not what `M-01` and `M-02` already tested.** Those are one derivation checked
      against itself: `state-tables.test.ts` checks the table against the rule it was written
      from, and `state-machine.test.ts` drives the pure evaluator over the same table. Neither can
      see whether the four *mechanisms* produce the flags the table describes, which is the thing
      `PLAN.md` names as Phase 3's principal risk — four independent recomputes, each written in a
      different task, each convinced it owns a column.

      **The property the risk is about, tested directly.** Turn all four on, then clear them one
      at a time: the sensor stays Paused through every step and the reported cause walks down
      `parent → dependency → schedule → user`. If precedence were a priority chain rather than an
      independent set, lifting the top source would have resumed it.

      **Two interactions the sixteen rows cannot express**, both tested separately. Pausing a
      group that *contains* a dependency's master releases that dependency — a paused master is
      not a Down master (`WORKFLOW.MD §5`), which is the opposite of what "pause the group" sounds
      like it should do. And resuming the object that was directly paused does not resume a sensor
      another source still holds; the cause moves, the pause does not lift.

      **The API now says which source it is.** `refuseResume` only knew about `object_pause`
      rows, so an object held by a schedule or a dependency was told "this object is not paused" —
      wrong, and the least useful thing to say to somebody looking at a blue sensor. The 409 now
      names the holder in the same order §5 evaluates them, with the group to resume, the master
      to wait for, or the time the window opens, and a machine-readable `source` beside it.

      Checked by mutation rather than assumed: inverting the view's parent/dependency precedence
      fails five of the twenty-five, which is the shape a real regression would have.
- [x] **M-13 — Acknowledgement** · M · M-02 · **`M-02` left the columns and the transitions:**
      `acknowledged_at` / `acknowledged_until`, expiry against the result clock, and clearing on
      a recovery that a reading decided. What is missing is the API, the presets and who did it. Down (Acknowledged) state, until-options, message
      stored as last message, expiry back to Down, cleared by pause+resume, permission grantable to
      read-only users.

      **M-13 outcome.** Migration 014 adds `acknowledged_by_kind` / `acknowledged_by_label`.
      `packages/core/src/state/acknowledgement.ts` is the rules,
      `SensorStateService.acknowledge` the write, `POST`/`DELETE /objects/:id/acknowledge` the
      API.

      **`M-02` left a hole, and this task's first test fell into it.** The machine cleared an
      acknowledgement on recovery and on expiry — but only in the cached facts. `RuntimeWrite`
      carried no acknowledgement field, so `writeRuntimes` never touched the columns: a sensor
      that recovered still had `acknowledged_at` set in the database, and a cache eviction or a
      restart brought the silenced alarm back silenced. `RuntimeWrite.acknowledged` now carries
      it, and the write only ever *clears* — nothing about a result can create an
      acknowledgement. Live-correct, restart-correct, and it was invisible to `M-02`'s own tests
      because those asserted the facts the machine returned rather than the row it left behind.

      **Acknowledging works on anything above a sensor.** Nobody wants to click forty times when
      a switch fails, so acknowledging a device or a group covers every sensor beneath it that is
      Down **at that moment** — a snapshot, not a rule. A sensor that fails an hour later is a new
      alarm nobody has looked at, and silencing it would be the opposite of what was meant.
      Refused when nothing beneath is Down, because §2.4 applies the layer only to `down` and an
      acknowledgement stored anywhere else would sit silently and suppress the *next* outage.

      **The message becomes the sensor's last message** (`CAPABILITIES.MD §5.3`). That needed one
      change in `reevaluate`, which blanked the message for anything that was not a pause: it now
      carries the operator's words whenever the operator's action is what decided the state, and
      blanks them otherwise — the reason a sensor is Unknown after a resume is that nobody has
      scanned it.

      **A fourth way to clear one, beyond the spec.** `CAPABILITIES.MD §5.3` lists recovery,
      expiry and pause-then-resume; all three are *events*, and none of them is "I acknowledged
      the wrong sensor". Pause-then-resume as the only undo costs the sensor its failure count
      and leaves it Unknown, which is a worse outcome than the mistake. `DELETE
      /objects/:id/acknowledge` is one call on the same write path, both halves audited. Added to
      `CAPABILITIES.MD` rather than left as an undocumented extra.

      **Who, on the state read.** Two columns, deliberately absent from the batch read that
      ingestion uses — the audit log has more detail, but an operator looking at a red sensor
      that is not paging anybody should not have to go searching for who decided that.

      Left for `A-03`: "permission grantable to read-only users". There are no accounts yet
      (`A-01`), and every actor is still the caller's address; the route is the one place the
      permission will attach.
- [x] **M-14 — Simulated error state** · S · M-02 · **`M-02` left the column and the layer:**
      `sensor_runtime.simulated_error`, evaluated below pause and above everything else. Force a sensor Down to test notification
      chains end to end.

      **M-14 outcome.** No migration — `M-02` left the column and §2 layer 2 already reads it.
      `SensorStateService.simulate` is the write, `POST`/`DELETE /objects/:id/simulate-error` the
      API.

      **Loud, not expiring.** A pause and an acknowledgement both take an optional deadline
      because a forgotten one looks exactly like a healthy sensor. A forgotten simulated error
      looks like a *screaming* one, with `simulated` written on it in the state, the transition
      and the audit entry — so what makes it safe is that it cannot be mistaken for a real
      outage, not that it lapses. A deadline was considered and left out for that reason rather
      than overlooked.

      **It keeps being scanned.** Only the four pause flags remove a sensor from its probe's
      configuration, so a forced sensor goes on measuring — the force changes what its readings
      *mean*, not whether it takes any. That is why lifting one returns it to the truth
      immediately instead of yielding Unknown the way a resume does: there is nothing to wait
      for.

      **Everything downstream behaves as it would in a real outage**, which is the point of a
      chain test: the transition is recorded in `sensor_state`, and a master forced Down pauses
      its dependents exactly as a real failure would. Pausing still wins (§2 layer 1) — a sensor
      somebody switched off must not start paging people because somebody else was testing.

      On a sensor, or on anything above one, in which case **every** sensor beneath it is forced
      rather than only the Down ones: forcing a Down is not a statement about the current state.
      `M-17`'s alarm-storm scenario is what wants the subtree form. The API description says
      plainly that this fires the real chain at real people.

      **Corrected by U-06.** "It keeps being scanned" had a consequence nobody had looked at: the
      scan that ran a second later overwrote the runtime *message* with the probe's, so a forced
      sensor read "Down — 2/2 replies, min 0.072 ms". Invisible until the alarms view put the
      message on the operator's home screen. `SensorStateService` now consults `operatorDecided`
      on the result path — the same rule `reevaluate` already used — and keeps the operator's
      words for as long as the operator's action is what decides the state.
- [x] **M-15 — State-change log** · M · M-02, S-10 · Every transition with previous state, new
      state, message and cause.

      **M-15 outcome.** No migration: `M-02` has written every transition to `sensor_state`
      since it landed, because `CLAUDE.md` computes uptime from state history rather than from
      samples — the rows had to exist whether or not anybody read them. This is the reading.
      `packages/core/src/timeseries/state-log.ts` and `GET /state-log`.

      **One route, scoped, not two that drift.** `CAPABILITIES.MD §8`'s Logs view and the sensor
      detail page's log tab are the same query with a different `objectId`: a sensor id gives
      that sensor's log, a group id gives everything beneath it, and no id gives the
      installation. Filters on `state` and `cause`, both repeatable, and on a time range.

      **Duration is computed, not stored, and measured against the real next transition.** A
      transition's row cannot know how long the state lasted — the answer arrives with the next
      one, and storing it would mean going back to update an append-only hypertable. The obvious
      implementation is a window function over the page, which is free and wrong: it makes a
      state's duration depend on where the page boundary fell, so the same transition reads
      "28 minutes" or "still running" according to how the client paged. A lateral join on
      `(sensor_id, time)` costs one index seek per row and is stable. `null` means the state the
      sensor is still in, and only that.

      **History outlives its sensor.** The join to `object` is a left join on purpose: the
      transition most worth reading may be the last one a deleted sensor made. The name comes
      back empty rather than the row disappearing.

      Two bugs found on the way, both fixed here:

      - **`/objects?kind=a&kind=b` was a 400.** The schema put an `enum` beside `items`, and an
        `enum` is checked against the *whole* value — so the array Fastify builds from two
        occurrences failed validation, while the handler behind it had always called `asArray`
        and the service had a passing test for the multi-kind filter. `oneOf` covers both shapes
        and validates both; there is now an HTTP-level test, which is the level the bug lived at.
      - **A test-helper throw could hang the runner.** `createScratchDatabase` validated the
        database name *after* connecting its admin client, so a prefix it refused left an open
        socket and a run that hung for ever instead of failing. Validated before anything opens
        now. (The prefix it refused was mine: `state-log`, with a hyphen.)
- [x] **M-16 — Property-based state machine tests** · L · M-12, M-13 · No event sequence reaches
      an undefined state; invariants hold under shuffled and duplicated events.

      **M-16 outcome.** `packages/core/test/state-machine-properties.test.ts`, using `fast-check`
      (the first test dependency beyond `node:test` and `vitest`; shrinking is what makes a
      counterexample actionable, and every one below arrived as three to five events).
      `MS_PROPERTY_RUNS` turns the depth up; the default is 500 per property and a 300,000-run
      sweep takes 50 seconds because the machine is pure.

      **Why this is not what `M-02`'s exhaustive test already did.** That one drives `evaluate`
      over the *entire* static input space — sixteen pause combinations × simulated × probe ×
      acknowledged × five scan facts × four channel verdicts — and exhaustive beats sampled every
      time. What it cannot reach is anything that depends on history: the two-step policy counts
      consecutive scans, an acknowledgement expires against the result clock, a resume forgets
      what was measured, and a redelivered batch must advance none of them. Those are properties
      of a **fold**, and a fold has no finite input space to enumerate.

      **Two real defects, both in the acknowledgement layer, both live:**

      - **An acknowledgement survived a recovery that did not arrive as a result.** §2.4 says it
        is cleared by recovery to any non-Down state, and `applyResult` did that — but
        `reevaluate` did not. Force a simulated error on a healthy sensor to test a chain,
        acknowledge the forced alarm, lift the force: the sensor is Up carrying an
        acknowledgement made against an outage that never existed, invisible because nothing
        displays one on an Up sensor, and it silences the next *genuine* failure. The rule is now
        `clearedByRecovery`, applied on both paths, with an integration test that fails the next
        real outage if it regresses.
      - **A lapsing acknowledgement claimed a change nobody could see.** The expiry override
        reported cause `user` whenever the computed state was Down — including when the Down came
        from a simulated error (so `M-14`'s promise that a forced outage is unmistakable was
        broken), and including when the acknowledgement had never actually suppressed anything.
        It now requires both that the reading decided the state and that the sensor really was
        showing Down (Acknowledged).

      **Four gaps in `M-01`'s transition tables**, all of them states the machine reaches and the
      tables did not describe: `paused → unknown : probe` and `paused → down : simulated` (a
      resume while the probe is away or a force is set), `down_acknowledged → down : scan` (a
      withdrawal, which `M-13` added), and `unknown → down_acknowledged : user` (a probe
      returning to a still-acknowledged outage). The first two were hand-enumerated `from` lists
      that excluded `paused` on the reasoning that pause outranks those layers — true while
      paused, beside the point at the instant it resumes. Those entries are now derived from the
      layers rather than listed.

      **Two flaws in the generator, which is the same thing working.** It invented a channel
      verdict of `up` with cause `limit`, which `rollUp` never returns — "within limits" is not a
      fact about a limit — and it acknowledged sensors that were not Down, which `M-13` refuses.
      Both were caught by the table property reaching transitions nothing can produce, and both
      are now modelled with the production predicates (`CHANNELS_CLEAR`, `canAcknowledge`) so the
      model cannot drift from what the system allows.

      Also extracted `isStaleResult` out of the ingestion fold, so the at-least-once property
      exercises the rule production uses rather than a second copy of it.
- [x] **M-17 — Alarm-storm scenario test** · M · M-11 · A simulated switch failure produces one
      dependency-suppressed alarm, not one per downstream sensor.

      **M-17 outcome.** `packages/core/test/alarm-storm.test.ts` builds the topology `PLAN.md`
      describes — a switch, its Ping sensor as master for its device, and eight servers of five
      sensors each behind it — unplugs the switch, and counts. Forty downstream sensors, so
      "not forty" is literal.

      **What it asserts.** One sensor ends Down with cause `scan`; forty end Paused with cause
      `dependency`; the probe's configuration drops to exactly one check, on the master, because
      a master that stopped being scanned could never report its own recovery. On the way back
      up, the master recovers and the forty return to Unknown rather than to a state nothing has
      checked since. And the other half of *one outage, one alarm*: a single server failing
      behind a healthy switch still alarms, because a dependency must not swallow an outage that
      is genuinely its own.

      **The measurement `N-15` needs.** The forty dependents fail in the same batch that takes
      the master Down, so each does record a Down — decided against facts that the dependency
      reaction, later in the same transaction, then supersedes. That is truthful: the check did
      fail, and the system then attributed the failure to the master. What matters is that none
      of them *stands*: exactly one Down has no successor, and the superseded ones last **one
      millisecond**, inside a transaction nothing outside ever observed. Notification latency of
      any usable length is four orders of magnitude longer, which is why `N-15` will find no
      message — and `CLAUDE.md` names latency as one of the three mechanisms for exactly this.

      **One real bug found and fixed.** The dependency's `paused` transition was written at the
      same instant as the Down that caused it, and `sensor_state` is keyed on
      `(sensor_id, time)` with `ON CONFLICT DO NOTHING` — so it was **silently dropped**, leaving
      the history saying Down while `sensor_runtime` said Paused. Uptime is computed from the
      history, so that is a corrupted SLA rather than an untidy log. In production the wall clock
      is normally a little past the result and the collision does not arise; it takes a probe
      whose clock runs slightly ahead, or a replay, to line them up — the sort of thing that
      happens once and is never reproduced. `reactionTime` now makes the ordering true by
      construction: the pause was *caused* by the Down, so it is recorded after it. The scenario
      drives both at the same instant deliberately, so the hazard is exercised rather than
      avoided by luck.

## Phase 4 — Notifications

- [x] **N-01 — Trigger storage and inheritance** · L · S-04 · Triggers on any object, inherited
      downward; effective trigger set names the source object for each.

      **N-01 outcome.** `notification_trigger` (migration `015`) hangs off any object, with the
      kind's settings in `jsonb` behind a JSON Schema — the same arrangement as
      `sensor_config.params`, and for the same reason: the two v1 kinds share almost no fields,
      `[V2]` adds three more, and the schema generates the form, validates the API and documents
      the field in one declaration rather than a column set per kind and a migration every time
      one arrives. `TriggerRepository` owns the inheritance, `TriggerService` the validation and
      the audit, and four routes serve them. Nothing here fires anything: `N-02`–`N-05` are the
      engine, and this is the storage every one of them depends on.

      **Triggers inherit by accumulation, not by nearest-ancestor — the central decision.**
      Every other inheritable thing resolves to one value from the closest ancestor that defines
      it, which is why `InheritanceResolver` exists and why `CLAUDE.md` insists everything goes
      through it. A trigger is not a setting with a value. `CAPABILITIES.MD §5.1` says a child's
      trigger tab shows "both its own and every inherited trigger", so the effective set is the
      **union** along the chain: a state trigger on the root and a threshold trigger on one
      device both apply to that device's sensors, and neither displaces the other. That is a
      different rule, so it is a different table and a different query — not a quiet
      reinterpretation of the resolver's. The rule in `CLAUDE.md` is about inheritable
      *settings*; a trigger is a row, not a value.

      **Two directions, one answer.** The tab walks *up* from one object, nearest first, and each
      entry names the object it is defined on — the only place it can be edited or removed, and a
      trigger an operator cannot find is one they cannot turn off. The engine (`N-02`) asks about
      thousands of sensors at once, so `effectiveForSensors` walks *down* from each trigger to
      the objects beneath it, the cheap direction `M-09` and `M-11` also take. A test asserts the
      two agree on the same **order**, not just the same set: the engine sees the most specific
      rule first, and a tab that ranked them differently would be describing a different system.
      They differ in exactly one respect, deliberately — the tab shows disabled triggers, because
      one an operator cannot see is one they cannot re-enable; the engine does not, because a
      disabled trigger fires nothing. `anyDefined` is the `LIMIT 1` guard in front of all of it,
      the same shape `M-09` and `M-11` use.

      **A threshold trigger is not a channel limit (`M-04`).** A limit decides the sensor's
      *state* — it is what makes a sensor Down, and everyone who looks at the sensor sees it. A
      threshold trigger decides who gets *told*, without changing what the sensor is. "Page me at
      80% but do not call the disk Down until 95%" needs both, and conflating them would make one
      of them impossible.

      **Two things found while writing it.** `TriggerError` was handing its `problems` list to
      `AppError`, whose constructor takes a scalar-only `context` and silently drops everything
      else — so a rejected trigger came back with no reason, which is a form that just refuses.
      It carries its own `details` now, like `ObjectError`, and `toHttpError` maps it to 400
      rather than letting an `AppError` fall through to a 500 that blames the server for the
      caller's mistake. Separately, the audit diff for an update reported the new summary on both
      sides; it carries `previousSummary` now, because "who changed the escalation to four hours"
      is the question that log exists to answer.

      **The state trigger offers four states, not six.** `§5.1`'s list minus the two marked
      `[V2]` — a form field for a trigger that could never fire is worse than a missing one,
      because it looks configured. Deliberately *not* `V1_STATES`: `paused` is a state an
      operator puts a sensor into on purpose, so notifying about it is notifying about one's own
      action, and `down_acknowledged` is stranger still — acknowledging is how an operator stops
      being told, so a trigger on it would notify about the suppression of a notification. The
      engine still has to know about `down_acknowledged`, because a `down` trigger must not
      re-fire when the Down is acknowledged, but that is `N-02`'s problem and not a setting.

      **Not built, and not smuggled in.** PRTG has a per-object "inherit notification triggers:
      yes/no" toggle. It is not in `CAPABILITIES.MD` and it is not here; a trigger is switched off
      where it is defined, or the object is moved. Filed as `N-16` rather than added quietly.
- [x] **N-02 — State trigger** · L · N-01, M-15 · Initial latency, initial notification,
      escalation latency, escalation notification, repeat interval, recovery notification.

      **N-02 outcome.** Two tables (migration `016`) and three modules. `notification_alarm` is
      what the engine is currently doing about one sensor for one trigger;
      `notification_request` is what it decided to send. `chain.ts` holds the decisions and
      nothing else, `repository.ts` the set-based SQL, `engine.ts` the two entry points. Nothing
      delivers anything yet: `N-05` gives the template ids meaning, `N-07` onwards send.

      **The engine tracks alarms, not events — the central decision.** The obvious design reacts
      to each state change as it arrives: arm a timer on Down, cancel it on Up. It does not
      survive a restart, it leaks a timer whenever a cancellation is missed, and it cannot answer
      "why is this sensor about to page somebody" without replaying history. So there is a row
      per (sensor, trigger) for as long as that trigger's state is standing, and every reaction
      is a *reconciliation* of that row against the sensor's present state. A restart rebuilds
      nothing — the rows are there and the due times are absolute. A missed reaction self-corrects
      at the next one. The property is not theoretical: see the measurement below.

      **The alarm keeps its own clock.** `sensor_runtime.since` moves on every transition, and
      acknowledging a Down *is* a transition — so a chain measured against it would silently
      restart its escalation the moment somebody acknowledged it. `notification_alarm.since` is
      when the alarm began and does not move while it stands, which is also what keeps "down for
      three hours" saying three hours after an acknowledgement.

      **An acknowledged Down is still Down.** `down_acknowledged` is a different state
      (`docs/state-machine.md §2.4`), so the naive comparison ends the alarm and fires a recovery
      — telling everybody the sensor came back at the exact moment an operator said "I know, I am
      on it". `stillStanding` is that one rule, and `PLAN.md`'s exit criterion is the pair it
      makes possible: the chain stops, the alarm stands, and the recovery still fires. The two
      halves pull in opposite directions — deleting the alarm loses the recovery, leaving it
      armed keeps escalating — which is why they are asserted in one test.

      **A recovery is a return to Up and nothing else.** `CAPABILITIES.MD §5.1` says so, and the
      narrowness is the point: a Down sensor that goes Unknown because its probe died has not
      recovered, and one an operator paused for maintenance has not either. A false all-clear is
      worse than silence, because somebody stops looking. Confirmed live — clearing a simulated
      error took a sensor to Unknown and the engine stood the alarm down without a word.

      **Where it hangs.** `SensorStateService.reevaluate` and the ingestion write, which between
      them cover every path that can change a state, plus `TriggerSync` on the audit sink for the
      configuration half — adding a trigger during an outage has to arm the outage, which is the
      case that sync exists for. `AlarmSweep` fires what falls due, once a second, and is
      deliberately dull: `N-04` replaces the tick with a wait on `nextDueAt`, and the correctness
      lives in the table either way.

      **One real bug, and the same one twice before.** The guard in front of everything was "is
      any trigger enabled", which is false the moment somebody switches off the last trigger in
      an installation — while alarms are still standing against it. The very reaction that should
      have stood them down returned early, and they stayed armed for ever. `M-09` and `M-11`
      learned this exact lesson; `anyWork` is now the union of "any trigger could arm" and "any
      alarm is standing", which is the shape all three should have had from the start.

      **A claim withdrawn after measuring it.** The reaction is placed after the dependency
      reaction so a storm arms one chain rather than forty. A mutation test — reversing the two
      lines — showed the reversed order *also* ends with one, because the dependency reaction
      re-reconciles the sensors it paused through `reevaluate`, inside the same transaction, so
      nothing outside ever sees the pair. The order is still right (doing the work once beats
      arming thirty-nine chains and standing them down two statements later) but it is not
      load-bearing, and the comment claiming it was has been corrected. That is reconciliation
      earning its keep: two orderings, one answer.

      **Not fixed here, filed as `N-17`.** A simulated error (`M-14`) returns at layer 2 of the
      state model and never reaches the acknowledgement layer, so `POST /acknowledge` on a
      simulated Down is recorded and has no effect — the sensor stays `down`, not
      `down_acknowledged`. Found while verifying live. It is a state-machine question, not a
      notifications one, and changing the layer order to suit this ticket would contradict
      `docs/state-machine.md §2` and `M-01`'s tables.
- [x] **N-03 — Threshold trigger** · M · N-01 · Channel, condition, value, latency, trigger and
      clear notifications.

      **N-03 outcome.** `threshold.ts` holds the decisions; migration `017` widens `N-02`'s
      tables to carry them. The whole trigger is one channel, one comparison and one latency, and
      almost all of the work was in what "the channel's current value" means.

      **One alarm table, not two.** A threshold alarm and a state alarm differ in what arms them
      and in nothing else: both stand while their condition holds, both have a latency measured
      from when it began, both are reconciled against the present rather than driven by events.
      More to the point, `N-04` will sweep *one* due-time index — two tables would mean two
      sweeps and two chances to send a notification twice. So `kind` discriminates, `state`
      becomes nullable, and a shape constraint makes the variants exclusive at the database
      rather than by convention.

      **A threshold trigger is not a channel limit, and the test says so.** A limit (`M-04`)
      decides the sensor's *state*; a threshold trigger decides who is *told*, without changing
      what the sensor is. "Page me at 80% but do not call the disk Down until 95%" needs both. It
      is asserted directly — the sensor reads Up and a notification goes out anyway — and
      confirmed live: `state = up` beside a queued `threshold` request. That is also why the two
      new reasons are `threshold` and `clear` rather than reused `initial` and `recovery`: a
      breach is not an outage, and a digest that called them the same thing would be describing a
      different system.

      **The design flaw the tests found: a time window cannot tell stale from fresh.** The first
      version read "the newest sample within a lookback" and called that the current value. A
      sensor that failed its last check still has readings from thirty seconds ago sitting in the
      hypertable — indistinguishable, by timestamp alone, from a sensor that just reported. So a
      breach stayed standing across an outage and would have sent a *clear* notification when the
      sensor came back under its threshold, describing a recovery that never happened.
      `readingsAreCurrent` is the fix and the signal was already stored:
      `consecutive_failures = 0` means the most recent result succeeded, so what is in the table
      came from it. Paused and Unknown are excluded outright — nobody is scanning, so nothing is
      current whatever its timestamp says. A Down sensor with no failures is *included*, because
      Down-by-limit is a successful check with a bad number in it and its readings are as current
      as any. The lookback stays as a second, cruder bound: it keeps the lateral inside the newest
      chunk or two rather than walking back through a hypertable chunked by the day.

      **No-data is not zero, stated twice.** A `below 10` trigger must not fire when a probe goes
      away, and losing the reading is not clearing the breach — the alarm is stood down, because
      we no longer know, but *silently*: "back under 80%" would be a false all-clear, and a false
      all-clear is worse than silence because somebody stops looking. The same rule `N-02` applies
      to a recovery, for the same reason.

      **What it deliberately does not have.** No escalation and no repeat: `CAPABILITIES.MD §5.1`
      gives a threshold trigger a trigger notification and a clear notification and nothing
      between them, and a channel that has been over its threshold for an hour has said everything
      it has to say the first time. No acknowledgement either — that belongs to the state chain,
      and a sensor can be over its threshold while perfectly Up.

      **`equal` compares exactly.** Right for the channels anybody sets it on — status codes,
      counts, enumerated values — and treacherous for a computed float. That is the operator's
      choice to make, and a system that quietly compared within an epsilon would fire on a value
      the operator can see is different.
- [x] **N-04 — Latency timer engine** · L · N-02 · Timers cancel on recovery and on
      acknowledgement; survive a restart; no leaks across thousands of sensors.

      **N-04 outcome.** `AlarmScheduler` replaces the tick `N-02` shipped as a placeholder. One
      timer for the whole installation, sleeping until the next due time. Measured:
      `docs/findings/2026-08-26-notification-timers.md`.

      **There are no timers, and that is the design.** The obvious reading of the ticket is a
      `setTimeout` per pending notification, cancelled on recovery and on acknowledgement. At the
      v1 target — 5,000 sensors each carrying an initial, an escalation and a repeat — that is
      **15,000 live handles**, every one a closure holding a sensor id, every cancellation a
      chance to leak one, and all of them gone after a restart with nothing to rebuild them from.
      `N-02` had already put the due time in a row, so the cancellations this ticket asks for are
      the `DELETE`s and `UPDATE`s that already happen for other reasons: an alarm that recovers is
      removed, an acknowledged one has its `next_due_at` set to null. "No leaks" is structural
      rather than careful. What was left for `N-04` is the one timer that decides when to look.

      **Three things end a sleep**, and the third is the interesting one. The due time arriving;
      `wake()`, which the engine calls whenever it arms an alarm; and a 60-second cap. The cap is
      the safety net rather than the schedule — a wait only a poke can end is a wait one lost poke
      turns into silence, and the failure mode of a notification system that goes quiet is that
      nobody notices. It is also what bounds a wall-clock jump: due times are `timestamptz`
      because they are data, the sleep is a monotonic timer because it is scheduling
      (`CLAUDE.md`), and capping the delay means a clock that moves under us costs a minute rather
      than a night.

      **`wake()` is deliberately allowed to be spurious.** It fires inside the arming
      transaction, before a commit that may never happen, so a rolled-back batch pokes a scheduler
      that then finds nothing. That costs one indexed query. The alternative is threading an
      after-commit hook through the ingestion write, `reevaluate` and every audited mutation — and
      forgetting one means a notification that waits a minute for no reason.

      **Measured, at 2,000 sensors under one root trigger.** Arming 2,000 chains: 145 ms.
      Holding them inside their latency: 53 ms — the steady state of a large outage, and the
      figure to watch, because it is the work repeated every scan interval for as long as the
      outage lasts. Cancelling all 2,000: 74 ms. Firing 4,000 due steps after an hour's backlog:
      189 ms, drained in one wake across two rounds. **Timers held: 2 idle, 2 with 2,000 chains
      pending, 2 after they all cancelled** — the claim, asserted rather than asserted about.

      **One real bug, found by a flaky test rather than by reasoning.** `wake()` fires inside
      the arming transaction, and the design note said a spurious wake was harmless — one wasted
      query. That was half right: a wake that arrives *early* is not harmless. The scheduler can
      sweep, read and find nothing before the commit lands, then sleep the full 60-second cap
      with the alarm committed and overdue, because nothing is left to poke it again. It showed
      up as a 20-second timeout about one full-suite run in four. A wake that finds nothing is
      now re-checked rather than believed — twice, at 250 ms and 1 s. Both halves are tested,
      and the second test is the interesting one: it runs the same forced race against a
      scheduler configured with no re-checks and asserts it *does* sleep through the commit, so
      the fix is demonstrated rather than described. `wake()` is also now a no-op before
      `start()`, because a scheduler nobody started sweeping because something poked it is a
      second scheduler nobody knows is running.

      **One test rewritten after it proved the wrong thing.** The promptness check originally
      timed the round trip and asserted under a second, which measures PostgreSQL on a loaded
      machine rather than the scheduler. It now asserts through the sleep the scheduler was
      holding: if it is asleep for the full cap and the notification arrives anyway, the wake is
      the only thing that could have sent it. Load-independent, and a sharper claim.

      **Verified live.** A trigger with a four-second latency and an eight-second escalation,
      against the running service: the initial notification landed at +4s and the escalation at
      +8s from the state change, on the second.
- [x] **N-05 — Notification templates** · M · N-01 · Template objects with method, content,
      recipients, priority.

      **N-05 outcome.** `notification_template` (migration `018`), a method registry with the
      five `[V1]` delivery methods, and a service whose most important job is what it *does not*
      return. Nothing here sends anything: `N-06` substitutes the placeholders, `N-07` onwards
      deliver, `N-11` decides what is folded into a digest.

      **A library object, like a schedule.** Many triggers reference one template and none
      contains it, so it has no parent, no inheritance and no place in the tree. Methods are
      declared the way sensor types and trigger kinds are — one JSON Schema per method that
      generates the form, validates the API, documents the field and marks the secrets — so
      `[V2]`'s SMS, syslog, SNMP-trap, SNS and MQTT methods are a one-file job.

      **A Slack webhook URL is a credential, and is treated as one.** Anybody holding it can post
      to the channel, with no other authentication. So it is `writeOnly` in its schema, collected
      at load, and stripped at exactly one place — `TemplateService.#view` — the arrangement
      `CLAUDE.md` mandates for monitored-device credentials and for the same reason: a new
      endpoint cannot forget what it never sees. Three further locks, each of which would be the
      last line if the others failed: the response schemas name only the fields that may go out,
      so `fast-json-stringify` cannot serialise a stray one; the one-line summary is built from
      the *redacted* copy, because a summary is the likeliest place for a secret to escape by
      accident; and the audit log records the name and the method and never the settings, because
      a log is read by more people, kept for longer, and exported. The test asserts against the
      **raw response body** rather than the parsed object, which is the only version of that
      assertion that catches a field nobody thought to check.

      **The generic webhook's URL stays visible; Slack's and Teams' do not.** Not an
      inconsistency — a generic webhook's address is usually just an address, and an operator has
      to be able to see where their alarms are going, so anything secret goes in `secretHeaders`
      instead. A system that hid every URL would make templates unreviewable; one that showed a
      bearer token would leak it.

      **An edit that does not resend a secret keeps it.** The failure this prevents is mundane and
      total: the form was rendered from a redacted read, so a faithful PUT carries no webhook URL,
      and treating that as "remove it" would break the template every time somebody fixed a typo
      in a subject line. An explicit `null` clears it — absence and instruction are different
      things, and a merge that collapsed them would make one of them unreachable. Changing the
      *method* carries nothing across: a Slack URL is not a webhook's secret headers.

      **Deleting a template a trigger names is refused, with the list.** A trigger names its
      templates inside a `jsonb` document, so no foreign key can enforce the reference —
      `CAPABILITIES.MD §5.2`'s "used by" lookup is the query that stands in for one, and it asks
      `triggerKinds.templatesIn` rather than SQL, so a new trigger kind cannot be missed. For the
      same reason there is deliberately **no** foreign key from `notification_request.template_id`:
      `N-02` decided a trigger may name a template that does not exist and that refusing to record
      the obligation would lose it rather than surface it. Adding the key now would have quietly
      reversed that.

      **One real bug the tests found.** `redactedSettings` reported a schema *default* — the
      webhook method's empty `secretHeaders: {}` — as though a secret were set. A form reading it
      would have said "configured, not shown" about a credential nobody had ever entered, which is
      an invitation to retype something that does not exist. The field is now removed always and
      *reported* only when it held something.
- [x] **N-06 — Placeholder substitution** · M · N-05 · `%sensor`, `%device`, `%group`, `%probe`,
      `%status`, `%laststatus`, `%lastmessage`, `%lastvalue`, `%datetime`, `%since`, `%linksensor`,
      `%priority`, `%comments`, `%objecttags`, `%host`, `%location`. Case-insensitive. Unknown
      placeholders reported, not silently blanked.

      **N-06 outcome.** `placeholders.ts` is the substitution and the seventeen names `§5.2`
      lists; `context.ts` is where their values come from. A test asserts the list against the
      scope contract by name, because a placeholder quietly dropped from a build is a template
      that stops working.

      **"Reported, not silently blanked" is enforced twice, and the first one matters most.** A
      template naming an unknown placeholder is **refused when it is saved**, with the list of
      valid names — the only moment somebody is looking at the text and can fix it. A message
      that quietly loses `%lastvlaue` reads perfectly, says nothing, and nobody finds out until
      the night it mattered. For anything already stored, substitution leaves the token exactly as
      written and reports it, so a message an older build produced is one an operator can look at
      and immediately see what is wrong with.

      **Parsing rules.** A name is `%` and the *letters* that follow it, so "CPU at 90% used"
      survives untouched and `%sensor1` is `%sensor` followed by a 1. `%%` is a literal per cent,
      which is the only way to write one immediately before a word. Substituted values are output,
      never re-scanned: a check message reading "disk at 90%full" cannot become a placeholder.

      **Case-insensitive at the table, not at each lookup.** Names are lower-cased once when the
      table is built, so `%Sensor`, `%SENSOR` and `%sensor` are one entry rather than three code
      paths — and an operator capitalising the first word of a sentence is not punished for
      correct English.

      **Where the values come from.** `MessageContextLoader` builds a batch of contexts in two
      queries however many notifications there are, which is what `N-11` will ask for when it
      assembles a digest of twenty-five. The ancestry is one recursive walk rather than four
      joins, because "the nearest device above this sensor" is not a fixed depth — groups nest,
      so a sensor may be four levels below its probe or ten, and the test builds probe → group →
      group → device → sensor to prove `%group` names the *nearest* one.

      **Three decisions worth naming.** `%location` is a new inheritable setting
      (`object.location`) rather than a column, so it resolves through the one resolver like
      everything else — a site set on a group reaches every device beneath it, and `[V2]`'s maps
      will read the same value rather than a second one that could disagree. `%linksensor` needs
      an externally reachable base URL that cannot be derived from what the core *binds* to — a
      link built from a loopback address is worse than no link, because it looks like one — so
      it is configuration (`notifications.publicUrl`), and empty renders the bare object id.
      Dates are ISO 8601 UTC: a locale-formatted date needs a locale and a timezone nobody has
      been asked for, and "03/04" read in the wrong country is a date two months out.

      **A correctness fix found by looking at the live output.** `%objecttags` first rendered the
      sensor's *own* tags. `CAPABILITIES.MD §1` makes "tags + inherited parent tags" a v1
      capability and the object *filter* already resolves them that way — so a message would have
      shown a different set of tags from the search that found the sensor. It now resolves the
      inherited set, sorted.

      **Shipped with something that calls it.** `GET /templates/:id/preview?sensorId=N` renders a
      template against a sensor's actual state. Without it `N-06` would be code nothing runs until
      `N-07`, and an operator writing `%device / %sensor: %lastmessage` has no way to know whether
      it reads well until they see it against something real. `N-14`'s send-test uses the same
      rendering.

      **And the same trap, for the third time.** A backtick inside a SQL template literal — this
      time in a comment reading `` `device_config` `` — ended the string and produced
      `ReferenceError: device_config is not defined` from a line that looked like SQL. The
      memory note about it exists precisely because the error never points at the backtick.
- [x] **N-07 — Email delivery** · L · N-05 · SMTP relay with port, auth (none/SMTP/SASL), TLS
      negotiation, sender and HELO override, primary + fallback relay. HTML and plain bodies.

      **N-07 outcome.** Four pieces: migration `019` records what happened to a queued
      notification, `NotificationDispatcher` turns obligations into messages, `EmailTransport`
      sends them, and `DeliveryLoop` decides when. Verified against MailHog — a real ESMTP
      conversation, not a stub agreeing with itself — and end to end against the running service:
      a forced Down produced a delivered email **in the same second**, first attempt.

      **`nodemailer` for the SMTP itself**, per `ADR-001` Decision 6, which named it and rated the
      ecosystem alive. An ESMTP client with STARTTLS, four SASL mechanisms, MIME encoding and
      dot-stuffing is a great deal of well-trodden protocol to get subtly wrong, and unlike
      syslog or NetFlow this is not a gap we have to fill ourselves. Version **9**, not the 7 that
      `npm install nodemailer` first resolved to: that one carries six high-severity advisories,
      three of them CRLF injection into headers.

      **Which is why headers are sanitised here as well.** A subject is built from a sensor's name
      and a probe's own message, and neither is under this system's control — a check reporting
      `ETIMEDOUT\r\nBcc: someone@else` would otherwise be writing headers. Nodemailer encodes
      them properly and has still had three advisories against separate fields, which is the
      argument for doing it *as well as* rather than *instead of*. One regex, applied to the
      subject, the sender, every address and the HELO name.

      **Claim, render, send, record — and the order is the design.** The claim is a short
      transaction that increments the attempt count and pushes the next attempt into the future
      *before* anything is sent; the send is not in a transaction at all. The alternative puts a
      relay's timeout in charge of a database connection and holds a row lock for the length of
      it. That makes delivery **at-least-once**, deliberately: a crash between the send and the
      record sends the message again. For an alarm system that is the right way round — a
      duplicate alarm is an annoyance, a lost one is the failure the whole subsystem exists to
      prevent — and the attempt count is on the row, so a duplicate is explainable.

      **Primary then fallback.** Paessler's own advice is two delivery paths per trigger; this is
      the cheaper half, and one relay going down must not silence an installation. When they all
      fail, every relay's reason is recorded rather than the last: "primary refused the address,
      fallback timed out" is a diagnosis, and "timed out" alone sends somebody to the wrong
      machine. Retryable if *any* relay might work later — one permanent rejection does not make
      the whole thing permanent.

      **SMTP already classifies failures**, which is why the protocol has two failure classes: a
      4xx is "not now" and a 5xx is "not ever". A connection error with no code is transient far
      more often than not. Trying a permanently rejected address for ever is how a queue fills
      with something nobody will receive; giving up on a timeout is how an outage goes unreported
      because the network hiccuped.

      **What is *not* failed.** A method with no transport yet (`N-08` to `N-10`) and a template
      switched off both leave their requests queued and counted, not failed — marking them
      undeliverable would throw away real obligations, and `CAPABILITIES.MD §5.2`'s activation
      schedules make "collect and send when reactivated" a first-class choice (`N-12`). A request
      whose template is *gone* does fail, with a reason: migration `018` deliberately allowed a
      trigger to name a template that does not exist, and this is where an operator finds out.

      **`DeliveryLoop`, not `AlarmScheduler`.** The temptation was to reuse `N-04`'s waiting
      machinery, and the shapes are genuinely different: that one sleeps until a due time it reads
      from a table and runs its sweep *inside* a transaction. Delivery has no due times of its own
      — a notification becomes deliverable the moment something queues it — and an SMTP
      conversation inside a transaction is the thing the dispatcher exists to avoid. What it does
      reuse is the pattern: sleep long, be woken by the engine that queued the work, treat the
      sleep as a safety net rather than a schedule.

      **Configuration, not an API resource.** The relay holds a password, is set once per
      installation by whoever runs the service, and a file the operating system protects is a
      better place for a credential than a table any administrator can read. It also means
      `MS_NOTIFICATIONS__SMTP__PRIMARY__PASSWORD__FROM_FILE` works out of the box, which is how
      systemd's `LoadCredential=` and Docker secrets deliver one without putting it in the
      environment. `bootstrap` logs the config *path* and never the config, so nothing leaks into
      the journal.

      **Left for `N-13`.** The retry delay is flat and the attempt bound is a constant — the
      honest placeholder for a backoff policy, rather than a policy pretending to be one. Failures
      are logged at `error` because `WORKFLOW.MD §6` says a delivery failure is itself an alarm;
      putting that on Core Health is `N-13`'s half.
- [x] **N-08 — HTTP action / webhook delivery** · M · N-05 · Method, URL, headers, templated
      body, timeout, TLS options, SSRF guard.

      **N-08 outcome.** `WebhookTransport` plus a pure address policy in `ssrf.ts`, and one
      addition to `N-06` that turned out to matter more than the transport: **substitution now
      escapes for the syntax it is landing in.**

      **The escaping is the bug nobody would have found.** An operator writes
      `{"message": "%lastmessage"}`, a probe reports `unexpected " in response`, and the document
      that goes out is not JSON at all. The endpoint rejects it — or worse, parses it into
      something else — and it happens only for the checks whose messages contain a quote, which
      is to say the interesting ones. `substitute` and `render` now take an `Escaping`, the
      transport declares which one its content type needs, and only *substituted values* are
      escaped: the braces and quotes the operator typed are the document's structure. Verified
      live with a check message containing a quote; the body arrived as valid JSON.

      **`node:http` rather than `fetch`, for one reason: the guard.** A guard that resolves a
      hostname, decides it is acceptable and then hands the *name* to a client has checked
      nothing — the client resolves it again, and a DNS answer with a one-second TTL can point
      somewhere else by then. That is DNS rebinding. Here the name is resolved once, **every**
      address it returned is judged (not the first — a name resolving to one public and one
      link-local address reaches the link-local one as soon as the resolver reorders them), and
      the connection is pinned to a verified address through the request's own `lookup` hook.
      `fetch` has no equivalent seam.

      **The default policy blocks link-local and nothing else, deliberately.** A monitoring system
      lives *inside* the network it watches: an internal ticketing system, a self-hosted chat
      server, a script on the same machine are all ordinary webhook targets, and a guard that
      refused them would be switched off within the hour — a worse outcome than a narrower guard
      nobody disables. What it does block is the one range that is never a legitimate target and
      is a known credential-theft vector: `169.254.169.254` and its IPv6 equivalents, where every
      cloud provider parks the metadata service that hands out IAM credentials to anything that
      asks. `private` and `none` are available; multicast is refused under all three, because a
      POST to it is a mistake rather than a configuration. Verified live: pointing a template at
      the metadata address failed on the first attempt with a reason an operator can act on.

      **Redirects are followed by hand**, because every hop is a new host that has to be judged
      again — a public endpoint redirecting inward is the redirect-based SSRF the guard exists
      for. A hop to a different origin does **not** carry the secret headers: a bearer token that
      follows a redirect to somebody else's host has been given to that host, which is the
      distinction `curl` draws between `--location` and `--location-trusted`. And a redirect
      becomes a GET with no body, because reposting it is how one webhook becomes two deliveries.

      **A defect found by an intermittent test.** `AlarmScheduler.sweep` had no `stopped` check,
      so a timer that had already fired when `stop()` was called went on to sweep afterwards.
      In a test that meant one scheduler quietly doing another's work — which is how it showed up,
      as `fired: 0` beside a notification that had definitely been sent. In production it means a
      notification going out during shutdown, from a component the process is in the middle of
      abandoning. Fixing it revealed that three tests had been asserting "a sweep found nothing"
      against a *stopped* scheduler, which now passes without looking at a row; they drive a fresh
      one instead.

      **One test relaxed rather than papered over.** The real-SMTP test asserted a first-attempt
      success. MailHog is a small Go binary sharing a host with a dozen test files and drops the
      occasional connection under that load — which the transport correctly reports as retryable.
      Asserting one attempt was asserting the relay was not busy; it now dispatches until it
      lands, which is the behaviour the transport actually promises.
- [x] **N-09 — Slack and Teams delivery** · M · N-08 · Formatted messages with status colour and
      a link back to the sensor.

      **N-09 outcome.** Both services are one `ChatTransport` parameterised by a `ChatFormat`,
      because they differ only in the shape of the document: each posts JSON to an
      incoming-webhook URL through the guard `N-08` already built. Writing them as two classes
      would have duplicated the guard, the pinning, the redirect handling and the status reading
      to gain nothing — so `N-08`'s HTTP half was lifted out into `GuardedHttpClient` first, and
      `WebhookTransport` is now a settings parser sitting on top of it.

      **The transport is handed the facts, not only the prose.** `OutgoingMessage` gained its
      `MessageContext`. A card needs the *state* to pick a colour and the sensor id to build a
      link, and neither can be recovered from a string an operator wrote — a formatter that tried
      to parse them back out of the rendered subject would be guessing. Email ignores the field.

      **Colour is never the only signal.** Every card carries the glyph, the word and the colour
      together. One in eight men has some form of colour blindness, chat clients recolour
      everything in dark mode, and a phone's notification banner shows no colour at all — WCAG
      2.1 1.4.1 says this about our own UI and the reasoning does not stop at the boundary of
      software we did not write. Two states are kept off the traffic light entirely: `unusual` is
      violet, and `paused` is grey, because the alarm that arrives *because* somebody paused a
      sensor must not look like an outage. `down_acknowledged` still reads "Down (acknowledged)":
      acknowledging stops the repeats, it does not fix the thing.

      **A fourth escaping, for the same reason `N-08` needed the third.** Slack renders `<`, `>`
      and `&` as syntax, so a probe reporting `got <html> not a reply` would otherwise arrive with
      a piece missing and a link nobody wrote. `mrkdwn` escaping joins `json` and `form`, and —
      as before — it applies to *substituted values* only, so a template written as `*%sensor* is
      down` still arrives bold. Verified live: a simulated error containing `<ms-target> & the
      "backup" path` reached the sink as `&lt;ms-target&gt; &amp;` with the quotes intact.

      **Teams has two wire formats and the URL does not say which.** Microsoft retired Office 365
      connectors in favour of Power Automate workflows: a workflow URL takes an Adaptive Card
      inside a `message` envelope, a surviving connector URL takes a bare `MessageCard` and
      rejects the envelope with a 400 whose body says nothing useful. The two are
      indistinguishable by inspection, so `format` is a field on the method rather than a guess,
      defaulting to the shape Microsoft still hands out. Both were sent and read back live.

      **The URL is the credential, and is treated as one everywhere.** Anybody holding a Slack or
      Teams incoming-webhook URL can post to that channel with no other authentication — the
      secret is the path, not the host. It is `writeOnly` in the method schema, `describe()`
      returns a constant so the summary cannot leak it, and no error message contains it: a
      failure reports the host and the status, which is what an operator can act on. Confirmed
      against the running stack — five deliveries, and `/hook/` appears nowhere in the journal.

      **Verified live end to end.** Templates on both methods against an HTTP sink on the dev
      network: Down arrived red with a linked title, the recovery arrived green saying "was down",
      and switching the Teams template to `messageCard` without re-supplying the URL kept the
      secret and changed the document. Five requests, `sent` on the first attempt each.

      **One thing the live output showed that no test would have.** A recovery renders
      `%lastmessage` as nothing, so the operator's body began with a blank line. The card now
      trims it — leading whitespace in a chat message carries nothing, and the alternative was a
      message that opens with an empty row every time something comes back up.
- [x] **N-10 — Execute program delivery** · M · P-03, N-05 · Sandboxed, timed out, output
      captured to the log.

      **N-10 outcome.** `runProgram` in `@ms/shared` plus `ProgramTransport` in the core.

      **Built without `P-03`, and deliberately not around it.** The dependency was on the probe's
      child-process runner, which does not exist yet — but it could not have been reused anyway,
      because a notification runs in `ms-core` and `P-03` runs in `ms-probe`. What the two do
      share is the hard part, so the runner went into `@ms/shared`: no shell, a hard timeout, a
      built environment, bounded output. `P-03` and `T-19` should adopt it rather than write a
      second one, and the note on `P-03` says so.

      **This is the most dangerous method in the subsystem, and the design is mostly about
      that.** A template is data an operator edits through an API. If `path` could name any file,
      then permission to edit a notification would be permission to run anything as the service
      account — a privilege escalation with a form in front of it. So a template names a file
      *inside* `notifications.program.directory`, the **resolved real path** has to still be under
      it, and the directory is empty by default, which switches the method off entirely. Four ways
      out are closed and each is tested: an absolute path, a `..`, a symlink pointing out, and a
      sibling directory whose name merely starts with the same characters. Verified live —
      `../core.json` failed permanently with "resolves outside the programs directory".

      **Never through a shell, which is the whole of the injection defence.** An argument carries
      `%lastmessage` and a check message is whatever a monitored device said, so a shell would
      turn `; rm -rf /` in an SNMP description into a command. `spawn` with an argv array makes
      that a string instead. The escaping problem `N-08` had to solve for a JSON document simply
      does not arise, which is why `bodyEscaping` is `none`. Confirmed live with exactly that
      message.

      **The environment is built, not inherited.** `MS_NOTIFICATIONS__SMTP__PRIMARY__PASSWORD`
      and `MS_DATABASE__PASSWORD` are supported overrides (`N-07`), so a script in the programs
      directory would otherwise be able to read the relay password out of its own environment.
      It gets an allowlist of what a program needs to *run*, and the alarm's facts as `MS_*` —
      which also means a script needs no arguments at all, and the template can name the program
      and nothing else. The body arrives on stdin, because a check message can be longer than the
      platform's argv limit.

      **The process group, not the process.** A timeout sends `SIGTERM` to the group and `SIGKILL`
      after the grace period; Windows has no group to signal, so the tree goes down with
      `taskkill /T`. A mutation test earned this: with a plain single-process kill, the "runs too
      long" test went from 300 ms to the full 30 s, because killing `/bin/sh` leaves its `sleep`
      holding the stdout pipe open. A script that backgrounds `curl` and exits would have left it
      running for ever.

      **A non-zero exit is not retried, and that is a decision rather than an oversight.** The
      program is a side effect — it opens a ticket, sends an SMS, pulls a lever — and running it
      five more times because it reported a problem is how one alarm becomes five tickets. It
      said no; that is an answer. A timeout *is* retried, because the program never got to say
      anything, and a script that can be run twice is a script that will behave.

      **`secretArgs` is honest about what it is now.** Write-only in the API and still an argument
      on a command line, where any local user can read `/proc/<pid>/cmdline` while the program
      runs. The schema says so, the log records the program's name and never its arguments, and
      the `MS_*` environment is the way to avoid needing a secret on the command line at all. A
      test asserts against the serialised log line, so nothing reaches the journal by accident.

      **An unrelated failure fixed on the way through.** `notification-engine.test.ts` asserted a
      resumed escalation by sweeping at a synthetic `T0 + 810s`, while `acknowledge` and
      `clearAcknowledgement` are the two calls in that file that take no timestamp — production
      has no synthetic clock, so they stamp `new Date()`. The chain resumes from the real moment
      the acknowledgement was lifted, so the test passed all morning and failed every afternoon
      once the wall clock passed 09:00Z. It now sweeps relative to the clock the service actually
      used.
- [x] **N-11 — Summarisation engine** · L · N-05 · All six modes, default _first down and up
      immediately then summarise_; configurable window; digest caps with overflow splitting;
      Slack/Teams/webhook/script always immediate.

      **N-11 outcome.** What stops a switch failure from sending two hundred emails. A pure mode
      table in `summarisation.ts`, a window table in migration 020, and three steps added to the
      dispatcher ahead of the claim it already did: decide, close, digest.

      **A window is a row, not a timer** — the same reasoning as `N-02`'s alarms. A timer holding
      a storm's worth of notifications is a restart away from losing all of them, so an open
      window is a row with a due time and closing it is an `UPDATE`. A core that restarts
      mid-storm sends the digest late rather than never, and a test asserts exactly that against a
      fresh dispatcher. One open window per template, enforced by a partial unique index rather
      than by convention.

      **`disposition` is a column because the decision has to be made once.** "Send the first Down
      immediately, then summarise" is not a property of the request — it depends on what the
      window has already released. Re-deciding on a retry would take a message an operator was
      promised at once and fold it into a digest fifteen minutes later, so the answer is written
      the first time and read thereafter. That is the subtlety in the whole ticket, and it has its
      own test.

      **Three kinds, not two.** Two modes say "summarise others", so there has to be an *other*:
      a Warning is neither the outage the Down modes are about nor the all-clear. A threshold
      breach is counted as a **Down**, deliberately — reading the mode names literally would hold
      a filling disk for the whole window, and an operator who asked for "all Downs immediately"
      would get a late digest about it. Between noisier than asked for and later than asked for,
      an alarm system takes the noisy one.

      **The digest reads in the operator's own words.** Their subject cannot be the digest's
      subject — "%sensor on %device is %status" says nothing useful about twelve sensors — so the
      digest's subject is generated and their subject becomes each *line* of the body, rendered
      per notification. Throwing their wording away would have produced a digest that reads
      nothing like the messages it replaced.

      **`CAPABILITIES.MD`'s caps, both of them.** Twenty-five notifications and about a thousand
      characters per message, splitting the overflow. Either cap alone lets through a digest a
      mail client truncates, and what gets cut is the end — which in a cascade is the part that
      explains it. A single line longer than the cap gets a message to itself rather than being
      dropped: it is somebody's alarm, and the cap exists to keep messages readable, not to decide
      which outages are worth reporting.

      **Methods that are never summarised are forced, not ignored.** Slack, Teams, HTTP action and
      execute program store `always-immediate` whatever was asked for, so a form cannot show a
      mode the dispatcher will not honour. The dispatcher asks the *method* rather than the row as
      well, so a row written past the service is still sent immediately.

      **Two existing tests changed, and the change is the feature.** `email-delivery.test.ts` had
      two tests queueing several notifications on one template and expecting several messages —
      which under the new default is one message and a digest. They now ask for
      `always-immediate`, because they are about the counters and the batching loop rather than
      about summarisation.

      **Verified live against the dev stack** with a 60-second window and a three-sensor storm:
      one immediate Down, then a digest reading _"Dev installation: 2 notifications — 2 down"_
      with both sensors in the operator's own wording; then the same again on recovery — one
      immediate Up and a 2-up digest. Nothing left pending.

      **Left for `N-15`.** The 200-sensor scenario test, which is what proves the alarm *volume*
      rather than the mechanism.
- [x] **N-12 — Template activation schedules** · M · M-09, N-05 · With queue-or-discard for
      notifications generated while inactive.

      **N-12 outcome.** Migration 021 adds two columns to `notification_template` and a third
      answer to `notification_request.status`; `activation.ts` decides which templates the clock
      has switched off; the dispatcher does the rest with the exclusions it already had for
      summarisation.

      **The choice is the whole ticket, and both halves are real.** An on-call rota that pages at
      03:00 wants the out-of-hours message *gone*; a daytime team's ticket queue wants every one
      of them waiting on Monday morning. A system that picked one would be wrong for half its
      users, so `when_inactive` is a column and neither answer is the "advanced" one.

      **`discarded` is its own status, not `failed`.** A notification nobody was meant to receive
      did not fail — counting it as one would put it on `N-13`'s Core Health failure count and
      send an operator looking for a relay problem that does not exist. It is not `sent` either,
      because nobody got it. The row carries which schedule suppressed it and when that schedule
      reopens, so "why did I not hear about this" has an answer rather than a silence.

      **Evaluated at delivery, not when the alarm is queued.** An operator setting a template to
      office hours is saying "do not send me this outside office hours" — about the *message*,
      not about the outage — so a notification queued at 17:59 and delivered at 18:01 is an
      out-of-hours message and is treated as one.

      **In TypeScript rather than SQL, deliberately.** A schedule is a statement about local time
      with its own IANA zone (`M-09`), evaluated through `Intl` so office hours move with daylight
      saving. Reimplementing that in SQL would be a second answer to the same question and the two
      would disagree twice a year — on exactly the nights nobody is awake to notice. An
      installation has tens of templates, so asking in TypeScript is one small partial-index query
      per pass.

      **A suppressed template's backlog is left *undecided* rather than held.** That is the piece
      that makes this meet `N-11` properly: deciding them would open and close summarisation
      windows all night with nobody listening, and the morning would bring a stale digest. Left
      undecided, the whole night is decided as one storm when the schedule reopens — first Down
      immediately, the rest in one digest. A test asserts no window opens at all while the
      template is off.

      **The reference is guarded in both directions.** `schedule_id` is a real foreign key with
      `ON DELETE RESTRICT` — a schedule quietly detaching itself would turn an out-of-hours
      template into an always-on one, which is the loudest possible failure for this feature — and
      `ScheduleService.delete` refuses first, with the template names, so an operator gets words
      rather than a constraint number. A template naming a schedule that does not exist is refused
      the same way. Absent `scheduleId` keeps what is stored and an explicit `null` clears it, the
      same distinction the secret merge draws.

      **Verified live against the dev stack:** two templates on the built-in *Weekends* schedule,
      inactive on a Wednesday afternoon. The `discard` one recorded `discarded: the template is
      outside its "Weekends" schedule; it is active again at …`; the `queue` one stayed pending
      with nothing in MailHog; moving it to *Office hours* delivered it, and the discarded one
      stayed discarded.

      **An unrelated flake fixed on the way through.** The real-SMTP test has failed twice under
      full-suite load since `N-08` "relaxed" it to dispatch until it lands — and could not have
      worked, because its dispatcher used the default sixty-second retry delay, so the very next
      `dispatch()` in the loop claimed nothing. It now uses `retryDelayMs: 0`, which is what makes
      the relaxation actually retry.
- [x] **N-13 — Delivery retry and failure surfacing** · M · N-07 · Backoff retry; failures
      logged and raised on Core Health; the alarm itself is never lost.

      **N-13 outcome.** `retry.ts` is the policy, `health.ts` reads whether delivery is working,
      `log.ts` answers "what happened to my alarm", and `GET /notification-health` and
      `GET /notification-requests` serve both. No migration: `N-02`'s indexes already covered
      every question these ask, which the migration test found by refusing a duplicate index name.

      **A lease and a backoff are two different things, and `N-07` conflated them.** The claim
      happens before the send and the send happens outside the transaction, so a core that dies
      mid-conversation leaves a row that looks claimed and is not being worked on. That row needs
      a **lease** — how long before somebody else may try it, necessarily longer than the slowest
      transport's own timeout, since `N-10`'s programs may run for five minutes. A *failed*
      attempt needs a **backoff**, which depends on the attempt count and is therefore only
      knowable once the attempt has happened. So the claim writes a lease and the record replaces
      it. Conflating them is why the old flat sixty seconds was simultaneously too short for a
      lease and too rigid for a retry — and why the real-SMTP test could never retry (`N-12`).

      **Half of each wait is randomised, and that is not decoration.** A relay that was down for
      an hour comes back to a queue whose waits all started at the same failure and would
      otherwise all expire at the same instant — a thundering herd aimed at a service that has
      just proved it is fragile. The exponent is also capped *before* the multiplication, because
      `2 ** 400` is `Infinity` and no `timestamptz` will take it.

      **Health is read from the queue, never counted in memory.** `DispatchStats` counts what this
      *process* has done since it started, which is the wrong answer twice over: a core that
      restarted five minutes ago reports a clean sheet over a queue full of undelivered alarms,
      and one that has been up for a month reports failures from three weeks ago. The obligations
      are rows, so the health of the subsystem is a query — and a test drives it through a fresh
      reader for exactly that reason.

      **Three states, and what each one means.** `down` when an alarm was **given up on** — that
      is the failure the whole subsystem exists to prevent — or when something attempted has been
      undeliverable longer than `staleAfterSeconds`, because a relay that has refused the same
      message for twenty minutes is not coming back on its own. `warning` while anything is being
      retried. A `discarded` notification (`N-12`) affects nothing: an operator asked for it to be
      thrown away, and counting it as a fault would send them looking for a relay problem that
      does not exist.

      **"The alarm itself is never lost" needed a route, not a policy.** `notification_request`
      has recorded the answer since `N-07` and nothing could ask: the only question anyone put to
      the table was the dispatcher's "what is owed". `WORKFLOW.MD §6` says a delivery failure must
      be surfaced rather than disappearing into a log file, and a failure nobody can query has
      disappeared into a log file however carefully it was written. The log pages by descending
      id rather than by offset, because notifications arrive while somebody is reading and an
      offset page would show a row twice or not at all.

      **The health query is bounded, `lastDeliveredAt` included.** "Nothing has been delivered in
      the last hour" is a health answer; "the last delivery was in March" is a history question,
      and answering it would mean scanning a year of delivered rows every time a UI polls.

      **Verified live against the dev stack:** a webhook pointed at a refused port and a program
      template naming a file that is not there. Health went to `down` — _"1 notification(s) were
      given up on"_ plus the program's own ENOENT — with the webhook counted separately as
      `retrying`, and the earlier `N-12` discard sitting in its own column without affecting the
      status. The log showed all four statuses side by side, and the webhook's `nextAttemptAt`
      moved from ~20 s to ~68 s between attempts.

      **What `P-12` still owes.** "Raised on Core Health" needs the Core Health sensor, which does
      not exist yet. `DeliveryHealthReader` is what it should read — shared, so the sensor and the
      API cannot end up disagreeing about whether delivery is working — and the note on `P-12`
      says which channels to make from it.
- [x] **N-14 — Send test notification** · S · N-05 · Per-template action with a full result
      report.

      **N-14 outcome.** `NotificationTester` and `POST /templates/:id/test`, sharing the
      dispatcher's own transport list — a test that went through a different set of transports
      would be testing something the alarms do not use.

      **It really sends, and that is the point.** The same rendering, the same transport, the same
      settings and the same recipients; a test that stubbed any of them would prove the stub
      works. Which also means somebody testing an on-call template at three in the morning has
      paged whoever is on call, so it is written to the audit log with who did it and whether it
      arrived — `template.tested`, the one read-shaped action in this system that puts a real
      message in front of real people.

      **What it skips is the queue.** No `notification_request` row, so nothing is retried,
      summarised (`N-11`) or suppressed by an activation schedule (`N-12`) — each of which would
      turn "did my relay work" into "wait fifteen minutes and find out".

      **Those three are reported instead, and that is the "full result report".** A green test on
      a template that is switched off, or outside its schedule, or set to summarise everything,
      has proved the relay works and proved nothing about whether an alarm would arrive. The
      `notes` say so in words: *"This template is outside its 'Weekends' schedule right now. A
      real notification would be thrown away."* Failures are reported rather than thrown — the
      error, whether it was retryable, and how long it took — because a 500 explains nothing to
      the person who clicked the button.

      **Without a `sensorId` it renders against an example sensor**, which is not a convenience:
      the first thing an operator does with a new installation is check that the SMTP relay works,
      and at that point there may be no sensors at all. The example link still points at the
      configured `publicUrl`, which is one of the things a test send should reveal.

      **Jim.** Verifying this live found the cause of the "MailHog is flaky under load" that had
      been blamed and worked around for four tickets: **Jim, MailHog's chaos monkey, is live in
      that image** and randomly answers `550 Invalid recipient`. Measured at one failure in ten
      test sends, and zero in twenty with Jim switched off in `docker-compose.dev.yml`. It is not
      something a suite can assert against either — a 550 is a permanent rejection by every
      correct reading, so the transport does not retry it and no amount of looping helps, which
      is why the `N-12` workaround only ever reduced the odds. The retry loop in the real-SMTP
      test stays as a defence against a genuinely busy relay; its comment now says what actually
      happened.
- [x] **N-15 — Notification scenario tests** · M · N-11 · 200-sensor outage → one immediate
      message plus digests, verified against MailHog and a webhook sink; a 30-second blip under a
      5-minute latency produces nothing.

      **N-15 outcome.** `packages/core/test/notification-scenario.test.ts`, and Phase 4's exit
      criteria are now measured in `PLAN.md`.

      **Against real delivery, not stubs.** A scenario test whose delivery is a mock proves the
      mock agrees with itself; the whole point of the criterion is that a message arrives
      somewhere an operator could look. So: a real ESMTP conversation with MailHog and a real
      HTTP server as the webhook sink, driven through the same `AlarmEngine`, `AlarmScheduler`
      and `NotificationDispatcher` production wires up.

      **The number: 200 sensors become 9 emails.** One immediate message for the first Down, then
      199 in 8 digests of 25, 25, 25, 25, 25, 25, 25 and 24 — the overflow split of
      `CAPABILITIES.MD §5.2` doing real work rather than being unit-tested in isolation. Each
      digest is numbered "(n of 8)".

      **And 200 webhook posts, which is the point rather than a failure.** The same outage, the
      same trigger set, a method that is never summarised. Asserting it here is what makes the
      trade-off visible: an operator choosing a machine-consumed channel is choosing every event.

      **Two triggers on the root, so every sensor arms two chains.** That fell out of writing the
      scenario and is worth stating: `N-01`'s inheritance accumulates, so the counts differ per
      method rather than per sensor, and 200 sensors produced 400 obligations.

      **The blip asserts absence, three ways.** No message arrived, no request was ever queued,
      and the armed chain was stood down rather than left waiting — because "nothing arrived" is
      also what a broken engine that never armed anything produces.

      **A real defect found by running it.** `AlarmEngine.react` issued its three reads with
      `Promise.all` on the caller's transaction client. pg queues them, so the results were right
      — and it emitted `client.query() when the client is already executing a query`, which
      **breaks outright on pg@9**. A transaction is one client and therefore one wire, so the
      `Promise.all` bought no parallelism at all; it is now three awaits. The deprecation is gone
      from the whole core suite.
- [x] **N-17 — Acknowledging a simulated error does nothing** · S · M-14, N-02 · `evaluate`
      returns at layer 2 for a simulated error, so acknowledgement — layer 6 — never runs. The
      API accepts the acknowledgement, records it, and the sensor stays `down` with cause
      `simulated`, which makes `M-14`'s own purpose ("test a notification chain end to end")
      impossible to complete: the escalation cannot be cancelled the way a real one would be.
      Decide whether a simulated error should be acknowledgeable (a layer-2 result that still
      falls through to layer 6), or whether the API should refuse the acknowledgement and say
      why. Either way `docs/state-machine.md §2` and `M-01`'s tables move with it.

      **N-17 outcome: acknowledgeable.** `docs/state-machine.md §2` and `§2.4` and `M-01`'s
      transition table have moved with it.

      **The decision, and the argument that settles it.** Layer 2 says *behave as though this were
      down*. `down_acknowledged` is how a Down behaves once somebody has acknowledged it, so
      refusing the acknowledgement made the simulation unfaithful at exactly the step worth
      rehearsing — "does acknowledging really stop the repeats at three in the morning" is the
      question an operator wants answered before the night it matters. The alternative the ticket
      offered, having the API refuse and say why, would have left `M-14` unable to complete its
      own stated purpose and put a special case on a route that otherwise treats every Down alike.

      **What did *not* change.** Layer 1 still beats it: a pause is an instruction to stop
      monitoring, and a paused sensor is nobody's alarm. It still short-circuits layers 3 to 5 — a
      forced outage ignores the probe and the readings. Only §2.4 is now applied to it, through a
      helper both layers call, because a second copy of the rule is how "acknowledging works,
      except on the path nobody tested" happens.

      **One new transition and one simplification.** `down_acknowledged → down` gained the cause
      `simulated`, for withdrawing an acknowledgement while the force still stands: the sensor is
      Down for that reason and no other, and `M-14` promises a forced outage says so. And the
      expiry override in `applyResult` lost its `decidedByReading` guard, which turned out to be
      redundant *and* now wrong — `evaluated.state === 'down'` already excludes a paused sensor
      (`paused`) and one whose probe is away (`unknown`), and a simulated Down should reach it,
      because since this change the acknowledgement really was suppressing something.

      **`M-16`'s carve-out was revisited rather than left standing.** §2.4 said an acknowledgement
      lapsing on "one held Down by a simulated error ended nothing an operator could see". That
      was true when the acknowledgement did nothing there; it is not true now, so the clause is
      gone and the reasoning is written down in its place.

      Verified live, and the state log reads as the rehearsal it is meant to be: `down/simulated`
      → `down_acknowledged/user` → withdrawn back to `down/simulated` → acknowledged again →
      force lifted → `up/scan` with the acknowledgement cleared. And in
      `notification-engine.test.ts`, the whole chain: the forced outage fires its initial
      notification, acknowledging suppresses the escalation *and* the repeats, and lifting the
      force fires the recovery — which is `M-14`'s purpose, finally completable.
- [x] **N-16 — Per-object trigger inheritance toggle** · S · N-01 · PRTG lets an object opt out
      of its ancestors' notification triggers entirely. `N-01` deliberately did not build it: it
      is not in `CAPABILITIES.MD`, and a trigger can already be switched off where it is defined.
      Decide whether an operator ever needs "this device notifies nobody, whatever the root says"
      — and if so, whether the toggle belongs on the object or is better served by a state
      trigger with no template. Mark the scope in `CAPABILITIES.MD` either way.

      **N-16 outcome: decided yes, and built.** `CAPABILITIES.MD §5.1` now carries the row,
      marked `[V1]`.

      **The decision.** The need is "keep monitoring this, but do not notify about it" — a lab, a
      staging rack, a customer still being onboarded. Nothing in the system says that. A pause and
      a schedule both stop the *monitoring*, which throws away the graphs and the uptime an
      operator still wants. Switching a trigger off where it is defined switches it off for
      everybody. `N-12`'s activation schedule is per template and time-based, not per subtree.
      Defining the triggers lower down instead of on the root works until somebody adds a group
      and forgets, which is a silently unmonitored subtree — the failure mode inheritance exists
      to prevent.

      **The suggested alternative provably does not work.** "A state trigger with no template" on
      the device would *add* a silent chain beside the root's noisy one, because trigger
      inheritance **accumulates** (`N-01`) rather than choosing the nearest. There is no way to
      write "and nothing from above" with the pieces that existed.

      **A column on `object`, not an inheritable setting**, and that is the interesting part.
      `CLAUDE.md` says inheritable settings go through one resolver — but a setting resolves to
      the nearest ancestor that defines it, so a group set to "do not inherit" would make every
      descendant resolve "do not inherit", and each of them would then also ignore *the group's
      own* triggers. That is the opposite of what was asked for. What is wanted is a fence at one
      object, and a fence is a property of the object it stands on.

      **Both walks honour it, and a test asserts they agree.** The tab walks up from a sensor and
      the engine walks down from a trigger; a fence one of them ignored would put a notification
      on a page that says no notification applies. Upward, the fenced node is still visited — its
      own triggers count — and the climb stops there. Downward, a child that does not inherit is
      never added, so the descent cannot pass through it. Same rule, opposite directions.

      **Flipping it moves standing alarms**, through the same `TriggerSync` hook a trigger edit
      uses, and only when it actually changed: that sink sees every rename, and reconciling a
      subtree because somebody fixed a typo is the regression `M-08` paid for once already.

      **Patch-only, and it clones.** Nobody creates a device already knowing it should notify
      nobody, so it is not on the create schema; a clone of a lab device is still a lab device, so
      it copies. The change is in the audit diff, because who gets told about a subtree is
      exactly the sort of thing somebody needs to find afterwards.

      Verified live: a root trigger reaching a sensor, the device fenced off, the effective set
      dropping to zero and a simulated outage queueing nothing at all; then the fence down, the
      trigger back, and the outage arriving in MailHog.

## Phase 5 — Web UI

- [x] **U-01 — Frontend scaffold** · M · F-01 · React 19 + TypeScript + Vite 8, routing, design
      tokens, light and dark themes, served as static assets by the core.
      **U-01 outcome.** Decision 8 named the framework and the charting libraries and left
      *styling* and *routing* unspecified; both are now filled and recorded in an amendment to
      that decision — Tailwind CSS 4 and React Router 7, with no component library. Design tokens
      are CSS custom properties rather than Tailwind theme keys, because uPlot draws to a canvas
      and cannot read a utility class but can read a custom property — so `U-05` gets the same
      palette without a second source of truth. Every `-fg` token meets AA in both themes, and
      `StatusBadge` gives each of the six `WORKFLOW.MD` §4 states a distinct glyph and its name,
      so colour is never the only signal.
      Serving is real, not planned: `api.webRoot` registers `@fastify/static`, deep links fall
      back to the app shell while `/api/*` keeps answering JSON 404s, hashed assets are immutable
      and `index.html` is `no-cache`. The static route is the only exemption from the
      response-schema guard and is enumerated in `ApiServer.assetRoutes` so a test can assert
      nothing else has crept in. `package.sh` builds and stages `dist`; `install.sh` puts it at
      `/opt/ms/web`; an empty `webRoot` serves no UI, which is what a headless install wants.
      **The UI says what is not true yet rather than drawing a green dial.** Every sensor reads
      Unknown, and each empty panel names the task that fills it — `P-08` for a sensor type,
      `R-04` for the config push, Phase 3 for the state machine.
      **Found while building it:** the core withholds *all* parameters of an unregistered sensor
      type (P-05's conservative fallback), and the first version of the detail page labelled them
      "write-only" — telling an operator their timeout was a credential. The page now checks the
      catalogue and distinguishes "set, write-only" from "withheld, type not registered".
- [x] **U-02 — WebSocket state stream** · L · P-12 · Subscribe to state changes by subtree;
      reconnect and resync; no full-page polling.

      **U-02 outcome.** `GET /api/v1/stream`, a `StateBroadcaster` in the core and a
      framework-free `StateStream` in the web app, with the tree wired to it.

      **The stated dependency is backwards, and nothing blocked.** `P-12` is the Core Health
      *sensor*; a state stream needs none of it. The real relationship runs the other way —
      `CLAUDE.md` says a new subsystem with a queue or a connection adds a metric to Core Health
      — so `StateBroadcaster.stats` is what `P-12` should read, and the note there says so.

      **The hard part was where a committed state change comes from.** Every reaction in this
      system deliberately runs *inside* the transaction — a dependency pause and an alarm chain
      must commit with the state that caused them (`M-11`, `N-02`). Publishing is the opposite: a
      frame announcing a state change, sent from inside the transaction that decided it, is an
      outage on an operator's screen that may never have happened. So `Queryable` gained
      `afterCommit`, and the publish hangs off **`writeStateHistory`** — the one function every
      state change in the system goes through, from ingestion, a pause, an acknowledgement, a
      simulated error, a dependency cascade and a schedule window alike. One seam, and a new path
      cannot forget. It announces only the rows that actually landed, because
      `ON CONFLICT DO NOTHING` drops a repeat and announcing the drop would describe a history
      the table does not have.

      **Subscribe, then snapshot, then stream — and the order is the whole design.** The
      subscriber is attached *before* its snapshot is read, so a change landing in between is
      queued and delivered afterwards rather than falling into the gap. Applying it a second time
      sets the state it already has, which is why this ordering is safe and the intuitive one
      silently loses changes.

      **Resync is "subscribe again".** No cursor, no replay log: a client that reconnects, or
      that is told it overflowed, resubscribes and is handed a fresh snapshot. A cursor would
      mean the server keeping a buffer whose length is a guess about how long a laptop stays
      shut, and getting that guess wrong shows somebody a stale tree with no way to tell.

      **A subscriber that cannot keep up is cut off and counted, never quietly trimmed.** A
      client missing a change from the middle of the stream shows a state the system has moved on
      from and has no way to know. And an installation with nobody watching pays *one comparison*
      — the ancestry read that scopes an event to a subtree only happens when there is a
      subscriber, the same guard `M-09` and `N-02` put in front of their sweeps.

      **Events carry the absolute path**, root first. Not overhead: it is how a subtree
      subscription is matched without a query per event, and it is what a tree rolls a colour up.
      The snapshot walks *up* from the subtree root before walking down, so its paths are the
      same absolute paths the events carry — a client matching one against the other would
      otherwise find the tree it drew and the tree it updates rooted differently.

      **Offline keeps the last states on screen and says so.** Blanking the tree is the
      honest-looking mistake: it says "nothing is wrong" about a subtree nobody is hearing from.

      **Two things found on the way.** `@ms/web` had no `pretest`, so its typecheck ran in no
      loop anybody used — and had been failing: `LimitBand` was passed a `decimals` prop it did
      not declare. It now formats limits at the channel's precision, because a limit shown as
      "500" on a channel reading "499.98" reads like a threshold nobody crossed. And
      `@fastify/swagger` does not describe routes that upgrade, so `/stream` is absent from the
      OpenAPI document; rather than pretend otherwise, the document's own description says where
      the stream is and how to talk to it.

      Verified live against the dev stack: a socket subscribed to a device's subtree received the
      snapshot of its three sensors and then `state` frames, numbered in sequence, as a simulated
      error went on and came off.
- [x] **U-03 — Device tree** · L · U-02 · Virtualised tree with rollup status colouring, live
      updates, search and tag filtering. Responsive at 5,000 sensors.
      **Added by S-14:** the tree already comes back in the operator's arrangement, and
      `POST /objects/{id}/order` moves an item one place or to an end. Drag-to-position is not
      covered — it would want an `{ after: siblingId }` form of the same endpoint, which is a
      small addition to `reorderSiblings` when this task knows it needs one.

      **U-03 outcome.** Three concerns that a tree normally tangles together, kept apart: the
      **shape** is fetched, the **states** are streamed, and the **rollup** is computed from the
      stream alone.

      **Shape: a level at a time, and cached.** `GET /objects?parentId=X&sort=manual&limit=500`
      per expanded branch, not `GET /objects/{id}/tree` — that route caps at 5,000 objects with
      no cursor, and the v1 target is 5,000 *sensors*, so the whole-subtree read is the one call
      guaranteed to hit its own ceiling on the installation this task exists to serve. Collapsing
      keeps what it loaded, so re-expanding is free.

      **Rollup from the stream, not from the children.** A collapsed group shows the colour of an
      outage inside it **without its children ever having been loaded** — verified live: with
      the tree collapsed to its two probes, a simulated error on one Ping sensor turned Smoke
      probe red, and clearing it turned it green again, no reload and nothing fetched. This works
      because `U-02`'s events carry the absolute path, so one pass over the live states rolls a
      colour onto every ancestor id in it. The alternative — rolling up from loaded children —
      makes a collapsed branch a liar, which is the one thing a status tree may not be.

      **The severity ladder is this file's own, and it is not the core's.** I first wrote that it
      mirrored `ROLLUP_SEVERITY` and that was wrong: the core's ladder ranks `up`/`warning`/`down`
      for a *channel* rollup and knows nothing of `paused` or `unknown`. A tree needs the full
      set, and two rungs are deliberate. `up` beats `paused`, because a branch holding one live
      sensor and forty paused ones is a branch that is up — reporting it as paused hides the
      thing still being watched. `unknown` beats `up`, because "we are not hearing from this" is
      a weaker claim than "this is fine" and must not be painted over by it.

      **Virtualised, and measured rather than asserted.** `VirtualList` renders the visible window
      plus overscan between two spacer divs. Measured on the 5,000-sensor shape the exit criteria
      name: **5,200 rows flattened and 5,000 states rolled up in 4.4 ms** (`tree-model.test.ts`),
      so a state change repaints inside a frame. Flattening is iterative, not recursive — a tree
      deep enough to blow the stack is a tree an operator built, not a bug.

      **A virtualised tree has to keep telling the truth about its size and its shape.** Every row
      carries `aria-posinset`/`aria-setsize` against the *whole* list, so "row 400 of 5,000" holds
      when eleven rows exist — a list that reports the eleven has hidden the installation. The
      roles come from the caller rather than the component: the first version was a `listbox` of
      `option`s with `aria-rowcount`, which is wrong three ways over — `aria-rowcount` is only
      valid on a grid, `option` announces a selection model this has none of, and a flattened tree
      without `aria-level` is read out as one flat list of names, losing the only thing the
      indentation was saying. It is now a `tree` of `treeitem`s carrying `aria-level` and
      `aria-expanded`, verified in the browser as well as in `virtual-list.test.tsx`.

      **Search and tag filtering are the server's**, `q` and `tag` on `/objects`, because
      filtering the loaded shape would only ever search the branches somebody had already opened.
      Tag matching is inheritance-aware, so searching `linux` finds the sensors under a device
      tagged `linux` and not only the device — confirmed live.

      **Found while building it.** `StatusBadge` was being passed a `label` prop it never
      declared, and **TypeScript did not catch it**: JSX spread attributes skip excess-property
      checking, so the badge had been silently dropping it. It now has a real `describedAs` prop
      that sets `role="img"` and an `aria-label` — which the tree needs anyway, because a group's
      badge is the worst state *beneath* it and a bare "Down" announced on a group is a claim
      about the group. And Vite's `/api` proxy had no `ws: true`, so the stream worked when the
      core served the built app and 400'd in development only: broken for the people building it
      and nobody else.

      **`StateStream.close()` was permanent**, so React StrictMode's mount/unmount/mount left the
      tree saying "Connecting…" forever. `subscribe()` clears the flag; the double-invoke found
      a real bug, which is what it is for.
- [x] **U-04 — Sensor detail page** · L · U-02, S-08 · Live graph, channel table, historic tabs
      (2d/30d/365d), log, settings, triggers.

      **U-04 outcome.** Six tabs — overview, history, log, settings, triggers, changes — over one
      page that works for a device and a group as well as a sensor, minus the tabs those kinds do
      not have. The tab is in the URL, because "look at the triggers on this sensor" is a thing
      one person sends another and a tab held in component state cannot be linked to.

      **The one endpoint this needed: `GET /sensors/{id}/values`.** A channel table needs current
      readings and nothing served them — `/objects/{id}/channels` is configuration and
      `/sensors/{id}/history` is a range. It is `DISTINCT ON (channel_id)` against the
      `(channel_id, time)` index, behind `TimeSeriesStore` like every other time-series read
      (`S-12`).

      **A reading older than the window is withheld, not shown with a timestamp beside it.** This
      is the same rule as "no-data is not zero", one step further out: a number on a screen is
      read as current whatever is printed next to it, and a sensor that has been Down for a day
      showing its last healthy figure is precisely the failure this system exists to prevent. So
      the value is `null` and the table says "no recent reading". A genuine zero — packet loss of
      0% — prints as `0`, and the two are visibly different rather than both being blank.

      **The window is three scan intervals, resolved through the inheritance resolver.** A
      constant would have to be either too short for a daily check — reporting every one of its
      channels as silent between scans — or long enough to call a minute-interval sensor's
      hour-old reading current. Three, because one is too tight to survive a single missed scan,
      and by four the failure policy has taken the sensor to Down anyway (`M-03`). The interval is
      usually set on the device or the group, so it goes through the resolver rather than reading
      the sensor's own row — parent-walking happens in one place (`CLAUDE.md`).

      **State is streamed, readings are polled, and the split is deliberate.** `U-02` carries state
      changes, which is what the badge needs and what has to be immediate — verified live: a
      simulated error turned the header red with its message inline, no reload. Channel *values*
      change every scan whether or not the state does, and a frame per reading per sensor would be
      a stream nobody could keep up with. So the table refreshes on an interval, paused while the
      tab is hidden. It is the only thing in this app that polls.

      **Found while building it — a real `U-02` bug.** The stream's snapshot entries carry `since`
      and its `state` frames carry `at`; the client declared both as one shape, so every
      timestamp after a reconnect was `undefined` and the header read "since Invalid Date". The
      tree never noticed because it shows no timestamps. **The test fixture had the same mistake
      in it**, which is why the suite agreed: it sent `at` on a snapshot entry, so a fixture
      written from the same wrong assumption as the code confirmed the code. The fixture now
      mirrors what the core actually sends, the two shapes are declared separately so the
      conversion has to exist, and the conversion is tested.

      **Also found: the plot's own geometry became a reading.** A packet-loss channel that has
      only ever read 0 has no range to scale against, so the scale is padded — and the label
      quoted the padded scale, announcing "-1 % to 1 %" about a channel that has never been
      anything but zero. Measured range and drawing scale are now two separate numbers; a flat
      series reads "steady at 0 %".

      **The graph is not uPlot yet**, and that is `U-05`'s line rather than a shortfall here: this
      draws a column per bucket with the min-max band and the average, so the gap rule is enforced
      and visible from the first day the page exists — a gap is *not rendered*, never a
      zero-height bar on the baseline. Verified against real data: a 2-day range showed 441 of 961
      buckets as gaps with holes in the right places, and a 365-day range came back assembled from
      `sample_1h + sample_5m + sample`, which is `S-08`'s three-tier stitch visible in the UI.

      **And a second core bug, found by looking at the Changes tab: the audit log was sorted as
      text.** `SELECT id::text, … ORDER BY id DESC` — and in PostgreSQL an unqualified name in
      `ORDER BY` binds to the *output* column first, which that cast had just made a string. So
      entry 9 sorted above entry 253 and the history read as though it had jumped back in time.
      Worse, the keyset cursor compares numerically (`id < $n`), so it and the sort disagreed and
      paging silently skipped entries and repeated others. Invisible while every id has the same
      number of digits, which is why nothing caught it for ten tickets. Fixed by qualifying the
      sort; the same shadowing was in `NotificationRepository.sensorsUnder`, where it decided
      which sensors survived a truncation, and is fixed too. The regression tests place ids across
      three digit widths rather than growing them, because with grown ids the bug hides — both
      tests were confirmed to fail against the old SQL.

      Settings name the object a value came from rather than its id, resolved against the
      breadcrumb the page already loaded — an inheritable value can only come from an ancestor.
      The tab strip has roving tabindex and arrow-key navigation per the ARIA practice, checked in
      the browser: only the selected tab takes a tab stop.
- [x] **U-05 — Time-series charts** · L · U-04 · uPlot panels per the `dataviz` guidance;
      gap-aware rendering (breaks, never a line to zero); themed; accessible.

      **U-05 outcome.** Real uPlot panels on the history tab, with the min–max band behind each
      average, a crosshair and one tooltip listing every series at the hovered bucket, a legend
      carrying each channel's latest value, and a table view.

      **The dual-axis trap is designed out rather than resisted.** A Ping sensor reports response
      time in milliseconds and packet loss as a percentage. On one y-axis either loss is
      invisible against a 250 ms scale or the scale means nothing; on two, the crossing point of
      the lines is an artefact of where the axes were put and a reader takes it for a
      relationship — the single most common charting mistake, and the `dataviz` guidance is blunt
      about it. So `groupByUnit` splits channels into one chart per unit and a panel is
      structurally incapable of holding two scales. Channels that *do* share a unit stay together,
      because that is where comparison is real: a Traffic sensor's in, out and sum belong on one
      axis.

      **Colour follows the channel, never its position on screen.** The palette slot comes from a
      channel's index in the sensor's whole channel list, not its index within a group — so
      splitting by unit, or a sensor type gaining a channel, never repaints the others. Verified
      live: with both Ping channels forced onto one chart and then split apart again, response
      time stayed orange and packet loss stayed blue.

      **The palette was computed, not chosen.** Eight categorical slots from the `dataviz`
      reference palette, re-run through its validator against *our* surfaces rather than the
      skill's — a contrast or lightness result only means something against the surface the chart
      actually draws on. Light on `#ffffff`: worst adjacent CVD ΔE 9.1, worst normal-vision ΔE
      19.6. Dark on `#111827`: 8.4 and 19.3. Both pass every gate. Three light slots sit below
      3:1 on white, which is a WARN whose relief is mandatory — the table view and the
      value-bearing legend are that relief, and both ship on every chart. The command is in a
      comment beside the tokens so the next person changing a hex re-runs it.

      **Status colours are not series colours.** The state tokens stay reserved: a colour that
      also means "channel 4" stops meaning "down".

      **The gap rule survives the change of renderer, which is the point of doing it now.**
      `spanGaps` stays false and no code path turns a null into a number, so a period with no
      readings is a break in the line. uPlot's alternative would be to join across it, and a
      joined line is the same lie as drawing to zero told more convincingly. The tooltip reports
      a gap as "no reading" rather than omitting the row — omitting it would let a reader
      conclude the channel does not exist there. Confirmed live at 3-minute resolution: 430 of
      961 buckets are gaps and the line breaks in every one of them.

      **The canvas is `aria-hidden` and the data lives in the table.** A canvas carries no text an
      assistive technology can reach; a `figcaption` names the chart and its range, and the table
      view is the WCAG-clean twin rather than a fallback. Both themes are selected sets, not an
      automatic flip, and switching one rebuilds every chart live — the colours are read from the
      document's own custom properties at draw time, which is what `U-01` chose custom properties
      over Tailwind theme keys for.

      **Found while building it.** Automatic precision meant "up to six decimal places", which is
      right for a stored reading of `0.223 ms` and wrong for a 45-minute average of
      `0.20335648…` — six digits of it manufactured by dividing. It now means three significant
      digits, with the places moving with the magnitude so `0.000412` does not round to a zero.
      And the history API did not carry a channel's configured precision at all, so a chart had no
      way to honour it; `decimals` now travels with `ChannelRef` through `TimeSeriesStore`.

      **A second one found by reviewing rather than by running it.** The legend resolved its key
      colours in JavaScript at render time, so a theme toggle rebuilt the canvases and left the
      legend beside them in the old palette — invisible in the dev data, where every panel is a
      single channel and has no legend at all. The DOM does not need a resolved colour: the keys
      now carry `var(--ms-series-N)` and re-resolve themselves when the attribute on `<html>`
      changes, with no re-render to forget. Only the canvas reads values.

      Refetching holds the previous render at reduced opacity rather than flashing a skeleton, and
      the range and view controls sit in one row above every panel they scope, so two panels can
      never disagree about which period they show.

      **Not done here, and deliberately: keyboard focus on the marks.** The guidance asks for the
      same detail on focus as on hover; the canvas is `aria-hidden` and not focusable, and the
      table view is the reachable equivalent the same guidance names. `U-11` is where a focusable
      crosshair belongs if it is wanted at all.
- [x] **U-06 — Alarms view** · M · U-02, M-13 · Severity filters, branch scoping, priority and
      duration sorting, inline acknowledge/pause/resume.

      **U-06 outcome.** `GET /api/v1/alarms`, `AlarmService`, and the view at `/alarms` — second
      in the nav, before the tree, because `WORKFLOW.MD §7` calls it the operator's home screen.

      **What counts as an alarm is named, not derived.** The five states `WORKFLOW.MD §7` lists,
      and two deliberate absences. **Paused is not an alarm**: somebody switched it off on
      purpose, and a list that reports deliberate silence is the list an operator learns to scroll
      past — which is how the real alarm underneath it gets missed. **Unknown is not one either**:
      it means nothing has scanned this yet, true of every sensor in a fresh installation and of
      every sensor for one interval after a resume. A gap in coverage, not a fault.

      **The index for this was created eleven tickets ago.** Migration 008 added
      `sensor_runtime_not_up_idx` — partial, on the states that are not Up — naming `U-06` in its
      comment, because in a healthy installation the answer is a handful of rows out of thousands
      and a sequential scan to find them would be the one query that got slower as the product
      succeeded. This is the read that uses it.

      **The ancestry walk goes up from the alarms, not down from the root.** Scoping to a branch
      and naming each alarm's place are the same question — is this object in the chain, what are
      the chain's names — so one upward walk from a few dozen alarming sensors answers both. A
      downward walk would touch every object in the installation on a view that refetches whenever
      anything changes state.

      **The severity chips count what they hide.** The state filter is applied *after* the scope,
      not before, so a reader filtered to errors-only is still told there are three warnings. The
      first version filtered in the scan and the counts silently agreed with the filter — caught
      by its own test, which is what that test was for.

      **The list is the server's answer; the stream is only the prompt.** Sorting by priority then
      duration, scoping, counting: one query, not a second implementation in the browser. What
      `U-02` contributes is knowing *when* to ask again, debounced by 400 ms so a switch taking
      forty sensors down is one request rather than forty. Verified live: forcing an error put a
      row on screen with no reload, and clearing it took the row away and reset every chip.

      **Inline actions, because the alternative is forty round trips.** Acknowledge with the
      `CAPABILITIES.MD §5.3` presets, un-acknowledge, and pause — the same endpoints the detail
      page calls, nothing newly authorised. A refused action says so in the row: leaving it
      unchanged would read as a click that did not register, and the operator would click again.

      **A real defect in `M-14`, found because this view puts the message on the front page.** A
      forced sensor keeps being scanned — the force changes what its readings *mean*, not whether
      it takes any — and the result path overwrote the runtime message with the probe's. So a
      simulated outage read **"Down — 2/2 replies, min 0.072 ms"**, which is a row nobody can make
      sense of. The rule already existed and was already named: `operatorDecided`, which
      `reevaluate` consults and the result path did not. It does now, and keeps what is stored
      rather than blanking it, because there are no fresh operator words at that moment. Two
      tests, both of which fail against the old behaviour.

      Filters live in the URL, so "look at the Berlin alarms" is a link somebody sends; the
      object detail page links to its own scope.
- [x] **U-07 — Logs view** · M · M-15 · PRTG's category structure: status changes, system events,
      object history; filters and paging.

      **U-07 outcome.** `/logs` with the three categories `CAPABILITIES.MD §6` names, each backed
      by its own endpoint, plus a new `GET /api/v1/audit` for the global object history — the only
      one of the three that had no route, because `S-10` only ever exposed audit per object.

      **Three tabs rather than one merged stream.** They are three tables answering three
      questions: when did this sensor break, who changed this, and did anybody get told. Merging
      them would need a lowest-common-denominator row that describes none of them well, and then
      a filter to get back to the one you wanted.

      **Every list pages by keyset, never by offset.** Rows arrive while somebody is reading — a
      sensor changes state, somebody saves a setting — and an offset page recomputed against a
      shifted table shows a row twice or skips one. Verified live on 200 object-history rows: all
      200 distinct and still descending across the page boundary.

      **Loading more appends; changing a filter discards.** A log is read downwards, so a "load
      more" that swapped the list would lose the reader's place. But rows fetched against the old
      query answer a different question, so a filter change drops them rather than showing them
      under the new heading. Both are tested, along with the one that would look like it worked:
      paging from the *second* page's cursor rather than the first, which otherwise refetches page
      two for ever.

      **`objectId` on the audit list is that object exactly, never its subtree.** A subtree scope
      has to walk `object` to find descendants, and the entry most worth reading is the one
      recording a *deletion* — written about an object with no parent left to be found through. So
      scoping that way would silently drop precisely those. Category filtering is the alternative
      and works the same whether the subject still exists.

      **Twenty-six actions became seven categories**, the action's first segment, matched with
      `split_part` rather than a prefix `LIKE` so `object` can never also select a hypothetical
      `objectgroup.created`.

      **Found while building it: the web `AuditEntry` type disagreed with the wire on two
      fields.** `id` is a `bigint` served as a string and the client declared it a number — and it
      is also the paging cursor, so a rounded one would page to the wrong place; `objectId` is
      nullable and the client said it never was. Neither had bitten yet because the only consumer
      was the detail page's Changes tab, which reads neither field for anything load-bearing.

      System events carry only notifications, which is all v1 produces — the tab says so rather
      than showing three empty sections for auto-discovery, reports and clustering. The object
      detail page links to both its scoped alarms and its scoped log.
- [x] **U-08 — Schema-driven settings forms** · L · P-05, U-01 · Forms generated from each sensor
      type's `paramsSchema`, so a new sensor type needs no frontend work.

      **U-08 outcome.** `packages/web/src/forms/` builds a form from a `paramsSchema`, wired into
      both places a sensor's parameters are written: the detail page's Parameters card, and a new
      add-sensor flow reached from a device. `P-05` published the catalogue's schemas for exactly
      this, and the promise in `docs/adding-a-sensor-type.md` — that a type is a one-file job —
      only holds if nobody has to hand-write a form to go with it.

      **A defect in the core, and this is the one that mattered.** `params` is *replaced* on
      update, and a read never returns a `writeOnly` value. So any client that reads a sensor and
      writes it back deletes every credential it holds, on the first save, silently — and the
      sensor keeps scanning until the next authentication failure. A generated form is precisely
      such a client; so is a script, so is `curl`. `SensorCatalogue.carryWriteOnly` is the mirror
      of redaction and lives in the same place for the same reason: **absent** keeps the stored
      value, **present** replaces it, **`null`** removes it and is then validated, so a required
      secret cannot be cleared and an optional one can. Five tests, two of which fail against the
      old behaviour.

      **The form never fills a credential and never sends an empty one.** A `writeOnly` parameter
      shows "set, write-only" with Replace and Clear; leaving it alone omits the key entirely.
      Pre-filling would be pre-filling a lie, and submitting the empty box would be the deletion
      above with extra steps.

      **A field the controls cannot draw becomes a JSON box, never nothing.** Same reason: a
      control that silently skipped an array would delete it on the next save. The catalogue
      permits schemas richer than these controls cover, and the honest answer to one is to hand
      the operator the value.

      **Defaults are pre-filled when adding and not when editing.** The core applies and *stores*
      schema defaults at validation time, so on a new sensor the default is what is about to
      happen and showing it is honest. On an existing one the same pre-fill would say a parameter
      is set when the stored row does not have it.

      **Client-side validation is a convenience, and says so.** It checks *less* than Ajv rather
      than differently — two validators that disagree are worse than one — so combinators,
      formats and conditionals are left to the core, whose refusal names a path. That path is
      shown against the field it names rather than as a banner over twelve inputs, which needed
      `ApiError` to start carrying `details` and needed to read **both** problem shapes: Fastify's
      request validator says `instancePath`, the sensor-type gate says `path`.

      **`If-Match` is sent, because the core requires it and is right to.** Two operators with
      this form open is the realistic collision, and under last-write-wins the second save
      silently reverts the first. Verified live: an external change made the open form stale and
      the save came back 412 with a message saying whose change it would have overwritten.

      Generated labels are sentence case to match the rest of the UI — a declared `title` always
      wins.
- [x] **U-09 — Inheritance-aware controls** · M · S-04, U-08 · Every inheritable field shows the
      inherited value and an override toggle; reverting discards the local value.

      **U-09 outcome.** The Settings tab stops being read-only: each setting shows what is in
      force, where it came from, an override toggle, and — the part that needed an API change —
      what reverting would restore.

      **`SettingView` gained `inherited`, and the toggle cannot work without it.** The view
      already carried the *effective* value and `own`, but when a setting is overridden, what the
      object would fall back to is nowhere in the response. A UI could only show an operator what
      reverting does by doing it. `inherited` is the setting resolved **at the parent** — which is
      what a revert means, since inheritance is nearest-ancestor and discarding the local value
      removes this object from the walk — and the registry default at the root, which has no
      parent to ask.

      **Overridden-to-the-same-value stays a distinct state, and this is the subtle one.**
      `own: { value: 300 }` under a parent that also says 300 is a deliberate pin: when the parent
      moves to 30, this object stays at 300. A control that decided "is this overridden?" by
      comparing the effective value against the inherited one would silently turn that pin into a
      follower. The toggle reads `own`, which is `null` or a value and never a comparison — the
      response schema has said so since `S-04`, and there is now a test that walks the parent
      underneath a pin and asserts it holds.

      **Turning the toggle on writes immediately**, with the value it is already showing, rather
      than leaving a pin that exists only in the browser until somebody types something. Turning
      it off is `DELETE`, which discards the local value; the sentence beside it says what will
      come back and names the ancestor it comes from rather than an id.

      **The inherited value is shown disabled, not hidden.** It is the fact an operator came to
      read; hiding it behind the toggle would make them switch the toggle on to find out what they
      were about to override.

      **Controls are `U-08`'s, extracted so there is one of them.** `SchemaControl` now renders a
      value from a schema for both the sensor-parameter form and this, because two places deciding
      what an `integer` with a `minimum` looks like is two places to fix when one is wrong. One
      thing does not transfer: a setting's key is dotted — `scan.intervalSeconds` — and the params
      form's path machinery would read that as nesting, so `fieldFor` builds the field model
      directly. A nullable setting is not "required": `schedule.id: null` means "always", and
      calling it required would make that unreachable through the control.

      Verified live end to end: override, edit, save, watch the origin change to "set here";
      set the interval on the device and see the sensor say "inherited from ms-target"; override
      at the same value and read "Reverting restores 120, from ms-target"; revert and watch it
      return to inheriting.
- [x] **U-10 — Notification configuration UI** · L · N-05 · Template editor with live placeholder
      preview and test send; trigger editor showing inherited triggers and their source.

      **U-10 outcome.** `/templates` edits templates and the Triggers tab edits triggers, both
      forms generated from schemas the core already publishes: a notification method's
      `settingsSchema` and a trigger kind's. That is the third and fourth use of `U-08`'s form
      generator, and adding a method or a kind stays a backend-only job.

      **The preview renders the draft, which needed a new route.** `POST /templates/preview` takes
      an *unsaved* template and a sensor, and runs it through the same `#parse` every write uses.
      Previewing what is stored instead would have shown the operator the old subject line while
      they typed a new one — the one thing a live preview exists to prevent. It is debounced at
      500 ms rather than fired per keystroke: substitution is a round trip, and the answer changes
      about once a word.

      **A misspelled placeholder is refused, not half-rendered.** `%sensorr` gets "this template
      uses placeholders this build does not know", the offending name, and the full valid list —
      because the save path refuses it too, so a partial render would preview something
      unsaveable. The refusal is rendered with its details, not just its sentence; the list is the
      useful half.

      **Deleting a template in use is refused with the list.** `N-05`'s "used by" lookup stands in
      for the foreign key a `jsonb` reference cannot have, and the refusal now renders each
      trigger with a link to the object's Triggers tab — measured live: `"On-call email" is still
      used by 1 trigger(s)`, one click from the thing holding it.

      **Inherited triggers are shown, read-only, with their source**, and the note says they fire
      *as well as* the ones defined here rather than instead of them. That is `WORKFLOW.MD`'s
      rule, and it is the one an operator gets wrong: a trigger list that showed only the local
      ones would make a device-level trigger invisible from the sensor it fires for.

      **One seeding function, because there were three copies of it.** Sensor params, method
      settings and trigger settings all pre-fill from schema defaults, and all three walked only
      the top level of `fieldsOf`'s tree — so a default nested inside an object property was
      declared, drawn as an empty control, and never saved. `seedDefaults` walks it, and skips
      `writeOnly` everywhere: a credential with a declared default would otherwise be written by a
      form nobody typed a secret into.

      Verified live end to end: created a template through the form, watched the preview follow
      the subject line, sent a test that arrived in 64 ms carrying `N-14`'s notes, attached it to
      a trigger, had the delete refused with the link, and read an inherited threshold trigger on
      the sensor showing "from ms-target".
- [x] **U-11 — Accessibility and responsive pass** · M · U-03…U-10 · WCAG 2.1 AA, keyboard
      navigation, touch targets, no horizontal body scroll.

      **U-11 outcome.** A pass over the nine routes in both themes, measured in the browser
      rather than reasoned about: a script walked every rendered node computing contrast against
      the surface actually behind it, listed everything narrower or shorter than 24px, and
      reported any element crossing the viewport's right edge that no ancestor scrolls.

      **The tree announced itself as a tree and had no arrow keys**, which is worse than not
      claiming to be one: `role="tree"` tells a screen-reader user the arrows walk the branches,
      and they walked nothing. It is now the ARIA pattern — up and down, right to open then
      descend, left to close then climb, Home and End, Enter to open the object — with a roving
      tab stop. That collapsed the tree from one tab stop per row *plus* one per expander and one
      per link to exactly **one**, whatever the row count; at the 5,000-sensor target the old
      shape was about 15,000 stops. The decision half is a pure function, `treeCommand`, because
      "left closes an open branch, and climbs from a shut one" is the pair that gets swapped.

      **A roving tab stop needs the row to survive the rows changing.** Collapsing a branch takes
      rows away underneath the active index, and an index past the end means nothing carries
      `tabIndex={0}` — a tree with no way back in from the keyboard at all. `keepActive` follows
      the object id and clamps when it has gone; verified live by collapsing a branch from the
      mouse while the keyboard sat three levels inside it.

      **`--ms-border` was 1.23:1 under every input in the light theme.** WCAG 1.4.11 holds the
      boundary of a user interface component to 3:1, and the divider grey was never going to meet
      it. `--ms-control-border` is a second grey for the edge of anything pressable — one value
      that clears 3:1 on all six surfaces (worst case 3.57 light, 3.74 dark) — and dividers keep
      the old one, because a rule between table rows is decoration and the criterion does not
      reach it. Three destructive buttons wearing `border-down-border` at 1.9:1 moved to
      `border-down-fg` for the same reason.

      **Forty-one controls had no focus indicator in forced-colors mode**, and it looked fine
      everywhere else. They carried `focus:outline-none focus-visible:ring-2` — and a ring is a
      `box-shadow`, which Windows High Contrast drops, so those controls had removed the outline
      and put the indicator somewhere that mode does not paint. They now use the one base
      `:focus-visible` rule, which is an outline, and it takes `Highlight` under forced colors.
      A focused row insets its outline: at the full width of a scrolling viewport the default
      2px offset is clipped, leaving a single line that reads as a divider.

      **The document title never changed** — nine routes, all "MonitoringSystem" (WCAG 2.4.2) —
      and focus stayed on the link that was clicked, so a screen-reader user got no announcement
      that the page had changed. `PageTitle` owns the `h1`, the title and the focus together,
      because a route cannot then set one and forget another. It moves focus on a *route* change
      only: not on first load, where focus belongs at the top with the skip link, and not on a
      re-render, where it would yank a keyboard user out of the control they are using every time
      data arrives.

      **The header nav pushed every page 60px wider than a 375px viewport.** One flex row of six
      links that could not wrap, so `1.4.10` failed identically on all of them; the tree's two
      filter inputs did the same at 320px. Both reflow now. Touch targets under 24px were the
      small controls, so the floor is one base rule rather than a class on each: a `text-xs`
      button with `py-1` measures 22px, and the next one written would have too.

      Measured after: no horizontal document scroll on any route at 320px, no text or control
      boundary under its threshold in either theme, and nothing pressable under 24px.

## Phase 6 — Sensor breadth

- [ ] **U-12 — Repeating fields in the generated form** · M · U-08 · An array of objects in a
      `paramsSchema` renders as `U-08`'s JSON fallback — an editable textarea holding the raw
      value. It round-trips correctly and deletes nothing, which is why the fallback exists, but
      an operator configuring one types JSON by hand.
      **Added by `T-04`:** `snmp.table.columns` is the first shipped parameter of that shape, and
      `T-06`'s filter rules will be the second. Wants `kind: 'array'` in `forms/schema.ts` with
      add/remove/reorder over `items`, and it must keep working for a free-form array with no
      `items`, which still has to fall back.
- [x] **T-01 — SNMP session layer** · L · P-05 · v1/v2c/v3 (auth + priv), connection pooling per
      device, timeout and retry, bulk-walk support, vendored `net-snmp`.

      **T-01 outcome.** `packages/sensors/src/support/snmp/` — credentials, OIDs, a session and a
      pool. Nothing here is a sensor type; `T-02`…`T-06` are, and they all sit on this.

      **Isolated, not vendored, and the ADR is amended rather than ignored.** The row this task
      quotes says "vendor a fork" against a single-maintainer risk. Measured: `net-snmp` 3.26.3 is
      MIT, published April 2026, and its entire tree is `asn1-ber` and `smart-buffer` — no native
      code anywhere, which also corrects ADR-001's Decision 10 claim that it needs one. What
      replaces vendoring is a boundary: `session.ts` is the only file in `packages/` that imports
      it, and `net-snmp.d.ts` declares the whole surface used in about eighty lines. That file is
      the inventory, so the replacement cost is bounded at one module — and carrying 15,000 lines
      of somebody else's USM implementation today would forfeit the upstream fixes that are the
      reason to use a maintained library.

      **Credentials are an argument, not something this reads out of `params`** — which is what
      makes `A-05` a change of caller rather than a rewrite. `credential_set` has existed since
      migration 001 and `InheritanceResolver.resolveCredentials` already walks it; what is missing
      is the write and decrypt half. **`A-05`'s own note says it must be pulled forward or
      credentialed sensors are unusable, and `T-01` is where that becomes real**: until it lands,
      an SNMP sensor carries its own community string, so forty sensors on a router hold forty
      copies and rotating one means editing forty. The transport is correct either way.

      **Three things a well-behaved agent will not do, and all three are handled.** A walk fails
      rather than spins when an agent answers with an OID that does not increase; fails rather
      than truncates at `maxVarbinds`, because a table quietly missing its tail reads as a device
      that lost interfaces; and stops at the subtree edge by comparing OIDs *arc by arc*, since
      `1.3.6.1.2.1.2` is not a prefix of `1.3.6.1.2.1.25` but its text is.

      **`Counter64` stays a `bigint` and an `OctetString` stays a `Buffer`.** `ifHCInOctets` is
      the counter that exists to go past 2^53, which is exactly where a `number` starts dropping
      low bits — `T-02` computes deltas across wraps from these. An `OctetString` is bytes: a MAC
      address is not UTF-8.

      **Abort cancels the request, never the session.** The socket belongs to every sensor on the
      device, so closing it because one check timed out would fail the others mid-flight. The wait
      is abandoned and net-snmp's callback lands later on a settled promise.

      **Tested against a real socket, not a mock.** `test/support/snmp-agent.ts` is a hand-written
      v1/v2c responder — the SNMP half of `P-06` arriving early — because what a session layer
      needs tested is an agent that misbehaves on demand: silent, dropping the first datagram,
      walking backwards, returning an error-status. v3 goes the other way and uses `net-snmp`'s
      own agent, because USM is engine discovery, key localisation and a cipher, and a
      reimplementation in a test would only prove two halves of one mistake agree. authPriv with
      SHA and AES succeeds; wrong auth key, wrong priv key, wrong protocol and unknown user all
      fail, which is what gives the success its meaning. 51 tests.

      **Not done here:** the `paramsSchema` fragment is written and tested but no sensor type uses
      it yet, and the pool exposes `stats()` in the shape the wheel and worker pool use but
      nothing collects it until `P-13`.
- [x] **T-02 — SNMP Traffic sensor** · L · T-01 · In/out/sum channels, 32- vs 64-bit counters,
      wrap and reset detection, interface selection at add time.

      **T-02 outcome.** The sensor type is `packages/sensors/src/types/snmp-traffic.ts`, and most
      of the work is not in it: turning a counter into a rate is a *core* concern, and this is the
      first type that needed it.

      **Counters are divided in the core, not on the probe.** An interface reports octets since it
      was last reset; the rate is the difference between two readings over the time between them,
      so something has to remember the last one. Not the probe: a check runs in whichever worker
      is free, so per-worker state would give a sensor its own previous reading only when it
      happened to land on the same thread twice — and every probe restart, which is every upgrade,
      would lose the baseline for every interface on the box. `channel_counter` holds one row per
      channel, and `M-07` already describes this layer: what happens to a reading between arriving
      and being judged.

      **The rate is stored and the counter is not**, which `scaling.ts` already states the rule
      for: one number, so a chart can never disagree with the alarm that fired.

      **A 64-bit counter going backwards is a reset, never a wrap.** `ifHCInOctets` at 100 Gbit/s
      takes about forty-six years to go round, so backwards is a device that rebooted — and
      "correcting for the wrap" would store one sample of roughly 1.8×10^19, dwarfing the axis for
      the whole retention window. A **32-bit** counter is the opposite: 2^32 octets is
      thirty-four seconds of gigabit, wrapping is routine, and correcting for it is the whole job.
      Reverting that asymmetry to one rule fails seven tests.

      **The width travels on the reading, not only on the channel.** `channels()` runs at
      sensor-creation time and cannot know what the device offers; `auto` prefers the HC counters
      and falls back per device. A 32-bit wrap read as a 64-bit counter looks exactly like a
      reset, so without this every wrap would be a gap — on a gigabit link, every thirty-four
      seconds. There is a test and its control.

      **Counters cross the wire as decimal text.** `ifHCInOctets` passes 2^53 in about nine days
      on a 100 Gbit/s link, and above 2^54 a double cannot represent consecutive integers at all.
      A rate computed from a rounded counter is quietly wrong on exactly the links anyone watches.

      **Found by running it, not by a test: `A-05` was broken on the wire.** `credentials` was
      added to `SensorAssignment` and not to `sensorAssignmentSchema`, so the first sensor that
      actually had a credential made the probe reject the whole configuration with "must NOT have
      additional properties", disconnect, reconnect and do it again — a reconnect loop in which
      nothing was scanned. Nothing caught it because the core's tests build assignments directly
      and never send one. Both schemas are fixed and `messages.test.ts` now round-trips every
      field these types carry.

      Verified live against the dev SNMP simulator: sensor **up**, message `interface 2, 64-bit
      counters, oper status 1, 100 Mbit/s`, and `total` exactly equal to `in + out`
      (3,065,958 = 1,623,154 + 1,442,804 octets/s) with the baselines in `channel_counter`.

      **Interface selection is by index *or* by name, and the picker is not built.** Matching
      `ifName`/`ifDescr`/`ifAlias` is better than an index — indexes move across a reboot on many
      devices, and a sensor pinned to one then watches a different port with no sign anything
      happened. What is missing is the *list* at add time, and it needs infrastructure that does
      not exist: the core cannot reach the device, so listing interfaces means an on-demand
      request to the probe and an answer routed back to a waiting HTTP request. That is `R-09`
      below, and `D-02` needs the same thing.
- [ ] **R-09 — On-demand probe queries** · M · R-01 · A request/response message pair over the
      probe channel so the core can ask a probe to run something *now* and route the answer back
      to a waiting API call: correlation ids, a timeout, and a bound on how many are in flight.
      **Added by `T-02`:** the protocol is one-way for everything except the handshake, so there
      is no way to populate an interface picker at add time — the core has no route to the
      device. `D-02` (device identification) needs the same pair, and so does any "test this
      sensor now" button.
      **Added by `T-04`:** and the table row picker, which is the same gap on a bigger surface —
      an operator adding a table sensor currently reads the table with `snmpwalk` and types the
      column positions and the row value they find. Neither sensor type is blocked on it: both
      resolve the row on every scan either way, so this is the add-time convenience and not the
      monitoring.
- [x] **T-03 — SNMP Custom + Custom String** · M · T-01 · Arbitrary OIDs; regex extraction and
      lookup mapping for strings.

      **T-03 outcome.** Two types — `snmp.custom` for a numeric OID and `snmp.custom.string` for a
      text one — plus `support/snmp/check.ts`, which is the preamble all four SNMP types now
      share. That was extracted rather than copied a third time because the failure of copying it
      is not duplication but *drift*: the fifth type says "authentication failed" where the first
      names the missing credential kind, and an operator learns that some SNMP sensors explain
      themselves and some do not.

      **Gauge or counter is asked, not guessed.** `snmp.custom` reuses `T-02`'s counter path, so
      the two need different arithmetic and the OID alone does not say which the operator wants.
      Guessing from the varbind type is wrong in both directions — a Counter32 somebody wants
      graphed as a total would become a rate, an Integer that happens to climb would not. The
      device is consulted to *check* the answer: a mismatch goes in the message, which is where
      somebody with a wrong-looking graph actually looks.

      **The regex is the sharp edge, and it is now genuinely bounded.** An operator-supplied
      pattern against device-supplied text, inside a worker, with no way to interrupt it —
      JavaScript has no interruptible regular expression, so `ctx.signal` cannot help. Measured
      while building this: `(a+)+$` against **forty characters** takes **86 seconds**. Truncating
      the subject does not fix that, and refusing "dangerous" patterns is not decidable.

      What does work is V8's own watchdog: the match runs in a `node:vm` context with a 250 ms
      timeout, which *can* stop it. Measured cost — **0.19 µs direct against 99.7 µs in the
      sandbox** — which is five hundred times slower and completely irrelevant beside an SNMP
      round trip, about 0.5 s of CPU a minute if all 5,000 sensors at the v1 target were this
      type. A mistyped pattern now fails one check in 250 ms with a sentence naming it, instead of
      holding a worker until the pool terminates it.

      One bug that cost a debugging round and is worth knowing: what the watchdog throws does not
      reliably satisfy `instanceof Error` across the realm boundary, so the timeout was being
      reported as an unexplained pattern failure. It is detected by `code` now.

      **A no-match in match mode is a reading, not a failure.** "The phrase is gone" is exactly
      what a limit or a lookup is set against, and failing the check instead would make the sensor
      Down and lose the data point. In number mode the same no-match *is* a failure, and the
      message carries what the device actually said — the only way to tell "my pattern is wrong"
      from "the device changed what it reports".

      Verified live against the dev SNMP simulator: `snmp.custom` reading sysUpTime as a gauge
      (142,261,734 TimeTicks); `snmp.custom` in counter mode on `ifInOctets.2` producing
      **5,479,022 octets/s** with the channel correctly labelled `octets/s`; and
      `snmp.custom.string` matching "Linux" in sysDescr with the message
      `= "Linux zeus 4.8.6.5-smp …" → "Linux"`.

      **Not done here:** the interface/row picker still needs `R-09`, and a *lookup* picker would
      want the same — an operator has to type a lookup id today rather than choose from what the
      installation has loaded. The id is validated by the core and a missing one is reported
      rather than fatal (`M-06`), so this is a convenience gap and not a correctness one.
- [x] **T-04 — SNMP Custom Table** · L · T-01 · Walk a table; one sensor per row or channels per
      column; row selection at add time.

      **T-04 outcome.** `snmp.table`: one sensor is one row, and its channels are the columns.
      The ticket offered that layout *or* channels-per-row, and only one of them the channel
      model supports. `channels(params)` is declared before a sensor has ever run — that is what
      lets the core create channels at sensor-creation time carrying a primary, a lookup and a
      counter width. Rows live on the device, so a channel-per-row sensor could declare none of
      those: its channels would be created from the wire on first scan (`ChannelResolver` does
      that), with no primary, no lookup and no counter arithmetic — a table sensor that could not
      compute a rate, which is most of what a table sensor is for. Columns are typed in at add
      time; rows are discovered. So columns are channels.

      **The row is found by what it is called, not only by where it sits.** A table index is an
      integer an agent may reassign — the dev target's own `hrStorageTable` is indexed
      1, 3, 6, 7, 8, 10, 11, 33, 38…, and `ifIndex` moves when a module is reseated — so a sensor
      pinned to index 3 later watches a different volume with nothing anywhere to say so. Naming
      the identifying column and the value to find in it survives that, at one walk per scan; the
      index is still accepted alone, and given *with* a value becomes a hint checked first, so an
      unchanged table costs one request instead of a walk. Measured on the test agent: 2 requests
      when the hint holds. `rowIndex` is text rather than an integer because plenty of real tables
      are indexed by more than one arc.

      **Reused rather than re-solved:** `T-02`'s counter path (a column set to counter declares
      64 bits and the reading corrects it from the varbind type, so a Counter32 wrap is not read
      as a device reset), `M-06`'s lookups per column, and `T-03`'s sandboxed matcher for
      `regex` row matching — an operator-supplied pattern against device-supplied text is the one
      thing in a check that no `AbortSignal` can interrupt, and matching runs against *every row*
      of the naming column, so a pattern that backtracks fails the check on the first row rather
      than costing the 250 ms watchdog on each of them.

      **Channel keys are derived from the column, not asked for** (`col6`, `col1_6`). A key is
      stable within the sensor and is never the label, so deriving it means renaming a channel
      keeps its history — and makes two columns with the same key impossible, where the
      one-key-per-sensor constraint would otherwise turn a duplicate into a failed insert at
      sensor creation.

      Verified live against the dev target's real net-snmp agent, which produced a case the test
      agent only simulated: a sensor on `hrStorageEntry` matching "Physical memory" resolved to
      row 1, read Size and Used, and **gapped** `hrStorageAllocationFailures` — that agent does
      not implement the column — reporting `value: null` through storage and query rather than a
      zero, with the reason in the sensor message and the sensor still Up. A second sensor on
      `ifEntry` matching "eth0" resolved to the sparse index 11 and reported 15.97 octets/s from a
      Counter32 through `T-02`'s arithmetic, alongside `ifOperStatus` carrying its lookup.

      **Not done here:** the row picker still needs `R-09`, same as `T-02`'s interface picker —
      an operator reads the table with `snmpwalk` and types what they find. And the `columns`
      array renders in the generated form as `U-08`'s JSON fallback rather than as a repeating
      row of fields; that is `U-12`, not a change to this schema — the schema describes the
      parameter honestly and the form generator is what has the gap.
- [x] **T-05 — SNMP CPU / Memory / Disk Free / Uptime** · M · T-01 · Standard MIB sensors with
      restart detection on uptime.

      **T-05 outcome.** Four types — `snmp.cpu`, `snmp.memory`, `snmp.diskfree`, `snmp.uptime` —
      plus `support/snmp/mibs.ts`, which holds the parts of HOST-RESOURCES-MIB and UCD-SNMP-MIB
      that are *not* obvious from the OID. Every number quoted below was measured against the dev
      target's own net-snmp agent while writing this; they are in the code comments because they
      are the argument for the choices.

      **`sysUpTime` is the wrong OID for uptime and is the one everybody reaches for.** It counts
      from the last time the *network management subsystem* re-initialised, so restarting `snmpd`
      resets it while the host keeps running. On the dev target it read **32 hours against
      `hrSystemUptime`'s 8.9 days**, on a box that had not rebooted — a sensor built on it would
      have raised the exact alarm this type exists to raise, falsely, on the first device it was
      pointed at. `hrSystemUptime` is preferred, `sysUpTime` is the fallback for hardware with no
      HOST-RESOURCES-MIB (where the two do restart together, and the sensor says the reading now
      means something else), and both are read every scan because an agent that restarted alone
      explains a gap in every other SNMP sensor on the device.

      **Restart detection is a threshold trigger on an uptime channel in seconds, and that is not
      a compromise.** A restarted device has a small uptime; `M-11`'s threshold trigger already
      evaluates "below 600" with latency, escalation and summarisation. Verified live: the trigger
      reads back as **"when uptime < 600"**. Detecting the *transition* instead would mean the
      core keeping a previous reading per channel and synthesising a value the probe never sent —
      a new concept in ingestion, for a strictly narrower answer, since a condition also catches a
      restart that happened while the sensor was Down and a transition does not. What the type
      owes that setup is the unit: seconds rather than raw TimeTicks, or every threshold anybody
      writes is wrong by a factor of a hundred.

      **"Available memory" has three sources on one device and they disagree by a factor of two.**
      Measured on the same 7936 MiB box: the `hrStorage` row net-snmp calls "Available memory"
      (Linux's own `MemAvailable`) said **5169 MiB**; `memAvailReal + memBuffer + memCached` said
      5583 MiB; `memAvailReal` alone — which is `MemFree` — said **2819 MiB**. The last is what a
      naive sensor reports, and it would have called the box **64% used** when the true figure is
      35%. Every Linux machine under load looks nearly full by that measure, because the kernel
      spends free memory on page cache deliberately and hands it back on demand, and a monitoring
      system that alarms on it teaches its operators to ignore memory alarms. The order is
      MemAvailable, then free+buffers+cached, then MemFree with the caveat in the message; the
      sensor always says which it used. Live, it read 32.03% used.

      **`hrStorageSize` is in allocation units and the unit differs per row on the same device** —
      1024 on the memory rows, 4096 on the filesystems. A sensor reading the column raw reports a
      filesystem four times too small, which is why `snmp.diskfree` exists rather than being a
      `snmp.table` preset: it multiplies out, finds the row by mount point, and computes the
      percentage the device does not report at all.

      **Nothing assumes an index starts at one or is contiguous.** The dev target indexes its
      eight processors from **196608** and its storage rows 1, 3, 6, 7, 8, 10, 11, 33, 38, 39 —
      so `snmp.diskfree` matches the mount point every scan and treats a stored index as a hint it
      *verifies* before trusting, and `snmp.cpu` walks rather than probing 1..n.

      `snmp.cpu` prefers `hrProcessorLoad` over UCD's `ssCpuRaw*` counters deliberately: the raw
      counters are jiffies, a percentage is one counter over the sum of all of them, and the core
      computes rates per channel independently (`T-02`) so it could not divide one by another —
      that would need a new kind of derived channel for a number the device already computes. The
      average is primary with the **busiest processor** beside it, because a 32-core box with one
      pegged core averages 3% and is in trouble.

      Verified live against the target's real agent, all four: uptime naming the agent restart,
      `2.13% across 8 processors, busiest 3%`, memory at 32.03% from MemAvailable, and `/dev` found
      by name on row 33.

      **Not done here:** a channel *per processor* and a sensor per filesystem at add time both
      need what `T-02` and `T-04` need — `R-09` for the picker, and dynamic channel declaration for
      the per-row case, which the channel model deliberately does not have (see the `T-04`
      outcome). `snmp.cpu` reports the average and the busiest instead, which is the pair worth
      alarming on.
- [x] **T-06 — SNMP Trap Receiver** · L · T-01 · Listener, trap and inform handling, filter
      rules, count channels, message retention.

      **T-06 outcome.** The first sensor in the catalogue that is *asked* questions rather than
      asking them, and most of the ticket was deciding where that shape lives. A check runs in
      whichever worker is free and only while it is running, so a listening socket cannot be
      inside one; a socket per sensor would mean a port per sensor, which is not how devices send
      traps. So the probe owns one receiver and `CheckContext.received` carries each sensor what
      has arrived since it last looked.

      **The split is the design: the listener knows nothing about sensors, and the sensor type
      does all the deciding.** Filter rules, counting and retention are `params`, so they belong
      to the type — one file in `@ms/sensors`, tested against a fabricated batch with no socket in
      the test. The probe keeps a ring buffer, a cursor per sensor and the counters that make it
      observable. Buffering *once* and filtering per sensor at check time is what makes that
      possible: filtering at receive time would need the listener to know every sensor's rules,
      and it costs nothing here because a probe has a handful of trap sensors, not thousands.
      `T-20`'s syslog receiver is the second listener and reuses the contract unchanged.

      **v1 and v2c traps are different messages and exactly one place knows it.** A v1 trap
      carries an enterprise OID, a generic 0–6 and a specific in the PDU header; a v2c trap and an
      inform put `sysUpTime.0` and `snmpTrapOID.0` at the front of the varbinds instead. A rule
      written against one shape would silently never match the other — the worst failure a
      receiver can have, because it looks exactly like a quiet network. RFC 3584 §3.1 is the
      mapping (generic 0–5 → `1.3.6.1.6.3.1.1.5.{n+1}`, generic 6 → `{enterprise}.0.{specific}`,
      and the `.0` is the part everybody drops). Verified live: a v1 trap and a v2c trap sent
      seconds apart both read as `linkDown` in the same sensor message.

      **Informs are acknowledged, and that is not optional.** An unacknowledged inform is
      retransmitted until the sender gives up, so a receiver that merely counted them would turn
      one event into a burst. `net-snmp`'s receiver sends the response before the callback runs;
      the test asserts it from the *sender's* side, which is the only thing that proves it.

      **A trap sensor is Up when traps arrive, and its count is per interval.** The ordinary state
      of a healthy device is zero, so the alarm is an upper limit — a sensor that went Down for
      silence would alarm every quiet night. It deliberately does not turn one trap into one
      alarm: a device with a flapping uplink sends the same trap every thirty seconds, and "one
      outage, one alarm" is exactly what the count crossing a limit once preserves.

      **Two things it refuses to report as zero.** No listener running on the probe is a *failed
      check* naming the configuration, not a count of nothing — a receiver that was never switched
      on must not look like a quiet network. And a bounded buffer that overwrote notifications
      before a sensor read them fails the check too, by default: the count is known to be short,
      and a gap is the honest reading for a number nobody should act on. What was lost is counted
      per sensor and never dropped silently.

      **Found by pointing it at the dev target:** `sourceIsDevice` compared a trap's sender
      *address* against the device's `host`, which there is the name `ms-target` — so it counted
      zero for ever, indistinguishable from silence. The host is now resolved (cached five
      minutes, skipped for a literal address) and a name that will not resolve fails the check
      rather than matching nothing. Verified live afterwards: the device-filtered sensor resolved
      the name, saw a trap from the docker gateway, and reported it as **not matched** rather than
      counting or discarding it.

      **Not done here:** v3 notifications decode and are reported as v3, but configuring USM users
      for a *receiver* — engine IDs, per-user keys, on the probe rather than per device — is its
      own config surface and is not wired. The listener is off by default: it binds a socket, 162
      is privileged, and a probe that silently opened a listening port would be a surprise on
      somebody's firewall audit.
- [ ] **T-07 — SSH session layer** · M · P-05 · `ssh2` with key and password auth, connection
      reuse, host-key policy, command timeouts.
- [ ] **T-08 — SSH Script / Disk Free / Load Average / Meminfo** · L · T-07 · Four sensors,
      documented script output format for the first.
- [ ] **T-09 — Windows check transport** · L · P-03 · PowerShell / WinRM shell-out from a
      Windows-hosted probe, with credential handling and output parsing.
- [ ] **T-10 — Windows CPU / Memory / Volume / Service sensors** · L · T-09 · The v1 Windows set.
- [ ] **T-11 — TLS Certificate sensor** · M · P-05 · Expiry countdown, chain validation, hostname
      match, issuer and SAN channels.
- [ ] **T-12 — TLS Security Check sensor** · M · T-11 · Offered protocol versions and cipher
      suites, scored by weakness.
- [ ] **T-13 — HTTP Advanced** · M · P-09 · Method, headers, POST body, auth, redirect policy,
      response validation.
- [ ] **T-14 — HTTP Content** · M · T-13 · String and regex matching, numeric extraction into
      channels.
- [ ] **T-15 — HTTP Transaction** · L · T-13 · Multi-step scripted sequence with per-step
      validation and variable capture between steps.
- [ ] **T-16 — REST Custom** · L · T-13 · JSONPath/XPath extraction into declared channels, with
      a mapping editor.
- [ ] **T-17 — Mail sensors** · L · P-05 · SMTP, POP3, IMAP, and SMTP&IMAP Round Trip with
      cleanup of test messages.
- [ ] **T-18 — Database sensors** · L · P-05 · PostgreSQL, MySQL, MSSQL: connect, run a query,
      execution time and first-result-cell channels, statement timeout.
- [ ] **T-19 — EXE/Script sensors** · L · P-03 · Simple and Advanced variants, documented output
      formats, sandboxing, timeout, working directory and env control.
- [ ] **T-20 — Syslog Receiver** · L · P-05 · In-house RFC 3164 and 5424 parser, UDP + TCP
      listeners, filter rules, severity/facility count channels, message retention.
- [ ] **T-21 — Sensor Factory** · L · M-04 · Formula language over other sensors' channels
      (`channel(id, ch)` arithmetic), its own channels and limits, cycle detection.
- [ ] **T-22 — Ping Jitter and Port Range** · M · P-08, P-10 · Completes the v1 connectivity set.
- [ ] **T-23 — Sensor type authoring guide** · S · P-05 · Documentation plus a worked example,
      proving a new type is a one-file, half-day job.

## Phase 7 — Discovery and templates

- [ ] **D-01 — Network sweep** · M · P-08 · Ping sweep across an IP range; resumable,
      cancellable, rate-limited so it never starves live checks.
- [ ] **D-02 — Device identification** · L · T-01, T-07, T-09 · SNMP sysObjectID/sysDescr, WMI,
      SSH banner, open ports, reverse DNS → a device fingerprint.
- [ ] **D-03 — Device templates** · L · D-02 · Fingerprint → sensor set mapping; a built-in
      template set; save-this-device-as-a-template.
- [ ] **D-04 — Provisioning and idempotency** · L · D-03 · Create devices and sensors; match on
      IP/DNS within the target group; re-runs create zero duplicates.
- [ ] **D-05 — Default master dependency** · S · D-04, M-11 · Each discovered device's Ping
      sensor becomes its master object.
- [ ] **D-06 — Discovery levels** · M · D-04 · Ping-only through detailed, with time estimates
      shown before starting.
- [ ] **D-07 — Scheduled rediscovery** · M · D-04, M-09 · Hourly/daily/weekly, **off by default**,
      with optional auto-creation of newly appeared devices.
- [ ] **D-08 — Discovery run summary** · S · D-04 · Scanned, found, created, errors — persisted
      and viewable.
- [ ] **D-09 — Bulk operations** · M · S-03 · Multi-select edit, clone, move, delete across the
      tree.
      **Added by S-03:** `ObjectService.batch(mode, fn)` composes any number of repository
      operations into one transaction under one advisory lock — D-09 is a loop, not an API
      redesign. Bulk selection **must** page with `sort=id`: under `sort=name` a keyset scan can
      return a renamed object twice or miss it, so a bulk delete could skip objects the operator
      selected.
- [ ] **D-10 — Discovery UI** · M · U-03, D-06 · Range entry, level and template selection, live
      progress, cancel.

## Phase 8 — Remote probes

- [ ] **R-01 — Probe identity and approval** · L · F-09 · GID generation, access keys,
      source-IP allowlist, per-GID revocation, pending-approval queue and admin action.
      **Added by S-03:** `POST /objects {kind:'probe'}` currently creates a plain object with
      no GID and no access key; enrolment replaces it, which is a documented pre-1.0 API break.
      R-01 must also make the local probe undeletable, matching PRTG. S-03 already refuses to
      *clone* a probe, because a cloned probe is either a duplicate GID or a placeholder no
      installation can claim.
      **Added by R-04:** the storage exists — `probe_config.gid`, one branch per probe, enforced
      by a partial unique index — and `PATCH /objects/{id} {kind:'probe', gid}` claims a branch by
      hand. What is left for this task is everything around it: issuing a GID rather than typing
      one, the pending-approval queue, per-GID access keys, the source-IP allowlist, revocation,
      and making the local probe undeletable. The endpoint already re-resolves an unclaimed
      session on every push, so approving a connected probe takes effect without a restart.
- [x] **R-02 — Disk-backed result spool** · L · F-09 · Bounded size, oldest-first eviction,
      dropped-result counter, crash-safe. _Beats PRTG's RAM-only 500k buffer._
      **R-02 outcome.** Newline-delimited JSON in segments, not a binary format with length
      prefixes and checksums. Results are already JSON on the wire, a torn line is detectable
      without a checksum because it does not parse, and a spool an operator can read with `tail`
      during an incident is worth more than the bytes a binary encoding saves. Segments are what
      make eviction and reclamation O(1): delete a file rather than rewrite one.
      **Crash safety is a boundary property.** Appends are not fsynced per record — at five
      thousand checks a minute that would dominate the probe's cost, to protect against losing
      the last few results to a power cut. What is protected is the case PRTG loses everything
      to: a *process* restart. `open()` truncates a torn trailing line so the next append starts
      clean, which is what stops one bad crash from corrupting every later read, and it counts
      what it discarded.
      **Nothing leaves the spool until the core says it stored the batch.** A lost acknowledgement
      costs a duplicate write, which S-07 made free with the unique index on `(channel_id, time)`;
      an optimistic delete costs a reading, which nothing can recover. The same reasoning makes a
      lost or unreadable cursor safe: it replays from the start rather than skipping.
      **One refusal is discarded rather than retried.** `invalid` is the one nack retrying cannot
      fix, so the drain drops that batch — loudly and counted — because keeping it would jam every
      result behind it for ever.
      **Measured, not asserted.** The core was killed, the probe kept scanning for 100 seconds,
      the whole process was then restarted: 12 results came back off disk, replayed as one batch,
      24 samples stored, and the per-minute timeline shows no gap across the outage.
      **Found while running it:** the development PostgreSQL had Docker's default 64 MB
      `/dev/shm`, which `drop_chunks` over a day of readings exhausts — reported as "No space left
      on device", which reads like a disk problem and is not one. `shm_size: 1gb` in
      `docker-compose.dev.yml`. It made the rollup perf test flaky, not R-02.
- [x] **R-03 — Ordered replay on reconnect** · L · R-02, S-07 · Rate-limited catch-up that cannot
      stall live ingestion; ordering preserved.
      **Added by S-07:** ordering per connection is already done — the endpoint chains a probe's
      result batches so an acknowledgement can never overtake an earlier batch still in flight.
      What is left here is the rate limit across probes, and it has a signal to use: the ack's
      `retryAfterMs` rises before the queue is full. Replay itself is safe to repeat, because the
      write is `ON CONFLICT DO NOTHING` and a range landing behind a rollup watermark queues its
      own backfill in the same transaction.
      **Added by R-02:** the drain exists and honours `retryAfterMs` on the acknowledgement, so a
      single probe already slows down before it is refused. What is left is the limit *across*
      probes — a hundred reconnecting at once, each politely obeying its own signal, still
      arrives as a stampede — and a catch-up that yields to live results rather than starving
      them.
      **R-03 outcome.** The gap was that `retryAfterMs` is *one global signal*: it rises with
      queue depth and asks every probe to slow down, live and replaying alike. Right for absolute
      capacity, wrong for fairness — a probe reporting a check that just ran was throttled exactly
      as hard as one dumping an hour of spool, which is "live ingestion stalled by catch-up" in
      one sentence.
      **So the probe now says how far behind it is.** `results` carries an optional `backlog`,
      because only the probe knows it. `ReplayPacer` adds delay to catch-up acknowledgements in
      proportion to how many probes are catching up at once, and adds *nothing* to a batch with
      no backlog behind it. A probe that has caught up rejoins the fast path on its very next
      batch. It converges with no coordination: the count falls as probes finish, and the delay
      each is asked for falls with it. Capped, because past a point asking politely is not the
      tool — the queue's own refusals are, and they do not depend on a probe honouring a hint.
      **Optional, so no version bump.** A version-3 probe that sends no `backlog` is read as
      "unknown" and paced as live, which is exactly how it behaved before. Adding a nack reason
      for "queued behind other probes" was considered and rejected: an unknown enum value fails
      schema validation on an older probe and drops the connection, and the delay already carries
      everything the probe acts on.
      **Bigger bites when behind.** The drain uses `spoolCatchUpMaxRows` once there is a backlog —
      the same rows in fewer round trips clear it sooner, and the sooner it clears the less time
      that probe's own live results spend queued behind it. Pacing is by delay, not batch size,
      so a larger batch does not take more of the core.
      **Ordering** was already guaranteed per connection (S-07 chains a probe's batches); what is
      new is a test that appends live results *during* a replay and asserts the core sees one
      ordered stream end to end.
      **Verified live:** with a live batch size of 2 and a catch-up size of 8, a probe recovering
      10 spooled results sent 8 with `backlog: 2`, then 2 with `backlog: 0`, then returned to
      one-result live batches — never paced again.
      **Not done, deliberately:** within a single probe, live results still queue behind that
      probe's own backlog. The spool is a durable FIFO and reordering it to prioritise the tail
      would cost a much more complex cursor for a delay already bounded by how fast the backlog
      drains — which is what the larger catch-up batches shorten.
- [x] **R-04 — Incremental config push** · L · S-03, F-09 · Each probe receives only its own
      subtree, as deltas, with a resync path after a long disconnect.
      **R-04 outcome.** Protocol version 3: `config-set`, `config-delta`, `config-unchanged`
      from the core, `config-ack` back, and a `configVersion` fingerprint on `hello`. The
      fingerprint is content-addressed rather than a counter — derived from the answer itself, so
      it cannot drift from what a probe should be running the way a stored sequence can. It is
      what makes the resync path cheap: a probe that reconnects after a blip presents the
      fingerprint it holds, and a match costs one message instead of five thousand assignments.
      Held in memory and deliberately not persisted, because a restarted probe has nothing to
      keep the fingerprint *of*.
      **Deltas only against state we know the peer has.** A delta is sent only when the core has
      already sent that session a snapshot; after a disconnect the answer is a snapshot or
      `config-unchanged`, never a delta against a guess. A snapshot is sent instead whenever the
      upserts alone would be no smaller — removals are integers and are not weighed against whole
      assignments.
      **Change detection rides the audit sink**, which every mutation already passes through, so
      no new mutation path has to remember to tell the probes about itself. It marks *all*
      connected probes for recomputation rather than resolving which one was affected: a spurious
      recomputation is free because the push compares fingerprints and sends nothing when they
      match, and resolving the ancestor would mean a query inside the mutation's own transaction —
      the cost S-16 removed.
      **It needed the storage half of R-01.** A `probe` object and a connected probe were
      unrelated things; migration 007 adds `probe_config.gid` with a partial unique index, so one
      branch has one probe and one probe has one branch. `TASKS.md` already recorded that
      enrolment would replace creating a probe by `POST /objects`; approval queues, per-GID access
      keys, source-IP allowlists and revocation are still R-01's.
      **Found while wiring it:** a session resolved its branch once, at the handshake — so
      approving a probe that had *already connected* did nothing until it restarted, which is the
      ordinary enrolment sequence. An unclaimed session now re-resolves on every push. There is a
      test named for it.
      **Verified end to end:** with the development probe bound, the core pushed two assignments,
      the wheel scheduled them, and `icmp.ping` ran against `ms-target` on its own. Adding a third
      sensor to the live tree arrived as a delta of one upsert.
- [ ] **R-05 — Probe offline handling** · M · R-01, M-02 · One alarm for the probe; its sensors go
      Unknown, not Down. **`M-02` left the layer:** `StateFacts.probeReachable`, evaluated third
      and deliberately **not persisted** — restoring it from a table would record a transition
      for every sensor on every core restart, an alarm storm generated by the restart itself.
- [ ] **R-06 — Version skew detection** · M · F-09 · Core and probe negotiate a protocol version;
      incompatibility is reported clearly, never silently mishandled.
- [ ] **R-07 — Probe installers** · L · F-07 · Linux and Windows probe-only packages with a
      guided enrolment flow.
- [ ] **R-08 — Disconnect/reconnect soak test** · M · R-03 · A one-hour disconnect replays with
      zero data loss and no ingestion stall.

## Phase 9 — Users, RBAC and security

- [ ] **A-01 — Accounts and authentication** · L · S-01 · Read/write and read-only accounts,
      argon2 hashing, secure-cookie sessions, login throttling.
- [ ] **A-02 — User groups and primary group** · M · A-01 · Group membership, one primary group
      per user.
- [ ] **A-03 — Per-object access rights** · L · A-02, S-04 · none/read/write/full; inherited up
      the tree; explicit beats inherited; highest across groups wins.
- [ ] **A-04 — Read-only account restrictions** · M · A-03 · Enforced at account level: no admin
      groups, no credential visibility, optional acknowledge permission.
- [x] **A-05 — Credential vault** · L · A-03 · Credential sets inherited from group/device,
      encrypted at rest with a key from the OS keystore or a key file, **write-only through the
      API** by every route.
      **Added by S-03:** credential inheritance already lives in
      `InheritanceResolver.resolveCredentials` — extend it, do not write a second parent-walker.
      Read routes exist and return metadata only (kind, `publicParams`, source, `updatedAt`);
      A-05 adds the write path. **Scheduling risk:** Phase 6 (sensor breadth) precedes Phase 9
      in the plan, so A-05 must be pulled forward or credentialed sensors are unusable.

      **A-05 outcome — pulled forward, minus the half that needs accounts.** The stated
      dependency is `A-03`, which needs `A-02` and `A-01`; none exist. But that dependency is
      about *who may write* a credential, and everything here is already write-only to
      **everyone**, which is the stronger property CLAUDE.md demands. `A-03`/`A-04` still add the
      permission check on the write — one guard in one place when accounts arrive. The scheduling
      risk this ticket predicted is what forced it: `T-01` shipped a transport whose sensors would
      otherwise each carry their own community string.

      **A key file, not the OS keystore, and the task offered both.** On Linux the keystore is
      libsecret over a *session* D-Bus, which a systemd system service does not have; on Windows
      it is DPAPI through a native addon. A mechanism that works on one platform, in one session
      type, with a compiled dependency is not a key path for a standalone native service
      (CLAUDE.md constraint 1). The file is generated at first start rather than defaulted —
      a key derived from something the installer knows produces an installation encrypted in form
      and not in fact — created 0600, and **refused on every load if the mode has widened**, since
      key files get restored from backups and copied between hosts.

      **AES-256-GCM, and the associated data is the part worth explaining.** Object id and kind go
      into the AAD, so a `secret` column value copied from one row to another fails to
      authenticate. Without it, anybody with database access could grant a device another
      device's credentials by copying a cell — an attack needing no key at all. Reverting the AAD
      to a constant still passes 19 of 21 crypto tests; the two that fail are the ones that exist
      for it.

      **The fingerprint hashes a rotation stamp, never the credential.** A probe's config version
      has to change when a community string is rotated, or the probe holding the old one is told
      `config-unchanged` and keeps authenticating with it. The obvious way to get that is to hash
      the credential in — and it is a mistake: a community string is short and drawn from a tiny
      space, so a published SHA-256 of one is recovered by guessing, and this value is sent to
      probes and written to logs. `ownerId@updatedAt` changes on every rotation and reveals
      nothing.

      **Secrets reach the probe, deliberately, and only there.** The probe is what authenticates
      to the device, so the alternatives are shipping the vault key to every probe or moving the
      protocol into the core. What bounds it: mutual TLS, only the kinds a sensor *type* declared
      (`SensorType.credentialKinds`), and only to the probe that owns that sensor — a Ping probe
      never receives an SNMP community string. Verified: the probe keeps assignments in a `Map`
      and its only disk write is the result spool, which carries outcomes and never parameters.

      **The audit entry has its own shape rather than reusing `setting.set`'s `before`/`after`.**
      An audit row is permanent and readable through the history API, so a diff carrying values
      would be a plaintext archive of every credential the installation has ever held. It records
      field *names*: `secretsSet: ["community"]` answers "was the community rotated, or only the
      SNMP version corrected" without answering "to what".

      **A secret the caller omits is kept**, the mirror of `U-08`'s `carryWriteOnly` and for the
      same reason: a read never returns it, so a form correcting the version beside it cannot send
      it back, and a wholesale replace would delete it every time. `null` clears it.

      Verified live end to end: key file created 0600; the community string appears in none of
      `?include=credentials`, the credentials route, the object history or the global audit feed;
      `position('super-secret' in secret) = 0` in the column itself; a device-level set inherited
      by the sensor at depth 1; an edit sending only the version reporting
      `secretsKept: ["community"]`; and a delete answering with the group's credential now in
      force. 52 new tests.

      **Left for `A-03`/`A-04`:** who may write one, and the read-only account restriction.
      **Left as a follow-up:** a rotation pass that rewrites records onto a new key —
      `key_id`, `VaultKeyring`'s multi-key support and `VaultSealer.isCurrent` are the half that
      makes it a loop rather than a design.
- [ ] **A-06 — API tokens** · M · A-01 · Per-user tokens, scoped, revocable, with last-used
      tracking.
- [ ] **A-07 — TOTP MFA** · M · A-01 · `otpauth` enrolment with QR, recovery codes, enforcement
      per group.
- [ ] **A-08 — Audit log UI** · M · S-10, U-01 · Per-object history with diffs and actor.
      **Added by S-10:** the per-object route and its paging exist
      (`GET /api/v1/objects/{id}/audit?before=&limit=`), and the entry shape is final. What is
      missing is a **global feed** — "everything that changed this week", "everything this user
      did" — which the `audit_log_at_idx` and `audit_log_actor_idx` indexes are already there
      for. Note that a subtree delete writes one entry, on the object the delete was aimed at,
      listing what it destroyed; a destroyed child has no entry of its own, so the UI has to
      look at ancestors to explain where something went.
- [ ] **A-09 — Security hardening pass** · L · A-03 · Rate limiting, CSRF, security headers,
      dependency audit, SSRF guards on all user-supplied URLs, script-sensor sandboxing.
- [ ] **A-10 — Access-control test matrix** · L · A-03…A-05 · Every combination of role, group
      and tree position; explicit test that no route leaks a credential to a read-only user.

## Phase 10 — Hardening and release

- [ ] **H-01 — 24-hour soak test** · L · P-15, T-* · 5,000 sensors for 24 hours: no memory
      growth, no scheduler lag drift, rollups correct throughout.
- [ ] **H-02 — Failure-mode verification** · L · H-01 · Every row of `WORKFLOW.MD §13` tested:
      core restart, DB loss, probe loss, delivery failure, hung check, scheduler lag, disk full,
      clock jump.
- [ ] **H-03 — Upgrade and migration path** · L · S-01 · Schema migration with rollback, config
      backup before upgrade, version-skew handling between core and probes.
- [ ] **H-04 — Backup and restore procedure** · M · H-03 · Documented and tested end to end,
      including a restore onto a clean host.
- [ ] **H-05 — Linux installers** · M · F-07 · `.deb` and `.rpm` in addition to the tarball, with
      upgrade paths.
- [ ] **H-06 — Windows MSI** · L · F-06 · Installer with service registration, firewall rules and
      an upgrade path.
- [ ] **H-07 — Documentation set** · L · — · Installation, administration, sensor reference,
      API reference generated from OpenAPI, troubleshooting runbook.
- [ ] **H-08 — Published sizing guidance** · M · H-01 · Measured numbers per hardware tier, not
      estimates.
- [ ] **H-09 — Release candidate field test** · L · H-01…H-07 · Clean installs on Ubuntu and
      Windows Server monitoring 100 real devices for a week without intervention.

---

## Backlog — v2 candidates

Ordered by expected value. Not scheduled.

- **V2-01** NetFlow v5/v9/IPFIX collector (in-house template cache) and sFlow sensors
- **V2-02** Maps and dashboard designer
- **V2-03** Reporting engine (templates, scheduling, PDF/CSV, security context)
- **V2-04** Libraries (filter-rule alternate tree views)
- **V2-05** Ticket system (user, ToDo and notification tickets)
- **V2-06** Failover clustering
- **V2-07** LDAP/AD and OIDC single sign-on
- **V2-08** Virtualisation sensors (VMware, Hyper-V, Proxmox)
- **V2-09** Cloud sensors (AWS, Azure, Microsoft 365)
- **V2-10** HTTP Push Data sensors and inbound webhooks
- **V2-11** PRTG-compatible API surface (`table.json`, `historicdata.json`, `getsensordetails`)
- **V2-12** Business Process sensor
- **V2-13** SNMP Library (`.oidlib`/MIB import)
- **V2-14** Unusual-value detection (historic baseline per weekday and hour)
- **V2-15** Mobile push notifications
- **V2-16** Declarative YAML config export/import for version-controlled setups
