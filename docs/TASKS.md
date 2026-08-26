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
- [ ] **N-02 — State trigger** · L · N-01, M-15 · Initial latency, initial notification,
      escalation latency, escalation notification, repeat interval, recovery notification.
- [ ] **N-03 — Threshold trigger** · M · N-01 · Channel, condition, value, latency, trigger and
      clear notifications.
- [ ] **N-04 — Latency timer engine** · L · N-02 · Timers cancel on recovery and on
      acknowledgement; survive a restart; no leaks across thousands of sensors.
- [ ] **N-05 — Notification templates** · M · N-01 · Template objects with method, content,
      recipients, priority.
- [ ] **N-06 — Placeholder substitution** · M · N-05 · `%sensor`, `%device`, `%group`, `%probe`,
      `%status`, `%laststatus`, `%lastmessage`, `%lastvalue`, `%datetime`, `%since`, `%linksensor`,
      `%priority`, `%comments`, `%objecttags`, `%host`, `%location`. Case-insensitive. Unknown
      placeholders reported, not silently blanked.
- [ ] **N-07 — Email delivery** · L · N-05 · SMTP relay with port, auth (none/SMTP/SASL), TLS
      negotiation, sender and HELO override, primary + fallback relay. HTML and plain bodies.
- [ ] **N-08 — HTTP action / webhook delivery** · M · N-05 · Method, URL, headers, templated
      body, timeout, TLS options, SSRF guard.
- [ ] **N-09 — Slack and Teams delivery** · M · N-08 · Formatted messages with status colour and
      a link back to the sensor.
- [ ] **N-10 — Execute program delivery** · M · P-03, N-05 · Sandboxed, timed out, output
      captured to the log.
- [ ] **N-11 — Summarisation engine** · L · N-05 · All six modes, default _first down and up
      immediately then summarise_; configurable window; digest caps with overflow splitting;
      Slack/Teams/webhook/script always immediate.
- [ ] **N-12 — Template activation schedules** · M · M-09, N-05 · With queue-or-discard for
      notifications generated while inactive.
- [ ] **N-13 — Delivery retry and failure surfacing** · M · N-07 · Backoff retry; failures
      logged and raised on Core Health; the alarm itself is never lost.
- [ ] **N-14 — Send test notification** · S · N-05 · Per-template action with a full result
      report.
- [ ] **N-15 — Notification scenario tests** · M · N-11 · 200-sensor outage → one immediate
      message plus digests, verified against MailHog and a webhook sink; a 30-second blip under a
      5-minute latency produces nothing.
- [ ] **N-16 — Per-object trigger inheritance toggle** · S · N-01 · PRTG lets an object opt out
      of its ancestors' notification triggers entirely. `N-01` deliberately did not build it: it
      is not in `CAPABILITIES.MD`, and a trigger can already be switched off where it is defined.
      Decide whether an operator ever needs "this device notifies nobody, whatever the root says"
      — and if so, whether the toggle belongs on the object or is better served by a state
      trigger with no template. Mark the scope in `CAPABILITIES.MD` either way.

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
- [ ] **U-02 — WebSocket state stream** · L · P-12 · Subscribe to state changes by subtree;
      reconnect and resync; no full-page polling.
- [ ] **U-03 — Device tree** · L · U-02 · Virtualised tree with rollup status colouring, live
      updates, search and tag filtering. Responsive at 5,000 sensors.
      **Added by S-14:** the tree already comes back in the operator's arrangement, and
      `POST /objects/{id}/order` moves an item one place or to an end. Drag-to-position is not
      covered — it would want an `{ after: siblingId }` form of the same endpoint, which is a
      small addition to `reorderSiblings` when this task knows it needs one.
- [ ] **U-04 — Sensor detail page** · L · U-02, S-08 · Live graph, channel table, historic tabs
      (2d/30d/365d), log, settings, triggers.
- [ ] **U-05 — Time-series charts** · L · U-04 · uPlot panels per the `dataviz` guidance;
      gap-aware rendering (breaks, never a line to zero); themed; accessible.
- [ ] **U-06 — Alarms view** · M · U-02, M-13 · Severity filters, branch scoping, priority and
      duration sorting, inline acknowledge/pause/resume.
- [ ] **U-07 — Logs view** · M · M-15 · PRTG's category structure: status changes, system events,
      object history; filters and paging.
- [ ] **U-08 — Schema-driven settings forms** · L · P-05, U-01 · Forms generated from each sensor
      type's `paramsSchema`, so a new sensor type needs no frontend work.
- [ ] **U-09 — Inheritance-aware controls** · M · S-04, U-08 · Every inheritable field shows the
      inherited value and an override toggle; reverting discards the local value.
- [ ] **U-10 — Notification configuration UI** · L · N-05 · Template editor with live placeholder
      preview and test send; trigger editor showing inherited triggers and their source.
- [ ] **U-11 — Accessibility and responsive pass** · M · U-03…U-10 · WCAG 2.1 AA, keyboard
      navigation, touch targets, no horizontal body scroll.

## Phase 6 — Sensor breadth

- [ ] **T-01 — SNMP session layer** · L · P-05 · v1/v2c/v3 (auth + priv), connection pooling per
      device, timeout and retry, bulk-walk support, vendored `net-snmp`.
- [ ] **T-02 — SNMP Traffic sensor** · L · T-01 · In/out/sum channels, 32- vs 64-bit counters,
      wrap and reset detection, interface selection at add time.
- [ ] **T-03 — SNMP Custom + Custom String** · M · T-01 · Arbitrary OIDs; regex extraction and
      lookup mapping for strings.
- [ ] **T-04 — SNMP Custom Table** · L · T-01 · Walk a table; one sensor per row or channels per
      column; row selection at add time.
- [ ] **T-05 — SNMP CPU / Memory / Disk Free / Uptime** · M · T-01 · Standard MIB sensors with
      restart detection on uptime.
- [ ] **T-06 — SNMP Trap Receiver** · L · T-01 · Listener, trap and inform handling, filter
      rules, count channels, message retention.
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
- [ ] **A-05 — Credential vault** · L · A-03 · Credential sets inherited from group/device,
      encrypted at rest with a key from the OS keystore or a key file, **write-only through the
      API** by every route.
      **Added by S-03:** credential inheritance already lives in
      `InheritanceResolver.resolveCredentials` — extend it, do not write a second parent-walker.
      Read routes exist and return metadata only (kind, `publicParams`, source, `updatedAt`);
      A-05 adds the write path. **Scheduling risk:** Phase 6 (sensor breadth) precedes Phase 9
      in the plan, so A-05 must be pulled forward or credentialed sensors are unusable.
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
