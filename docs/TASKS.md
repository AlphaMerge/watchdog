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
- [ ] **P-15 — 5,000-sensor benchmark** · L · P-08…P-11, P-06 · Sustained 1-hour run:
      **p95 dispatch jitter < 1 s on 8 cores**. Results recorded in the repo. _Architecture
      go/no-go gate — do not proceed to Phase 3 without it._

## Phase 3 — State machine

- [ ] **M-01 — Write the state and pause precedence tables** · S · — · Document every transition
      and the evaluation order of the four pause sources _before_ writing code. Reviewed against
      `WORKFLOW.MD §4–5`.
- [ ] **M-02 — Core state machine** · L · M-01, P-05 · The six v1 states (Up, Warning, Down,
      Down (Acknowledged), Paused, Unknown), all transitions between them, cause attribution on
      every change. Unusual and Down (Partial) are `[V2]`; leave room in the type for them.
      **Added by S-07:** the wire already carries what this needs — a result's `outcome`,
      `message` and `durationMs` reach `IngestionService.acceptResults` and are deliberately
      dropped there, because deciding a state is this task's job, not the probe's. Hook in at
      that point. `sensor_state` writes want the same batching the readings get, so extend
      `Ingestor` with a second row type rather than opening a second pipeline.
- [ ] **M-03 — Two-step failure and retry policy** · M · M-02 · Per-sensor policy from
      immediate-down through warn-N-intervals-then-down; default one warning interval.
- [ ] **M-04 — Channel limits** · M · M-02 · Upper/lower error and warning limits, custom limit
      messages, immediate effect (not subject to the two-step rule).
- [ ] **M-05 — Multi-channel state rollup** · S · M-04 · Sensor state = worst channel state
      combined with the query-failure state.
- [ ] **M-06 — Lookups** · L · M-04 · Definition format, `SingleInt` and `Range` types,
      `undefinedState`, custom definitions overriding built-ins by id, validation and error
      reporting.
- [ ] **M-07 — Scaling factors and spike filter** · S · M-04 · Multiplication/division, decimal
      places, min/max spike discard.
- [ ] **M-08 — Manual pause** · M · M-02 · Indefinite, 5m/15m/1h/3h/1d presets, until-datetime,
      optional message. Persists across core restart.
      **Added by S-03:** a cloned object is created manually paused with the message
      `cloned from #<sourceId>`, with a scenario test. All clone paths go through
      `ObjectService.clone`, so this is one line in one place. S-03 deliberately did not invent
      pause columns ahead of the logic that maintains them.
- [ ] **M-09 — Schedules** · L · M-08 · Reusable schedule objects; weekly grid **and** period-list
      (`ww:hh:mm-ww:hh:mm`) authoring; suppress monitoring, notifications and reports.
- [ ] **M-10 — Maintenance windows** · M · M-09 · One-off start/end datetimes; early cancel by
      setting the end to the past.
- [ ] **M-11 — Dependencies** · L · M-08 · _Use parent_, _select object_, _master object for
      parent device_; recursive cascade; **master keeps scanning while dependents are paused**;
      delay-after-recovery; manual/schedule pauses do not cascade via dependency.
- [ ] **M-12 — Pause precedence integration** · M · M-08…M-11 · Parent cascade → dependency →
      schedule → manual, exhaustively tested. Cascade-paused children cannot be resumed
      individually, and the API says so clearly.
- [ ] **M-13 — Acknowledgement** · M · M-02 · Down (Acknowledged) state, until-options, message
      stored as last message, expiry back to Down, cleared by pause+resume, permission grantable to
      read-only users.
- [ ] **M-14 — Simulated error state** · S · M-02 · Force a sensor Down to test notification
      chains end to end.
- [ ] **M-15 — State-change log** · M · M-02, S-10 · Every transition with previous state, new
      state, message and cause.
- [ ] **M-16 — Property-based state machine tests** · L · M-12, M-13 · No event sequence reaches
      an undefined state; invariants hold under shuffled and duplicated events.
- [ ] **M-17 — Alarm-storm scenario test** · M · M-11 · A simulated switch failure produces one
      dependency-suppressed alarm, not one per downstream sensor.

## Phase 4 — Notifications

- [ ] **N-01 — Trigger storage and inheritance** · L · S-04 · Triggers on any object, inherited
      downward; effective trigger set names the source object for each.
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
      Unknown, not Down.
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
