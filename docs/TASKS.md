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
- [x] **S-07 — Ingestion pipeline** · L · S-05 · Batched writes with a bounded queue, a
      backpressure signal to probes, and per-batch metrics. Target 100k samples/min sustained,
      p99 write < 100 ms.
      **Added by S-06:** when a batch's oldest sample precedes the five-minute watermark — which
      is what a probe replaying its spool looks like — call `Housekeeper.noteLateSamples(from,
      to, reason)`. Without it those readings land in raw, correct and invisible, and no rollup
      ever looks at that window again. Cheap enough to call for any batch that qualifies; a
      redundant window costs one row and one pass.

      **S-07 outcome.** `packages/core/src/ingestion/`. Both targets are cleared by more than an
      order of magnitude and the measurement is committed rather than asserted
      (`docs/findings/2026-08-25-ingestion-measurements.md`, reproduced by
      `packages/core/test/perf/ingestion-performance.test.ts`): at the shipped 1,000-row batch,
      **3,653,796 samples a minute at a p99 write of 28.9 ms**, against 100,000 and 100 ms. Larger
      batches are not better — 5,000 rows buys no throughput and triples the p99 to 85.9 ms —
      which is the reason the default is what it is rather than the largest number that fit.

      **Backpressure rides on the acknowledgement, not on the refusal.** `results-ack` carries
      `retryAfterMs`: zero means keep going, anything else asks the probe to wait before offering
      more. By the time batches are being *refused* it is too late to be polite, so the signal has
      to exist while everything is still working. Measured under the load it exists for: two
      probes replaying a spool alongside one reporting live cost the live probe **1.02x** its
      quiet latency against a 3x budget, with the replaying probes asked to wait up to 50 ms and
      the live one never asked at all.

      **The late-data hook went in tighter than S-06 asked for.** Rather than the ingestor
      deciding a batch is late and calling `noteLateSamples` afterwards, it hands every written
      range to `Housekeeper.noteWrittenRange` *inside its own write transaction*, and the
      watermark comparison happens there in one statement. The readings and the promise to re-roll
      them therefore commit or fail together — a replayed spool cannot leave the rollups quietly
      wrong because the process died between the two writes.

      **The state machine's share is a number, not a hope**: 7.0% of throughput, and a run where
      *every* sensor changes state on *every* scan still writes at a p99 of 31.0 ms. The same
      measurement caught something that reads as a bug and is not — one probe offering one batch
      at a time spends 250 ms of a 275 ms round trip in the flush timer, because a single probe
      never fills a write.
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
- [x] **S-09 — Gap semantics** · M · S-08 · No-data distinct from zero in storage, query results
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
      floor; the tooltip says "no reading" and the table view a dash.

      **S-09 outcome: the scenario test, `packages/core/test/gap-scenario.test.ts`.** One sensor,
      sixty one-minute scans, ten of them failing, walked from the failed check to the JSON a
      chart is drawn from. Every stage of that already had its own tests, which is the reason the
      composed test was still worth writing: *no-data is not zero* is not a property of storage,
      or of the rollup, or of the query, or of the chart — it is a property of the five of them
      together, and a zero could appear at any seam between them without failing a test written
      for one stage.

      **The reading is a constant 100 ms, so arithmetic is the assertion.** Anything that
      interpolates, zero-fills or divides by elapsed time instead of by readings produces a number
      that is not 100, and the failure names the stage that produced it. The sharpest case is a
      single bucket over the whole hour: fifty readings of 100 must average **100**, not 83.3.

      **Two things it makes concrete that were only written down before.** The scan at minute 25
      is a *failed* check that carries a reading of zero anyway — what a sensor type that reports
      `0` on failure looks like from the core's side — and it is discarded and counted rather than
      trusted. And the gap and the outage are **different lengths**: readings stop at the first
      failed scan, but `scan.retryWarnings` defaults to 1, so the sensor is not Down until the
      second. Ten minutes of gap, nine minutes of downtime. Anything computing uptime from where
      the samples stop would invent a minute of downtime that never happened, which is why
      `CLAUDE.md` computes it from `sensor_state`.

      Mutation 6/6, and the first round was 4/6: the test asserted `null` on the averages and not
      on `min`, `max` and `count`. A min-max band drawing to the floor while the line correctly
      breaks is the same bug wearing a different array, so a gap is now asserted `null` in every
      series a bucket has, through `JSON.stringify` as well — the cheapest place to lose one.
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
- [x] **P-111 — Four load-bearing lines in `main()` could be deleted with nothing failing** · M ·
      P-80, P-82, P-94, P-103 · The gap
      `docs/findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md` already named — "what
      remains unpinned is `main()`'s own composition" — measured rather than argued.

      **Deleted `pauses` and `reachabilitySync` from `packages/core/src/main.ts`: 2,118 core tests
      pass. Deleted `onAdd` and `onDispatch` from `packages/probe/src/main.ts`: 283 probe tests
      pass.** Four shipped fixes — `P-80`, `P-82`, `P-94`, `P-103` — silently reverted, with a
      green suite. `buildHarness` constructs its own state service and its own audit sink, and the
      watchdog's tests call `assigned` and `forget` directly under a comment noting that `main.ts`
      does it "in the same breath", so every one of them proves the *mechanism* and none proves
      the wiring.

      **The fix is the one already working elsewhere in the same file.** Two of today's additions
      — `reconcilesReadings` and `ingestionDiscards` — could not be deleted, for one reason: they
      are required interface members, so the compiler is the guard. So the other three became
      required too: `onDispatch` on the dispatcher deps, `pauses` on `SensorStateServiceOptions`,
      and the assignment listeners moved from `store.onAdd(...)` registrations into the
      constructor as a required `AssignmentListeners`. A caller with nobody to tell can still say
      so with an empty function; what it can no longer do is say nothing.

      **The fourth could not be typed**, because a sink in an `AuditSink[]` has no shape to
      require. The three lists are extracted into `objects/audit-composition.ts` as named
      functions with a required parameter per sink, and `audit-composition.test.ts` asserts each
      list's membership — so removing one fails there. The differences between the three lists are
      asserted too, because they are the interesting part: only the object service gets
      reachability, a schedule edit skips the result cache and the alarm chain, a trigger edit
      skips the configuration push.

      Two contract tests came with it, for a store whose own behaviour nothing had pinned: `onAdd`
      fires when a sensor arrives and **not** on a re-push — which is exactly `P-80`'s rule, since
      firing on every push would restart the clock of every healthy sensor on every reconnect —
      and `onDrop` fires when one leaves.

      **What is still not covered**, and is said so on purpose: that `main()` passes these lists to
      those three services, and that it constructs the store and the dispatcher at all. That is one
      line each, `main()` still has no test file, and closing it properly means extracting the
      composition into something a test can build. The gap is smaller and it is not gone.

- [ ] **S-11 — Resolve TimescaleDB on Windows** · M · S-06 · Spike: install and benchmark on
      Windows Server. Decide TimescaleDB vs plain-Postgres fallback and record the outcome in
      ADR-001. _Blocks the Windows release story._

      **The decision half is answered and does not need a Windows host** —
      `docs/findings/2026-09-03-timescaledb-on-windows.md`. TimescaleDB publishes current Windows
      builds (2.29.2 ships `timescaledb-postgresql-{16,17,18}-windows-amd64.zip`, and the eight
      most recent releases all do), and the PostgreSQL 17 package contains
      **`timescaledb-tsl-2.29.2.dll`** — the licensed module where compression lives — plus every
      function this project uses: `create_hypertable`, `time_bucket`, `drop_chunks`,
      `compress_chunk`, `add_compression_policy`. **So no `PlainPostgresEngine` fallback is
      required on availability grounds**, and the cost `S-12` priced does not have to be paid.

      What is left is what actually needs the host: the benchmark, and whether `setup.exe`
      composes with how an operator installs PostgreSQL on Windows — there is no Windows
      counterpart to `scripts/smoke/provision-postgres.sh`.

      **Writing that counterpart blind was considered on 2026-09-04 and deliberately not done.**
      The Linux script is 38 lines and the shape transfers — preload `timescaledb`, set the licence,
      restart, wait, create the role and database, `CREATE EXTENSION`. What does not transfer is
      every particular it depends on: the data directory, the service name, and whether
      `setup.exe` places the extension where a running server will find it. The finding above says
      in as many words that this is unverified, so a `.ps1` written now would be a guess at paths
      and service names that reads like progress and proves nothing — and `P-53` would parse-check
      it, which makes it look checked. Write it on the host, where the first run says whether it is
      right.

      Re-check the availability finding
      before a Windows release; an upstream that stopped publishing Windows builds would flip it.
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
- [x] **S-17 — Nothing knows how full the disk is** · L · S-06, P-12 · `WORKFLOW.MD §13` row 7
      says "housekeeping escalates, oldest raw data is evicted first, a critical alarm fires
      before ingestion stops". **The system does none of the three.** There is no free-space read
      anywhere in `packages/`, no disk channel on Core Health, and the housekeeper's retention is
      by *age* only. A full disk today stops PostgreSQL, and the first thing an operator learns
      about it is that ingestion has stopped — which is the failure mode this whole project
      exists to not have.
      **Found by `H-02`** auditing §13 row by row (`docs/findings/2026-08-29-failure-modes.md`).
      Three parts, and the middle one is the interesting one. Measuring free space is a
      `statfs` on the data directory, plus `pg_database_size` for the share this installation is
      responsible for. Alarming on it is a Core Health channel and a default limit, which is
      `S-18`. **Evicting oldest raw data first interacts with the rollups**: raw behind the
      rollup watermark can go and raw ahead of it cannot, because dropping it would lose the
      rollup that has not been computed yet — and the watermark is already what
      `Housekeeper#rollForward` maintains, so the eviction order is a query rather than a new
      concept. `drop_chunks` is Apache-licensed (`CLAUDE.md`), so the mechanism is available.
      Wants an ADR paragraph on one thing: whether the emergency eviction is allowed to violate
      the operator's configured retention. It should be — data that cannot be written is worse
      than data that was kept less long than promised — but that is a decision, not an
      implementation detail, and it must be said out loud in the alarm.

      **S-17 outcome, and the ADR paragraph the ticket asked for is written** (ADR-001, amended
      2026-08-29): below a configured free-space threshold, housekeeping drops the oldest readings
      **ahead of the retention the operator configured**. The alternative is letting PostgreSQL
      run out of room, and that is worse — a monitoring system whose database has stopped
      accepting writes is both broken and *silent*.

      **The hard part was not the measurement, it was being sure of the disk.** The readings are
      on PostgreSQL's volume; this process is on its own. A core that watched its own and called
      it the database's would show a healthy number in front of a volume about to fill. So a
      configured `housekeeping.disk.path` wins; a loopback or unix-socket database means the data
      directory's filesystem is the right one; and **a database on another host produces no
      reading at all** — a gap, not a zero, with eviction off, because dropping real data on the
      strength of an unrelated disk's fullness is the worst outcome available.

      Four bounds, each closing a way this could do more harm than the full disk it answers:
      never past what the tier above has summarised (raw that has not been rolled up is the only
      copy of that hour); never into a window a pending backfill has to re-read; never newer than
      `minimumRetainedHours`, 48 by default; and coarsest tier last, daily never. It drops a day
      at a time and re-measures after each, stopping at `recoverAbovePercent` — above the trigger,
      or the installation spends its life at the threshold shedding a chunk at a time.

      Nothing about it is quiet. Every eviction is an error-level log line naming the table and
      the horizon; `evictedChunks` is a counter channel whose declared limit (`S-18`) fires on any
      rate above zero; `diskFree` warns at 20% and errors at 10%, which is *the same event* as the
      eviction threshold rather than a number picked separately. There is also a distinct message
      for the case that matters most: everything eviction was allowed to take has gone and the
      disk is still filling.

      **The guard is a public method as well as a step**, and the reason is a test that failed
      for the right reason: inside a full pass the rollup has already advanced the very watermark
      eviction is capped by, so a test pinning that cap could not see it hold. Production calls
      `runOnce`; the cap tests call `guardDisk` directly.

      Tests: 15 in `disk-guard.test.ts` against a real database with real chunks and a faked
      filesystem — filling a real one would be a test about the filesystem. Every bound has its
      own test, because **eviction is a bug that destroys data** and the failure is silent and
      permanent.

      Mutation 9/9, after two rounds, and each survivor was worth the round. One test passed for
      the wrong reason: with no rollup watermark planted there was no cap, so eviction bailed
      before it ever looked at the disk. Nothing covered the remote-database branch at all, which
      is the branch whose whole point is not guessing. And `bavail` versus `bfree` — the root
      reserve — was only reachable through the un-injected `statfs`, so it now has a test against
      a real one that discriminates wherever the filesystem has a reserve. The last survivor was
      the threshold check itself, which the recovery check subsumes: deleting it drops nothing and
      logs an error every five minutes on a healthy installation, which is how an operator learns
      to ignore the log. That is a test about what is *logged*.

      **Found while verifying live, and fixed in this commit**: a channel created by the ingestion
      path — a probe reporting a key for the first time — got no declared limits, so `S-18`'s
      defaults arrived a restart late for every channel added to an existing type. Which is
      exactly what these new Core Health channels were. `ChannelResolver` now takes the same
      lookup the start-up pass uses.

      Also fixed in passing: `credentials.ts` held a **raw NUL byte** as its digest separator.
      Written as `'\0'` now — the raw byte is invisible in every editor and diff, and the same
      character had silently found its way into a `split(' ')` in this ticket's own code, where it
      made the start-up backfill match nothing.
- [x] **S-18 — The health sensors ship with no thresholds** · M · M-04, P-12, P-13 · `ChannelDef`
      has no way to declare a default limit, and neither `ms.core.health` nor `ms.probe.health`
      seeds one: `channel.limits` is a `jsonb` column that starts empty and nothing fills it. So
      **a fresh install alarms on none of its own numbers** — scheduler lag, deferred checks,
      spool depth, rollup lag, undelivered notifications are all measured, all correct, and all
      silent until an operator writes a threshold by hand.
      **Found by `H-02`.** It is what makes §13 rows 6 and 7 say "warns" where the system only
      "records". The difference is between a system that *can* be monitored and one that *is*.
      The shape is a `limits` field on `ChannelDef` applied at channel creation, not a migration
      seeding rows: a limit that only existed for installations created after this ticket would
      be the worst of both. An operator override must keep winning, and a channel whose limit the
      operator has cleared must not have it put back on the next start — so "never set" and "set
      to nothing" have to be distinguishable, which they are not today.
      Pick the numbers from `H-01`'s soak rather than by taste; a default that fires on a healthy
      installation teaches people to ignore it.

      **S-18 outcome.** `ChannelDef.limits` is a declaration a sensor type makes, applied when the
      channel is created and by a start-up pass to channels that already exist. Migration 038 adds
      `channel.limits_source` — `unset` | `declared` | `operator` — and everything turns on it.

      **The column is the ticket.** `{}` meant both "nobody has configured this" and "somebody
      deliberately cleared it", and a default cannot be applied safely without telling those
      apart: a backfill reading the *value* would put a threshold back on the next restart that an
      operator had just removed, and do it silently. `operator` is written the moment anybody
      patches a limit — including patching it to nothing — and is never written over. The
      migration marks existing non-empty limits `operator` on the way in, because before this
      there was no other way to fill that column.

      **A start-up pass rather than a migration**, because a migration is checksummed SQL and
      cannot read the catalogue — and the alternative, hardcoding the two health types in SQL, is
      the switch statement `CLAUDE.md` forbids. The pass builds its map from
      `catalogue.channelsFor`, so a type that gains a declaration needs no change here. It writes
      only where the value would change: writing a channel bumps its sensor's version and
      invalidates every open ETag (`S-13`), so a pass that touched every health channel on every
      start would make a restart look like a configuration change to every client watching.

      **The numbers are provisional and say so.** Ten channels across the two health types:
      ingestion queue, rollup lag, oldest undelivered notification and alarm-sweep overdue on
      Core Health; scheduler lag, pool usage and dropped spool results on Probe Health. Each is
      argued from something structural rather than from taste — the shortest interval a sensor may
      have is 10 s, so a p95 scheduler lag of 5 s is half of it and the graph's spacing has
      stopped meaning what it says. `H-01`'s soak should revisit them.

      `spoolDropped` is the one that is not a matter of degree: a counter becomes a rate, and any
      rate above zero is measurements that no longer exist anywhere. Its bound is 0.00001 rather
      than 0, because a limit of exactly zero fires on the floating-point residue of a rate that
      has returned to none.

      The catalogue refuses a declaration with no bound, one that is not a number, and one whose
      warning sits outside its error — at registration, where every other channel rule is checked.

      Verified live against the running dev stack: migration 038 applied, 10 channels took their
      declared limits on the first start and 0 on the second, the `icmp.ping` limits somebody had
      set by hand were marked `operator` and left alone, and both health sensors are **Up** under
      the new thresholds — which is the requirement, since a default that fires on a healthy
      installation teaches people to ignore it.

      Tests: 12 in `declared-limits.test.ts`, 5 in `catalogue.test.ts` for the registration rules
      plus one asserting only the two self-monitoring types ship thresholds at all. Mutation 8/8.
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
- [x] **S-15 — State-history retention that cannot lose current state** · M · S-06, M-15 ·
      `sensor_state` is deliberately excluded from S-06's retention sweep. A sensor that has sat
      Up for three years has exactly one row, three years old; `drop_chunks` would take it and
      the sensor would have no known state at all, breaking uptime and SLA — which CLAUDE.md
      requires be computed from state history. Retention here has to carry the latest row per
      sensor forward before dropping a chunk, and needs a test that ages a quiet sensor past the
      horizon and asserts its state survives.

      **S-15 outcome.** Migration 037, `stateAtHorizon`/`anchorStates` on the store, a
      `state-retention` step in the housekeeping pass, and `retention.stateDays` (default 3,650 —
      as long as the coarsest sample tier, because uptime and SLA are computed from *this* table
      and a retention that outlived the state history would leave a graph with numbers and no way
      to say how much of it was an outage).

      **The order is the whole design: snapshot, drop, then anchor.** Read what each quiet sensor
      was in *before* the drop, because afterwards the answer is gone; drop; then write an anchor
      only for the sensors the drop actually left with **no rows at all**.

      **Anchoring after the drop rather than before it is what makes this affordable**, and it is
      the non-obvious half. The natural reading of the ticket — "carry the latest row forward
      before dropping a chunk" — writes a row on *every* pass for as long as a sensor stays quiet:
      the horizon moves, the anchor is always older than it, and a five-minute pass would produce
      288 rows a day per quiet sensor. Conditioning on "this sensor now has no rows" is exact and
      self-limiting: anchored once, and not again until the anchor's own chunk ages out, which is
      once per chunk period. A mutant that moved the anchor before the drop is killed by the test
      that runs three passes.

      **`carried` is a column, not a new `sensor_state_cause`.** A cause says *why the state
      changed*, and nothing changed here — the row exists so the history has a floor. Removing an
      enum value on rollback means rewriting the type and every row that used it, where dropping a
      column is one statement that cannot fail halfway. It is not cosmetic either: `M-02` writes a
      transition when the *cause* changes without the state changing, so `previous_state = state`
      was already possible and could not have identified an anchor.

      A deleted sensor is never anchored — its history is on its way out with it, and resurrecting
      a row would keep it alive one pass at a time. The state log and its API carry `carried`, and
      the detail panel says "carried forward" instead of inventing a transition from a state to
      itself: an operator scrolling to the oldest thing the log still holds is looking at the floor
      of the history, not its beginning.

      Mutation: 10 mutants, 10 killed. Live: a paused sensor with one 900-day-old row had its chunk
      dropped and its state carried forward to the horizon — `up`, `carried`, "state carried
      forward past the retention horizon" — and three further passes added nothing.

      Tests: 10.
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
- [x] **P-03 — Child-process runner** · M · P-02 · For shell-outs and user scripts: separate
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

      **P-03 outcome.** `ProcessRunner`, beside `CheckPool` and with the same contract — submit
      returns immediately, results arrive by callback, and both spool through one sink because to
      everything downstream a reading is a reading. Which runner a check goes to is the *sensor
      type's* declaration (`SensorType.isolation: 'process'`), read from the catalogue exactly as
      `T-06`'s `listener` is, so the probe never matches on a type id.

      **The justification is narrower than "if a check can hang", and this ticket's own framing
      undersold it.** A worker thread is terminable and has its own heap limit, so hanging and
      leaking are both survivable in the pool. What is *not* survivable there is a **hard crash**:
      a segmentation fault in a native module, or an `abort()` from something a user's script
      loaded, takes the whole probe down — every sensor on it, not one. That, plus running as a
      different OS user, is what a thread cannot offer at any price. There is a test for it:
      `test.abort` raises `SIGABRT`, the runner reports one Down sensor and carries on.

      **One process per check, not a pool of them** — the opposite of `CheckPool`'s trade, for the
      opposite reason. A pool exists to amortise start-up; here *not* amortising is the feature,
      because nothing survives from one check to the next and so a leak or a stuck handle cannot
      accumulate. Measured at **~21 ms** of start-up, with the whole shipped catalogue costing
      1.3 ms more than a one-file registry — a direct consequence of the rule that a type's heavy
      imports live inside `execute`, and the measurement that would catch it being relaxed
      (`docs/findings/2026-08-27-process-runner-startup.md`). 21 ms is noise beside a script that
      runs `df`, and three to twenty times the cost of an ICMP check on the same LAN, which is
      exactly why isolation is opt-in per type rather than the default.

      **The request goes in on stdin, never in argv**, because a `CheckRequest` carries decrypted
      credentials (`A-05`) and argv is world-readable through `ps` — a secret this system encrypts
      at rest and then publishes to every local user would be a secret it did not protect at all.
      The answer comes back on a *marked* line of stdout, read from the end, because a library a
      type imports may print and a check that runs somebody's script may echo text it does not
      control.

      **Found while writing it:** the runner imported its result marker from `check-child.ts`,
      which is an entry point with top-level `await` on stdin — so importing it ran the child's
      body *inside the probe*, and the probe sat waiting for its own stdin to end, for ever. The
      constant now lives in `types.ts`, which is neither the program nor its launcher.

      **What is bounded and what is not**, stated rather than implied. Bounded: wall-clock
      (`SIGTERM` then `SIGKILL` against the whole process group), heap, captured output, and a
      built rather than inherited environment. Not bounded: CPU seconds, address space, file
      descriptors and child count — Node exposes no `setrlimit`, and reaching one would mean a
      shell or a native dependency. `A-09` is where a platform-specific answer belongs.
- [x] **P-04 — Backpressure and lag metrics** · M · P-02 · Skip-if-still-running, deferred-check
      counter, scheduler lag histogram (p50/p95/p99), pool utilisation.
      **Added by P-01:** `TimingWheel.stats()` already carries the scheduler half — tick lag
      percentiles over the last 1,024 ticks, dispatch count, skipped ticks and clock jumps. Only
      the wheel can measure its own lag, because only it knows the instant each tick should have
      run at.
      **Added by P-02:** `CheckPool.stats()` carries the rest — busy workers, queue depth,
      deferred and refused counts, worker crashes, and percentiles for both queue wait and check
      duration. Skip-if-still-running is implemented; what is left for this task is surfacing all
      of it on Probe Health.

      **P-04 outcome: delivered by `P-13`,** which is where "surfacing it" had to happen. The
      numbers travel on the heartbeat as `ProbeHealthReport` (protocol 7) and become channels —
      `schedulerLag` (p95, because a scheduler is late in bursts), `poolUsage`, `queued`,
      `checkWait`, `deferred`, `refused`, `timedOut`, `workerCrashes`, `clockJumps`. Each is a
      channel an operator can put a limit on rather than a line in a log nobody greps.
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
- [x] **P-06 — Protocol simulator harness** · L · F-02 · Mock SNMP agents, scriptable-latency
      HTTP server, SSH server, syslog sender, flow exporter. Shipped as a package, used by every
      sensor test.

      **P-06 outcome.** `packages/simulators` — `@ms/simulators`, a `devDependency` of the
      packages that have tests and of nothing that ships.

      **Most of it already existed and this is where it was always going.** The SNMP agent said so
      in its own header from `T-01`: "when `P-06` builds the rest, this is the piece to move rather
      than to write again." The mail servers came with `T-17`, the SSH server with `T-07`, the
      PowerShell stand-in with `T-09`. They lived under `packages/sensors/test/support/`, which is
      why the core's and the probe's tests could not reach them, and why **seven test files each
      stood up their own `createServer`**. Auditing what was there before building anything is what
      turned that into a move rather than a rewrite.

      **What was genuinely missing was the latency, and it is the headline for a reason.** Every
      HTTP-shaped sensor here is really a timing sensor: `T-13` reads a response time, `T-15`
      follows a redirect that must not re-send its body, `T-14` bounds a body and must fail rather
      than truncate, `P-02`'s pool needs a check that hangs. `HttpSimulator` makes each of those
      one field — `delayMs` (no answer yet), `bodyDelayMs` (head now, body later), `dripMs` (a slow
      trickle), `hang`, `reset` — and a route may be a *sequence*, which is how "fails twice then
      succeeds" is written at all.

      `bodyDelayMs` carries a lesson this repository already paid for once: **`writeHead` only
      stages the headers**, and Node sends them with the first body chunk, so without
      `flushHeaders` a server appears to think for the whole delay and then answer instantly —
      which is exactly the shape the test was trying to tell apart.

      **The syslog sender renders its own bytes** rather than calling `@ms/sensors`' renderer, for
      the reason the SNMP agent is hand-written: a harness built from the code under test is a
      closed loop that passes whether or not either side matches the RFC. It speaks both of RFC
      6587's TCP framings and can split a frame across two packets — and the **pause between the
      halves is not decoration**, because two writes with nothing between them are coalesced into
      one segment and the split would exist only on the sending side. Two socket-level receiver
      tests that were previously impractical exist now because of it.

      **The harness has its own tests**, which is not ceremony: a `delayMs` that did not delay
      would turn a timeout test into one that passes for the wrong reason, and every sensor test
      downstream would stay green. That is worse than no harness.

      **Not built: the flow exporter** the ticket lists. NetFlow and IPFIX are deferred to v2
      (`CLAUDE.md`), so a simulator for them would be a harness with nothing to test.

      **Not finished: the conversion.** `rest-custom.test.ts` and `syslog.test.ts` use the harness
      now; `http.test.ts`, `http-advanced.test.ts`, `http-transaction.test.ts`, `jitter-range.test.ts`,
      `port-dns.test.ts` and `tls.test.ts` still stand up their own servers. Those are green and
      several have hard-won detail in them (`http.test.ts`'s 4 MB backpressure pump), so converting
      them is follow-up worth doing deliberately rather than a rewrite bundled into this ticket.

      Tests: 21 (the harness's own) + 4 new socket-level syslog and REST cases.

      Also found: `npm run format:check` — which CI runs — has been failing on 34 tracked files
      from earlier tickets. Per-file `prettier --check` was passing, so nobody saw it. Fixed in its
      own commit, and `.prettierignore` now skips agent worktrees the way `eslint.config.js`
      already did.
- [x] **P-07 — ICMP spike and decision** · M · P-06 · Benchmark system-`ping` wrapper vs raw
      socket at 1,000 targets for throughput, accuracy and privilege cost. Record the outcome in
      ADR-001.
      **Outcome: no raw socket, and the answer was a flag.** ADR-001 predicted three seconds a
      check and no pool that absorbs it. The three seconds were real; the cause was not process
      spawn but `ping` idling one second between packets, which `P-08` never overrode. `-i 0.2` —
      the floor an unprivileged process may use, not a preference — took 1,000 targets from **20
      to 99 checks a second on 64 workers**, identical reply counts, 4.9x flat across the
      concurrency curve. The v1 target is 83 checks a second: the old flags missed it at 256
      workers (77/s), the new ones clear it at about 55.
      **So the fast path is declined on a measurement rather than deferred.** Node still cannot
      open a raw or unprivileged ping socket without a native addon — a compiler on the operator's
      machine, a per-platform artefact, an unmaintained dependency in the hottest path here — and
      the requirement it existed to rescue is now met with headroom. Revisit above ~10,000 ping
      sensors per probe, or below a 30 s interval at the v1 count.
      **It also found a shipped bug.** `-c` and `-w` interact: with a deadline iputils waits for
      `count` *replies* and keeps transmitting, so `P-08`'s `-c 4 -w 5` sent **five** packets to a
      host that was down, and `-i 0.2` under it would have sent twenty-five — five times the
      traffic at exactly the hosts already in trouble. Linux uses `-W` now; the count means what
      the form says and the dead-host case halved. Jitter keeps a one-second default deliberately:
      twenty packets at 0.2 s sample four seconds of network, and congestion on a ten-second cycle
      is invisible in a four-second window. `docs/findings/2026-08-29-icmp-throughput.md`.
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
- [x] **P-09 — HTTP sensor** · M · P-05 · Status code, response time, size channels; timeout,
      redirect and TLS-verification options.

      **P-09 outcome.** `http.request`. The host comes from the device and never from a URL in the
      parameters: a type that took a whole URL would let the two disagree, which is how a device
      gets renamed and half its sensors keep checking the old address.

      **Two timings, because they fail differently.** Time to first byte is connect, TLS and the
      server thinking; the total adds transferring the body. A page that got slower because a
      query got slower moves the first; one that got slower because it got bigger moves only the
      second — and a single "response time" cannot tell an operator which happened. (The test for
      this failed on the first run for a good reason: `writeHead` only *stages* headers and Node
      sends them with the first body chunk, so the test server needed `flushHeaders()` to produce
      the shape the assertion is about.)

      **The body is counted, never accumulated.** Size is worth having — a page that suddenly
      halves is a broken deploy — but a check runs in a worker shared by hundreds of sensors, and
      buffering an accidental multi-gigabyte download takes all of them down. `T-14` needs the
      content and can bound what it keeps; this needs the count. Tested against a 4 MB response.

      **A redirect that leaves the device is reported, not followed.** Following it means the next
      reading is about somewhere else, under a sensor named for this device, with nothing on the
      graph saying the subject changed — so a different host, scheme or port ends the chain and
      the message says where it pointed. Five hops otherwise, and a loop is named as one.

      An unfollowed 3xx is a **success** when redirects are off, because "check that this still
      redirects" is a real thing to watch and calling the correct answer a failure would make it
      inexpressible. So is an expected 404 or 401 — a canary for a page that must stay
      unpublished, or an endpoint that must stay authenticated. TLS failures are named by their
      cause (expired, self-signed, wrong host) rather than reported as "request failed", and
      running with verification off says so in the message on **every** scan rather than once at
      configuration time.
- [x] **P-10 — Port sensor** · S · P-05 · TCP connect with timing; optional banner match.

      **P-10 outcome.** `port.tcp`. The cheapest check that proves something is *serving*, which
      ICMP does not — a host answers ping while the daemon on it has been dead for an hour. The
      reading is the handshake time, which sits above an ICMP time to the same host and should:
      a listener's accept queue filling up shows here and nowhere else, which is the reason to
      run this alongside a ping rather than instead of it.

      **The banner is matched as text, never as a regular expression**, and deliberately: an
      operator-supplied pattern against remote-supplied bytes is the ReDoS hazard `T-03` had to
      put a `node:vm` watchdog behind, and "does this still say OpenSSH_9" is a substring. A
      banner that *changed* is a reading of 0 rather than a failed check — the service is up and
      answering, and what it says is a thing to set a limit on — but a banner asked of a protocol
      that never speaks first is a **failed check saying so**, because that is a misconfigured
      sensor and not a fault. Errors name the cause from the socket's own code: nothing listening,
      a name that did not resolve, or a filtered port, which behaves exactly like a slow one and
      is the one people misread.

      A banner is a *line* — SSH, SMTP, FTP, POP3 and IMAP all end theirs with CRLF — so the
      newline ends the read. Waiting out the banner timeout after it had arrived cost three
      seconds on every scan; measured in the tests, 3008 ms down to 1.9 ms.
- [x] **P-11 — DNS sensor** · S · P-05 · Resolve a record type, validate the value, time the
      query; configurable resolver.

      **P-11 outcome.** `dns.record`. Resolution is the dependency nothing else in a monitoring
      system can see failing: every check that names a host resolves it first, so a broken
      resolver is a hundred sensors going Down with a hundred different-looking errors and the
      one thing they share invisible.

      **The resolver is configurable and defaults to the system's, because those answer different
      questions.** Empty, this is "can this probe resolve names at all" — the thing the hundred
      sensors depend on. Pointed at a server it is "is *that* nameserver answering correctly".
      Same sensor, one field. A name is refused as a resolver: resolving a resolver is the problem
      this sensor exists to detect.

      The expected value is compared against **every** record rather than the first, because a
      name with two addresses answers in either order and a check reading `records[0]` would flap
      between them for ever with nothing wrong. "No such record" and "the lookup failed" are
      separated — different faults, different fixes. MX carries its priority and SRV its weight,
      since a set that kept its hosts and reordered their priorities is a change worth seeing.
- [x] **P-12 — Core Health sensor** · M · P-05, S-07 · CPU, memory, ingestion queue depth, DB
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

      **P-12 outcome.** `ms.core.health` in `@ms/sensors`, `CoreHealthService` in
      `packages/core/src/health/`, a thirty-second sweep, and `GET /api/v1/core-health`. Sixteen
      channels, every one of them a number some earlier ticket added a `stats()` for. Results go
      through `acceptResults` exactly as a probe's do, so Core Health has history, limits,
      triggers and alarms with no special case downstream — and `evaluatedBy: 'core'` keeps it
      out of every probe's assignment list, the mechanism `T-21` built.

      **What it cannot do, stated rather than implied.** `WORKFLOW.MD §13` says Core Health goes
      Down when the database is unavailable. **This sensor cannot report that while it is
      happening**: its reading is a row and its state is a row, and there is nowhere to write
      either. What it does instead is the more useful half — the queue, the write latency, the
      notification backlog and the rollup lag all climb *before* a struggling database becomes an
      unreachable one. The live answer during a total outage is `GET /api/v1/core-health`, which
      is why there is a route and not only channels; most of it needs no database at all.

      **No "config age" channel**, which the ticket asks for and PRTG has. Theirs measures a core
      that has stopped persisting its configuration file; ours has no such file — configuration is
      rows in the same database as everything else, written in the transaction that changed them,
      so there is no separate write that can fall behind. The risk that number stands in for is a
      *probe* running configuration older than the core's, which is per-probe and belongs on
      `P-13` beside version skew.

      **The primary channel is the ingestion queue**, not a health score. It is zero whenever the
      core is keeping up and climbs whenever anything downstream of a probe is not, which makes it
      the one number that means "the core is failing at its job" rather than "one of its parts is
      busy". PRTG's answer is an opaque 0–100 assembled from numbers that each have a meaning of
      their own, and an operator cannot act on it.

      **Three decisions the tests exist to defend**, each one a way of not lying:
      *CPU is a gap on the first reading*, because a rate needs two samples and 0% is a claim
      about the machine rather than about the measurement. *Rollup lag is the excess over each
      tier's own bucket width*, because a daily tier can only ever be materialised to the last
      complete day — a channel carrying `now - watermark` would rank a healthy 1d tier far worse
      than a broken 5m one. *A read that fails records no channel values*, because zeros are
      exactly what a perfectly idle, perfectly healthy core looks like.

      **The sweep and the route keep separate CPU baselines.** A rate consumes its previous
      sample, so one shared meter would mean a dashboard polling `/core-health` every two seconds
      silently turned the *recorded* channel into a two-second sample — every reading honest, the
      history noisier for being watched.

      The timer came out into `PeriodicSweep` at its second caller, shared with `T-21`'s factory
      sweep: what they have in common is entirely mechanical — an unref'd interval, a re-entrancy
      guard, a skip counter, and a failure that must not stop the next pass.

      Mutation: 12 mutants, 12 killed. Live: 16 channels created with the right units and counter
      widths, three sweeps recorded, the first sample of `cpu` and of all three counters a
      deliberate gap, and the sensor Up with "0 queued, writes 20 ms, rollup 25 s behind".

      Tests: 24.
- [x] **P-13 — Probe Health sensor** · M · P-04 · Scheduler lag, deferred checks, pool
      utilisation, connection state, spool depth, version skew.

      **P-13 outcome.** `ms.probe.health` in `@ms/sensors`, `ProbeHealthService` in
      `packages/core/src/health/`, a thirty-second sweep, `GET /api/v1/probes/{id}/health`, and
      protocol 7 carrying the probe's own numbers on the heartbeat.

      **The core evaluates it, and that is the decision the whole ticket turns on.** The obvious
      design is a sensor that runs on the probe and reports its own numbers — and it fails at the
      only moment that matters. `R-05` says a lost probe is one alarm, not a thousand: its sensors
      go Unknown because nobody asked them anything, and the single alarm comes from Probe Health.
      **A probe cannot report its own absence.** So the reading is two halves: what the core knows
      (link, heartbeat age, protocol skew), which is always available, and what the probe told it
      while it still could (scheduler lag, pool, spool), which gaps when the probe is gone.

      **It found a real bug in `R-05` before a line of it was written.** `ProbeReachability`
      marked *every* sensor under a lost probe Unknown — including core-evaluated ones. That was
      already wrong for `core.factory`, whose readings come from rows the core holds and which the
      probe never touched; for Probe Health it would have been disabling, because the sensor whose
      job is to raise the alarm for a lost probe would have been silenced by that very outage. The
      walk now excludes core-evaluated types. **Verified live**: with the probe killed, sensor 8
      went `unknown/probe` while Core Health and Probe Health kept their own states.

      **`connected` is the primary channel**, through a lookup rather than a threshold — the state
      reads "not connected", not "below 0.5" (`M-06`). Two built-in lookups joined the catalogue,
      `ms.probe.link` and `ms.probe.protocol`. The protocol one has no code for "not yet known" on
      purpose: a lookup maps a *reading* to a state and has no Unknown to map to, so an unrecorded
      version is a **gap**. A fourth code would have had to be Warning, marking every probe after
      an upgrade until it reconnected.

      **A probe too old to report says so in words.** Below protocol 7 the probe's half is absent;
      the channels gap and the message reads "its own numbers are unavailable — it speaks protocol
      3, this build speaks 7, so it cannot …". `R-06`'s rule: a peer that connects and quietly does
      less than it should is the failure worth making visible.

      Mutation: 14 mutants, 14 killed. One survived first time — moving the primary channel off the
      link, which nothing asserted — and `packages/sensors/test/health-types.test.ts` now pins the
      primary and the lookups for both health types. Live: the local probe reported at protocol 7
      with 47 sensors scheduled and 4.8 ms scheduler lag, `cpu` a gap on its first report, and a
      sensor watching a probe that has never connected went **Down** with "Link to the core is 0
      (not connected)" and exactly one channel carrying a reading.

      Tests: 16 (core) + 5 (probe) + 5 (sensors) + 5 (shared) + 2 (reachability).
- [x] **P-14 — `prom-client` metrics endpoint** · S · P-04 · Everything in P-04, P-12 and P-13
      exposed for external scraping too.

      **P-14 outcome.** `MetricsExporter` in `packages/core/src/metrics/` and `GET /metrics`.

      **The library is `prom-client` under its current name.** npm answers an install of
      `prom-client` with "has been replaced by `@prometheus-io/client`" — the same project, now
      published under the Prometheus organisation's scope. `CLAUDE.md`'s stack row is updated
      rather than quietly diverged from; this is a rename, not a different decision.

      **Read from the health services, not from the subsystems a second time.** The rule `N-13`
      set for delivery health: a second implementation of a health question is a second answer to
      it, and the day they disagree is the day nobody trusts either. `/metrics` and the two health
      sensors are the same numbers from the same call, differing only in how they are spelled —
      base units, because that is what every dashboard and alert expression assumes.

      **A gap is an absent series.** Prometheus has no null, so the honest translation of the
      no-data rule is to stop exporting the series for that scrape; a graph then breaks the line,
      exactly as ours does. Every gauge is reset before each collection, because a gauge that kept
      its last value would report a probe that has gone as still running at whatever it was doing
      when it left. Verified live: a probe that has never connected exports `ms_probe_connected 0`
      and its info series, and nothing else at all.

      **Live verification found the same mistake in the opposite direction.** A labelled counter
      does not exist in the client library until something touches it, so skipping a zero delta
      left `ms_probe_checks_refused_total` *absent* on a probe that had refused nothing —
      indistinguishable from a probe that never reported. **A reported zero is a reading**; only a
      missing reading may be an absent series. Counters are now initialised at zero, which is also
      the baseline `rate()` and any "no data" alert need.

      **The endpoint is at `/metrics` and had to be guarded explicitly.**
      `registerAuthentication` guards paths under `/api/` only, because the app shell must be
      public — so a route outside that prefix is public by default. That default is right for
      `index.html` and wrong for a body carrying every queue depth, the sensor count per probe and
      the probe names, which together is a map of the installation. A scraper authenticates with
      an API token (`A-06`), which is what `authorization` in a Prometheus `scrape_config` is for.

      The response-schema guard — the structural half of the credential defence (`A-10`) — gained
      its second exemption, and the mechanism now records *why* each one is exempt rather than a
      boolean: bytes off disk, and a text format that is not JSON. Two justifications are two
      decisions, and an exemption nobody can enumerate is one nobody reviews.

      The core's own CPU, memory, heap and uptime are deliberately **not** re-exported as channels
      of ours: the default collector already publishes `process_resident_memory_bytes`,
      `nodejs_heap_size_used_bytes` and `process_cpu_seconds_total`, which is what a Prometheus
      user's existing Node dashboards read — and a total lets the scraper pick its own rate window
      rather than being handed ours. The *probe's* process numbers have no such standard series,
      so those are exported.

      Mutation: 10 mutants, 10 killed. Tests: 17.
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
- [x] **P-18 — Demand-driven worker pool sizing** · M · P-15 · Grow the check pool when the queue
      is persistently non-empty and shrink it when idle, within a configured bound, so a probe
      pays for the slots its workload needs rather than for a fixed default. `P-15` measured the
      cost of getting it wrong in both directions: 7 slots refused 21% of checks and delayed the
      rest by 15.8 s, while a flat 48 costs ~290 MB of resident memory on a probe watching fifty
      sensors. The sweep in `scheduler-benchmark.test.ts` is the harness to prove it against.

      **P-18 outcome.** `workerPoolSize` becomes a ceiling; `workerPoolMinSize` (default 4) is
      where the pool starts, and `workerPoolIdleShrinkMs` (default 60 s) is how long everything
      must have been idle before a worker is given back. Measured on `P-15`'s own harness
      (`docs/findings/2026-08-29-pool-sizing.md`):

      | Pool | p95 jitter | Refused | Memory |
      | --- | --- | --- | --- |
      | fixed 48 (what shipped) | 218 ms | 0 | 557 MB at 48 workers |
      | demand-driven 4 → 48 | **217 ms** | 0 | 16 MB at 4 |
      | fixed 7 (pre-`P-15`) | 29,176 ms | 3,494 | 34 MB at 7 |

      **The ramp costs nothing measurable** — one millisecond at the p95, over ninety seconds
      that include growing from four workers to forty-eight — because the delay is spent once, on
      the first tranche, and does not reach the percentile the gate is stated at. At fifty
      sensors the pool never grows at all: **4 workers and 16 MB against 48 and 263 MB**, which
      is the case this ticket was written for.

      **The policy is asymmetric because the mistakes are.** Growth is immediate — a queued check
      with every worker busy is the only state in which another worker would have started
      something that is instead waiting, and `#pump` runs first, so a still-non-empty queue *is*
      that state. Shrinking waits out a whole quiet interval and gives up one worker at a time,
      because all it buys is about six megabytes and paying a spawn during the next spike to have
      saved them is a bad trade. The idle clock is monotonic and is reset by *submitting*, not
      only by finishing: a shrink between a check queueing and a worker picking it up would take
      the worker that was about to run it.

      Setting `workerPoolMinSize` equal to `workerPoolSize` restores the old fixed pool exactly,
      which is what a probe with a known steady workload should do.

      **Probe Health's message names the size now**, which live verification is what showed was
      needed: `pool 0%` is the same sentence for four workers and for forty-eight, and with a
      fixed pool an operator could be assumed to know the denominator. The channel stays a
      percentage — that is what a limit is set on — and the size goes in the sentence beside it
      rather than becoming a channel of its own.

      Mutation 9/10 after two withdrawals. One targeted a redundant condition — `#grow` re-checked
      for an idle worker that `#pump` had just proved could not exist — which was deleted rather
      than tested around. The survivor is the growth *step*: doubling versus one at a time is a
      judgement about a ramp, not a contract, and a unit test pinning it would be testing the
      implementation; the ramp as shipped is measured end to end instead. A third was withdrawn
      as equivalent — a sizing timer that a fixed pool starts and that changes nothing observable.
- [x] **P-23 — `ingestion` nack test raced for the queue slot it was asserting about** · S · — ·
      "passes a refusal back to the probe as a nack it can retry" in
      `packages/core/test/ingestion.test.ts` failed once inside the full core suite, reading
      `results-ack` where it wanted `results-nack` — and took **60,076 ms** to get there.
      **Found by `P-18`**, which did not touch ingestion.

      **P-23 outcome: the test, not the ingestor.** It offered two batches without awaiting the
      first, and both resolve their channels against the database before reaching the queue —
      so nothing made the first of them win. When the second got the only slot it was *accepted*,
      and an accepted batch of one row then waits out `batchMaxDelayMs`, which this test sets to
      sixty seconds. Hence a minute of silence followed by an assertion about the wrong batch.
      It now waits for `queuedRows` to reach two before offering the second, and runs in 12 ms.

      **The production race it was filed against does not exist, and that is worth writing down
      rather than leaving open.** `Ingestor.submit` has no `await` between reading `#stopping`
      and pushing to the queue, so a batch cannot be enqueued in the window where `stop()` has
      already decided the queue was empty: a submit either sees the flag and is refused, or is
      queued before it is set. Checked by reading, and the code is short enough for that to
      settle it.

      Worth the hour for the reason a sixty-second test is worse than a failing one: a suite that
      occasionally takes a minute longer for no visible reason is a suite people stop waiting
      for. It is the only place in the core's tests that offers a batch without awaiting it.
- [x] **P-19 — Bulk provisioning path** · M · S-16, D-04 · Create a subtree in one request rather
      than one object per request. `docs/findings/2026-08-25-tree-build-measurement.md` records
      the serial 5,000-object build eroding from 21.0 s to 29.3 s across Phase 3, recovered to
      23.7 s by guarding `M-08`'s ancestor query. What remains is per-object work that is
      genuinely needed (`M-02`'s `sensor_runtime` row); the answer is to stop paying an HTTP
      request and a transaction for each of five thousand objects, which discovery needs anyway.

      **The serial path sits on its budget, and `P-21` is the reason it looks worse than it is.**
      Measured 2026-08-28, five runs on a host that was *not* as idle as it looked — the dev stack
      up and a mutation sweep finishing: **32.1, 32.5, 35.7, 36.3 s against the 30 s budget**, with
      one at 31.8 s that passed. Re-measured 2026-08-29 with the stack stopped and nothing else
      running: **25.2 s, 16% spare**, and eight in flight at 7.8 s with 74% spare.

      So the honest statement is not "this regressed past its budget" — it is **"this is close
      enough to the budget that machine load decides the outcome"**, which is `P-21`'s complaint
      exactly. The margin is 16% on a quiet machine against a target that has eroded from 21.0 s
      across Phase 3, so `P-19` is still the fix; what it is not is a failing test that needs its
      number moved. The budget has not been widened.

      **P-19 outcome.** `POST /api/v1/objects/tree`. Nodes name their parent by `ref` where that
      parent is also being created, so a caller describes a subtree rather than sorting one.
      Measured on the same harness, over the same HTTP, building the same 5,000 objects
      (`docs/findings/2026-08-29-bulk-tree-create.md`):

      | How | Wall | Rate | Against the 30 s budget |
      | --- | --- | --- | --- |
      | serial, one request per object | 28.8 s | 174 objects/s | 4% spare |
      | 8 requests in flight | 8.8 s | 570 objects/s | 71% spare |
      | **one request** | **2.8 s** | **1,798 objects/s** | **91% spare** |

      **10.3x the serial path**, and 3.1x a client clever enough to pipeline eight at a time. What
      it stops paying is not the inserts — `S-16` already established the remaining per-object
      work is genuinely needed — but the costs that are really *per request*: a transaction and
      its commit, `lockTreeShared`, the `anyActive` probe, and a `SELECT` of a parent whose kind
      the caller already knew. Eight statements for 4,999 objects, against roughly fifteen
      thousand.

      **The tree is the same tree, and that is asserted rather than asserted-to.** A test creates
      one sensor each way and compares the *stored rows*, because a hard-coded expectation would
      go on passing if normalisation moved and only one path followed it. The audit log gets one
      entry per object, each built from a read-back so it carries the defaults the schema filled
      in, the version the triggers landed on and `A-05`'s redaction — an entry saying "5,000
      objects were created" answers no question anybody has.

      **Two things are deliberately different.** It is all-or-nothing, because a half-provisioned
      device is worse than a failed one — nothing says which half — which is also why the node
      count is capped at the v1 target. And the answer is ids rather than objects, in the order
      the nodes were sent: five thousand full objects is megabytes describing what the caller
      already wrote, and the one thing they could not know is the ids.

      Mutation 13/14. The survivor is an `ORDER BY` on the batched insert that no test can
      distinguish, because a function scan over `jsonb_to_recordset` yields array order anyway —
      kept and labelled as a guarantee requested rather than demonstrated, with the property it
      protects covered end to end instead. Two rounds were needed: the first pass's pause-cascade
      mutant matched the *serial* path's identical line, and passing it was the tests being right
      about the wrong code.

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

      **The client threw its first connection away, and reconnection covered for it.** Found
      later, from an `InvalidStateError` on every page load in development. StrictMode's second
      mount closes a socket that has not finished connecting, and that socket's close event
      arrives *after* its replacement exists — so handlers that read `this.#socket` rather than
      the socket the event belonged to cancelled the new socket's registration on the strength
      of the old one's death. Measured in the browser: the subscribe frame for the working
      socket was never sent at all, that socket then stayed open and unsubscribed for the life
      of the tab, and the tree filled in ~900 ms later when the reconnect backoff expired. The
      live view worked, in development, only because reconnection did. Handlers now check that
      their own socket is still the one in use, and a subscription made while connecting waits
      for `onopen` rather than throwing. The test fake now throws on `send` before `open`, the
      way a browser does — accepting it silently is how a client that sent too early passed
      fifteen tests here while filling the dev console with the error.

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

      **Independently re-checked on 2026-09-04** against the live stack at the v1 target — 5,051
      sensors, 5,329 objects, real alarms — rather than against fixtures, since scale and real
      strings are what break a layout that passes on seed data. Overview, Tree, Alarms, Logs and a
      sensor detail page: no console errors, and at a 320px viewport `documentElement.scrollWidth`
      equals `clientWidth` on every one, with the wide tables contained by their own
      `overflow-x-auto` wrappers rather than by the document. A contrast sweep over every element
      holding a text node, in **both** themes, reported zero pairs under 4.5:1 (3:1 for large).
      Both of this ticket's headline fixes are still in place: titles read "Tree —
      MonitoringSystem", "Probe Health — MonitoringSystem" per route, and the light theme's border
      is no longer the 1.23:1 it was.

      A spot check across five routes rather than a fresh audit of all nine, and no substitute for
      a screen reader — but it is evidence against the usual decay, which is that a pass like this
      is true on the day it is done and quietly stops being.

- [x] **U-16 — Clear the Fast Refresh allowlist** · S · U-01 · Thirteen web modules exported a
      pure helper beside their components, so `@vitejs/plugin-react` could not Fast Refresh them:
      every edit reloaded the page and dropped whatever UI state was open.

      **U-16 outcome.** `react-refresh/only-export-components` is an error across
      `packages/web/src` with no exemptions, and the allowlist that carried the thirteen is gone.
      31 violations, all the shape `whereSteps` had. The helpers moved into sibling modules —
      `time-series-model`, `page-title-model`, `tabs-model`, `virtual-list-model`, `logs-model`,
      `templates-model`, one `routes/detail/model.ts` for the five detail panels, and
      `descendantsOf` into the `discovery-model` that already existed.

      **One `model.ts` for `detail/`, not five.** It mirrors `src/tree/model.ts`, and
      `test/detail-model.test.ts` already treated those panels' helpers as one thing.

      Two were not simple moves. `PageTitle` kept its "which page was I on" in a module-level
      `let` that `resetNavigationFocus` cleared, so the state had to travel with the export; the
      read-then-write is now one `takeFocusOn` call, which is also the honest contract — the
      answer is only right on a route's first render, and it is the recording that makes it so.
      `SchemaForm` needed no new module at all: its three flagged names were a re-export of
      `forms/schema` and `forms/validate` that nothing imported, so the line was deleted. Four
      imports elsewhere died with the moves and lint caught each one.

      Verified with `isLikelyComponentType` — vite-plugin-react's own predicate, the one that
      emits the invalidate message — over all fourteen modules: every runtime export is a
      component. Types moved where they were a moved function's argument (`ChartSeries`,
      `TabDefinition`, `RangeId`), since a type-only import back would have been a cycle.

- [x] **U-17 — A login view, so the UI can be used with authorisation on** · M · A-01, A-11 ·
      `packages/web` has no login route, no password field and no 401 handling. With
      `api.requireAuthentication` on — the default since `P-154` — the bundle loads and then every
      API call it makes is refused, with nothing on the page saying why. The core warns about the
      pairing at startup (`P-172`), which is a signpost and not a fix.

      Needs: a login view posting to `POST /api/v1/auth/login`, a 401 interceptor in the API
      client that routes to it rather than rendering an error, the "change your password at first
      login" flow `ensureFirstAdministrator` sets up, logout, and the MFA challenge `A-07`
      already serves. Until it lands, an operator running the bundled UI must set
      `api.requireAuthentication` to false — which means an API that needs no principal at all,
      so it belongs behind something else that authenticates.

      **U-17 outcome.** A login form, a forced change-password form, logout, and the second
      factor `A-07` already serves. The interesting part was not the form.

      **"Nobody is logged in" and "a login is needed" are two facts, and no route said the
      second.** `GET /auth/me` refuses an anonymous caller with 401 — and with
      `api.requireAuthentication` off, that same 401 comes back to a caller who may use the
      entire rest of the API. A client that read only the status has to choose between demanding
      a login the core does not want and rendering an application whose every request will be
      refused; those are the two halves of this ticket, one of them the bug it was written for
      and the other the bug a naive fix introduces. So `GET /auth/session` — public, 200 to
      anybody, `{ requireAuthentication, authenticated, principal? }` — is the first call the
      browser makes. **Adding it took two edits, not one**: the authentication hook refuses from
      its own `ALWAYS_PUBLIC` list before a route's `config: PUBLIC` is ever consulted, so a
      route declaring itself public and nothing else answers 401 to the callers it exists for.
      Mutation: removing the path from that list turns the guarded-anonymous case red.

      **The 401 interceptor filters on the code, not the status.** `POST /auth/login` answers 401
      three ways — password not accepted, second factor needed, code wrong — and every one of
      those is the login form working, not a session going away. `AUTH_REQUIRED` is the one code
      the guard raises. That rule has to be asserted at the client, not through the application:
      the provider separately ignores a lost session unless it was signed in, so a listener
      firing on every 401 renders identically in every screen the app can reach. Two overlapping
      guards, one testable path — the shape of entry 32 in the wrong-reason findings, caught
      this time by mutating.

      **`mustChangePassword` is a flag nothing on the core enforces.** No route refuses a request
      because of it. If the client does not act, the generated password in `first-admin-password`
      stays a live credential for the life of the installation — so the form is forced, and the
      only thing that takes it down is the core saying the flag is gone. The client asks again
      rather than assuming, because the flag lives on the account.

      `MFA_REQUIRED` arrives for two different situations and only `details.enrolled` separates
      them: "now type a code", and "a group requires a factor this account has never enrolled",
      which is a lockout, because enrolling needs the session being refused. The form names an
      administrator instead of offering a field with nothing to type into.

      `P-172`'s startup warning is gone — it said this build of the UI could not log in, and the
      `api.requireAuthentication` doc comment in `packages/shared/src/config/schema.ts` said the
      same thing and promised the warning; both are corrected.

      **`dev/core.json` stays at `requireAuthentication: false`.** It was flipped on, to make
      development exercise the configuration production ships, and flipped back when the sixth
      panel pointed out what that breaks: the three `curl` commands the README gives for driving
      the dev core, and `scripts/soak.sh`, whose readiness gate is an unauthenticated `curl` that
      does not honour the `MS_TOKEN` its own `.mjs` helpers accept. Turning it on is worth doing
      and is `U-20`, with those two fixed first. The login path was verified against a dev core
      with the flag on before it went back.

      Tests: 35 new in `packages/web`, 9 on the core. Mutations 16/16. Verified live against the
      dev core and in the browser at 320px in both themes — where the first real defect turned up
      (`U-18`).

      **The sixth panel then found a worse one, and it is the reason this entry is long.** The
      login form read `enrolled` and `retryAfterSeconds` from `error.details`. The core puts an
      `AuthError`'s values in `error.context`: `toHttpError` has *two* namespaces and fills
      `details` only for `ObjectError`, `MethodError` and `TriggerError`. So the lookup was always
      `undefined`, `=== 'true'` was always false, and **every account with a second factor got the
      lockout message and a disabled button** — the MFA half of this ticket was unreachable in any
      real installation, and the throttle delay always read "shortly".

      Nothing failed loudly, which is the shape of it: reading the wrong namespace is not a type
      error, the branch it guards is simply never taken. And the tests were the alibi — all eight
      MFA and throttle cases built the refusal envelope with the data in `details`, a shape no
      server emits, so they passed against a body that does not exist. **No test in `packages/web`
      can see the wire**, so the shape is pinned where it lives: four cases in
      `auth-api.test.ts` assert `context` carries `enrolled` and `retryAfterSeconds` and that
      `details` stays empty, and one logs the enrolled account in with a recovery code so the two
      refusals cannot both be satisfied by a core that never accepts a factor at all. Moving the
      values to `details` on the core turns three of them red; reading `details` on the client
      turns six web tests red. Entry 35 in the wrong-reason findings.

      Also from that panel: `stuck` disabled the submit button for the life of the form and was
      never cleared — and a disabled default button swallows Enter too, so one lockout refusal
      killed the form for every other account until a reload. It clears on any credential edit
      now. An empty submit went to the core and rendered Ajv's JSON Pointer at the operator. The
      `unreachable` screen had no exit but a manual reload; it offers a retry. `/password` was
      routable while anonymous, where `POST /auth/password` is refused whatever the flag says.

- [x] **U-19 — an expired session looks like a network blip to the state stream, for ever** · S ·
      U-17 · `onSessionLost` fires from the fetch client, so it cannot see the WebSocket. With
      authentication on, `GET /api/v1/stream` is guarded, and a session that goes away turns the
      upgrade into a 401 — which `StateStream.#dropped` cannot distinguish from a dropped
      connection, so it reconnects for ever at the 10s ceiling. An operator sitting on the tree or
      the alarms view, making no other request, sees the live dot go offline and stay there while
      the header still says they are signed in. The dot is honest about staleness, which is why
      this is not urgent; what is wrong is that nothing ever resolves it, and the fix is not
      obvious — a browser cannot read the status of a refused upgrade. Probably: after N
      consecutive failures, ask `GET /auth/session` and let the answer decide between "offline"
      and "logged out".

      **U-19 outcome. The premise checked out this time**, which is worth saying after `P-185`:
      an unauthenticated upgrade to `/api/v1/stream` really is refused with a clean
      `401 AUTH_REQUIRED` — measured with `curl`, headers and envelope — and the browser
      `WebSocket` API really does hide it, handing the page a 1006 close indistinguishable from a
      pulled cable.

      So the client asks the one route that can answer. `StateStream` gains `onStuck`, called from
      the ceiling of its backoff onwards rather than on the first failure: the early rungs are what
      a lid closing, a wifi roam or a core restart look like, and asking after one of those spends
      a request on every one of them. It repeats while stuck, because the outage long enough to
      matter is exactly the one a session can expire during. `confirmSession` in the API client
      does the asking and reports through the same listener a 401 on any other request uses, so the
      gate that puts the login form up knows nothing about sockets. **An unreachable core is not an
      answer** — that is what the reconnect loop is already handling, and reading silence as
      "logged out" would put a login form in front of somebody whose network blinked.

      The class keeps its callback rather than growing a `fetch`, so it stays framework-free and
      drivable without a server — which is what let the whole thing be verified against the real
      one. Vite serves the source modules, so a browser console can import `StateStream` and
      `confirmSession` and point them at the live core with no config change and no restart: six
      reconnects in five seconds, the first `onStuck` at **1,154 ms** — after the ladder, not on
      the early failures — four calls, four lost sessions reported. At the production ladder
      (`[500, 1000, 2000, 5000, 10000]`) that is one public GET about fifteen seconds into an
      outage and one per ten seconds after.

      Tests: 7 new, 4 on the stream's timing and 3 on what `confirmSession` does with each of the
      three answers. Mutations 5/5 — asking on every failure, asking exactly once, never resetting
      the streak, treating an unreachable core as logged out, and never reporting at all.

- [x] **U-20 — run the dev stack with authentication on** · S · U-17 · `dev/core.json` has
      `requireAuthentication: false`, so the one configuration development never exercises is the
      one production ships. Turning it on needs two things first: `scripts/soak.sh:50` gates on an
      unauthenticated `curl "${API}/objects/root"` and must honour the `MS_TOKEN` that
      `scripts/soak/provision.mjs` and `sample.mjs` already read, and the README's three `curl`
      commands for claiming the probe branch, pausing an object and setting channel limits need
      to say where the session comes from (`dev/data/first-admin-password`, written inside the
      container). Check `scripts/dev-e2e.sh` and the smoke scripts at the same time.

      **U-20 outcome.** `dev/core.json` runs with `requireAuthentication` on. One credential
      mechanism — a bearer token in `MS_TOKEN`, which `scripts/soak/*.mjs` already read — and one
      place that turns it into a header, `scripts/lib/api-auth.sh`. `scripts/dev-token.sh` mints
      one for the dev stack from the generated bootstrap password; `scripts/smoke/api-token.sh`
      does the same inside a smoke container, where a cookie jar on the host would be no use.

      **The gate's diagnosis was the actual defect, not the missing header.** `curl -sf` cannot
      tell a refusal from a silence, so the soak harness reported "no installation answering" about
      an installation that was answering perfectly well, and sent whoever ran it to restart a
      service that was already up. `ms_api_probe` distinguishes ok / unauthenticated / forbidden /
      unreachable and each gets its own sentence, including which command mints the token.

      **The smoke harnesses were broken before this ticket, not by it.** `deploy/examples/core.json`
      does not set `api.requireAuthentication`, so a packaged install defaults to on, and
      `smoke-install.sh` asserted anonymous access on three routes, `smoke-restore.sh` on eight
      through its `api` helper, and `smoke-enrol.sh` on one — all answering 401 and reporting the
      thing under test as broken. All now authenticate. `smoke-restore.sh` uses the *origin's*
      token on both hosts, which is sound and worth saying: by the time anything questions the
      target it is running on the origin's restored database, accounts included, so a token that
      stopped working across the restore would itself be a finding. `scripts/dev-e2e.sh` calls no
      API and needed nothing.

      **Two things found by running it.** `ms_curl` first built its `-H` arguments in an array;
      macOS ships bash 3.2, where expanding an empty array under `set -u` is an unbound-variable
      error rather than nothing — and it failed inside a `$(…)` the caller had guarded with
      `|| true`, so the symptom was an empty status code and a confident report that nothing was
      listening. Exactly the misdiagnosis the file exists to remove, reintroduced by the fix.
      Two branches now, no arrays.

      And `--teardown` could never have worked on a tree this harness makes: it counted
      `(await GET /objects/:id/tree).items.length - 1` for `expectedDescendants`, but `/tree` is
      paginated and answers `{ items, truncated }`. For the 5,250-object soak tree in the dev
      database it computed **999**, and the core refused with "now holds 5250 other objects, not
      999". The `/counts` route exists for exactly this and its own documentation names the
      mistake — counting a page of `/tree` "gives the right answer for a small installation and a
      quietly wrong one for a large installation". It reads `/counts` now: 5251 total, 5250
      descendants, the number the core said it wanted. Verified by computing it, not by deleting
      anything.

      **Not run here:** the three smoke harnesses themselves, which build a release tarball and
      boot systemd containers. The part that could be wrong — login, token issue, the header — is
      verified against a real core; the `docker exec` plumbing is a substitution. `shellcheck`
      is clean at warning level across all seven scripts.

      **A foot-gun worth knowing about:** the dev database's 5,000-sensor load *is* a soak tree
      named `Soak`, so `scripts/soak.sh --teardown` deletes the working fixture. The
      `expectedDescendants` guard is the only thing between that and a bad afternoon, and it is
      now the *only* thing, because the count it is checked against is correct.

- [x] **P-183 — the first administrator could not administer anything** · S · U-20, A-03 ·
      `ensureFirstAdministrator` creates the bootstrap account with `role: 'admin'` and put it in
      no group. **`role` is an account-level ceiling, not a right on any object.**
      `AccessService.resolve` grants `full` on everything only through membership of a group with
      `is_admin`, and otherwise falls through to per-object grants — of which a brand new
      installation has none. So the only account on a fresh box passed every role bar and was
      refused by **all 32 object-scoped route declarations**, across eight files and including 23
      in `objects.ts`: reading an object, the tree, a sensor's state, history, triggers,
      credentials, discovery, templates. A fresh install was unusable by the account it creates
      for you, through the UI or otherwise.

      **It was invisible because nothing anybody used was fresh.** Migration `032` backfills every
      account that already exists into a group — "Administrators by role, everybody else by
      default" — so every database that upgraded into user groups has a working administrator, and
      only a database created *after* `032` does not. The dev database is one of the former: its
      `admin` is in `Administrators [is_admin]`, which is why the same request that answers
      `AUTH_FORBIDDEN` on a fresh box answers `OBJECT_NOT_FOUND` there. Two environments, one of
      them the one we ship, and the divergence is exactly the thing under test.

      Found by `F-08`'s install smoke test, which builds the only fresh installation this project
      makes — and which could not see it either until `U-20` gave it a credential to be refused
      with. It had been asserting `GET /sensors/999999/state` answers `OBJECT_NOT_FOUND`; it
      answered `AUTH_FORBIDDEN`, and that assertion is sound again now rather than needing to be
      weakened. Tests: 1 new in `accounts.test.ts`, resolving `full` on an arbitrary object id and
      asserting `viaAdminGroup` — the right answer for the wrong reason would be a per-object
      grant. Mutation 1/1.

- [x] **P-184 — six pause-precedence tests fail on a tree that was green eight hours earlier** · M ·
      `packages/core/test/pause-precedence.test.ts` fails six of its twenty-nine cases, all of them
      the `schedule` source: "holds a sensor by schedule", the two combinations that report
      schedule, the resume refusal, the dependency release on a schedule edit, and the
      all-four-holders report. **Deterministic, not flaky** — six of six on every run, in isolation
      and in the full suite.

      **Nothing in the repository changed between green and red.** The full suite passed on this
      same core source at about 02:00 on 2026-09-07 and failed at about 10:00; `git stash` confirms
      the failures are present on `5568fc8` without any local edit. So the variable is time or the
      environment, not the code, which makes this a test that was passing for a reason nobody
      stated. The suspicion to start from: the fixture pins `OUTSIDE = 2026-08-24T03:00:00.000Z`
      and creates its schedule *now*, so anything in the schedule path that is evaluated relative
      to creation rather than to the instant passed in would drift away from the pinned date as
      real time moves — two weeks by now. `SchedulePauses.recompute` itself takes `now` and calls
      the pure `isActiveAt`, so if that suspicion is right the drift is upstream of it, in what
      `list` or `anyWork` returns.

      **P-184 outcome. The drift was real and the direction was the other one.** The fixture
      drives `recompute` and `sweep` at the pinned `OUTSIDE` — Monday 03:00 UTC — but three
      service paths reach the schedule at the *real* clock and cannot be told otherwise:
      `ObjectService.pauseState` computes schedule holding live, `resume` evaluates the same way
      before deciding whether to refuse, and `ScheduleSync` recomputes at the mutation's own
      timestamp. So the window `mo:08:00-mo:18:00` was closed at `OUTSIDE` and **open for ten
      hours of every real week**, and during those ten hours the row said "held by schedule" while
      every live path said "open".

      **Green was the accident.** Ten hours in a hundred and sixty-eight is a 6% chance per run,
      and the run that caught it was a Monday morning. The failing assertion is the one whose own
      comment states the invariant — "the view an operator reads has to agree with the row a probe
      is filtered by, or one of them is lying about the same sensor" — and for a fortnight it had
      been asserting that agreement at two different instants.

      Fixed in the fixture, not in the product: the office window is pinned to a weekday that is
      not today, which closes it on both clocks at once, at any hour, without asking `pauseState`
      to accept an instant it has no other reason to take. It stays closed at `OUTSIDE` whichever
      day is chosen — either the weekday differs, or the day is Monday and 03:00 is still before
      08:00. An injectable `now` on `pauseState` was written first and reverted: it fixed the view
      and left `resume` and `ScheduleSync` on the real clock, which is a seam that buys a third of
      a fix.

      Mutations 2/2, both run inside the window that exposes this. Restoring the fixed Monday
      window reproduces exactly the six original failures; a window that is always *open* fails
      fifteen, which is what says the fixture is doing the work rather than the cases passing
      regardless. Full suite green at 3,875 — measured on a Monday morning, which is the only time
      that number means anything for this file.

- [x] **P-185 — the pause view and the probe's filter disagree at every window edge** · S ·
      P-184 · Falls out of `P-184`'s diagnosis and is a property of the product, not of a test.
      `paused_by_schedule` in `sensor_runtime` is what the probe configuration filters on and is
      moved by the sweep; `pauseState` computes schedule holding live from the definition, because
      it must — a group or a device carrying a schedule has no `sensor_runtime` row to read a flag
      from. Between a window edge and the next sweep, armed at the next wall-clock minute, the two
      disagree.

      The direction that matters is the close: at 18:00 the row still says not-paused, so the
      probe keeps scanning and an alarm can still fire, while the operator's view already reports
      the sensor held by its maintenance window. Somebody is told the window has started while it
      pages them. The open edge is the milder inverse — the UI says live, nothing is scanning it —
      and both are bounded by the sweep, so this is a minute, not an outage. Worth deciding
      deliberately rather than by accident: either the view reads the flag where there is one, or
      the sweep is armed off the next window edge rather than off the next minute.

      **P-185 outcome. The premise was wrong by three orders of magnitude, and both proposed fixes
      were wrong with it.** The sweep is not armed on the minute: `#arm` computes
      `MINUTE - (now % MINUTE) + 50`, so it fires fifty milliseconds *past* every wall-clock
      minute — and schedules have minute resolution, so every possible boundary is acted on
      within 50 ms of itself. The method's own comment says exactly this: "a boundary at 09:00:00
      is acted on at 09:00:00 and not at 08:59:59.998". I filed a ticket about a sixty-second
      exposure without reading the twenty lines that set it, and then proposed arming off the next
      window edge — which the class comment above rejects, with a better argument than mine: a
      deadline computed an hour ago is an hour wrong the moment a country changes its clocks, and
      the transitions that matter most are the ones nobody is awake for.

      So no product change. What was genuinely missing is that **nothing asserted the agreement at
      all** — which is what `P-184` had just demonstrated, since the one assertion that claimed to
      was comparing two clocks. `schedules.test.ts` now asserts all three parties at one instant,
      in both window states: the view says held, the row says held, and the probe is not given the
      sensor — then the same three the other way round. Mutations 2/2: a view that stops reporting
      schedule holding fails it, and a "closed" window that quietly covers the present fails it.

      It also adds `farFromNow()`, the missing complement of the `aroundNow()` helper that was
      already in that file. Its absence is what `P-184` was made of: a test that wants "closed"
      reaches for a fixed window like `mo:08:00-mo:18:00`, which is closed at whatever instant the
      author had in mind and open for ten hours of every real week.

      The residual exposure is 50 ms plus the sweep's own duration. **`P-186` measured that second
      term**: 73.5 ms for five thousand sensors moving at once, so the disagreement is about
      **125 ms**, twice a day — three orders of magnitude from the minute this ticket claimed.

- [x] **P-186 — the schedule sweep has no measured budget** · S · P-185 · Every installation with
      a schedule runs `ScheduleSweep.sweep` once a minute, for ever, and nothing measures it. The
      perf suite has budgets for ingestion, rollups, history, clone and tree build; this is the
      one periodic loop without one. It matters twice: it is the term that bounds how long the
      pause view and the probe's configuration can disagree after a window edge (`P-185`), and a
      sweep that grows with the sensor count is a minute-by-minute cost on exactly the large
      installations `P-15` sizes for. `recompute` opens with a `LIMIT 1` that returns nothing when
      no schedule is assigned, so the floor is already known to be near zero — what is unknown is
      the shape above it. Wants a `test:perf` case at the 5,000-sensor scale with every sensor
      under a schedule, run on a quiet machine with `ms-server` stopped, and the number in
      `docs/findings/`.

      **P-186 outcome.** Measured at the v1 target, in a tree of the shape an installation has,
      with the schedule assigned at the probe so the inheritance walk runs the full depth:
      `docs/findings/2026-09-07-schedule-sweep-budget.md`.

      | pass | median | samples | budget |
      | --- | --- | --- | --- |
      | no schedule assigned | **0.8 ms** | 2.4, 0.8, 0.8 | 50 ms |
      | a window closing, 5,000 moving | **73.5 ms** | 247.2, 73.5, 66.0 | 1,000 ms |
      | an ordinary minute | **10.4 ms** | 11.6, 10.4, 10.0 | 600 ms |

      **The always-paid cost is 10.4 ms a minute at five thousand sensors — a duty cycle of
      0.017%.** An installation that does not use schedules cannot tell the feature exists: 0.8 ms
      is `anyWork`'s `LIMIT 1` returning nothing. What makes the steady state cheap is that
      `applyPauses` writes only where the flag differs, so the walk runs, the answer is discarded,
      no `sensor_state` row is written and no probe is pushed to.

      **It also finishes `P-185` with a number instead of an argument.** That ticket claimed the
      pause view and the probe's filter could disagree for up to a minute after a window edge; the
      arming answered half of it (50 ms past the minute, and boundaries have minute resolution) and
      this is the other half. The disagreement is 50 ms + 73.5 ms ≈ **125 ms**, twice a day.

      Three samples of each rather than one, because the machine was not exclusively mine —
      `ms-server` and the Vite container were stopped per `CLAUDE.md` and the rest were idle under
      2.2%, but two containers from unrelated work were up. The first pass of each case is visibly
      dearer (cold buffers, an unplanned query) and is reported rather than averaged away, because
      that cost is paid once per process start and not once a minute.

      Budgets are set at roughly ten times the measured value, so a change that makes this
      materially worse fails rather than drifts. What is **not** measured is the shape above five
      thousand: the walk should be about linear in the sensor count, but that is an expectation,
      and an installation an order of magnitude larger is `P-15`'s question to re-measure rather
      than to extrapolate.

- [x] **P-187 — the dev database is not shaped like a fresh install, in the way that hides
      bugs** · S · P-183 · `dev/data`'s `admin` sits in the `Administrators` group, and it is
      there because it predates migration `032` — which backfills every account that already
      exists, "Administrators by role, everybody else by default". `ensureFirstAdministrator`,
      which runs *after* migrations on a fresh install, joined no group at all until `P-183`.

      **That is the exact divergence that hid `P-183` for as long as it existed.** Every
      environment anybody used had been upgraded into user groups; the only fresh installation
      this project makes is the one `smoke-install.sh` builds in a container, and it could not see
      the defect either until `U-20` gave it a credential to be refused with. A development
      database that has been migrated forward for weeks is not the thing we ship, and the ways it
      differs are invisible precisely because nobody chose them.

      What would help is being able to get a *fresh* one cheaply and routinely — a documented
      teardown-and-rebuild for `dev/`, so the shipped first-boot path is exercised by ordinary
      work rather than only by a smoke test somebody remembers to run. Note the constraint before
      designing it: `docker compose down -v` deletes the dev Postgres volume, which is the whole
      point here but is also how somebody loses a fixture they wanted; and `dev/data` holds the
      vault key and `first-admin-password`, so "fresh" means those too. Not urgent, and worth
      doing before the next thing that only reproduces on a virgin database.

      **P-187 outcome.** `scripts/dev-reset.sh`. It drops the `monitoring` database and removes the
      three things a fresh install has none of — the vault key, the generated password and the
      probe's spool — then starts the core so it migrates and bootstraps.

      **Surgical, not a directory wipe**, and that is the design constraint: `dev/data` is also
      where somebody's own notes and scratch files live — `api.txt`, `smoke-api.sh`, `spike/`,
      `test-logs/` — so the state is named one item at a time and everything else is left. It does
      not touch the container, its volume, or any other database, including the `ms_test_*`
      scratch ones the suites make. `docker compose down -v` would have been the obvious mechanism
      and is the wrong one twice over: it takes the whole volume, and it is the command that loses
      a fixture somebody wanted.

      It names what it will destroy and then asks — `--yes` for a script, a typed `y` for a
      person, a refusal when there is no terminal to ask on — which is `P-188`'s pattern applied to
      the other destructive thing in `scripts/`.

      **`CREATE DATABASE` inherits `timescaledb` from `template1`**, which is where the image's own
      initialisation puts it and is why a plain `CREATE DATABASE` works for the scratch databases
      in `test/support/database.ts`. Migration `003` checks for the extension and cannot install
      it, so the reset checks too rather than trusting it: if the image ever stops seeding
      `template1`, the failure is a sentence at the point the assumption was made instead of a
      migration abort three steps later.

      **Run for real, which is what it was for.** The dev database was 5,051 sensors migrated
      forward for weeks; it is now one root object, no samples, one account — and that account
      reads `admin | admin | Administrators [is_admin]`, which is `P-183`'s fix confirmed on a
      virgin database rather than in a smoke container. `GET /objects/root` answers 200 and
      `GET /sensors/999999/state` answers `OBJECT_NOT_FOUND` rather than `AUTH_FORBIDDEN` — the
      exact discriminator `smoke-install.sh` uses, now true in development too. `dev-token.sh`
      works again, because the bootstrap password is new. All thirteen unrelated files under
      `dev/data` survived.

      The 5,000-sensor load is reproducible with `scripts/soak.sh --sensors 5000`, and the tree is
      deliberately **not** rebuilt by the reset: walking the README's "Making it actually scan
      something" from an empty tree is the operator path, and restoring the fixture automatically
      would put the environment straight back to being unlike a new one.

- [x] **P-189 — approving a connected probe does not start it scanning** · M · R-01, P-187 ·
      The first thing an operator does after installing is approve the probe waiting in the queue.
      Nothing happens. It keeps sitting there, scanning nothing, until something makes it
      reconnect.

      `ProbeEndpoint` sets `session.approved` **once, at admission**:

          // **An unapproved probe is sent nothing**, which is the whole of what approval means
          if (session.approved) this.#queueConfig(session, logger, hello.configVersion ?? '');

      A probe that connected while pending has `session.approved === false` for the life of that
      session, and `ProbeRegistry.approve` writes `probe_registration`, writes `probe_config`, logs
      "a probe was approved" and tells the live session nothing. `ConfigChangeNotifier` rides the
      audit sink, so later object mutations do flush — to a session that is still marked
      unapproved.

      **The API reference promises the opposite**, in the approve route's own description: "A probe
      that is already connected starts scanning without reconnecting." That sentence is not
      implemented.

      Measured on a fresh install (`P-187`'s reset, which is how this was found): probe pending,
      `POST /probes/dev-local-probe/approve` answers `status=approved objectId=2`, then five
      thousand sensors created under it — and eleven minutes later the probe had logged nothing
      since its handshake and `sample` was empty. Restarting it: `probe applied its
      configuration`, `scheduled: 5000`, readings within seconds.

      Two ways to make it true, and they are not equivalent. **Implement the promise** — on
      approval, find the live session, re-evaluate it and queue its configuration. Note what else
      is bound to the handshake before choosing this: the probe's own key is issued "at its next
      handshake, not here", so a session that never re-handshakes also never gets its key, and
      `hasOwnKey` stays false. **Or close the session on approval** and let the probe reconnect on
      its own retry, which it does in seconds — cruder, one line, and it makes the documented
      sentence true in effect while keeping the key issue on the handshake where the design put it.
      The second looks right; the first is what the sentence literally says.

      **P-189 outcome. Closed the session, and the key settled it.** The endpoint now indexes
      pending sessions by gid — `#sessions` deliberately holds approved ones only, which is why a
      decision had nothing to act on — and `ProbeRegistry.approve` calls `disconnect(gid)` through
      a narrow `ProbeConnections` interface, late-bound from `main.ts` the way
      `ConfigChangeNotifier.attach` already is.

      **Reviving the session in place would have left the probe scanning without a key**, which is
      the argument that decided it. A key is issued only when a probe presents the *enrolment*
      key, in the welcome — `approve` nulls the stored hash precisely so the next handshake
      re-issues one (`P-37`). Flipping `approved` on a live session and pushing it a configuration
      skips the welcome, so the probe would have been scanning happily on a credential the core
      had just invalidated, and would have been refused whenever it did eventually reconnect.

      Measured on the dev stack: approve at `08:20:25.081`, then `a probe was approved` →
      `closing a probe connection so a decision reaches it` → `link to core closed` →
      `reconnecting to core` → reconnected at `08:20:26.222`, **1.1 seconds**, with
      `issued this probe a key of its own` on the core and `issuedKey: true` on the probe, and
      `scheduled: 5000` behind it. `hasOwnKey` stays false for one more handshake, which is `P-37`
      working as designed: issuing repeats until the probe comes back *using* the key.

      The approve route's description said "A probe that is already connected starts scanning
      without reconnecting", which was not implemented. It now says what happens and why, and
      names this ticket — a sentence that was wrong for long enough to be quoted in a bug report
      is worth marking rather than quietly correcting.

      **An existing test claims this property and does not test it.** `probe-endpoint.test.ts`
      has "reaches a probe that was enrolled after it had already connected", whose comment reads
      "If the session only resolved its branch at the handshake, approving it would do nothing
      until someone restarted the probe" — exactly this defect. It drives an *already approved*
      session whose branch is claimed later, which is a different property, and it passed
      throughout. Left in place, because what it tests is worth testing; the real case is two new
      tests beside it. Tests: 4 new. Mutations 2/2 — approve not telling the connection, and
      pending sessions not being indexed.

- [x] **P-190 — the README's "making it scan something" documents a flow that R-01 replaced** · S ·
      P-189 · It tells the reader to claim a branch with
      `PATCH /objects/2 {"kind":"probe","gid":"dev-local-probe"}`, and says so under a note that
      "`R-01` replaces claiming a branch by hand with an enrolment flow; until then this is how".
      `R-01` has landed: there is a queue, and `POST /probes/{gid}/approve` binds the identity to
      an object.

      **On a fresh install the documented command cannot work**, because there is no object 2 —
      the tree is one root, and the probe arrives `pending` with `objectId: null`. The real path is
      create a probe object under the root, then approve the GID onto it. This went unnoticed for
      the same reason `P-183` did: every environment anybody used already had the object the
      instruction assumes.

      **P-190 outcome.** The section documents the enrolment flow: list the queue, create an
      object for the probe to own, approve it onto that object. Three commands where there was
      one, and the one it replaces could not work on the installation it was written for.

      It also says what happens next, because `P-189` changed it: the probe's connection is closed
      as it is approved and it comes back about a second later, through the handshake that issues
      its key and its first configuration. Without that sentence the reader watches a probe
      disconnect immediately after they approve it and reasonably concludes they broke something.

      **Walked end to end on a fresh install, using nothing but what the page says.**
      `scripts/dev-reset.sh` (`P-187`) back to empty, then the four commands extracted from the
      README itself rather than typed from memory: the token minted from the bootstrap password;
      `GET /probes` answering with one entry, `pending`, `objectId: null`; the object create
      returning **`id: 2`**, which is why the page can state that number rather than hedge; and
      the approve answering `status=approved objectId=2`. The `P-189` sequence — approved,
      connection closed, reconnecting, key issued, connected — all landed inside the same second,
      so "about a second later" is conservative.

      Then the last sentence of the section, which needed a sensor to be true of: a device and one
      `icmp.ping` under the new probe object, first reading in about twenty seconds, sensor `up`
      with `4/4 replies, avg 0.056 ms`. The documented path takes an empty installation to a
      scanning one, which is the only claim that matters here and the one that could not be made
      before `P-187` existed.

- [x] **P-191 — an authentication exemption for a route that does not exist** · S · U-17, P-187 ·
      `ALWAYS_PUBLIC` in `authentication.ts` listed `/api/v1/health`. There has never been such a
      route: the health endpoints are `/core-health`, `/probes/:id/health` and
      `/notification-health`, all behind `READS`. The entry exempted nothing, which is why nothing
      ever failed — **and a dead line in the list of paths that skip authentication reads, to the
      next person, as evidence that an unauthenticated liveness endpoint exists.** Whether this
      installation should have one is a real question, and a load balancer or a systemd unit
      generally wants it; leaving the line here implied the decision had already been taken.

      Removed, and the list is exported so a test can assert every entry is a route the server
      actually registered. **This list fails silently in both directions** — an entry matching
      nothing is invisible, and a missing entry is invisible until somebody cannot log in — which
      is exactly the shape that deserves a guard rather than care. Mutation 1/1: putting the dead
      entry back reddens it.

      **Found by accident, and it had a second victim.** `scripts/dev-reset.sh` used that path as
      its readiness probe, so `curl -sf` never succeeded, `break` never fired, and every reset sat
      out the full sixty seconds looking like a slow migration — measured: `exit 22` against the
      old path, `exit 0` against `/auth/session`, which is public and answers 200 to anybody.
      Mine, from `P-187`, and it "worked" only because a minute is long enough for the core to
      come up regardless. **A readiness probe that never succeeds is indistinguishable from one
      that is merely patient**, which is why it survived four resets without being noticed.

- [x] **P-188 — `soak.sh --teardown` will now delete the dev stack's working fixture** · S ·
      U-20 · The dev database's 5,000-sensor load *is* a soak tree: `provision.mjs` names its root
      `Soak`, finds an existing one and leaves it alone, and that is what the 5,047 sensors in
      `dev/` have been all along. `--teardown` removes it.

      **Until `U-20` it could not.** It counted `expectedDescendants` from a page of `/tree`,
      which is capped, so it asked to delete 999 of 5,250 and the core refused every time. That
      refusal was the only thing standing between an idle `--teardown` and an afternoon rebuilding
      the fixture — and it was refusing for the wrong reason, so fixing the count removed the
      guard as a side effect. Nobody decided that; it fell out.

      Wants a deliberate answer rather than the accidental one it had. The cheapest is for
      `--teardown` to say what it is about to remove and require a confirmation — the core already
      returns exact counts through `/objects/:id/counts`, so "5,251 objects, 5,000 of them sensors:
      type the number to confirm" costs one call it already makes. Worth considering alongside:
      the dev fixture and a harness's scratch tree sharing a name is the underlying reason this is
      even a question.

      **P-188 outcome.** `--remove` prints what it is about to delete — the object, its name, and
      the breakdown from `/objects/:id/counts`, which it already fetches for `expectedDescendants`
      — and then asks. `--yes` (or `MS_ASSUME_YES=1`) for a script; a typed `y` for a person; and
      a **refusal** when there is no terminal to ask on and no flag, because a non-interactive run
      that nobody has been asked about is exactly the case this exists for. `soak.sh --teardown`
      passes `--yes` through.

      The guard lives in `provision.mjs`, not in the shell wrapper, so calling the script directly
      is protected too — the danger is in the thing that sends the `DELETE`.

      **Two defects found by running it rather than reading it.** `--teardown` `exec`ed *above*
      `ms_api_require`, so the one subcommand that deletes things was also the one that reported a
      missing credential as a `fetch` stack trace; it goes through the gate now, while `--report`
      stays above it because it reads a file and needs nothing. And **Ctrl+D at the prompt threw
      an unhandled `AbortError`** — `readline.question` rejects on EOF rather than returning an
      empty answer — so an operator who hit it got a stack trace instead of a decision. EOF is a
      no, the same as every other answer that is not `y`.

      Verified against a stub core that records whether the `DELETE` ever arrives, in all four
      paths: no terminal and no flag refuses with zero `DELETE`s; `--yes` sends one; a real
      pseudo-terminal answering `n` leaves it alone; answering `y` removes it. The live dev tree
      was never a target — 5,051 sensors and one `Soak` root before and after.

      **Not fixed, and deliberately:** the name collision underneath all this. The dev fixture and
      a harness's scratch tree are the same object because `provision.mjs` finds an existing
      `Soak` and leaves it alone, which is the behaviour that makes the harness idempotent and
      also the behaviour that made a working fixture out of a scratch tree. Renaming would orphan
      the tree every dev stack is carrying. **Also not fixed:** there is no test. `scripts/` has no
      harness and inventing one is bigger than this ticket, so the guard is verified and not
      guarded — a regression here would be silent.

- [x] **U-18 — `.ms-label` silently overrides every colour utility beside it** · S · U-17 ·
      The class sets `color: var(--ms-text-muted)` and is unlayered, so it beats any Tailwind
      text utility on the same element — those live in `@layer utilities`, and unlayered CSS wins.
      `class="ms-label text-accent-contrast"` renders muted grey, and on a filled accent button
      that measures about 1.5:1 against WCAG 1.4.3's 4.5:1. Found by looking at the rendered
      login button, not by any test.

      `U-17`'s own two buttons are fixed — they use the primary-button spelling the other nine
      call sites use, which does not include `ms-label`. **What is still there is the general
      case**: the header's theme toggle carries `aria-pressed:border-accent aria-pressed:text-accent`
      and the ink half of that has never applied, and nothing stops the next one. Either
      `.ms-label` drops its colour and every call site states one, or it moves into
      `@layer components` so utilities win — the second is one line and changes what forty
      existing labels look like, so it wants looking at rather than assuming. Whichever way, the
      thing worth having is that a colour utility written next to it either works or fails to
      compile, rather than being quietly discarded.

      **U-18 outcome.** `.ms-label` moved into `@layer components`. That is the whole fix: a call
      site naming no colour still gets the muted one, because the layer still applies, and a call
      site naming one now gets what it asked for. Eight call sites were asking for something they
      were not getting — the masthead's `text-text`, the error panel's `text-down-fg` on its
      label and its "Try again" button, four `hover:text-text` states that did nothing at all, and
      the theme toggle's `aria-pressed:text-accent`, which is the one this ticket was written
      about.

      **The chart rules stay unlayered, and that is the half worth guarding.** `.ms-chart*`
      overrides `uplot/dist/uPlot.min.css`, which is imported from a component and is itself
      unlayered — layering ours would make it lose, and the chart would quietly take uPlot's
      palette instead of the app's. So the fix is not "move the custom CSS into a layer": it is
      one rule in, and a test that asserts the other rules stay out. Mutations 2/2, one in each
      direction.

      **Measured, and smaller than the ticket claimed.** On the surviving call sites the muted
      colour already met AA in both themes, so this is a correctness fix rather than a contrast
      one — declarations written, accepted and discarded. Against the running app: the error
      panel's label goes 6.15 → 6.61 in dark and 4.80 → 5.53 in light; the masthead 6.37 → 14.86
      and 5.56 → 16.67; the pressed toggle 6.37 → 5.86 and 5.56 → 5.62, which is *lower* in dark
      and still well clear of 4.5. The one genuine failure — about 1.5:1, `ms-label
      text-accent-contrast` on a filled accent button — was fixed in `U-17` by spelling that
      button the way the other nine primary buttons are spelled, and this ticket does not depend
      on it. What is fixed here is the class of bug: the next colour utility written beside
      `ms-label` works, and there is no reason muted would have kept passing on the next
      background someone puts it on.

      The container `div` added in `U-17` carried `ms-label` and no label text; removed, because
      it would have uppercased whatever was added to it next.

## Phase 6 — Sensor breadth

- [x] **U-12 — Repeating fields in the generated form** · M · U-08 · An array of objects in a
      `paramsSchema` renders as `U-08`'s JSON fallback — an editable textarea holding the raw
      value. It round-trips correctly and deletes nothing, which is why the fallback exists, but
      an operator configuring one types JSON by hand.
      **Added by `T-04`:** `snmp.table.columns` is the first shipped parameter of that shape, and
      `T-06`'s filter rules will be the second. Wants `kind: 'array'` in `forms/schema.ts` with
      add/remove/reorder over `items`, and it must keep working for a free-form array with no
      `items`, which still has to fall back.
      **Still open after `T-15` and `T-16`:** `http.transaction.steps` and `rest.custom.extract`
      are arrays of objects with arrays of objects *inside* them, so this is now the shape of
      every new sensor type's most important parameter rather than an edge case.

      **U-12 outcome.** `kind: 'array'` in `forms/schema.ts` and an `ArrayField` beside the
      object fieldset. Add, remove and reorder; `minItems`/`maxItems` honoured in the control and
      in the client-side check; a free-form array with no `items` still falls back to the JSON
      box, because where "add an entry" has nothing to add the honest control is the one that
      hands the operator the value.

      **Entries render through the same `Field` as everything else**, at paths carrying their
      index (`steps.0.method`), and three things fall out of that rather than being built:
      nesting works, because an entry containing an array is another `ArrayField` — which is what
      `http.transaction.steps` and `rest.custom.extract` actually need; server problems land on
      the right control, because the core reports Ajv's `instancePath` and that is the same path;
      and write-only entries keep their behaviour, which a bespoke editor would have had to
      reimplement.

      **The path helpers had to learn about arrays**, and that is the change with the sharpest
      failure mode. `writeAt` decides a container's shape from the *next* segment, so
      `steps.0.method` builds `{steps: [{…}]}` — a walk that always made objects would produce
      `{steps: {"0": {…}}}`, which serialises to JSON that looks almost right, validates as the
      wrong type, and is refused with a message about the parameter rather than about the form.

      **Reordering is one position at a time from a button**, not drag-and-drop: order is
      meaningful in every one of these — a transaction's steps run in order — and `U-11`'s WCAG
      pass rules out a drag target as the only way to do it.

      **`items.title` names an entry.** The fieldset is named for the parameter ("Steps") and an
      entry inside it wants the singular; nothing can derive one from the other without guessing
      at English plurals, so twelve shipped array parameters now declare theirs and the buttons
      read "Remove Step 2".

      Verified live against the running UI: `http.transaction` renders its steps as a repeating
      fieldset with per-entry headers and captures nested inside, and the body the form assembles
      is accepted by the API unchanged. Mutation 16/16, after two rounds — one survivor was a
      bounds check on the reorder that nothing can reach, since the edge buttons are disabled,
      and it was deleted rather than tested around; the other was the fixture giving an array and
      its items the same title, which let the fallback pass for the feature.

      **Filed on the way past: `A-11`.** Driving the real form in a browser found that the
      `dev:ui` profile cannot save anything — the cross-origin write guard takes an
      `allowedOrigins` list that no caller ever passes.
- [x] **U-13 — Mapping editor for REST Custom** · M · T-16, U-04 · The form that writes
      `rest.custom`'s `extract` array: paste a response, see what each path selects against it,
      name the channel. **Split out by `T-16`:** the sensor works without it — the paths go in
      the parameter form like any other array — but writing JSONPath blind against an API you
      cannot see is the part that makes people give up. It wants the response and the paths side
      by side, which is a UI job and not a sensor one.

      **U-13 outcome, and the ticket's "a UI job and not a sensor one" is half right.** The
      *layout* is a UI job. The evaluation is not, and doing it in the browser was the first
      design considered and rejected: `support/json-path.ts` is dependency-free and would have
      run there, but the aggregate, the scale, the format guess and the gap rule live in
      `rest-custom.ts`, and reimplementing them next to the form would have been a second
      implementation of the sensor. **A preview that agreed with the check only most of the time
      is worse than none — it certifies a path that does not work.**

      So the dry run is a **member of the sensor type**: `preview?(input)` on the contract,
      reached over `POST /sensor-types/:id/preview`. `rest.custom`'s implementation calls the
      same `parsePath`, `selectPath` and `aggregateOf` its `execute` calls, applies the same
      rounding, and takes the same two check-level failures. The tests that matter are
      **differential** — they run `execute` against the simulator and `preview` against the same
      body and compare the numbers, for every aggregate.

      **A contract member rather than a route keyed to `rest.custom`,** which would have been a
      switch statement of size one and the end of "adding a type is a one-file job". The
      catalogue summary carries `hasPreview` and the UI shows the panel off that flag, the same
      way `listener` and `evaluatedBy` are declared rather than matched on the id. A second type
      with a mapping language gets the editor by writing one method.

      `numericValue` moved out of `aggregateOf` and is exported, because the panel marks which
      selected values an aggregate can use — the commonest confusion here is five values on
      screen and no reading, and the answer is almost always that they are strings. Two
      implementations of "is this a number" would have made that annotation lie.

      **Found by driving the real form**, not by the tests: a single mistyped path produced
      *two* problems, the second being "none of these 1 paths matched anything in this response".
      `execute` compiles every path before it sends the request, so it would never report that —
      and it sends somebody looking at their document when the problem is a bracket. Fixed, with
      a test named after the disagreement.

      Also found there: the "not a number" marking was shading plus a `title`, which is colour
      alone to anybody using a screen reader (WCAG 1.4.1). It is `sr-only` text now, and the
      test reads the accessible text rather than the attribute.

      Bounded on purpose: 256 kB of document (the panel refuses more without a round trip), ten
      selections shown per row with the honest total beside them, 200 characters per value. The
      route stores nothing, fetches nothing and reads no credential, and there is a test that
      says so by counting rows before and after.

      Tests: 16 in `rest-custom.test.ts` (differential, per-aggregate, XML, bounds, the
      half-filled form), 9 over HTTP in `sensor-types.test.ts`, 14 in `mapping-preview.test.tsx`
      (debounce, stale-answer, gap-not-zero, the size refusal). Verified live in the dev UI end
      to end.

      Mutation 19/19, after one round. The survivor was the route dropping the pasted
      `Content-Type`, and it survived because every fixture either looked like XML or looked like
      JSON — the header only decides for a document the shape cannot, which is the HTML fragment
      starting with `<`. Two tests now turn on exactly that, one at the type and one over HTTP.
- [x] **U-14 — Exact totals for the overview** · S · U-01, U-03 · The overview counted the rows
      of one page of the tree. Replace that with an aggregate the database computes, so the
      numbers on the landing page are totals rather than whatever fitted in the response.

      **U-14 outcome, and the bug is worth stating plainly.** `Overview.tsx` read
      `/objects/{root}/tree?maxDepth=12&limit=1000` and counted what came back. On the dev
      installation — 5,329 objects, 5,051 sensors — that page showed **1 probe, 5 groups, 63
      devices, 930 sensors** and a sensor-health histogram over the same 930, all of it presented
      as fact. The only hint was a truncation note in the Tree card further down the page, which
      says the *response* was cut off and nothing about the four numbers taken from it.

      A number is read as a total. The fix is therefore not louder wording but a different
      question: `GET /objects/{id}/counts` walks the subtree and aggregates in SQL — kinds and
      the sensor-state histogram in one pass, the states as a second grouping column that is null
      for everything which is not a sensor. There is no depth and no limit to exceed, and every
      state comes back including the zeros, so no caller has to guess at an absent key.

      Measured against the dev database (5,329 objects): **23.7 ms and 195 bytes**, against
      **50.9 ms and 160,906 bytes** for the 1,000-row page it replaces — and that page was the
      one giving wrong answers. The overview no longer fetches the tree at all.

      Scoped to any object rather than the root, because a group page wants the same thing and
      would otherwise reach for the same wrong tool. `total` counts the object asked about, the
      way `enumerateSubtree` does for the delete confirmation.

      Tests: 6 in `subtree-counts.test.ts` over HTTP — including the same subtree read both ways,
      so the difference cannot quietly come back — and 3 in `overview-counts.test.tsx`, one of
      which asserts the page no longer requests `/tree`.

- [x] **U-15 — A catalogue you can find a type in** · S · U-08 · The sensor types page collapsed
      to one line per type, with a search that completes type ids, categories and parameter
      names.

      **U-15 outcome.** Forty-three types with every `paramsSchema` on screen is three hundred
      and twenty-two parameter rows and about twenty screens of scrolling — a page on which you
      cannot see what types exist, which is the one thing a catalogue is for. Each card is a
      disclosure now, shut by default, with the category, the cost hint and the parameter count
      on the row so it can be skipped without opening.

      **The search covers all three things the page holds**, because "which types take a
      `verifyTls`?" cannot be answered by scrolling and is the question an operator actually
      arrives with. Ids, categories and parameter names and titles, all substrings — nothing
      fuzzy, on a page whose entire content is identifiers, where a match the reader cannot
      explain is worse than no match. Ranking is in `sensor-types-model.ts` and tested there: an
      id that starts with the query beats one that contains it, which beats a category, which
      beats a parameter, and alphabetical within a rank so the list does not reshuffle itself as
      a search is narrowed one keystroke at a time.

      **A parameter hit opens its card; an id or category hit does not.** Somebody who typed
      `verifyTls` wants the row, not the card that happens to contain it. The mirror of that rule
      is why `matchedParameters` is empty whenever the id or the category matched: half the SNMP
      types have a parameter titled "SNMP version", and reporting it would open all nine cards on
      a search for `snmp` and tell each of them it "matches version".

      **What the search opens belongs to the search.** The state is the set of cards somebody has
      *decided* about, not the set of open ones, so clearing the box shuts what the box opened,
      and a card shut by hand stays shut. The first attempt held open ids in a `Set` an effect
      edited on every keystroke; thirteen cards opened by a search for `veri` were still open,
      with nothing on screen saying why, long after the search was gone.

      `Combobox` is the ARIA 1.2 "combobox with list autocomplete", and the keyboard is the half
      that is either right or a trap: focus never leaves the input, the active option is named by
      `aria-activedescendant`, arrowing does not choose anything, Escape shuts the list and shuts
      the field. An empty box lists every category with its count — eleven of them, never
      truncated, because that is the only complete short answer to "what is in here?" and cutting
      it hides exactly the category somebody could not name.

      **Marked matches fragment an accessible name**: `<mark>` inside the label computes to
      "snmp .traf fic", and it would change with every keystroke. The toggle and each option
      carry an explicit `aria-label` built from the plain strings, so what a control is called
      does not depend on the search.

      Found at 320px, the width WCAG 1.4.10 asks about: a header row that let the meta hold its
      width rendered `db.postgresql` as "d…". It wraps now, and the parameter table scrolls
      inside its card rather than pushing the page sideways.

      Tests: 21 in `sensor-types-search.test.ts` (ranking, the parameter rule, the browse menu),
      13 in `combobox.test.tsx` (the keyboard, and the stale `aria-activedescendant` a narrowed
      list leaves behind), 13 in `sensor-types-view.test.tsx`. Verified live at 320px and desktop
      in both themes; the mark measures 4.58:1 light and 8.73:1 dark.
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
- [x] **R-09 — On-demand probe queries** · M · R-01 · A request/response message pair over the
      probe channel so the core can ask a probe to run something *now* and route the answer back
      to a waiting API call: correlation ids, a timeout, and a bound on how many are in flight.
      **Added by `T-02`:** the protocol is one-way for everything except the handshake, so there
      is no way to populate an interface picker at add time — the core has no route to the
      device. Any "test this sensor now" button needs the same pair. **`D-02` turned out not
      to**: identification is a job nobody waits on, so it went down `D-01`'s asynchronous path
      instead. This ticket is still needed for the cases where a *request is waiting*, which is
      what makes it a different mechanism rather than a duplicate of one.
      **Added by `T-04`:** and the table row picker, which is the same gap on a bigger surface —
      an operator adding a table sensor currently reads the table with `snmpwalk` and types the
      column positions and the row value they find. Neither sensor type is blocked on it: both
      resolve the row on every scan either way, so this is the add-time convenience and not the
      monitoring.

      **R-09 outcome.** Protocol 8, capability `onDemandQuery`. `query` / `query-cancel` out,
      `query-result` back, correlated by a per-process UUID — `ProbeQueryService` in the core, a
      `QueryRunner` on the probe, and `POST /api/v1/sensors/{id}/check` as the first consumer.

      **This is the only message in the protocol the core waits for**, and that is what makes it a
      mechanism rather than another message. Everything else is one-way on its own clock, which is
      why `D-02` identifies two hundred hosts down the discovery path instead of this one. Here a
      person is looking at a spinner, so three things have to be true that are true nowhere else:
      the request is correlated to its answer, it is bounded in time, and it is bounded in number.

      **Three failures it exists to make impossible.** A promise that never settles — every path
      that removes a pending query settles it, including the disconnect and the shutdown, because
      an HTTP handler awaiting a promise nobody will resolve is a socket held until the client
      gives up. An unbounded queue — past a small in-flight bound a query is refused *and
      counted*, since a refusal an operator can retry beats a spinner queued behind other people's
      deadlines. And an answer delivered to the wrong caller, which the ids exist for.

      **Its own pool on the probe, one worker wide.** A scheduled scan is work the system owes and
      can be late; this is somebody watching. Sharing the scan pool would cost both — the query
      queues behind whatever was due on that tick, and monitoring loses a worker to something
      nobody is measuring — and a separate pool also means a flood of queries cannot displace
      monitoring at all.

      **A failing check is a 200.** The question is "what does this sensor say right now", and
      "the device refused the credential" is the answer somebody pressed the button to get; an
      error status would send it down a client's failure path. The error statuses are reserved for
      the *query* failing, and each one is a different thing to do: 503 offline or busy (wait),
      504 timeout (look at the device), 409 too old (upgrade the probe). Two phases the probe
      reports as ordinary check errors are re-labelled for the same reason — `pool-stopped` and
      `unknown-type` are the *probe's* fault, and "probe is stopping" printed under a device's
      name would send an operator to look at a machine that is working.

      **Nothing is stored, and the response says so on every reply.** A reading taken outside the
      schedule is not history: ten presses would draw ten spikes into a channel whose interval is
      a minute. **A paused sensor can still be checked** — a pause stops the monitoring, not an
      operator asking whether the thing they just fixed works, which is exactly when a sensor is
      most likely to be paused.

      **It took a hazard out of `R-04` on the way past.** `ProbeConfigService` kept credential
      rotation stamps in an instance field, reassigned at the top of every resolve and read back
      after it — sound for one caller and a shared mutable buffer for two, and this ticket is the
      second caller. `pushAllConfigs()` already started a resolve per probe without awaiting
      between them. What it could cost is not cosmetic: a fingerprint that stops moving when a
      credential is rotated is a probe told `config-unchanged` afterwards, scanning a device with
      a password that no longer works.
      **Said plainly: no interleaving was demonstrated.** Two candidates were traced by hand and
      written as tests, and neither reproduced against the old shape — every write goes through
      the field as it stands, and the read follows the last write with no yield between them. The
      stamps are returned rather than stashed, which removes the question for the cost of one
      object instead of answering it with a scheduler; the test that remains asserts concurrent
      resolves agree with serial ones, and it is a guard rather than a regression test.

      Verified live: ping answered in 678 ms end to end (`durationMs` 648, which is `P-07`'s
      spacing), an SNMP sensor answered through the credential path, five checks in a row added
      **zero** rows to `sample`, an unknown sensor 404s and an out-of-range timeout 400s.
      **The bound is on Core Health**, as `queriesRefused` — the one number from this
      subsystem an operator needs on a graph, since `CLAUDE.md` requires backpressure to be
      visible and the alternative is people quietly retrying a button that keeps refusing. Not
      the in-flight count (zero except while somebody is looking) and not the answered/timed-out
      counters (the checks already say that). `P-22` had just been filed for exactly this
      omission in another subsystem, so making a second one would have been careless.

      Mutation 17/17, after two of the original nineteen were withdrawn rather than fixed: one
      targeted a branch that turned out to be dead code, and one modelled a defect that could not
      be reproduced. Two survivors on the first pass were real: an answered query was leaking
      its deadline timer, which later fired against an id nobody held and sent the probe a
      `query-cancel` for work it had finished; and the probe's "cancelled" set turned out to be
      a branch no mutation could reach, because forgetting the entry in `#waiting` is already the
      whole mechanism — deleted rather than tested around, which is the same call `D-01` made
      about a coercion that did nothing.

      **Still not built here:** the interface picker and the table-row picker the notes above
      wanted. Those are UI work on top of this — a second `ProbeQuery` kind each, which is what
      the union is shaped for — and neither sensor type is blocked on them.
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
- [x] **T-07 — SSH session layer** · M · P-05 · `ssh2` with key and password auth, connection
      reuse, host-key policy, command timeouts.

      **T-07 outcome.** `support/ssh/` mirrors `support/snmp/` deliberately — credentials,
      session, pool, schema and the shared `check.ts` preamble — because a second transport that
      is *shaped* differently is a second set of habits for whoever adds the third. `ssh2` is
      imported in exactly one file with a hand-written `ssh2.d.ts` beside it, on the same bargain
      ADR-001 Decision 6 made for `net-snmp`: replacing the library is a change to one file.

      **The host key policy is the part of SSH that is easy to get wrong quietly**, and it is
      where most of the thinking went. A client that accepts any host key authenticates the
      *server* not at all, so a password can be handed to whatever answered on port 22 while the
      check still goes green. Most tools default to accepting anything because the alternative
      needs somewhere to record what was trusted — and a probe has nowhere: the config channel is
      one-way (`R-09`), so a trust-on-first-use store on the probe would last until the next
      restart and differ between probes.

      **So the recording problem is solved with a person instead of a store.** The expected
      fingerprint is a field on the credential, and a strict check with nothing recorded yet
      **fails naming the fingerprint the server presented**. The operator compares it against the
      machine and pastes it in. That is trust-on-first-use *with* the verification step that makes
      it worth anything, it needs no write-back, and the failure message is the mechanism rather
      than an error. `accept-any` exists, and says so in every sensor message rather than once at
      configuration time — a standing decision to authenticate nothing should stay visible.
      Verified against real OpenSSH: `hostVerifier` runs during key exchange, so a host that
      fails its check never receives the password at all, and the test asserts the server saw no
      authentication attempt.

      **Connection reuse matters more here than for SNMP.** An SNMP session is a UDP socket; an
      SSH handshake is TCP, key exchange and authentication — hundreds of milliseconds and real
      CPU on both ends. Measured live against the dev target: five checks, one connection, four
      reuses. The one structural difference from the SNMP pool is that opening is *asynchronous*,
      which brings a problem that pool does not have — two sensors on a device coming due on the
      same tick would both find nothing cached and both start a handshake. An in-flight open is
      shared instead, so concurrent checks join one handshake rather than racing.

      A non-zero exit is a **result, not an error**: `df` returning 1 and a script reporting a
      problem are readings a sensor type interprets, and throwing would make every caller catch in
      order to read an exit code. Output is bounded and passing the bound **fails** rather than
      truncating — `T-08` parses this output, and half an answer parses into a number that is
      wrong rather than absent. Abort closes the *channel*, never the connection, since the
      connection belongs to every sensor on the device.

      The test harness is built on `ssh2.Server` rather than hand-written, and the reasoning
      differs from `T-01`'s on purpose: the SNMP agent is hand-written because the cases worth
      testing are things a well-behaved agent *will not do*, where every SSH case worth testing —
      refusing a password, presenting the wrong key, hanging, exiting non-zero — is something a
      correct server does. A hand-rolled SSH server would have to implement key exchange
      faithfully to be wrong about any of them.

      **Not done here:** no sensor type uses this yet — that is `T-08`. The pool duplicates the
      SNMP pool's lease counting and idle eviction; extracting the shared half was `P-24`,
      deliberately deferred until `T-09` makes it a third instance and the shape is actually
      known rather than guessed from two. `T-09` turned out not to be one, so it moved to v2 as
      `V2-17` on 2026-09-04, where its third caller — `V2-08` — actually lives.
- [x] **P-20 — `alarm-scheduler` sweep test is timing-flaky** · S · — · "counts what it did, for
      Core Health" in `packages/core/test/alarm-scheduler.test.ts` asserts a timer *fired* within a
      real wall-clock window. It passes 17/17 in isolation and fails about one run in ten inside
      the full suite, where the machine is busy — it read `{"sweeps":3,"fired":0,"wakes":1}`.
      **Added by `T-08`:** a test that fails under load and not alone is a test that will be
      re-run rather than read, and this one guards real behaviour. It wants an injected clock like
      the one `T-07`'s pool eviction test uses, not a longer timeout.

      **P-20 outcome: it was not a timing assertion, and it was not the test.** The ticket
      assumed a wall-clock window and prescribed an injected clock; the test actually polls with
      `until`, and the reading it reported — sweeps 3, **fired 0**, wakes 1 — was true. It was a
      counter bug in `AlarmScheduler.sweep`, and a busy machine is only what made the window wide
      enough to catch it.

      `sweep()` drains a backlog in rounds. Each round commits its own transaction, so the
      `notification_request` rows are visible the moment it returns — but `#fired` was accumulated
      across the loop and applied once at the end. Between those two points the requests exist and
      the number describing them says zero, **and the loop only continues when a round came back
      full**: the gap is widest during exactly the backlog those numbers are most worth reading
      during. Counting each round as it commits is a one-line move and the flake is gone at its
      cause rather than waited out.

      Now covered deterministically with no database and no clock: a fake engine reports one full
      round then an empty one and reads the counter *from inside the second round*, which is a
      moment that genuinely exists. Mutation 4/4, including the original bug re-introduced.
- [x] **P-22 — The alarm scheduler's stats reach nothing** · S · P-20 · `AlarmSchedulerStats`
      — sweeps, fired, wakes, idle wakes, `nextWakeAt` — is computed, exported from
      `notifications/index.ts` and read by no one. `P-12` gave Core Health the *delivery* side
      (`notifyPending`, `notifyOldest`, `notifyFailed`) and left the scheduler's own numbers
      behind, which is what the comment in `alarm-scheduler.test.ts` calls "P-12 is where these
      land". **Found by `P-20`:** it fixed a counter nothing was reading, which is a bug that gets
      to survive precisely because nothing reads it. Decide whether these are health (a channel
      each) or diagnostics (`/metrics` only) — `nextWakeAt` slipping into the past is the one
      that would tell an operator something is stuck.

      **P-22 outcome: two channels of the five numbers, and the other three stay internal.**
      `CLAUDE.md` asks a subsystem with a queue to add *a* metric, not all of them, and `sweeps`,
      `wakes` and `idleWakes` are debugging aids — they answer "what has this loop been doing",
      which nobody asks until they are already looking at a stack trace. The two that describe
      the *system* are on Core Health, and reach `/metrics` through the same read rather than
      being counted a second time (`N-13`'s rule, `P-14`'s wiring).

      **`alarmOverdue`, in seconds, rather than `nextWakeAt`.** A channel holds a number, and a
      timestamp would have to be read against the clock by whoever looked at it. It is **zero
      whenever the scheduler is asleep with a wake ahead of it, and zero when nothing is armed** —
      both of those are on time, and a gap for either would make the channel noisy when nothing is
      wrong, which is how a channel stops being looked at. Anything else is a sweep that should
      have happened and has not, climbing a second a second.

      This is the one number that catches the scheduler's actual failure mode, which is
      **silence**: it stops, no notification goes out, and every other channel on this sensor
      stays exactly as healthy as it was. So the message says it too.

      **`alarmsFired` is a counter**, so the counter path turns it into steps per minute — the
      shape an alarm storm has while it is happening. `M-17` is a scenario test for the same rule;
      this is it on a graph.

      Mutation 8/8, 6/8 on the first round: nothing asserted the counter *declarations*, on either
      the channel or the exported series. A monotonic number published as a gauge is not an error
      anywhere — `rate()` just returns something wrong — so both are now named explicitly rather
      than checked against whatever the declaration happens to say.
- [x] **P-21 — The performance suite must not run against a busy machine** · M · — · Four
      measured budgets — `tree-build-performance`, `ingestion-performance` (two of them) and
      `notification-timers` — pass in isolation and fail inside the full core suite, where 1,300
      tests and the same PostgreSQL are competing for the machine. **Added by `T-15`:** a suite
      that reports four failures on an ordinary run is a suite people stop reading, and these are
      the tests guarding the numbers `PLAN.md` quotes. A budget measured under contention is not
      a measurement of anything. They want their own runner — `npm run test:perf`, serial, with
      nothing else on the database — and the main suite should skip them unless asked, the way
      `P-15` will need for the 5,000-sensor benchmark. Related to `P-20`, which is the same
      disease in one timing assertion.

      **P-21 outcome.** `npm test` is the unit suites; `npm run test:perf` is the budgets, serial,
      in every workspace that has them. Half of this existed already — `@ms/core` had a
      `test:perf` script — and did nothing, because `test` was `test:perf && test:unit`: the perf
      tests ran on every ordinary run *and* a single missed budget short-circuited 1,850 unit
      tests that were never the problem. `@ms/probe` was worse and nobody had noticed: its glob
      was `dist/test/**`, so the 5,000-sensor benchmark and both soak tests ran inside `npm test`
      too, ninety seconds at a time.

      **The diagnosis was right and it was the suite, not the host.** The failure that prompted
      finishing this read `1000 rows/write p99 90.9 ms` against `5000 rows/write p99 90.2 ms` —
      all three batch sizes converged into one band and the comparison flipped. Re-run alone on
      the *same busy machine* (load average 7.7 on eight cores) it reads **40.0 ms against
      108.2 ms**, a 2.7x margin. What contends is 1,300 unit tests and the shared PostgreSQL, not
      whatever else the operator has open, which is why isolation fixes it and a longer timeout
      would not have.

      **CI runs the unit suites only, deliberately.** A two-core hosted runner cannot measure an
      eight-core budget: asserting one there either fails honestly for the wrong reason or gets
      loosened until it means nothing. The budgets are taken by hand on the reference machine and
      committed to `docs/findings/`, which is what `CLAUDE.md` asks for anyway.

      **The cost of that is a suite nothing runs automatically, so the wiring is asserted rather
      than assumed.** `build-hygiene.test.ts` — which does run on every push — fails if a package
      has perf tests and no `test:perf` script, or if a `test` glob starts descending into
      `perf/` again. That last one is a single character, and it is how the budgets get back into
      the ordinary run without anybody deciding to put them there.
- [x] **P-33 — `sizing.md`'s worker formula has no stability floor, and understates every
      example it gives** · M · H-08 · The published rule is
      `workers ≥ burst ÷ (1 + tolerance ÷ check duration)`, derived from the rounds model:
      `rounds = ceil(burst ÷ workers)`, `jitter ≈ (rounds − 1) × check`. It bounds the jitter of
      **one** burst and never asks whether that burst clears before the next one arrives a
      second later. When it does not, the backlog grows every second and the jitter the formula
      predicts is not the jitter you get — it is the jitter of the first burst only.

      The missing constraint is Little's law: **`workers ≥ burst × check duration`**, equivalently
      `rounds × check ≤ 1 s`. Below it the pool's service rate is under the arrival rate and the
      queue is unbounded, whatever tolerance was asked for.

      **Every worked example on the page is under its own floor**, at the v1 target's burst of
      83.3/s:

      | Check | Page says | Little's floor | Service rate at the page's number |
      | --- | --- | --- | --- |
      | 200 ms | 14 workers | **16.7** | 70/s against 83.3 arriving |
      | 600 ms (`icmp.ping` as it ships) | 31 | **50.0** | 52/s |
      | 2 s HTTP | 83 | **166.7** | 41/s |

      The 2-second row is the page's own "worked example that does not fit", and it still
      understates the answer by half. An operator who sized down to any of these numbers would
      watch the lag climb without ever hitting a refusal, because the queue absorbs it silently
      until it does not.

      **Measured, not derived**: `P-31`'s run put the shipped pool of 48 against 600 ms checks
      and got p50 **3,027 ms**, p95 **5,371 ms**, nothing refused — a median check three seconds
      late is a queue growing, not a percentile.

      The fix is the constraint, the worked examples redone from it, and a sentence saying which
      of the two bounds is binding — they swap over as the check gets slower. Check `docs/sizing.md`'s
      memory table against the corrected numbers too, since it is indexed by worker count.

      **Done, and the "which binds" question has a cleaner answer than the ticket assumed.** They
      do not swap over as the check gets slower — the latency bound overtakes the floor only when
      `check duration + tolerance` is under one second, which is the wheel's tick. At the
      system's own 1,000 ms budget that needs a check faster than zero, so **rule 1 always
      binds** for any sensor with a real network round trip. `sizing.md` now leads with the floor
      and keeps the rounds model for predicting the jitter you get once clear of it, rather than
      presenting them as two candidate sizing rules.

      **The floor is necessary and not sufficient, which the measurements say plainly:**

      | | Floor | Pool | Ratio | Predicted | Measured p95 |
      | --- | --- | --- | --- | --- | --- |
      | 200 ms checks, shipped pool | 16.7 | 48 | **2.9×** | 200 ms | 208–217 ms, five runs |
      | 3 s checks, 256 workers | 250 | 256 | **1.02×** | 0 ms | **2,427 ms** |

      At 2.9× the model is right to within 17 ms across five independent runs; at 1.02× it is
      wrong by 2.4 seconds, because worker start-up and ordinary variance are bigger than a 2%
      margin. **Where between those it becomes safe is not measured**, and the page says so
      rather than inventing a coefficient — the instruction is to clear the floor comfortably,
      not to meet it.

      **The corrected model predicts every point we have**, which the old one did not: five
      200 ms runs at 48 workers (predicts 200 ms, measured 208–217), the 600 ms case at 48
      (predicts unstable, measured a growing backlog), and the old 7-worker default (predicts
      unstable; measured 29.1 s rather than the 124 s of pure arithmetic, because the queue hit
      its bound and refused 3,484 checks — the cap is the queue, and that is worth knowing).

      Corrected in four places, not one: `sizing.md`'s rules, worked examples, memory table and
      the "start here" table's assumption; the `H-08` finding, in place with a dated correction
      rather than a rewrite; and the `H-08` summaries in `PLAN.md` and `TASKS.md`, which both
      repeated "83 workers where 5,000 pings need 14".

- [x] **P-32 — The shipped pool default cannot sustain the v1 target in the sensor type we
      ship** · M · P-07 · `defaultPoolSize()` is 48. 5,000 `icmp.ping` sensors on a 60-second
      interval is a burst of **83.3 a second**, and `P-07` measured a check at **600 ms**, so
      Little's law needs **50 workers** and 48 gives a service rate of 80/s against 83.3
      arriving. **The pool is 4% short of stable at the documented v1 target with the flagship
      sensor type.**

      **Measured** (`P-31`, 2026-09-03): p50 3,027 ms, p95 **5,371 ms**, p99 5,932 ms against
      `P-15`'s 1,000 ms budget, with **wait 5,366 ms of the 5,371** and **nothing refused**. The
      queue is not shedding, it is growing — which is why no counter says anything is wrong.

      **Both halves were already measured and never compared.** `P-07`'s own row says the v1
      requirement of 83/s "needs about 55 now"; `P-15` set the default at 48 against a 200 ms
      model, where the floor is 16.7 and 48 is three times what is needed. Each ticket was right
      about its own number. Nothing put 55 next to 48.

      Deliberately not fixed on the spot, because the answer is a judgement rather than an
      arithmetic correction. Raising the default costs every small installation memory it does
      not need — the reason `P-18` exists — and `P-26` has since made the pool track its load, so
      a higher *ceiling* may now be nearly free where it was not before. Candidates: raise the
      ceiling, derive it from the configured sensors and their types rather than fixing it, or
      leave it and document that 5,000 ping sensors want a bigger pool. Whichever it is, it needs
      the measurement, and `P-33` needs to land first because the guidance is what an operator
      would use to decide.

      **Raised to 64, from a sweep rather than from arithmetic**
      (`docs/findings/2026-09-03-pool-default.md`). Six ceilings at the real 600 ms check, 5,000
      sensors, 90 s a point:

      | Ceiling | Ratio to the floor of 50 | Tranches | Predicted | p50 | **p95** | RSS |
      | --- | --- | --- | --- | --- | --- | --- |
      | 48 | **0.96×** | — | **unstable** | 3,081 ms | **5,082 ms** | 656 MB |
      | 56 | 1.12× | 2 | 600 ms | 220 ms | 822 ms | 753 MB |
      | **64** | **1.28×** | 2 | 600 ms | 8 ms | **614 ms** | 851 MB |
      | 80 | 1.60× | 2 | 600 ms | 4 ms | 608 ms | 1,037 MB |
      | 96 | 1.92× | 1 | 0 ms | 4 ms | 7 ms | 1,215 MB |
      | 128 | 2.54× | 1 | 0 ms | 3 ms | 9 ms | 1,514 MB |

      **The floor is a cliff.** 48 → 56 is one eighth more workers and takes the p95 from 5,082 ms
      to 822. **Nothing was refused at any ceiling, 48 included** — the pool that cannot keep up
      does not shed and alarm, it accumulates, which is why a p50 of 3.0 s is the honest signal
      and no counter is.

      **64 because the margin is doing visible work.** 56 and 64 are both two tranches and
      `P-33`'s model predicts 600 ms for each; they measure 822 and 614, because at 1.12× the
      floor the queueing the model omits is still on top and by 1.28× it is gone. 64 sits 39%
      inside the budget. 96 buys the last 600 ms for 32 more workers — about 1.1 GB in a real
      probe — to improve a budget already met.

      **What it costs the workload it does not help**, because it is not a rounding error: a v1
      target probe with fast checks now holds 64 where it held 48, about **+560 MB** in a real
      probe, for no latency gain — 83 is two tranches against either. Demand-driven sizing
      (`P-18`) and load tracking (`P-26`) mean nothing below the v1 target pays it at all, but a
      large fast-check probe does.

      **The test that was missing is the deliverable, not the constant.** `check-pool.test.ts`
      had two tests on the default and neither could see this: one rejects deriving it from the
      core count, the other checks the tranche count — the bound `P-33` showed is necessary and
      not sufficient. The new one asserts Little's floor for `icmp.ping` at the v1 target, and
      the margin above it the sweep measured. Verified by putting 48 back: the new test fails and
      **both old ones still pass**, which is exactly how this shipped.

      **Not done here, and deliberately.** The honest ceiling is derived from the measured
      duration of the checks a probe is actually assigned. The system does not have that number —
      `costHint` is a three-value enum, not a duration, and mapping it to milliseconds would put
      a guess underneath Little's law, which is the mistake `P-33` was about. Filed as `P-34`.

- [x] **P-42 — The same mid-push read, one line up, and this one lost traps** · S · P-41 ·
      Found by asking what *else* read the assignment store per message, immediately after fixing
      `P-41`. The answer was directly above it: `onConfig` swept the trap listener's ring cursors
      with `assignments.ids()` on every message.

      **`retain` is hygiene given the settled set and data loss given a fraction of it.** It
      deletes the ring cursor of every sensor absent from the list it is handed, so mid-push that
      is every trap sensor outside chunk one. And the loss is *silent*, which is what makes this
      worse than `P-41`: a sensor whose cursor has been deleted is indistinguishable from one that
      has never drained, so `drain` registers it afresh at the current sequence and returns
      `items: []` with **`dropped: 0`**. The ring's own doc comment promises the opposite — "a
      cursor the ring has overtaken yields a drop count rather than a quietly shorter list" — and
      CLAUDE.md's rule is that backpressure is visible, never silent. An ordinary configuration
      push threw away buffered traps and told the sensor nothing had been missed. `P-41` cost
      workers destroyed and rebuilt; this cost the notifications a trap sensor exists to report.

      **And the syslog listener was never swept at all.** `T-20` extracted `NotificationRing`
      from the trap and syslog listeners on the grounds that the cursor arithmetic and the retain
      sweep are "byte-for-byte the same thing for traps and for syslog", gave both a `retain`,
      tested both, and wired one. `git log -S` finds no commit in the repository's history that
      ever called `syslogListener.retain` — so syslog cursors accumulated for the life of the
      process, one per sensor ever assigned. Fixing the trap sweep and leaving that would have
      repeated the original mistake in the same file.

      **Both now run on `P-41`'s settle**, renamed from `sizePoolWhenSettled` to `onConfigSettled`
      since it is no longer only about the pool. One subtlety worth naming: the old helper began
      `if (!autoSize) return`, so hanging the sweep off it unchanged would have quietly disabled
      cursor cleanup for every operator who set `workerPoolSize`. The guard now sits inside
      `sizePool`, which is whose business it is.

      **One limitation the debounce introduces, since it should not have to be re-derived**: a
      core pushing configuration more often than every two seconds, indefinitely, starves the
      settle. The sizer has a backstop — its own thirty-second timer calls `sizePool` directly —
      and the sweep does not. Left as is because the consequence is stale cursors rather than lost
      ones, the eager direction being the dangerous one; and because a config path that never
      quiets for two seconds is a larger problem than cursor hygiene.

      **Tested where it can be**, with the same limitation `P-41` recorded and for the same
      reason. Three cases drive a real `NotificationRing` off a real `AssignmentStore` through a
      chunked push: sweeping at the chunk boundary loses three traps buffered for sensor 150 and
      reports zero dropped; sweeping once the push has settled keeps all three; and a sensor
      genuinely absent from the *settled* set still loses its cursor, so the fix did not simply
      neuter the sweep. That is the policy pinned from both sides. What it cannot pin is the call
      site, because `main()` is a 500-line unexported bootstrap that nothing imports — `P-43`,
      **which has since been done**: the sweep moved to `core-handlers.ts`, and the mutant that
      reintroduces this exact bug now fails five of the eight tests there.

- [x] **P-41 — The pool sizer read a configuration that was still arriving** · S · P-34 ·
      `sizePool()` ran on every `config` message. `P-28` sends a full configuration as a
      `config-set` followed by deltas carrying the same version — because one message for five
      thousand sensors exceeded the frame bound and left the probe unable to reconnect at all —
      and `AssignmentStore` treats a set as **authoritative**. So between the first chunk and the
      last, the store legitimately holds a fraction of this probe's sensors, and the sizer read
      that fraction as the workload.

      **It bites where the ceiling is above the floor**, which is precisely the case `P-39`
      exists for. A probe whose checks take two seconds, holding a ceiling of 128, sees a chunked
      push of 5,047 sensors derive:

          after 1,000 applied ->  64
          after 2,000 applied ->  87
          after 3,000 applied -> 130
          after 5,047 applied -> 219

      Two readings of 64 clear `P-40`'s band and persist, so the ceiling drops to 64; `P-39` then
      sheds about sixty workers at once; and three chunks later the completed push asks for them
      back. At the v1 target with ping-shaped checks the floor of 64 masks it entirely, which is
      why it would not have shown up on the dev stack.

      **Coalesced rather than guarded.** Sizing after a push now waits two seconds from the last
      message, so it sees a complete picture — still far faster than the thirty-second timer,
      which is the whole reason the config hook exists. Guarding instead (say, ignoring a set
      smaller than the current set) would have been a rule about message shapes rather than about
      when an answer is ready, and would have got in the way of a genuine shrink.

      **Tested where it can be**, which is not `main.ts`: two cases on `AssignmentStore` prove the
      trap is real rather than theorised — that a chunked push holds only its first chunk until
      the deltas land, and that `poolDemand` over the store mid-push derives less than half what
      it derives once complete. The debounce itself is composition-root wiring; what is worth
      pinning is the fact that makes it necessary. **`P-43` has since closed that gap**: the
      handler now lives in `core-handlers.ts`, where a test asserts directly that a chunked push
      sizes nothing until it settles.

      Third in a chain from one change, and each was correct alone: `P-34` made the ceiling
      derived, `P-39` made it obeyed promptly, `P-40` damped the resulting thrash, and this is the
      input that fed it.

- [x] **P-40 — Shedding promptly made the ceiling worth thrashing** · S · P-39 · The other
      side of `P-39`, and it needed answering in the same breath. While a lowered ceiling decayed
      one worker a minute, a derived ceiling that wobbled cost almost nothing — the decay damped
      it. Shedding at once removes the damping, so the sizing loop's every twitch becomes workers
      destroyed and rebuilt.

      **Measured rather than imagined.** At the v1 target a ping duration of 600 ± 40 ms derives:

          560 ms -> 47.1 required -> ceiling 64
          600 ms -> 50.5 required -> ceiling 66
          640 ms -> 53.8 required -> ceiling 70
          660 ms -> 55.5 required -> ceiling 73

      Nine workers of movement, every thirty seconds, for a workload that has not changed at all.
      A worker costs about 35 MB and a registry import to replace.

      **Raise now, lower slowly**, and the asymmetry is the design. A pool that is too small is a
      probe falling behind and every second it waits is checks queueing, so upward moves are
      immediate. Downward ones must clear a deadband — 10% or four workers, whichever is larger,
      the constant floor mattering because 10% of a small ceiling is less than one worker — and
      then persist for two computations, about a minute at the loop's cadence.

      **The streak resets rather than decays**, which is the part worth stating: a network sitting
      just inside the band for an hour must not eventually trip a drop it never earned. Only a
      reading that leaves the band counts toward one, and any upward reading clears the count,
      because the workload has just said the low readings were not the trend.

      Pure, like `poolDemand` and `staleKeyAction`, so the policy is tested without a pool, a
      clock or a network. Six cases including the measured sawtooth replayed as data: the ceiling
      moves at most twice across twelve samples, where without the band it moves on most of them.
      Flattening the constants fails five of the six, so they are load-bearing rather than
      decorative.

- [x] **P-39 — A pool over its ceiling took three hours to obey it** · S · P-34 · An
      interaction between two changes, neither wrong alone. `P-26` set the shrink decay at **one
      worker per idle window**, which is right while the ceiling never moves: it decays a
      burst-sized pool gently and cannot thrash. `P-34` made the ceiling *derived*, so it moves —
      and `#considerShrink` never consulted `#maxSize` at all, only `minSize`.

      A pool above its ceiling is not merely larger than its current load; it is holding memory
      it has been **told it may not have**. At 35 MB a worker in a real probe:

      | Ceiling drop | Workers to shed | At one a minute | Held meanwhile |
      | --- | --- | --- | --- |
      | 256 → 64 | 192 | **3.2 h** | ~6.6 GB |
      | 128 → 64 | 64 | 1.1 h | ~2.2 GB |
      | 96 → 64 | 32 | 0.5 h | ~1.1 GB |

      Reachable rather than theoretical: `main.ts` derives within `[defaultPoolSize(), 256]`, so
      a probe whose slow checks recover — a device that came back, a network that stopped
      dropping packets — drops from a high ceiling to the floor and then sits on the memory for
      hours.

      **Fixed with a second pass that does not wait for the window.** Over the ceiling, every
      spare worker is retired until the pool is inside it; below the ceiling, the ordinary
      one-per-window decay is unchanged. The idle window is a thrash guard and a bound is not a
      hint. What the pass keeps is the only condition that was ever about safety — a worker must
      be **ready and holding no job** — because a ceiling change must never take a worker out of
      the middle of a check, which is `P-26`'s rule and the one that would corrupt a result.
      `setMaxSize` also runs it directly when lowering, so the effect is immediate rather than up
      to a window away.

      Three tests, and the first one's *setup* was the interesting part: with quick checks the
      burst drains before `#grow` catches up, the pool never reaches its ceiling, and the test
      passes without exercising anything. It uses 400 ms checks and asserts the pool reached 8
      first. A 60-second idle window means the ordinary decay cannot account for any of the
      shedding, so what is measured is the ceiling pass alone — it completes in 576 ms and fails
      at the 5 s timeout when the pass is removed. The other two hold the floor and the
      mid-check rule.

- [x] **P-38 — A probe holding a key the core has forgotten never tries the enrolment key** ·
      S · P-37 · The mirror image of `P-37`, and found while verifying its fix. There the core
      remembered a key the probe did not have; here the probe holds one the core has discarded,
      and the recovery an operator would reach for makes it worse.

      `core-client.ts` decides what to present in one line:

      ```
      accessKey: this.#identity.accessKey === '' ? config.core.accessKey : this.#identity.accessKey
      ```

      **The configured enrolment key is used only when the stored one is empty.** A probe with a
      stale key therefore presents it for ever. On the core side `#keyAccepted` sees
      `access_key_hash IS NULL` and accepts only the enrolment key — so the handshake is refused,
      no key is issued, and the loop is permanent.

      **The core forgets a key in ordinary circumstances**: re-approving a probe clears the hash
      (deliberately — a key that leaked before a revocation must not survive), revoking clears
      it, and a restored backup or a rebuilt core predates the issuance. So the trap is easy to
      walk into: an operator whose probe will not connect **re-approves it**, which is the
      documented remedy and the obvious thing to try, and that clears the core's hash while the
      probe keeps presenting its old key. The probe is now less recoverable than before they
      helped.

      Recovery today is deleting `identity.json` on the probe's own disk — which for a remote
      probe means logging into that machine, the exact thing enrolment exists to avoid.

      **The fix belongs on the probe.** On a `bad-access-key` refusal, a probe holding a stored
      key that differs from its configured enrolment key should discard the stored one and retry
      once with the configured key. That is safe: the enrolment key is a credential an operator
      put in the config, and `P-37`'s change means the core will then issue a fresh key and only
      close the fallback once the probe has used it.

      **Not on the core, and it is worth saying why.** Accepting an unknown key for an approved
      GID because the core has no hash would let anyone who can reach the port claim an approved
      probe's identity by presenting anything at all. The probe proving it holds the enrolment
      key is the whole point.

      Needs: the retry, a log line that names the situation rather than repeating
      `bad-access-key` forever, and a test that stores a key the core does not know and asserts
      the probe recovers without anyone touching its disk. A probe with no enrolment key
      configured genuinely cannot recover by itself — that case should say so once, clearly,
      instead of looping in silence.

      **Fixed on the probe.** A `bad-access-key` refusal now drops a stored key the core does not
      know and presents the configured enrolment key on the next handshake; `P-37`'s change then
      has the core issue a fresh one and close the fallback only once the probe has used it. So
      the two tickets compose: one made the core forgiving about a key it had written down, the
      other makes the probe stop insisting on a key nobody remembers.

      **Once per stale key, not once per reconnect**, and reset by a successful handshake rather
      than by a timer. A core that has genuinely revoked a probe refuses the enrolment key too,
      and retrying it every few seconds would be a machine arguing with a decision somebody made
      on purpose. Resetting on success matters because the core can forget a key more than once —
      a second re-approval, a second restored backup.

      **The decision is a pure function**, `staleKeyAction`, because the doing needs a live core
      and the deciding needs none — the same split as `P-34`'s `poolDemand`. The probe endpoint's
      tests drive a stub rather than a real `CoreClient`, so wiring the branch into the client and
      calling it tested would have tested nothing. Six cases, one per outcome, and the outcomes
      are separate names on purpose: "already presenting the configured key" and "no enrolment key
      configured" are different situations an operator would look for in different places, and a
      probe that loops in silence is the failure being replaced.

      **The case a probe cannot fix by itself now says so once** — a stored key the core rejects
      with no enrolment key to fall back on needs a human, and it logs what to do rather than
      repeating `bad-access-key` for ever.

- [x] **P-37 — A probe can be locked out for ever by one dropped welcome** · M · R-01 ·
      `ProbeRegistry` issues an approved probe a key of its own, and **stores the hash before the
      probe can possibly have it**:

      ```
      const issuedKey = randomBytes(32).toString('base64url');
      await UPDATE probe_registration SET access_key_hash = $2 WHERE gid = $1   // rotated here
      return { kind: 'approved', ..., issuedKey };                              // delivered after
      ```

      There is no acknowledgement. The probe writes the key to `identity.json` on receiving the
      welcome, and if anything comes between the database write and that disk write — the link
      dropping, the probe being killed, a read-only spool directory, the process losing power —
      the core has rotated the key and the probe has not. **The next handshake then takes the
      `hasOwnKey === true` path and is refused for ever.** The comment above it says "it happens
      exactly once", which is the assumption: it happens exactly once whether or not it worked.

      **The recovery is re-approval**, which needs a human in the UI. A probe in this state
      reconnects, is refused, backs off and reconnects again — indefinitely, and the only signal
      is `bad-access-key` in the log. **This is `P-28`'s shape exactly**: a probe that can never
      reconnect, looping, where nothing downstream says why.

      **Observed on the dev stack, 2026-09-03** — and observation and mechanism are separate here,
      so both are written down:

      - The stored hash is **not** the hash of the key the probe holds. `hashKey` is an unsalted
        `sha256`, so this is decisive: they genuinely diverged.
      - `decided_at` is unchanged since 2026-08-27, so neither `approve` nor `revoke` did it —
        those are the only other writers and both set it.
      - The probe's `identity.json` has not been written since the day it was approved.
      - 384 reconnect attempts, refused every time, with the core's `requireAccessKey: true`.

      **What is not proven is that the lockout arose this way.** The evidence fits and nothing
      else in the code can rotate that column without touching `decided_at`, but the moment
      itself was not captured — the dev stack was restarted several times by concurrent work on
      this machine. The mechanism above stands on reading the code, and it is a defect whether or
      not it is what happened here.

      Shapes a fix could take, cheapest first: **accept the previous key for a grace period**
      after issuing a new one, so a lost welcome costs a reconnect rather than the probe;
      **do not rotate until the probe presents the new key**, keeping the old hash until the
      first successful handshake with the new one; or **acknowledge** — the probe confirms it has
      persisted before the core commits. The first is the smallest and handles the case that
      actually happens. Whichever, it needs a test that kills the link between the database write
      and the probe's disk write, because that is the window and it is currently untested.

      Worth checking at the same time: what the probe does when `writeIdentity` fails. It logs,
      but a probe that could not persist a key it was issued is in the same trap and should
      probably refuse to continue rather than carry on with a key the core has already discarded.

      **Fixed by closing the fallback on first *use* rather than on the write.** Migration 039
      adds `access_key_confirmed_at`, and `hasOwnKey` now means "this probe has used a key of its
      own" instead of "a hash exists". Unconfirmed, the enrolment key is still accepted and a
      fresh key is issued, so a lost welcome costs one reconnect. Confirmed, only the issued key
      works — which is the property the shared enrolment key must not weaken, and it is why the
      window is bounded by use rather than by a clock: a probe switched off for a month is not
      less entitled to its key than one switched off for a minute.

      **Existing rows are backfilled as confirmed**, deliberately. A probe already carrying a
      hash has been authenticating with it — there has been no other way to stay connected — so
      marking the estate unconfirmed on upgrade would reopen the enrolment fallback everywhere to
      fix a liveness bug, which is a bad trade. A probe genuinely stuck is stuck already, and
      re-approval clears the hash and takes the new path.

      **A real ordering bug in the first version of the fix, caught by the new test.** `existing`
      is read *before* the key is checked, so deciding whether to issue from `existing.hasOwnKey`
      handed a second key to the probe that had just proved it held the first — the confirmation
      had happened, the snapshot predated it. `#keyAccepted` now returns which key was accepted,
      `'own' | 'enrolment' | 'no'`, and issuance keys off that. The stale snapshot was the same
      class of mistake as the bug being fixed: a fact read at one moment and trusted at another.

      **One existing test asserted the old meaning** — `hasOwnKey` true the instant a key was
      issued — and was changed deliberately with the reason written beside it, not incidentally.

      Two new tests: a probe that never received its welcome comes back on the enrolment key, is
      admitted, and is issued a *fresh* key; and once it has used one, the enrolment key is
      refused. The first fails when the fallback is removed, which is the check that it is doing
      the work. Migration rollback is exercised by the migrator's own "rolls back the most recent
      migration", 039 now being the most recent.

      **The `writeIdentity` question closed itself, and reading it was worth the trip.** That
      catch has always said "Not fatal: the probe works for as long as it stays up, and re-enrols
      if it restarts" — a promise this defect had quietly falsified, since a restart presented the
      enrolment key and was refused for ever. The trade the comment describes, losing the identity
      rather than losing the link over a read-only directory, silently stopped being the trade
      being made. Closing the fallback on first use restores exactly the property it claimed, so
      there is nothing further to change: carrying on is right *because* the enrolment key still
      works until a probe has used one of its own. `identity.ts` now names that dependency, so
      whoever changes the fallback next finds out that this catch rests on it.

      **`approve` and `revoke` clear the confirmation too**, found by tracing the recovery path
      rather than by a test failing. Both already cleared `access_key_hash`; leaving
      `access_key_confirmed_at` set left a row saying "no key, but confirmed", which cannot be
      true. It is harmless today only because `stored === null` is checked first, and that is
      exactly the kind of harmless that stops being harmless when somebody reorders the checks.

      **Verified as far as a shared machine allowed.** Migration 039 applied on the dev stack and
      the backfill did what it was designed to: the existing probe came back `confirmed`, so the
      enrolment fallback stayed shut and it remained locked out — correct, and the reason the
      backfill is not a security regression. Resetting it to pending and re-approving cleared
      hash and confirmation together, as intended. The last step — the handshake that issues a
      key and the one after it that confirms — was not observed at the time, because another
      session began approving probes through the UI in the same stack while it was in flight, and
      interfering with that would have been worse than leaving the check to the unit tests.

      **Observed live on 2026-09-04** (`findings/2026-09-04-live-probe-check.md`), both halves, and
      the stack happened to be in the state that exercises the recovery path too. The core issued a
      key (`issued this probe a key of its own`), the probe stored it, and the database then held
      `access_key_hash` set with `access_key_confirmed_at` **null** — the exact state this ticket
      added the column to represent. On the next connection the core logged `this probe used the
      key it was issued` and stamped the confirmation. No re-issue, no enrolment fallback.

      A second lockout path was noticed while doing this and was not fixed here: a probe holding a
      key the core has since forgotten presents that stale key rather than the enrolment key, so
      re-approval alone does not recover it. **`P-38` fixed it**, and the same live run shows the
      two composing exactly as `P-38` said they would — the probe logged `the core does not know
      the key this probe holds; falling back to the enrolment key`, and this ticket's change then
      issued a fresh one.

- [x] **P-36 — The session pools count backpressure and nobody ever reads it** · M · P-24 ·
      `SnmpSessionPool` and `SshSessionPool` maintain `sessions`/`connections`, `inUse`,
      `acquired`, `reused`, `opened`, `closed`, `evicted` and `overflowed` — and **`stats()` is
      called by nothing outside their own tests**. Both are re-exported from their `index.ts` and
      no consumer exists.

      **The code says otherwise, in as many words.** `snmp/pool.ts` on `maxSessions`:

      > Passing the bound closes the least-recently-used idle session to make room, and if every
      > session is in use it opens one anyway and counts it — refusing would fail a check to
      > protect a file-descriptor budget, which is the wrong trade. **`overflowed` in the stats
      > is what makes that visible rather than silent (CLAUDE.md).**

      It is not visible. It is computed and discarded. The trade described there is the right
      one — opening past the bound beats failing a check — but it is only defensible *because*
      somebody can see it happen, and nobody can.

      Two `CLAUDE.md` rules say this should exist: **"Backpressure is visible, never silent"**,
      and **"The system monitors itself. Any new subsystem with a queue, a pool or a connection
      adds a metric to one of them."** A pool with a bound, an eviction policy and an overflow
      counter is exactly that subsystem, twice over.

      What an operator loses today: no way to see that an SNMP session is being opened and
      closed for every check because `idleMs` is too short for their interval; no way to see a
      device holding sessions open; and no signal at all when the file-descriptor bound is being
      passed, which is the one that ends in `EMFILE` on a busy probe.

      Scope: the counters cross a process boundary — the pools live in `@ms/sensors`, inside the
      probe's **worker threads**, and Probe Health is assembled in the probe's main thread from
      `health/report.ts`. So this is not a channel declaration, it is a way for workers to report
      pool counters back with their results, then an aggregation. `P-27` is the pattern for the
      channel end (declared limits per `S-18`, protocol bump because the health schema is
      `additionalProperties: false`); the worker→main path is the new part and is why this is
      `M` rather than `S`.

      **Three channels on `ms.probe.health`, and the path they came down is the interesting
      part.** `sessionOverflows` carries the threshold — `upperError: 0.5`, the `spoolDropped`
      style, because this is not a matter of degree; `sessionsOpen` and `sessionsEvicted` carry
      none, since how many sessions a probe should hold is a property of its catalogue and
      alarming on it would be noise. Eviction is the diagnostic half: climbing in step with
      sessions opened is an `idleMs` shorter than the scan interval, so every check pays a
      handshake it need not.

      **The counters ride back on the result message.** The pools are module singletons *inside
      each worker thread*, so there is no one pool to ask — the probe's real figure is a sum over
      workers. A worker attaches its four integers to a result it was already sending, which
      needs no second channel between the thread and the pool and costs nothing on an idle
      worker, whose counters cannot have changed.

      **Through the registry rather than by importing the pools**, which is the design point.
      `check-worker.ts` loads its registry *by path* precisely so it never depends on
      `@ms/sensors` — that is what lets a test drive the pool with checks that hang and crash on
      purpose. So `CheckRegistry` gained an optional `sessionCounters()`, the catalogue registry
      implements it, and a fixture registry does not: **a build with no pools reports nothing and
      the channels gap**, rather than publishing a confident zero.

      **A retired worker's counters are banked, or the totals would go backwards.** The published
      figure sums live workers, so shrinking the pool would lower a cumulative counter — and a
      counter that falls is one nobody can put a trigger on. `open` is deliberately excluded from
      the baseline: it is a gauge and is meant to fall.

      **Protocol 9 → 10**, required by `additionalProperties: false` on the health schema exactly
      as `P-27`'s bump was; an older probe omits the fields and the channels gap.

      **The test that nearly did not earn its keep.** "Never lets a cumulative counter fall"
      passed with the banking removed, and the reason was worth finding: the pool starts at its
      floor and grows, so a burst of three checks finished on two workers while the third was
      still spawning, and the worker being retired had never reported. Retiring a worker with no
      counters loses nothing. It now drives checks until all three workers have reported —
      asserted, `open === 6` — before shrinking, and fails as it should when the banking goes.

      Live on the dev stack: **`sessionsOpen: 5`**, overflows and evictions zero, on a probe
      where that number was computed and discarded before today.

      **Amended: the gap claim was asserted in a commit message before it was asserted in a
      test.** "An older probe omits the fields and the channels gap" is the `R-06` rule and the
      reason the protocol bump is a bump; `P-27` proved exactly that for `spoolStalled` and this
      shipped without the equivalent. Three tests now cover the trip — the counters reaching
      their channels, the **absence staying an absence**, and zero overflows reading as zero,
      because a probe inside its bound has said something and it is the healthy answer. Proved
      to bite by changing one `?? null` to `?? 0`, which is the mistake that would actually be
      made.

- [x] **P-35 — A measured number is copied into four files and nothing notices when it
      changes** · M · P-31 · **Four defects in one day, all the same shape.** Each came from a
      correct measurement that a later, equally correct measurement silently invalidated:

      | | The number | Invalidated by | Found |
      | --- | --- | --- | --- |
      | `P-31` | the benchmark's `checkMs: 3_000` for `icmp.ping` | `P-07` measuring 600 ms, three days later | a week later, by reading a comment |
      | `P-32` | `defaultPoolSize()` = 48, chosen against a 200 ms model | the same `P-07` — whose own `PLAN.md` entry said the ping case "wants about 55 rather than 48" and called it "a tuning note, not a defect" | by `P-31`'s corrected run, five weeks later |
      | `P-33` | `sizing.md`'s worker rule, missing Little's floor | nothing; it was incomplete from the start and every example was under its own floor | by `P-32`'s arithmetic |
      | — | `PLAN.md`'s Phase 1 exit criterion, "measured at **21.0 seconds**" | Phase 3's `M-02` and `M-08`, which took it to 28.8 | while checking something else |

      **Nobody was careless.** `P-07` measured a ping and wrote its number down; `P-15` sized a
      pool against the model it had; `H-08` published a rule that fitted all fifteen of its own
      points. Every one was right in its own file. The defect is that a measurement is *copied*
      into the places that depend on it — a benchmark constant, a default, a worked example, a
      plan's exit criterion — and nothing relates the copies back to the source.

      **What it cost**: a shipped pool default that could not sustain the documented v1 target in
      the flagship sensor type, and would not have refused a single check while failing to.

      The fix is not review discipline, it is a source of truth. Candidates, cheapest first:

      - **One module of measured constants** — `ICMP_CHECK_MS`, the v1 target's sensor count and
        interval, the dispatch budget — imported by the benchmarks, the pool default's own test
        and the sizing scripts, each naming the finding it came from. A number then changes in
        one place, and everything that derives from it moves or fails to compile.
      - **Assert the derived relationships, not just the values.** `P-32`'s new test is the
        pattern: it does not check that the default is 64, it checks that the default clears
        Little's floor for the type we ship. That kind of test survives both numbers changing.
      - **A check that the prose agrees with the code.** `docs/sensor-reference.md` and
        `api-reference.md` are already generated and fail the build when they drift (`H-07`);
        `sizing.md`'s worked examples are arithmetic over constants and could be too.

      Scope it to the numbers that have already bitten rather than every figure in `docs/` — the
      goal is that the next `P-07` cannot land without the four places that depend on it moving
      or breaking.

      **`packages/probe/src/measured.ts`, and the goal is met literally.** Raising
      `ICMP_PING_CHECK_MS` from 600 to 900 in that one file fails
      `keeps up with the v1 target in the sensor type we ship` immediately — at 900 ms the floor
      is `84.1 × 0.9 = 75.7` and the default of 64 is under it. That is the exact scenario that
      played out silently over a week the first time.

      Six literals across five files became imports:

      | Was | Where |
      | --- | --- |
      | `600` / `0.6` under three names | `main.ts`, `scheduler-benchmark.test.ts`, `check-pool.test.ts` |
      | `5_000` / `60` / `5_000 / 60` | those two tests plus `timing-wheel.test.ts` and `reconnect-soak.test.ts` |
      | `1_000` dispatch budget, `200` model check, `1.3` margin | the benchmark and `main.ts` |

      **What is deliberately *not* collapsed**: `MODEL_CHECK_MS` (200) stays a separate constant
      from `ICMP_PING_CHECK_MS` (600). They are numerically unrelated and conceptually adjacent,
      which is precisely the confusion `P-31` was — a benchmark that thought its model was the
      shipped type. Two names, two doc comments, each naming its own finding.

      **`littleFloor(burst, checkMs)` is a function, not a constant**, and that is the second
      half of the idea. The bound `sizing.md` was missing is a *relationship* between two
      measurements, and a relationship survives both of them changing — the same reason `P-32`'s
      test asserts the default clears the floor rather than that it equals 64.

      Left for whoever wants it: the prose. `sizing.md`'s worked examples are still arithmetic
      typed by hand, and `H-07` already shows the shape of the fix — `sensor-reference.md` and
      `api-reference.md` are generated and fail the build when they drift. That is a bigger job
      than this ticket and it is not what bit us; the numbers the *code* depends on are now in
      one place, which is where all four defects came from.

- [x] **P-34 — The pool ceiling should come from the checks assigned, not from one constant** ·
      L · P-32 · `defaultPoolSize()` is one number for every workload, and `P-32` showed what
      that costs at both ends: 48 was below the floor for a probe watching `icmp.ping`, and 64 is
      about 560 MB more than a probe watching fast checks needs at the same sensor count. One
      constant cannot be right for both, because the floor is `burst × check duration` and the
      probe's own catalogue decides the second term.

      **The probe already knows the first term and not the second.** It knows every assignment
      and its interval, so `burst` is exact. What it lacks is a duration: `costHint` is
      `light | medium | heavy`, and turning that into milliseconds is a guess of exactly the kind
      `P-33` was filed about.

      Two ways to get a real number, and the second is probably right: declare a measured typical
      duration on the `SensorType` contract beside `costHint`, which puts the burden on whoever
      adds a type and is a lie the moment a network is slow; or **measure it** — the probe
      already times every check, so a rolling per-type p50 over recent results is a number the
      system owns rather than one it was told. That also handles the case neither constant can:
      an `http.get` against a slow endpoint is genuinely heavier than the same type against a
      fast one.

      Whichever, the ceiling stays a ceiling — a bound on memory, not an allocation — and the
      floor becomes something the probe recomputes as assignments change. Needs a scenario test
      for the case that would hurt: a probe whose checks get slower must raise its ceiling before
      the backlog grows, not after, and `WORKFLOW.MD`'s backpressure rule says the change must be
      visible on Probe Health rather than silent.

      **Measured, which was the choice between the two routes.** The probe times every check it
      runs, so `CheckPool` now keeps a bounded window of recent durations **per sensor type** and
      reports their median. Per type because that is the whole point — an `icmp.ping` at 600 ms
      and an `snmp.traffic` at 40 ms make a pooled median describing neither. The median rather
      than the mean because a check that ran to its timeout is in the window too, and one
      30-second timeout would size the pool for a workload that does not exist.

      **The arithmetic is a pure function**, `poolDemand` in `runner/demand.ts`:
      `Σ (duration ÷ interval)` over the assignments, times a 1.3 margin, clamped. Pure so it is
      table-tested without a pool, a wheel or a clock — nine cases including a mixed catalogue
      (which must *add*, not take the worst type), an unmeasured type, and an assignment whose
      interval is zero, which would otherwise make the ceiling `Infinity`.

      **`workerPoolSize: 0` now means "derive it", and any non-zero value is untouched.** That
      distinction already existed in the schema — 0 meant "use the default" — so no setting
      changed meaning for anyone who had configured one. Setting it is a statement about how much
      memory the probe may use, and a derived number must not overrule it.

      **Live, on the dev stack's 5,047 sensors, it does exactly what it should:**

          config push, nothing measured yet   64 -> 65 -> 66
          thirty seconds later, port.tcp timed   66 -> 64

      84.1 a second against the 600 ms assumption is 50.5 required, ×1.3 = 66. Once real
      `port.tcp` durations replaced the assumption the demand collapsed and the floor took over.
      **Assume, measure, correct** — and the assumption is deliberately the shipped check
      duration rather than the smallest plausible one, because guessing low here reproduces
      `P-32`.

      **On the backpressure clause, a judgement worth recording rather than burying.** The
      heartbeat carries held workers, not the ceiling, so publishing the derived number would
      cost a protocol bump. It is not needed for the signal the rule is about: the failure this
      change can introduce is the 256-worker cap binding, and a bound pool saturates, which
      raises `poolUsage` — already on Probe Health with declared limits at 80% and 95% from
      `S-18`, already the channel an operator has a trigger on. What the cap adds is a `warn` log
      naming the number that was refused, so the log says what to do. **The derived ceiling itself
      is informational and is not published**; if it turns out an operator wants to graph it,
      that is a channel and a protocol bump on its own terms.

      Fourteen tests: nine on the arithmetic, five on the pool — that it learns per type, that a
      median resists one outlier, that raising the ceiling allocates nothing by itself, that
      **lowering it never takes a worker out of a running check** (`P-26`'s rule, and the one
      that would corrupt results if it were wrong), and that it will not go under a configured
      floor.

      **Amended later the same day: those fourteen tested the parts and not the loop.** This
      ticket asked for a scenario test — "a probe whose checks get slower must raise its ceiling
      before the backlog grows, not after" — and it was ticked without one. Every component was
      covered and nothing proved they compose, which is the only claim an operator experiences.

      Two now do, on the same sensor type throughout, because that is the real case: an
      `http.get` against an endpoint that degrades is not a new type, it is the same one costing
      more.

      - **`raises its ceiling from what it measured, before the backlog grows`** — 3,000 sensors
        a minute apart is 50 checks a second; at 20 ms the floor is under the minimum and the
        ceiling stays at 4, and when the same checks start taking 400 ms the derived ceiling goes
        to 26. **The "before" clause is asserted rather than asserted-about**: `deferred` and
        `refused` are 0 and the queue is empty at the moment it moves, because the estimate comes
        from checks that have already finished, so a dozen of them is enough. Nothing had to
        queue up for the probe to find out.
      - **`gives the room back when the network recovers`** — the other direction, and the reason
        the ceiling is derived rather than latched: a probe that grew for one bad afternoon must
        not hold the memory for ever.

      Proved to bite by making `typicalDurationMs` always return `undefined` — a probe that can
      never learn. **Four tests fail**, including both of these; the fourteen that tested the
      parts did not all notice.

      Also fixed in passing: the schema's own comment for `workerPoolSize` still described the
      four-per-core default that `P-15` disproved.

- [x] **P-31 — The scheduler benchmark's `icmp.ping` case models a check we stopped
      shipping** · S · P-07 · The case is named "shows what the sensor type we actually ship
      would need" and ran `checkMs: 3_000`, because `ping` idles a second between packets and
      four packets is three seconds. That was true on **2026-08-26**, when it was written. On
      **2026-08-29** `P-07` passed `-i 0.2` and turned a three-second check into a
      six-hundred-millisecond one with identical reply counts
      (`docs/findings/2026-08-29-icmp-throughput.md`). The case kept the old number and the old
      claim for a week.

      **The arithmetic inverts, which is why it matters**: 83.3 a second at 3 s is 250 in flight
      and needs a pool nobody would configure; at 600 ms it is **50**, which is a pool an
      operator very nearly has. A case asking for 256 workers reads as a curiosity about a
      workload no one runs. The same case at 600 ms reads as a question about the default —
      and `P-32` is the answer it gives.

      **Split rather than retuned.** "As it ships" runs the real 600 ms check against
      `defaultPoolSize()`, which is the question an operator with 5,000 ping sensors has;
      "before `P-07`" keeps the 3-second, 256-worker run as the counter-example that makes the
      first row mean something, and as the shape any genuinely slow sensor type still walks into.
      `P-30`'s memory guard stays on the second one, where it belongs.

      It also means the `icmp.ping-shaped` row this morning's finding reported as *"the sensor
      type we actually ship, missing the budget by 2.3×"* was the pre-`P-07` check mislabelled.
      Corrected in `docs/findings/2026-09-03-perf-budgets.md` rather than quietly dropped.

- [x] **P-30 — `test:perf`'s last scheduler case is OOM-killed, so the whole file fails** · S ·
      P-15 · `scheduler-benchmark.test.ts`'s final case — "shows what the sensor type we actually
      ship would need" — asks for **256 workers at 3-second checks for 90 seconds**, and on a
      machine with less than about 3 GB free the process is **SIGKILLed** part-way through.
      `node:test` then reports the *file* as failed with the bare message `'test failed'` and no
      diagnostic, because the child died rather than asserting. Every test inside it passed.

      **Measured 2026-09-03** (`docs/findings/2026-09-03-perf-budgets.md`): peak RSS
      **2,636,592 kB (2.57 GB)**, killed at **84 s of the 90 s run** with **2,643 MB
      available** in the Docker VM. Run inside the whole file it dies
      sooner, because three 90-second soaks have already run in the same process. `NODE_EXIT=137`
      is the whole diagnosis — 128 + SIGKILL.

      **Not caused by `P-26`**, checked rather than assumed: the pre-`P-26` `pool.ts` was compiled
      back in (`busySince=4, idleSince=0` in the emitted JS, so the right code really was running)
      and it is killed identically. This is how the case has always been on a machine this size.

      Two things are wrong and they are worth separating. **The case costs 2.6 GB to assert
      `completed > 0`** — it models a probe watching 5,000 `icmp.ping` sensors, which
      `2026-08-26-scheduler-benchmark.md` says plainly nobody runs, and whose diagnostic value is
      already written down in that finding. **And a SIGKILL is indistinguishable from a real
      failure** in the output, which is exactly the "four false failures teach everyone to stop
      reading the output" problem `CLAUDE.md` separates `test:perf` from `npm test` to avoid.

      Whoever picks it up decides which: skip the case unless a memory floor is present (the
      pattern `MS_BENCH_SWEEP` already uses in the same file), shorten it, or declare the
      requirement and fail with a sentence rather than a signal. Do not just raise Docker's memory
      — that fixes one laptop and leaves the next one with a silent kill.

      **Declared and checked, which is the first of those.** The case now reads `MemAvailable`
      before it runs and skips with a sentence naming what it needs and what the machine has.
      `os.freemem()` was not good enough to decide it — that is `MemFree` on Linux, which
      excludes reclaimable page cache and understates the answer by gigabytes on a machine that
      has been working; `/proc/meminfo`'s `MemAvailable` is the kernel's own estimate of what an
      allocation would actually get, with `freemem()` kept as the fallback where there is no
      Linux `/proc`.

      **Both branches verified, on the same command that used to be killed:**

      | Available | Result |
      | --- | --- |
      | 3,005 MB (dev stack up) | skipped, **exit 0**, reason printed — this command gave `NODE_EXIT=137` before |
      | 4,262 MB (stack stopped) | ran to completion, exit 0 |

      **The threshold is bracketed by measurement rather than picked.** Killed with 2,643 MB
      available; ran with 4,262 MB at a peak RSS of **2,801 MB**. The floor sits at 4,000 MB,
      between the two and on the safe side, because the asymmetry is not close: erring high costs
      a skip that says why, erring low costs every other result in the file.

      Worth correcting from the ticket above: the 2,575 MB it quotes was a **truncated** peak,
      read from a run that was killed at 84 s. A run that finishes peaks at 2,801 MB.

      **And the case has now actually run, for the first time.** It had never completed on this
      hardware, so its own subject was unmeasured — `2026-08-26-scheduler-benchmark.md` predicted
      it from arithmetic and nothing had checked:

          icmp.ping-shaped  3000 ms check  pool 256
            jitter p50 603 ms  p95 2333 ms  p99 2371 ms
            (wheel p95 18 ms, wait p95 2325 ms)   7,876/7,876 checks, 0 refused

      **The `icmp.ping`-shaped load misses `P-15`'s 1,000 ms budget by 2.3×** — 3.8× when run
      alone on a cold process — and essentially all of it is *wait*, 2,325 ms of 2,333. The pool
      is the constraint and the wheel is not, at 256 workers. That is the arithmetic in
      `2026-08-26`'s "What this says about `icmp.ping`" confirmed rather than assumed, and it is
      why `P-07` made the check itself cheaper instead of making the pool bigger.

      **Whole file, end to end:** 7 tests, 6 pass, 0 fail, 1 skipped (the opt-in sweep),
      `NODE_EXIT=0` — and the `after` hook's table printed, which is the thing the kill used to
      destroy along with the four `P-15` results that had already passed.

- [x] **P-29 — The serial tree build is over Phase 1's 30-second budget** · M · S-16 · Phase 1's
      exit criterion is **5,000 objects through the API in under 30 seconds**, and
      `tree-build-performance.test.ts` now fails it. Three runs on 2026-09-03 with `ms-server`
      stopped: **31.5 s, 33.0 s, 35.4 s** — −5%, −10% and −18% against the budget
      (`docs/findings/2026-09-03-perf-budgets.md`).

      **The dev database's size is not the cause**, which was the first suspect and was checked:
      the `monitoring` database has grown to 4,958 MB since the soak, so the run was repeated
      against a **fresh empty TimescaleDB container** and came out **worst of the three at
      35.4 s**. Whatever this is, it is not the working set.

      **The cost is per request, not per object**, which narrows it: the same 5,000 objects in
      *one* request (`P-19`'s bulk path) took 2.6–3.0 s against a 2.8 s baseline — unchanged —
      while the serial path went 21.0 → 23.7 → 28.8 → 31.5–35.4 s across the recorded history
      (`2026-08-25-tree-build-measurement.md`, `2026-08-29-bulk-tree-create.md`). Eight in flight
      moved too, 5.9 → 7.9–11.1 s. So the extra is in what a *request* costs — socket, routing,
      validation, serialisation — not in what a create costs.

      **Read the number with its caveat.** Only two commits have touched the create path since
      the 28.8 s measurement (`H-07`, `S-18`), neither plausibly per-request, and the host these
      three runs were taken on carried other projects' containers throughout at a load average of
      about 9 on 8 cores. A per-request cost is the most CPU-contention-sensitive thing in the
      test. **So the first step is to re-measure on a genuinely idle host**, and only then to go
      looking — a 12% spread across three runs is not a machine that can adjudicate a 5% miss.

      If it is real, `2026-08-29-bulk-tree-create.md` already says where to look: the serial path
      pays per-request costs 5,000 times, and the bulk route exists because that is the wrong
      shape for a client to use. If it is not real, the ticket is still worth its keep for saying
      so with numbers.

      **It was not a regression, and the profile said what it was instead.** A `--cpu-prof` run
      came out at **28.7 s — the fastest of the lot, with the profiler attached** — against the
      **28.8 s** recorded on 2026-08-29. Nothing had got slower since. What the profile showed is
      that the process is **63.6% idle**: the serial path waits on the database and barely
      computes. So the ticket's premise ("something regressed") was wrong and its subject was
      real — the budget has had ~4% margin since Phase 3, and a host with ~20% run-to-run
      variance turns that into a coin flip.

      **Counted rather than guessed**: one sensor create made **11 database round trips**.

          BEGIN · advisory lock · parent check · INSERT object · INSERT sensor_config
          · read the object · INSERT channel · read the version again · pause guard
          · INSERT audit · COMMIT

      Two of those exist only because of ordering. Declaring a sensor's channels bumps the
      owner's version by trigger, so `create` read the object, `createChannels` re-read the
      version, and the service patched one into the other — the code said so in a comment about
      an ETag that would 412 on its own first write.

      **Fixed by reading once, after the object is finished.** `ObjectRepository.insert` writes
      and returns the id; the service reads the assembled detail after the channels exist, where
      the version is right by construction rather than patched. **11 → 10 round trips, and
      4.15 → 3.71 ms a create measured in-process (−10.6%)**, which is the controlled number —
      no HTTP, no machine noise.

      End to end, `ms-server` stopped, before → after:

      | | Runs | Best |
      | --- | --- | --- |
      | before | 28.7 (profiled), 31.5, 33.0, 35.4 s | 28.7 s |
      | after | **26.1, 28.3, 28.8 s** | **26.1 s** |

      **Three for three inside the budget**, where before it was one for four and that one had a
      profiler attached. The −9% end to end matches the −10.6% measured on the database portion,
      which is about three quarters of the time.

      **Two bigger fusions were tried and rejected, which is worth writing down.** Folding
      `INSERT sensor_config` into the object INSERT as a data-modifying CTE looks like a free
      round trip and is not: `sensor_config_kind_check` is a BEFORE INSERT trigger that does
      `SELECT kind FROM object WHERE id = NEW.object_id`, and a sibling CTE's insert is not in
      its snapshot. It would need a migration to change the trigger, which is a different ticket.
      Fusing the pause guard into the object read would work but puts the pause concern inside a
      generic read, and the round trip is not worth that.

      **The residual, stated plainly:** margin is now 4–13% against a machine that varies ~20%,
      so this is better rather than settled. The honest next lever is the remaining ten round
      trips, not the budget — and `P-19`'s bulk path already does the same 5,000 objects in
      2.5 s with 92% spare, which is what a client provisioning a tree should be using.

      The new test does not assert the round-trip count; it asserts the property the reordering
      could break — a created sensor's version works as the precondition for its own first write
      — and it was proved to fail against a planted stale-read mutant before being kept.

- [x] **P-28 — A probe at the v1 target could never reconnect** · M · P-27 · `config-set` caps
      `sensors` at 5,000 and the frame decoder refuses a message over 4 MB, while
      `CAPABILITIES.MD` §13 puts the v1 target at **5,000 sensors** — so an installation at its
      own documented size built a configuration its probe rejected outright.

      **The failure mode was a wedge, not a bad message.** The probe reconnects, the core sends
      the same oversized `config-set`, the probe closes the link on a protocol violation, and it
      reconnects again: **426 closures in three minutes** on the dev stack, `connected: 0`, and no
      way out short of deleting sensors. The core's own log said only "link to core closed".

      **A probe restart is what shows it**, which is why `H-01` ran 24 hours with these same 5,047
      sensors and never hit it — they had arrived as `config-delta` messages while the tree was
      being provisioned, and each delta was small. It surfaced the moment the probe was restarted
      to pick up `P-27`.

      **Fixed without touching the protocol.** The probe already applies a `config-set` as a
      replacement and a `config-delta` as an upsert, so a full push is now the first chunk as a
      set and the rest as deltas carrying the same version: 5,047 sensors in 6 messages, and the
      end state is identical to the one oversized message. A thousand assignments per chunk
      measured about 120 KB, so a chunk has roughly thirty times the headroom it needs — the
      margin matters because an assignment is as large as its parameters, and a `rest.custom` with
      many mappings is worth many times an `icmp.ping`.

      Left deliberately: the 5,000-item and 4 MB bounds stay where they are. They are absurdity
      guards, and now that no message approaches either, they are doing the job they were written
      for rather than standing between the product and its own target.

- [x] **P-27 — The spool stall belongs on Probe Health, not only in the log** · S · H-01 ·
      `92ec56a` gave `SpoolDrain` a stall detector — `DrainStats.stalledForMs`, how long the spool
      has held results with the link up and nothing moving — and then only logged it. An operator
      could not see it on a dashboard or put a trigger on it, which for a condition whose entire
      problem was being invisible is most of the way back to where it started.

      **`spoolStalled` on `ms.probe.health`**, in seconds, with an `upperError` of 0.5 in the
      style of `spoolDropped`: not a matter of degree, because the probe already reports zero
      unless it has waited out its own five-minute stall window, so any value here is a stall the
      probe has itself concluded is real and a higher threshold would only delay the alarm.

      **Depth could never have carried this signal, which is why it is a separate channel.** A
      spool with thousands of results in it is what a probe replaying an outage looks like, so
      `spoolDepth` has no declared limits and should not have any. What is never healthy is a
      spool holding results with the link *up* and nothing moving — a duration, not a depth.

      Wiring: `DrainStats` into `ProbeHealthReporter` as a source separate from the spool, because
      how much is waiting and whether any of it is moving are different questions and a build with
      one and not the other should report what it has; `spoolStalledMs` on the heartbeat;
      milliseconds on the wire converted to seconds on the channel, since every other duration an
      operator reads there is in seconds. **Protocol 8 → 9**: the health schema is
      `additionalProperties: false`, so a version-9 probe would have had every heartbeat rejected
      by a version-8 core with nothing to say why — the bump turns that into the handshake
      refusal `isProtocolCompatible` already knows how to give. An older probe omits the field and
      the channel gaps, which is `R-06` again.

- [x] **P-26 — The pool's shrink policy cannot fire on a probe that is doing anything** · M ·
      P-18 · `#considerShrink` gives a worker back only when the pool has been idle for
      `idleShrinkMs`, and `#busySince` is reset by **every `submit`** — so "idle" means "no check
      has been handed to the pool at all for a minute". A probe watching 5,000 sensors on a
      60-second interval submits about eighty-three checks a second, so the window never opens,
      and the one that grew a large pool is exactly the one that can never give it back.

      **Measured during `H-01`'s soak**, which is where it showed up: 5,047 sensors, the pool grew
      to 48 workers in 20 events during the provisioning burst, and in the following 70 minutes
      shrank **zero** times while `poolUsage` sat between 0% and 3%. Forty-five workers spare at
      all times, none returned. `P-18`'s own numbers say 48 workers cost 557 MB at start against
      16 MB for four, so the policy is inert precisely where it was worth the most.

      The measure of idleness is wrong rather than the interval: what matters is that a *worker*
      has been spare for the window, not that no work has arrived. Per-slot idle tracking would
      express that directly and would decay a burst-sized pool one worker a minute.

      **`check-pool.test.ts` asserts the current behaviour on purpose** — "does not give a worker
      back while work is still arriving", whose reasoning is that a shrink between a check
      queueing and a worker picking it up would take the worker that was about to run it. That
      hazard is real and is answered by only retiring a slot that is ready, jobless *and* idle for
      the whole window. Change that test deliberately, with a measurement, not incidentally.

      Not fixed on the spot because doing so restarts the probe, and that would have thrown away
      the 24-hour soak that found it.

      **And it does not only fail to shrink — it overshoots on the way up, which is the other
      half.** Growth doubles: `want = min(maxSize, held * 2, held + queue.length)`. A worker is
      not `ready` until it has spawned and imported its registry, and `#pump` only dispatches to
      ready slots — so the queue that triggered the growth is still there on the next tick, and
      the pool doubles again. Measured while sizing for `H-08`, on eight cores with a ceiling of
      256: **500 sensors grew the pool to 74 workers and 718 MB**, against a steady-state need of
      `500 / 60 × 0.2 = 1.7` workers. That is forty times the concurrency the workload has.

      With the release's own ceiling of 48 it simply pins there instead: 500 sensors on two cores
      settled at 27 workers and 340 MB, and the `H-01` soak's 5,047 sensors sat at 48 — the same
      48 a fifty-sensor probe reaches. **The ceiling, not the workload, is what a probe costs**,
      and that is what makes the memory column of any sizing table meaningless until this is
      fixed. Damping growth by what is already spawning, and measuring idleness per worker rather
      than per submission, are the same fix seen from two ends.

      **Both ends fixed, and the two-ended reading was right.** Idleness is now per slot:
      `Slot.idleSince` is stamped when a worker finishes and zeroed when it is dispatched, and
      `#considerShrink` retires the *oldest* slot that is ready, jobless and has been so for the
      whole window — which is the hazard the old test was guarding against, expressed as a
      condition on the slot rather than as a ban on shrinking. Growth no longer doubles: `want`
      is `held + (queue.length − growing)`, so a tick inside a spawn window does not buy a second
      time against a queue it has already paid for. `#busySince` is gone.

      **Measured on eight cores at the shipped ceiling of 48**
      (`docs/findings/2026-09-03-sizing-sweep-after-p26.jsonl`), before → after:

      | Sensors | Burst | Pool | RSS |
      | --- | --- | --- | --- |
      | 100 | 1.7/s | 4 → 4 | 120 → 117 MB |
      | 500 | 8.3/s | **27 → 14** | **343 → 216 MB** |
      | 1,000 | 16.7/s | **35 → 24** | **431 → 312 MB** |
      | 2,500 | 41.7/s | 48 → 48 | 565 → 547 MB |
      | 5,000 | 83.3/s | 48 → 48 | 578 → 571 MB |

      −37% resident at 500 sensors and −28% at 1,000. Above 2,500 the burst genuinely exceeds the
      ceiling, so pinning there is the pool doing its job rather than the defect. Dispatch latency
      is unchanged — the 2,500-sensor point read 70 ms against 18 on the first run and looked like
      a regression until it was run three more times: 10.5, 67.2, 8.9. That point sits exactly
      where a burst needs one round or two, and one sample of it means nothing.

      **The old test's premise was the defect**, so it was replaced rather than adjusted: "does
      not give a worker back while work is still arriving" asserted the very behaviour that made
      a busy probe unable to shrink. In its place, `gives back the workers a lighter load stopped
      needing` and `never takes a worker that is in the middle of a check` — the second is the
      hazard the old test was really about, and it fails if the ready/jobless condition is
      dropped.

      **On the dev stack this correctly changes nothing**: 5,047 sensors is a burst of 84 against
      48 workers, so no worker is idle for a 60-second window and the pool stays at its ceiling.
      The shrink path is covered by unit test rather than by the 60-second bench, because a run
      that short cannot exercise a 60-second idle window.

- [x] **P-44 — The auto-sizing loop had never been run** · M · P-34 · `bench.mjs` pins the
      ceiling and measures the pool underneath it, so the *loop* — measure durations, derive a
      demand, apply hysteresis, move the ceiling, watch the pool respond, measure again — had
      never run under load in any committed measurement. `demand.ts` has unit tests for the
      arithmetic and `P-43` added them for the settle, but between the two sat the part that only
      exists at runtime. Every claim in `docs/sizing.md` about how the ceiling behaves was read
      off the code.

      **The loop was extracted before it was measured** (`pool-sizer.ts`), for the reason `P-31`
      makes expensive: a benchmark that re-implements the policy is right until the policy changes
      and silent on the day it stops being. `scripts/sizing/autosize.mjs` imports the shipped
      `poolSizer` and changes the check duration underneath a running probe — 1,500 ms, then
      200 ms, then 1,500 ms again — which is the thing the loop exists to react to. Seven unit
      tests came with the extraction, mutation-checked against four mutants (ignore
      `workerPoolSize`, drop the hysteresis, ignore measured durations, warn silently); all four
      were caught by the case meant to catch them.

      **What is right**: the derived ceiling is Little's floor times the margin to the worker
      (66 against a predicted 65, the extra one being float accumulation in the sum); a raise is a
      single step with no ramp; a drop waits for two consecutive readings. **Nothing was deferred
      or refused at any point**, including while checks ran 25 seconds late — `P-33`'s argument,
      now measured.

      **Two things were wrong, and both were documentation rather than arithmetic.** The pool does
      not follow its ceiling down (`P-45`), and the ceiling moves about thirty seconds *after* a
      slowdown rather than before it — the sizing page claimed the opposite. The lag is the
      measurement rather than the cadence: `typicalDurationMs` is a median over a window, so
      recomputing more often re-derives the same stale number. Both corrected in `docs/sizing.md`,
      numbers in `docs/findings/2026-09-04-autosize-loop.md`.

- [x] **P-55 — `GET /discovery/schedules` returned the SNMP community in cleartext** · S · — ·
      CLAUDE.md: "Credentials are write-only … never returned by any API route, to anyone,
      including administrators." `scheduleSchema` declared `snmpCommunity: { type: 'string' }`, and
      three responses are built from it — the list, the 201 from create, and the 200 from the
      enabled toggle. `rediscovery.ts:369` maps `snmp_community` out of the row, `list()` returns
      it, and Fastify serialised it because the schema asked for it.

      **Fixed by deleting the property.** The schema is `additionalProperties: false`, so Fastify
      now strips the field on the way out while the service still carries it to the probe, which
      is what needs it. Nothing reads it back: there is no update route for a schedule, and the web
      form's draft starts empty rather than from a fetched value, so an operator loses nothing.

      **Why the existing defence missed it.** `api-routes.test.ts` sweeps a canary through a
      *hand-maintained list of URLs*. It is thorough about what is on the list; `/discovery/*` was
      never on it. So the fix ships with a guard that is derived instead: `docs/api-reference.md`
      is generated from the live route set (`H-07`) and kept in step by the build-hygiene check, so
      reading it is reading every route's declared response. Anything credential-shaped in a 2xx
      response now fails the build unless it is in an allowlist **with a written reason** — seven
      entries today, of which `secret` and `token` are the interesting ones: TOTP enrolment and API
      token creation return them once at creation, because a shared secret the operator is never
      shown cannot be used. Name-matching is a smoke alarm, not a proof: it cannot tell whether a
      field called `note` holds a password. It makes the easy mistake loud.

      Mutation-checked: putting `snmpCommunity` back fails the guard, naming the field.

- [x] **P-56 — `POST /objects/:id/as-template` returned every writeOnly parameter** · S · — · The
      same rule, a worse leak, and a false premise written down twice.

      `sensorsOfDevice` reads `sensor_config.params` with raw SQL, deliberately going around
      `ObjectService.#redact` because a template has to carry settings forward. Its comment
      justified that: "a monitored device's credentials live in the vault and never appear in
      `params` (CLAUDE.md)". **That is not true of the shipped catalogue.** `exe.script` and
      `exe.script.advanced` spread `SCRIPT_SCHEMA`, whose `secret` is `writeOnly` and is read back
      out of `context.params['secret']` to set `MS_SECRET`; every SNMP type spreads
      `SNMP_CREDENTIAL_SCHEMA`, whose `community`, `authKey` and `privKey` are `writeOnly` too. The
      route's response schema is `additionalProperties: true`, so nothing filtered them either.

      The same false claim sat in `from-device.ts`'s `stripEmpty` doc — "Nothing is redacted here
      because nothing needs to be" — which is how one wrong belief protected itself in two places.

      **Fixed at the read**, through the catalogue's own `redact`, so this shares one definition of
      "secret" with `ObjectService.#redact` rather than keeping a second list that could drift. A
      type the catalogue does not know now yields no params at all: shipping parameters on a guess
      is the failure being fixed. Both comments now say what is actually true.

      Mutation-checked: restoring the raw read fails the new test with "the secret leaked from
      sensorsOfDevice, which feeds POST /objects/:id/as-template as text". The test also asserts
      the public settings still travel, so a fix that returned nothing would not pass.

- [x] **P-57 — Listener notifications are drained, then dropped when the check is not accepted** ·
      S · P-42 · Found by the same audit and verified by hand before anything was changed.

      In the wheel's `onDue` (`packages/probe/src/main.ts:262`), `trapListener.drain(sensorId)` or
      `syslogListener.drain(sensorId)` runs *before* the check is handed to a runner, and
      `runner.submit(...)`'s `SubmitOutcome` is discarded. `NotificationRing.drain` advances the
      cursor unconditionally — `cursor.next = this.#nextSequence` — and hands the batch back. So
      when `submit` answers anything but `accepted`, the drained messages are gone: the cursor
      moved past them and the batch went into a call that dropped it.

      `already-running` is the ordinary case, not an exotic one: `WORKFLOW.MD §3` makes skipping
      the rule when the previous scan is still going, and a syslog sensor under a flood is exactly
      when its own `execute` is still parsing the last five thousand messages. `queue-full` and
      `stopped` lose them too.

      **Same family as `P-42`** — a cursor advanced past data that was then thrown away, reported
      as nothing missing.

      **Fixed by asking before draining.** Of the three candidate repairs, draining lazily cannot
      cross the worker boundary — the request is serialised to a worker, so a thunk cannot travel —
      and rewinding after a refusal would have to define what a rewind means against a ring that
      may have overwritten in the meantime, and restore `since` as well as `next`. Asking first is
      sound at this call site for a specific reason: `onDue` is synchronous and single-threaded, so
      nothing can change between the question and the `submit` that follows it.

      The objection to asking first was that it restates the admission rule at the call site, so it
      does not. Both runners now derive `submit` and a new `accepts` from one private `#admission`;
      `accepts` is the decision without the counters, so asking never moves one. The submit still
      happens when the answer is no, and the deferral still reaches Probe Health — what changes is
      that the ring keeps its messages for the scan that does get through.

      **This also closes the dispatch half of `P-43`'s residual gap, and not by choice.** `P-43`
      moved the *config* handlers out of `main()` and said plainly that construction and dispatch
      were still uncovered. `P-57` is a defect in dispatch, found by reading rather than by a test
      because no test could reach it. `due-dispatch.ts` now holds that policy — skip an unassigned
      sensor, route isolated types to the child-process runner, drain only for a check that will be
      taken — with five tests, two of which fail if the drain moves back before the question.

      One hazard met while extracting, recorded because the next person will meet it too:
      `assignments` is constructed *after* the wheel, because it needs the wheel, so passing it as
      a dependency value reads it in its temporal dead zone. The inline callback got that right by
      being a closure; it is passed as one now, with its return type written down, since leaving
      that to inference makes `wheel` circular through it.

- [x] **P-58 — Five audit candidates that nobody has verified by hand** · S · P-55 · An
      invariant-audit on 2026-09-04 produced fourteen candidates; eight were put to an adversary
      told to default to refuting, and it refuted **none of them**. Zero out of eight is not a
      result to trust: the two credential findings (`P-55`, `P-56`) and the listener one (`P-57`)
      were each re-verified by hand against the source before being acted on, and all three held.
      The remaining five were recorded here as candidates rather than as defects, and have now
      been read.

      All four distinct defects survive — the fifth entry was the fourth seen from its other end.
      Each is filed below with the evidence that convinced, and none of them is fixed here:

      - `P-59` — the Sensor Factory staleness collapse. Confirmed, and worse than it was filed:
        the installation-wide maximum means one sensor set to 86,400 s raises every other
        factory's cut-off, and the floor of 600 makes the schema's own `minimum: 30` unreachable.
      - `P-60` — the stream's overflow cut-off. Confirmed: `send` reaches `socket.send`, which is
        fire-and-forget, so `pending` is back to zero before the next event is considered.
      - `P-61` — `ProcessRunner`'s counters. Confirmed by exhaustion: `ProbeHealthSources`
        declares four sources, `main.ts` passes exactly those four, and `processRunner.stats()`
        is called nowhere in `packages/probe/src` but `.stop()`.
      - `P-62` — the pool's `#disabled` latch. Confirmed, and *less* severe than it was filed:
        the audit called it silent, but the latch logs an error and the `workerCrashes` that
        caused it has already been counted. What is lost is the volume discarded after it.

      Eight for eight, in the end. The distrust was still the right response to the rate — an
      adversary that refutes nothing has told you about itself and not about the code — but it
      is worth recording that reading them was what settled it, both times.

- [x] **P-59 — A Sensor Factory reads stale channels its own setting says to ignore** · S · P-58 ·
      `maxAgeSeconds` is documented in the sensor type's own parameter description as the age past
      which a reading "counts as absent — which makes the formula a gap rather than a number
      computed from something that stopped being true an hour ago". `FactoryService.#readInputs`
      does not implement that. It folds every factory sensor's setting into a single
      installation-wide `Math.max(600, …)` and passes that one interval to one SQL cut-off, so:

      - a sensor set to 60 s accepts a 24-hour-old reading the moment any *other* factory sensor
        anywhere in the installation is set to 86,400 s — and then reports "older than 60 s" in
        its own error text, because the message at `service.ts:179` reads the per-sensor value
        that the query ignored;
      - the floor of 600 makes the schema's `minimum: 30` unreachable — every setting below the
        default silently *is* the default.

      This is "no-data is not zero" failing in the direction that hurts: the gap becomes a number,
      and the number looks like data. The fix keeps the single over-fetching query — select each
      sample's age alongside its value, bounded by the widest setting in play — and applies each
      sensor's own cut-off where the formula reads the channel, so the write-back that lets a
      factory read a factory within one sweep keeps working, at an age of zero.

      Wants a table-driven test over (own setting, sample age, other sensors' settings): the
      defect is invisible with one factory sensor configured, which is why nothing caught it.

      **Fixed by moving the cut-off to where the formula reads the channel.** `FormulaInputs`
      carries a `maxAgeSeconds` and each reading carries its `ageSeconds`, so `evaluate` answers
      the same channel differently for two factories that disagree about how old is too old —
      which is the thing the old shape could not express at all. The query still makes one round
      trip for the whole sweep: it selects each sample's age alongside its value, bounded by the
      widest setting in play. That bound is an over-fetch so that every sensor has enough rows to
      apply its own cut-off to; it is not a cut-off anyone is subject to, and the comment says so
      where the next reader will be tempted.

      Two details worth keeping. The age is computed by the database in the same query that read
      the sample, so a core whose clock has drifted from the database's cannot make a stale
      reading look fresh. And the boundary is `>`, not `>=` — "older than" is what the parameter
      promises, and the other way would gap a source reporting at exactly its own period.

      The write-back that lets a factory read a factory within one sweep hands over an age of 0.
      It has no sample behind it because it *is* this sweep's value, and a tight cut-off upstairs
      must not turn a stack of factories into gaps.

      **The fix has its own failure mode, and it is guarded.** A `maxAgeSeconds` that arrives from
      the row as something unparseable becomes `NaN`, so the loader falls back to the default and
      a test writes `"whenever"` into `sensor_config.params` to prove it.

      The reason first written here was wrong, and `P-66` corrected it: `NaN` does not widen to
      `Infinity` under the `Math.max` that bounds the query — `Math.max(0, NaN)` is `NaN`. The
      query parameter therefore becomes the string `"NaN"`, and PostgreSQL answers `invalid input
      syntax for type interval: "NaN seconds"` (measured against the dev database). That throws
      the one query the whole sweep depends on, so a single unparseable row stops **every** factory
      sensor in the installation reporting rather than widening one sensor's cut-off. A worse
      consequence than the one claimed, by a different mechanism, and the same guard covers it.

      **The test that was already there could not have caught this, and the mutation says why.**
      "treats a stale reading as absent rather than as still true" survives deleting the age check
      from `evaluate` outright: with one factory configured, at exactly the floor of 600, the SQL
      cut-off alone excludes the 4,000-second reading. It was passing on the query, not on the
      rule, and both of its numbers had to be what they were. The four rows added around it each
      run with a neighbouring factory set to a day, because the collapse is only visible when
      there are two — and three of them die when the age check goes.

- [x] **P-60 — The stream's overflow cut-off cannot fire, and nothing else bounds the backlog** ·
      S · P-58 · `api-reference.md` tells the operator that a client which cannot keep up "is sent
      `overflow` and detached rather than being quietly trimmed". `StateBroadcaster.#deliver`
      guards that path on `attached.pending >= queueLimit` — but `pending` is incremented and
      decremented around a call to `StateSubscriber.send`, which the interface declares
      `send(event: StateEvent): void` and whose only implementation calls
      `socket.send(JSON.stringify(frame))`. `ws`'s `send` returns immediately and buffers
      internally, so `pending` is back to 0 long before the next event is considered. The counter
      is zero at every check, the cut-off is dead code, and `queueLimit` bounds nothing.

      A suspended browser tab therefore grows `socket.bufferedAmount` without limit — "never queue
      unboundedly" broken in the one place the documentation promises it is not. The quantity that
      actually measures the backlog is `bufferedAmount`, and that is where the guard belongs.

      The test needs a subscriber that does not drain. Every existing one accepts instantly, which
      is exactly why a guard that can never fire has always passed.

      **Fixed by asking the transport instead of inferring.** `StateSubscriber` gains an optional
      `backlog(): number` and the WebSocket route answers with `socket.bufferedAmount` — what `ws`
      has accepted and not yet written. That is the one quantity that actually grows when a client
      stops reading, and the broadcaster had no way to compute it, which is why its attempt read
      zero. `pending` is gone; there is nothing left to keep it in step with.

      The limit is bytes now, so `queueLimit` would have been a lie about its own unit and is
      `backlogLimitBytes` instead. The default is 1 MiB — deliberately forgiving, because cutting
      a subscriber off costs it a fresh snapshot of up to 20,000 sensors, so a limit tight enough
      to fire on an ordinary network stall would be worse than the backlog it prevents. What it
      has to stop is the unbounded case, and any finite number does that.

      `backlog` is optional because a subscriber that consumes synchronously genuinely has none,
      and every test recorder in the suite is one. That is also the trap: absent, it reads 0 for
      ever, and a route added later without one would be uncuttable and silent about it — the same
      failure in a new place. So the real-socket test asserts the route's own subscriber answers,
      and answers with the socket's figure. `undefined` against a number fails, which makes the
      one assertion cover both halves.

      **What the existing test was really testing.** "cuts off a subscriber that cannot keep up"
      passed throughout, on `queueLimit: 0` — `0 >= 0` fires on the first event whatever `pending`
      holds. It proved the detach mechanism and never touched the measurement, which is the same
      shape as `P-59`'s staleness test: a number chosen so the assertion holds for a reason other
      than the one the name gives. It is kept, because the mechanism is worth pinning; the two
      tests added beside it are the ones that read a backlog, and they fail if the guard goes back
      to counting for itself.

      One stale claim fixed in passing: the recorder helper's comment said it "can be told to stop
      draining", and nothing in it ever could. Now it can, because that is what these tests need.

- [x] **P-61 — EXE and Script backpressure reaches no health sensor** · S · P-58 · `ProcessRunner`
      counts `#deferred`, `#refused`, `#timedOut`, `#crashed`, a live count and a queue depth, and
      exposes all of them through `stats()`. `ProbeHealthSources` declares four sources —
      `scheduler`, `pool`, `spool`, `drain` — `main.ts` passes exactly those four, and
      `processRunner.stats()` is called nowhere else in `packages/probe/src` but `.stop()`. Every
      counter it keeps reaches nothing.

      So a probe whose child-process ceiling is saturated by slow EXE and Script sensors reports a
      perfectly healthy Probe Health while it defers and refuses checks. "Backpressure is visible,
      never silent" and "any new subsystem with a queue, a pool or a connection adds a metric to
      one of them" are broken by the same omission: the counting was done, and never wired up.

      A fifth source is the whole fix. The test that would have caught it is structural — every
      runner that has a `stats()` is named in `ProbeHealthSources`.

      **Adding the fifth source was not the whole fix, because the report is on the wire.**
      `ProbeHealthReport` is validated by a JSON schema with `additionalProperties: false`, so a
      newer probe sending a field an older core does not know has *every heartbeat rejected*, with
      nothing to say why. That is what the protocol version is for, and it is now 11. The ticket
      did not mention this and neither did the audit that filed it: the omission is only visible
      from the schema, three files away from the counters.

      Seven channels rather than a sum into the pool's: `childSlots`, `childBusy`, `childQueued`,
      `childDeferred`, `childRefused`, `childTimedOut`, `childCrashes`. The two runners saturate
      at completely different loads — a worker pool holds tens of slots and a child-process runner
      a handful — so folding them together would hide whichever is healthy behind whichever is
      not, and an operator diagnosing one does not want the other in the number. The Prometheus
      exporter gets the same six series for the same reason. Absent stays absent: a build with no
      child runner omits the block and the channels gap, rather than reading a confident zero that
      cannot be told from a runner sitting idle.

      **The test is structural, and it had to be.** Every number `ProcessRunner` kept was correct;
      they reached nothing, because the interface deciding what Probe Health reads had no key for
      it. Nothing behavioural can see that — the subsystem works, and the silence *is* the defect.
      So the rule is written down instead: every file in `packages/probe/src/runner/` that
      declares a `stats()` must have its stats type named in `ProbeHealthSources`. It reads the
      source rather than the build, so it fails on the regression whether or not it compiles.

- [x] **P-64 — The syslog and SNMP-trap listeners count what they lose, and tell nobody** · S ·
      P-61 · Found while wiring `P-61`, by asking the same question one subsystem further out.
      `TrapListener.stats()` and `SyslogListener.stats()` each keep `received`, `rejected`,
      `malformed`, `buffered`, `cursors` and — the one that matters — `overwritten`: notifications
      dropped from the ring because nothing drained them in time. Every one of those numbers
      reaches exactly one place, a `logger.info` at shutdown.

      So a probe under a syslog flood silently overwrites messages it was asked to watch for, and
      the only record is a line written when the listener stops. That is `CLAUDE.md`'s
      "backpressure is visible, never silent" and "the system monitors itself" broken in the
      subsystem where the data being lost is the *point* — a trap that was overwritten is an event
      nobody will ever know arrived.

      Not the same fix as `P-61`: these are per-listener and a probe may run neither, one or both.

      **What this ticket first proposed as the headline was written before anybody read the code,
      and it was wrong.** It named `overwritten` — "not a matter of degree, like `spoolDropped`",
      carrying a limit that alarms above zero. Verifying before implementing, which is the rule
      `P-58` exists for, refuted that and turned up a different defect.

      `overwritten` is not loss. `NotificationRing.push` increments it whenever the target slot is
      occupied, and slots are never cleared: `drain` reads without clearing, `retain` touches only
      cursors. So once `nextSequence >= size` every push increments whatever the cursors have done,
      and the counter is identically `max(0, nextSequence - size)` — **ring turnover**. At the
      default `bufferSize: 20_000`, a device sending 100 messages a second with a sensor scanning
      every 60 s drains 6,000 per scan, loses nothing, and turns `overwritten` over by ~8.6M a day.
      The limit this ticket asked for would have put every busy listener into permanent Error.

      The loss it called silent is already the loudest thing in the subsystem: the per-cursor
      figure is `ReceivedBatch.dropped`, and both `snmp.trap` and `syslog` already fail the check
      on it, with a diagnosis.

      **The reachable defect is `rejected`.** A message turned away by the community or sender
      allow-list never enters the ring, so it produces no batch item, no `dropped` and no
      `unmatched` — and it is deliberately not logged, because a misconfigured device retries for
      ever. Enable the listener with `communities: ['public']` and let a device be reconfigured to
      send `private`: every trap is rejected, the sensor drains an empty batch, `execute` returns
      `count: 0` without throwing, and `describe` renders "no traps since …". A green sensor
      reporting a quiet network, at a receiver that is turning all of it away — word for word the
      failure `snmp-trap.ts` says it must never have, guarded for a missing batch and unguarded for
      a filter that rejects everything.

      So three channels per listener, not six — `received`, `rejected`, `malformed` — and none with
      a limit: an allow-list exists in order to reject, and a public UDP port collects junk. Their
      value is turning "my trap sensor reads zero" into "the probe rejected 400 last minute". Not
      `overwritten`; not `buffered`, a latch that rises once and never falls; not `cursors`, a count
      the core already has. Protocol bump for the reason `P-61` documents.

      The structural test that caught `P-61` reads `src/runner/` only, so `src/listeners/` was
      outside its reach — generalising it over both directories is part of this. Both listeners also
      carry a comment claiming the malformed count "is on Probe Health either way", which is false
      today, and is some of why nobody looked.

      **Landed as the reading described, not as the ticket first did.** Two optional sources, three
      channels each, none with a limit, and `overwritten` deliberately left where it is. The
      comments in both listeners claiming the malformed count "is on Probe Health either way" are
      true now — they were written before anything carried it and had been wrong since `T-20`.

      The structural test from `P-61` read `src/runner/` only, which is how a subsystem keeping
      counters of exactly the same kind stayed invisible to it for three tickets. It reads both
      directories now, and fails when either listener's source is taken out of `ProbeHealthSources`.
      A rule that only looks where the last defect was found is a rule that finds the last defect.

- [x] **P-65 — The session-replacement test was watching an idle timer** · S · P-61 · The full
      suite went red on "replaces a stale session when the same probe reconnects" while `P-61` was
      in the tree, and the version bump looked like the cause: it passed at protocol 10 and failed
      at 11, three times each. It is not the cause. Six runs at protocol 10 failed once — the test
      is a coin flip, and it was one before anything in `P-61` was written.

      Measuring where the time went settled it. The second probe connects in 6 ms and is welcomed
      in 1 ms; the first socket then takes **3,000 ms** to close, against a `waitForClose` timeout
      of exactly 3,000 ms. That number is `heartbeatIntervalMs * 3`, the connection's idle timeout
      — and a log spy confirms what closes it: `connection idle, closing`, never `replacing an
      existing session for this probe`. **The test has never observed a replacement.** It watched
      an unrelated timer expire at the same instant it gave up, and won that race about five times
      in six.

      The reason the replacement never ran is a real asymmetry. `ProbeEndpoint` has a no-registry
      branch — pre-`R-01` behaviour, kept because, as its comment says, it is "what the
      transport's own tests drive, and leaving it in means those tests are not secretly testing
      the registry". That branch calls `#openSession`, which does `this.#sessions.set(gid, …)` and
      **overwrites**: nothing points at the old connection afterwards and nothing closes it, so it
      lives until its idle timer three heartbeats later. The registry branch has always destroyed
      the superseded connection properly. So the one test that names the behaviour drove the one
      branch that did not have it — and could not have failed for the right reason.

      Both halves fixed. The no-registry branch supersedes the same way, and the test runs with a
      30-second heartbeat so the idle timeout is 90 s and nothing but a replacement can close that
      socket inside the second it now allows. It went from 3,010 ms and one failure in six to
      13–29 ms and six for six, and it fails deterministically when the supersede is removed.

      **A production shutdown hang was suspected here and written off. That was wrong — see
      `P-67`.** Removing the supersede made the test take 90 s rather than 1 s, which pointed at
      `stop()`: it closes only what is in `#sessions`, and `server.close()` waits for every open
      connection. Two candidates were tried — a peer that ignores its `bye`, and a probe left
      pending approval, which `#openSession` deliberately does not store — and `stop()` returned in
      0 ms for both, so it was recorded here as a discard.

      Both tests were incapable of producing the condition. An ordinary `tls.connect` client
      answers the server's FIN automatically, so nothing was ever wedged; the peer has to be built
      on a socket with `allowHalfOpen: true`. With one, `stop()` was still waiting after six
      seconds. The hang is real and `P-67` fixes it. Left here rather than edited away, because a
      discard on the strength of a test that could not fail is worth more as a warning than as a
      deletion.

- [x] **P-66 — `P-60`'s cut-off counts the snapshot it sends, and detaches healthy clients** · S ·
      P-60 · Found by an adversarial review of `P-60` itself, and it is worse than the defect
      `P-60` fixed. The overflow cut-off reads `socket.bufferedAmount` — and the snapshot travels
      down that same socket. `snapshotLimit` defaults to 20,000 sensors, which is megabytes handed
      to `ws` in one call, against a `backlogLimitBytes` of 1 MiB. The subscriber is attached
      *before* the snapshot is sent, deliberately, so that no change is missed — so on any large
      installation the first state event after subscribing sees the whole snapshot still buffered,
      detaches a client that is keeping up perfectly, and tells it to resubscribe. Which takes
      another snapshot. **`P-60` turned dead code into a resubscribe storm**, on exactly the
      installations that need the stream most.

      Fixed by giving a snapshot an allowance for its own bytes. `socketBacklog` clamps that
      allowance to whatever is still buffered on every reading, so it only ever shrinks: while the
      snapshot is going out it forgives itself, once it is on the wire it is gone, and the guard is
      armed at full strength. A client that stalls *during* its snapshot still trips, because the
      events piling up behind it are counted in full — the forgiveness is for what we chose to
      send, not for the backlog.

      **`P-60`'s test for this was vacuous and said so was not.** It asserted
      `registered[0]?.backlog?.() === socket.bufferedAmount` inside the real-socket test, where
      `socket` is the *client* end and the reported figure comes from the *server's*. Both read 0
      on an idle connection, so it was `0 === 0` and would have passed against an implementation
      returning a constant. The commit message claimed it pinned "the socket's figure"; it pinned
      that the method exists. It now says exactly that, and the arithmetic is covered by
      `stream-backlog.test.ts` against a socket a test can move by hand — six cases, four of which
      die when the allowance is removed. That file is deliberately outside the database-gated
      suite, so it runs everywhere.

      **One gap left open rather than papered over.** Nothing fails if somebody removes the
      `backlog.allow(send(…))` that wires the allowance to the snapshot. Catching it needs a real
      socket whose buffer stays non-empty, and on loopback it drains before it can be observed —
      which is the same reason the original assertion was empty. The arithmetic is pinned, the
      wiring is one commented line, and pretending otherwise is what `P-60` did.

      Also corrected here: the `readMaxAge` rationale in `P-59`, in the code comment, the ticket
      and the commit message. `Math.max(0, NaN)` is `NaN`, not `Infinity`. See `P-59`.

- [x] **P-67 — A wedged probe holds the core's shutdown open for ever** · S · P-65 · **`P-65`
      refuted this and `P-65` was wrong.** `ProbeEndpoint.stop()` ends its sessions and then awaits
      `server.close()`, which completes only when every accepted socket has closed. `close()` sends
      `bye` and calls `socket.end()` — a half-close, an *ask*. A probe that has stopped reading
      never answers with its own FIN, so the socket stays open, `server.close()` never calls back,
      and the shutdown never finishes: a core that has to be SIGKILLed, on exactly the restart most
      likely to be happening *because* a probe is wedged.

      The refutation in `P-65` tested this with an ordinary `tls.connect` client, which answers the
      server's FIN automatically — so `stop()` returned in 0 ms twice and the hang looked
      imaginary. The peer has to be built on a socket with `allowHalfOpen: true` to be wedged at
      all. With one, `stop()` was still waiting after six seconds. Two negative results against a
      test that could not produce the condition, written up as a discard: the mistake `P-58` exists
      to prevent, made three tickets later.

      `#sessions` was never the set of open sockets and reading it as one is the root of it: a peer
      mid-handshake, one left pending approval, and one whose session was superseded are all live
      connections that nothing in that map points at. Every accepted socket is tracked now, and
      after a one-second grace — long enough for `bye` and a FIN to cross a WAN link, short enough
      that an operator does not think the restart has wedged — anything still open is destroyed.

      The test fails deterministically at eight seconds when the grace is removed, and passes at
      1,014 ms with it.

- [x] **P-70 — What the review found wrong with the fixes for what the review found** · S · P-66 ·
      An 81-agent adversarial review of `P-59`, `P-60` and `P-63` upheld nine findings out of
      twenty-five and then turned a completeness critic on the fixes themselves. Two of those hit
      code written hours earlier in this same run.

      **`P-66`'s allowance was wrong, and `ws` is why.** It forgave a snapshot's bytes and clamped
      that allowance to whatever was still buffered, on the assumption that `bufferedAmount` decays
      as a snapshot drains. It does not. `ws` reports `_socket._writableState.length +
      _sender._bufferedBytes`, and Node clears `_writableState.length` only when a whole write
      completes — measured by the review, a 3 MiB write to a peer that is not reading still reads
      3,145,728 three seconds later, then drops in one step. So the clamp came down onto the
      *events* queued behind the snapshot and forgave those instead, and a client that stalled
      mid-snapshot became permanently uncuttable. That is the hole `P-66` noticed and waved away.

      The correct accounting falls out of the socket being FIFO. The snapshot is queued first, so
      every byte of it leaves before any event byte does; counting event bytes written since the
      snapshot, the event backlog is exactly `min(bufferedAmount, sent)` — while any snapshot is
      still queued the buffer exceeds `sent` and the answer is every event byte and none of the
      snapshot, and once the snapshot has gone the buffer is events alone and the answer is the
      buffer. One expression, both cases, and the snapshot's size never has to be known at all.

      Two more from the same finding: the snapshot was sent after its `await` without checking
      whether the cut-off had detached the subscriber meanwhile — appending megabytes to a socket
      already given up on, which is the amplification worth closing whatever else is true — and the
      compiler cannot see a callback clear a flag, so the guard is a property on a holder rather
      than a `let` it would narrow to a constant.

      **`P-67` left the door it was closing.** It tracked sockets at `secureConnection`, so a peer
      that opens TCP and never starts a TLS handshake was handed to nothing, was in no set, and
      held `server.close()` open for ever — the same hang, through the one connection state the fix
      skipped, and the handshake timer does not help because it fires on sockets the endpoint knows
      about. Tracked at `connection` now, which is every accepted socket; the new test fails at
      eight seconds against `P-67`'s version.

      **`P-63` swept the simulators and stopped one short.** `TestSshServer.stop()` had a 500 ms
      timer beside its `close()`, and the sweep read "does not hang" as "fixed". It is not: the
      timer made `stop()` *resolve while the server was still listening*, so a suite moved on
      believing a fixture was gone. Its connections are ended now and the callback actually
      arrives.

      **Two of the critic's findings were checked and did not hold.** It called the new
      deterministic `P-63` guard "~3% reliable and passing against the unfixed simulator"; measured
      directly against the old tracking, a bare TCP connection held `close()` open **12 times out
      of 12**. And it called `P-67`'s "a service that has to be SIGKILLed" contradicted by a
      five-second budget; `deploy/systemd/ms-core.service` sets `TimeoutStopSec=30`, so systemd
      does kill it, and the wording stands. Recorded because a review that is right nine times is
      not therefore right the tenth — which is the whole lesson of `P-58`, pointed the other way.

      Two documentation defects it found were real: `P-66` had orphaned the `U-02` design block
      from `streamRoutes` so it read as `socketBacklog`'s, and the `readMaxAge` test still carried
      the `NaN`-widens-to-`Infinity` rationale that `P-66` corrected everywhere else.

- [x] **P-71 — The web client answers `overflow` with an instant resubscribe** · **discarded** ·
      S · P-70 · Raised
      by the review of `P-60` and not verified by hand. `packages/web/src/api/stream.ts` handles an
      `overflow` frame by calling `#send()` immediately on the same socket, with no backoff — the
      `retryMs` backoff beside it applies only to a dropped socket. Each resubscribe runs the full
      recursive-CTE snapshot query and appends another snapshot to a buffer that may still be over
      the limit, so one false cut-off becomes a cycle that costs a query and a multi-megabyte frame
      per turn. `P-70` makes a false cut-off much less likely; it does not make the response to one
      safe, and a client that is genuinely too slow will still be told to resubscribe for ever.

      **Read, and discarded.** The stated mechanism is dead: `overflow()` runs only after the
      subscriber has been deleted from the attached set, so no further event can reach that socket
      to re-trip the guard, and the socket being FIFO — the property `socketBacklog` is built on —
      means a second snapshot is not counted against the client either. Neither reviewer upheld it,
      and the proposed backoff was wrong on its own terms: it would have reset its ladder on every
      landed snapshot, which in the loop it was written for is every turn.

      One residual worry is real and is not this ticket: a client that is genuinely too slow is
      told to resubscribe for ever, and resubscribing *is* the documented resync, so there is
      nowhere for it to converge. That is a design question about what the stream owes a client it
      cannot serve, and it wants an answer rather than a backoff constant.

- [x] **P-68 — `MessageConnection` declares a backpressure signal that reaches nothing** ·
      **discarded** · S · P-61 · `pendingInboundBytes` is documented on the connection as "a
      backpressure signal for Probe Health" and is read by nothing — the same shape as `P-61` and
      `P-64`: a number computed, named for a consumer, and never wired to one. Raised by the review
      of `P-59`/`P-60`/`P-63`, then read before filing, and it does not hold.

      The number is the length of a **partial frame** sitting in the decoder. It is bounded by one
      message and falls to zero the moment that message completes — not a queue, unable to grow, no
      backpressure for it to signal and nothing an operator could do with it. Two independent reads
      agreed it should reach nothing.

      What remains is a wrong comment rather than a missing channel: the getter, and the note in
      `frame.ts` that calls it a backpressure metric, should say what the number is — bytes of an
      incomplete frame — or the getter should go. Kept as a closed entry rather than deleted,
      because "a number that reaches nothing" is a shape this codebase now looks for, and this is
      the case where the answer is that it should.

- [x] **P-69 — A gapped Sensor Factory leaves its stored sample where a factory above reads it** ·
      S · P-59 · Raised by the review of `P-59`, then verified by hand and by a test that fails
      against the old code. `#readInputs` loads the latest stored sample for every referenced
      channel, and a factory read by another factory has samples of its own — real ingestion writes
      them. When the lower factory gaps, the write-back does not happen, so its *previous* reading
      is still sitting in the shared map and the factory above computes from it. Same for a factory
      with a formula that will not parse, and for one in a cycle: all three branches `continue`
      without touching the map.

      That is exactly what the dependency ordering exists to prevent. The sweep's own comment says
      a factory over a factory "sees this sweep's value rather than last sweep's" — which has to
      mean a gap when this sweep produced nothing, or the ordering buys nothing at all. Fixed by
      clearing a factory's own channels from the map at the top of the loop, before any branch can
      `continue`, so only what it actually computes this sweep is visible downstream.

      **Two false starts, both worth recording.** The first test deleted every sample, which
      removed the lower factory's stored row along with its source, so there was nothing left to
      read and the test passed against the defect. The second inserted a sample for channel `v` and
      matched no rows: creating a factory through the harness declares a channel called `value`,
      because the *test catalogue's* stub for `core.factory` returns a fixed channel list and
      ignores its params — the real type derives them correctly, so this is a test double and not a
      defect, but it is enough to make a hand-written fixture miss. The reproducing test creates the
      channel the way ingestion would and then inserts into it.

- [x] **P-62 — What the worker pool discards after it gives up is never counted** · S · P-58 ·
      Once `#disabled` latches, `#admission` returns `stopped` before any counter is touched, so
      every check submitted from then on vanishes without appearing in `deferred`, `refused`, or
      anywhere else on Probe Health.

      The audit filed this as silent, and it is not quite: the latch logs an error, and the
      `workerCrashes` that caused it has already been counted, so an operator reading the logs
      learns the pool died. What nobody can see is the volume behind it — a probe with 400 sensors
      discards 400 checks an interval, and Probe Health shows precisely what a probe with four
      would show. The counter is the difference between "the pool failed" and "the pool failed,
      and here is what that cost".

      Smallest of the four: a `discarded` counter incremented in the `stopped` branch, and a
      channel to carry it.

      **Verified before implementing, and the reading found the ticket understated it twice.**

      First, the reachable consequence is not an uncounted drop. The core re-evaluates a sensor's
      state when a result arrives, and the only two routes to Unknown are an unreachable probe
      (`machine.ts:202`) and a sensor that has never been scanned (`machine.ts:206`) — there is no
      periodic sweep that ages a sensor out. A latched pool leaves the probe *connected* and
      heartbeating, so `probeReachable` stays true, results simply stop, and **every sensor under
      that probe holds its last state for ever**. The installation reports that everything is Up
      while nothing is being checked. That is the defect; the missing counter was a symptom.

      Second, Probe Health does not merely fail to say so — it reads actively healthy. The latch
      `return`ed one line before the `#slots.splice`, so the slot that killed the pool stayed in
      `#slots` for the life of the process and was reported as `poolSize`; `poolUsage` therefore
      read "0% of five workers" instead of gapping the way it does at size 0. The one guard that
      would have produced no reading was defeated by the leak.

      **So the alarm is a state, not a counter.** `poolState` rides the heartbeat and maps through
      a new built-in lookup `ms.probe.pool` — 0 running, 1 failed — so a dead pool turns Probe
      Health Down and says why in a sentence, the same treatment `ms.probe.link` gives a lost
      probe. `discarded` is the diagnostic half and carries **no limit**: the lookup already
      alarms for this cause, and a second alarm for one outage is what `CLAUDE.md` forbids.

      `SubmitOutcome` gains `disabled` beside `stopped`, because collapsing them is what hid this —
      stopping is something an operator did and the probe stops heartbeating for, while giving up
      leaves it connected, answering, and running nothing. Only one of them needs an alarm, and
      the on-demand query path now tells a requester which it hit. The counter increments on the
      `disabled` branch alone, so an orderly shutdown is not counted, and never in `accepts`,
      which `P-57` established must not move a counter.

      Protocol 12, for the reason `P-61` documents: the health schema is `additionalProperties:
      false`, so a field without a bump has every heartbeat rejected by an older core.

- [x] **P-73 — Each failed worker start is counted twice, so the pool gives up at two** · S · P-62
      · Found while verifying `P-62`, confirmed by reading and not yet fixed. `#spawn` registers
      both `worker.on('error')` and `worker.on('exit')`, each calling `#onWorkerGone`, whose only
      re-entry guard is `this.#stopped || slot.retired` — neither is set on a start failure. A
      worker whose top-level import throws emits both events, so one failed start increments
      `#startFailures` twice and `MAX_CONSECUTIVE_START_FAILURES = 3` latches on the **second**
      failing worker, not the third its own comment describes. `workerCrashes` is reported at
      double the true value for the same reason, and a ready worker's crash calls `#spawn()` twice
      for one death.

      The guard wants to be per-slot rather than per-pool — a `gone` flag on the slot, set on first
      entry — and the constant's comment wants to match whatever the count then means.

      **Fixed with the per-slot flag, and the comment now needs no change** — three consecutive
      failing starts really is three. `retired` was already there for the pool's own recycles, with
      a comment describing this exact hazard ("would count its own recycle as a crash and spawn a
      *second* replacement"); it simply did not cover the other way a worker can die twice.

      `test.crash` could not have caught this and no existing test could: `process.exit` fires
      `exit` alone. An uncaught exception fires `error` **and then** `exit`, so the new fixture
      throws from a `setTimeout` where nothing can catch it. The test pins one crash and one
      replacement, and fails on both counts when the flag is removed.

- [x] **P-74 — Nothing ages out a sensor whose probe stopped sending results** · M · P-62 · Found
      while verifying `P-62`, confirmed by reading. A sensor's state is re-evaluated only when a
      result arrives, or on a pause, an acknowledgement, or a change in probe reachability. The
      only routes to Unknown are `!probeReachable` and a sensor that has never been scanned. There
      is no watchdog for **a reachable probe that has stopped answering**, so any fault which stops
      results without dropping the link leaves every sensor under it frozen in its last state,
      indefinitely, with no alarm from the sensors themselves.

      `P-62` closes the one cause it knows about by turning the probe's own Probe Health Down. This
      is the general case: a wedged scheduler, a probe that stops draining its spool, an assignment
      list that never arrived, a bug not yet found. `CLAUDE.md` says no-data is not zero, and a
      sensor that is Up because nobody asked it anything is the largest possible version of that.

      Wants care rather than a quick fix: the natural rule — Unknown after some multiple of the
      scan interval — has to not fire on a probe legitimately replaying an outage from its spool,
      and it must produce **one** alarm for a probe-wide stall rather than one per sensor, which is
      what `ProbeReachability` already exists to arrange. Sizing and the alarm-shape question
      belong in a scenario test (`M-17`).

      **Designed before implementing: four approaches, judged, two eliminated on fatal flaws.**

      *The trap that kills the obvious implementation.* `sensor_runtime.last_result_at` is the
      **check's** clock — `writeRuntimes` sets it from `result.at`, the probe's own timestamp
      (`state/runtime.ts:272`, `state/service.ts:328`). A probe replaying an hour of spool delivers
      results stamped an hour ago, so `now() - last_result_at` stays an hour behind for the whole
      catch-up. "Overdue by N intervals" therefore fires hardest on the probe that is recovering
      correctly. Every design that survived reads an **arrival** clock instead, and never
      `result.at`.

      *The second trap.* After a core restart `loadRuntimes` restores `probeReachable: true`
      optimistically and `ProbeReachability`'s set starts empty, deliberately, to avoid an alarm
      storm generated by the restart itself (`state/runtime.ts:129-133`). A watchdog that does not
      allow for it alarms on every sensor at boot.

      *What the contract already says.* `CAPABILITIES.MD:96` lists Unknown as "No data yet, or **a
      communication error**" — broader than the two routes `machine.ts:202,206` implement — and
      `WORKFLOW.MD:465` fixes the alarm shape at "a single alarm, not one per sensor". §13 has no
      row for a probe that is reachable and has stopped producing results. `runbook-field-test.md:142`
      already lists "a sensor that stopped reporting without its state saying so" as an `H-09`
      failure criterion. This is an implementation narrower than its own specification, not a
      deferred choice.

      *Eliminated.* **Per-sensor staleness** (35.3/50) fires during a legitimate catch-up at the
      reconnect boundary — `reachability.found()` runs at the handshake, before assignments and
      long before any results — and its migration adds a `cause` enum value whose rollback rewrites
      a hypertable with 3,650-day retention, against the forward-and-back rule. **Heartbeat as the
      tick** (39/50) gates recovery on per-connection session state while `ProbeReachability` is
      keyed per probe, so a probe that stalls and then drops its link reconnects into a session
      that has forgotten, and the sensors stay Unknown for ever — a defect worse than the one it
      closes.

      *Chosen: the core-side delivery watchdog* (41.7/50). A probe that is connected and silent is
      not carrying its sensors, so it is handled the way a lost probe already is: `ProbeReachability`
      gains a second **reason** for the set it already owns, and sensors inherit
      `probeReachable: false` through the single overlay that exists today. No per-sensor fact, no
      new cause, no migration, no new layer. The decision is one pure `verdict()` — the discipline
      `state/machine.ts` has, so the table-driven tests drive the rule production uses — over an
      arrival clock stamped in `#queueResults`, with the window from the probe's own assigned
      cadence and the expected set taken from `sentSensors`, which already excludes every pause
      source, schedule, dependency and core-evaluated type. A legitimately quiet probe has nothing
      assigned and the question does not arise.

      Three properties fall out of the unit rather than out of extra machinery: the arrival clock
      makes a replay unable to trip it; the predicate is *zero* results in the window rather than
      "fewer than expected", so a saturated pool or a lagging wheel — both of which still ship
      something — cannot trip it either; and `unknown ∉ ALARM_STATES`, so however many sensors go
      Unknown the alarm count rises by exactly the one Probe Health sensor, which is how `R-05`
      already reaches "one outage, one alarm".

      It also closes a hole the ticket did not name: `ProbeReachability.lost` fires only on a
      session *close*, so a probe that was connected when the core restarted and never comes back
      has no disconnect event at all, and its sensors stay frozen for ever. The sweep iterates
      probe *objects* rather than sessions, so that case is covered by construction.

      *Deliberately not covered, and it is the honest boundary of a probe-level detector.* One
      wedged sensor among five thousand healthy siblings changes nothing: the probe is delivering,
      so the predicate is false, and marking 4,999 working sensors Unknown to catch one would be a
      false claim that wrecks their SLA. `P-76` carries the probe-side half — the probe is the only
      party that can see dispatch-without-completion, on its own monotonic clock — and it reports
      that as a Warning with a count rather than as a state change.

      **Landed.** `delivery.ts` holds the rule as one pure `verdict()` with fourteen table-driven
      tests, including the two that eliminated the rejected designs: forty batches of a spool
      replay in a row must not trip it, and the start-up grace must hold. `delivery-watch.ts` is
      the sweep — edge-triggered, so three sweeps over a stalled probe write **one** transition
      rather than one each, which matters because every call re-evaluates every sensor under the
      probe and writes into the table uptime is computed from.

      `ProbeReachability` now records *why* a probe's sensors are Unknown, and only the owner of a
      reason can clear it: `found` is the link's, `resumed` is the sweep's. Without that split the
      sweep would decide a *disconnected* probe was fine again merely because it had stopped
      expecting results from it, putting every sensor under a probe nobody is talking to back to
      its last reading.

      One case a naive edge-trigger gets wrong, and it has a test: a probe that disconnects while
      silent and reconnects **still** silent. The reconnect clears the reachability entry — `R-05`'s
      rule — so a watch still holding its claim reads the next stall as no change and never marks
      it again. The sweep drops its claim the moment the link goes.

      `delivering` and `resultAge` are computed by the *core* from arrival times, so there is no
      protocol field and no version bump, and they work against a probe of any version — which is
      the point: a probe that has stopped delivering cannot be relied on to say so.

      `docs/state-machine.md` and `WORKFLOW.MD §13` say this now. Row 3 of the layer table covers
      both faults with one answer, because the sensor cannot tell them apart and should not: what
      separates them is `connected` versus `delivering`, and the second is the one that can be Down
      while the first is Up.

- [x] **P-76 — A probe can be delivering and still have sensors that are not being checked** · M ·
      P-74 · The honest boundary of `P-74`, which is probe-level by construction. One wedged sensor
      among five thousand healthy siblings changes nothing: the probe is delivering, so the
      predicate is false. Marking 4,999 working sensors Unknown to catch one would be a false claim
      that wrecks their SLA, so the core cannot fix this from arrival times alone.

      The probe can. It sees dispatch (`dueDispatcher`), completion (`spoolResult`) and shipping
      (`SpoolDrain`) on its own monotonic clock, so it can answer "am I dispatching checks that
      never come back?" — a provable fault rather than a statistical guess, because a check
      accepted by a runner *must* settle inside its own timeout. The design that scored highest in
      `P-74`'s judging proposed `checkFlow` as a state on the heartbeat, precedence-ordered
      (wheel not ticking / dispatched and not completing / completing but not reaching disk / every
      runner given up), with `sensorsBehind` as a count and a Warning rather than a state change.

      Also found by that reading and worth folding in: `spoolResult`'s `.catch` in `main.ts` logs a
      line and the reading is gone, counted nowhere — a small `P-74` of its own, two counters to
      close.

      **Landed, and narrower than the design that proposed it.** `CheckFlowWatchdog` answers one
      question — are dispatched checks settling? — rather than the five-code precedence ladder the
      design sketched. The other four codes it proposed are already channels: a latched pool is
      `poolState` (`P-62`), a probe delivering nothing is `delivering` (`P-74`), and a wheel that
      has stopped ticking shows in `schedulerLag`. Adding a second way to say each of those would
      have been a second alarm for one outage.

      **Two clauses, and the second is the whole of why this is not noisy.** Something outstanding
      far past any timeout is necessary; *nothing at all having completed since it was dispatched*
      is what separates a stopped runner from one slow check while the rest of the probe works.
      A check accepted by a runner **must** settle — both runners emit a result on timeout, on a
      worker or child dying, and on stop — so the first clause is a proved fault rather than a
      guess, and the second stops it firing on the ordinary case of a check taking its time.

      Warning rather than Down, deliberately. `ms.probe.delivery` is Down because a probe
      delivering nothing is monitoring nothing. This fires while the probe *is* delivering, so the
      sensors still completing are genuinely fine; `checksBehind` says how much of the probe is
      affected, and the core decides what that means for any sensor's state. Marking the healthy
      ones Unknown to catch the wedged ones is exactly the false claim `P-74` refused to make.

      The structural test grew a third directory. It read `src/runner/` for `P-61`, gained
      `listeners/` for `P-64`, and now `health/` — which is the pattern rather than the exception:
      a rule that only looks where the last defect was found is a rule that finds the last defect,
      so the list grows whenever a subsystem starts measuring itself.

      Left for its own ticket, as filed above: `spoolResult`'s `.catch` still logs and loses the
      reading, counted nowhere.

- [x] **P-81 — The delivery rule measured a duration out of wall-clock instants** · M · P-74,
      P-80 · From the `P-80` panel; the two clock findings were one defect with two faces, and both
      close together because the fix changes `verdict`'s interface.

      `CLAUDE.md`: *time is monotonic for scheduling, wall-clock for data.* `verdict()` computes
      `silentForMs = now - max(graceEndsAt, configSentAt, lastResultsAt, connectedAt)` from five
      wall-clock `Date`s. It is a **duration**, and it is on the wrong clock.

      **Backwards.** A step puts `since` in the future. `P-80` clamped `since` to `now` so the
      published `resultAge` is never a negative sample — but the watchdog still reads 0 for the
      whole duration of the step and is blind across it, and with `P-77`'s narrowing it does not
      heal on arrival either, because `configSentAt` is only re-stamped by an actual push.

      **Forwards.** The rule cannot tell an N-second step from N seconds of silence, and `settle()`
      applies the same jumped `now` to every probe in one pass — each `lost()` walking a subtree,
      opening a transaction, re-evaluating every sensor under it and writing a `sensor_state` row
      per sensor that moves. `AlarmEngine` in this same codebase bounds `maxPerSweep` with a
      comment naming a forward clock jump as the reason it exists; this path bounds nothing. A
      thirty-minute chrony step writes a spurious Unknown interval into the table SLA is computed
      from, for whole probes at a time, then a second transition each when results resume.

      **Landed as one change, not two.** The session carries `connectedAtNs`, `lastResultsAtNs`
      and `configSentAtNs` beside its `Date`s — the `Date`s stay, because `resultAge` and the API
      genuinely want the wall-clock answer — and `linkFor` turns them into ages when the link is
      read, which is the only place holding both the stamps and a monotonic clock. `verdict` takes
      `coreUptimeMs` and three ages, and its arithmetic is the exact dual of the `Math.max` over
      instants it replaces: the most recent anchor is the *smallest* age.

      **The one trap in the translation, and it is a real one.** Under `Math.max` over instants,
      an anchor that never happened was `?? 0` — correctly, because zero could never win a
      maximum. Under `Math.min` over ages the same `?? 0` reads as "just now" and would excuse a
      probe for the life of the process, so it is `Infinity`. There is a test named for that
      inversion alone, because it is the sort of thing a mechanical translation gets wrong and
      nothing else would catch.

      Neither clock defect is now *expressible* against the interface rather than merely untested:
      an age is a difference of two `process.hrtime.bigint()` readings, so it cannot be negative
      and no step can move it. The suite says so in a test that asserts the property rather than a
      scenario, since the scenario can no longer be constructed.

      **And the per-sweep cap, on `AlarmEngine`'s reasoning.** Twenty probes a sweep, with the rest
      counted into `deferred` and logged rather than silently skipped — `CLAUDE.md`'s rule that
      backpressure is visible. Monotonic ages make the clock jump unreachable, but a real
      core-wide outage still leaves every probe silent at once, and the honest answer is to mark
      them all without doing it in one transaction storm. What is deferred is still stalled thirty
      seconds later, and the test walks four sweeps to prove it clears.

- [x] **P-82 — Two blind spots the watchdogs had by construction** · M · P-74, P-76, P-80 · From
      the `P-80` panel. Neither was a slip; both were the design doing exactly what it said while
      the thing it said was not quite what an operator needs.

      **One stopped runner is masked by the other.** `#lastCompletionNs` is a single value, and
      `main.ts` feeds it from `spoolResult` — the one sink both `CheckPool` and `ProcessRunner`
      settle into. So `stalled` requires that *nothing on the whole probe* has completed for five
      minutes. On any probe running both worker checks and isolated EXE/Script checks, a wedged
      `ProcessRunner` can never set `checksCompleting` to 0, because the pool keeps refreshing the
      timestamp. `check-flow.ts`'s own header claims the opposite — "a runner that has returned
      nothing since is everybody's" — which is not what the code measures. Those sensors sit frozen
      with no alarm anywhere: `checksBehind` climbs, but it is declared with no limit and no lookup
      because `checksCompleting` was supposed to be the alarm. Fix: one watchdog per runner, or a
      per-runner `lastCompletionNs`, so a runner is judged against its own completions.

      **Landed as a per-runner clock.** The outstanding entry carries which runner accepted the
      check — the one place that knows, since the dispatcher chooses and both settle into one sink
      — and `completed` reads it back before deleting. A stall is now asked of the runner that is
      overdue rather than of the probe. A completion nobody can attribute moves no runner's clock,
      which is the conservative answer in both directions: crediting the wrong runner would hide
      its stall, crediting all of them would hide every stall.

      **`assignedSensors: 0` cannot tell "nothing to do" from "we never worked it out".**
      `verdict` short-circuits to `nothing-assigned`, and the number is `session.sentSensors.length`
      — what the core successfully built for this session. On every path where that computation did
      not happen it is still the `[]` from `#openSession`, and reads exactly like a legitimately
      empty probe: `assignmentsFor` throwing (logged once, connection kept, and on a stable
      installation nothing retries for days), or a probe below the config-push protocol version,
      where it is permanent for the life of the session. A probe carrying 300 sensors and checking
      none of them then reports `delivering: 1` — the exact failure `P-74` exists to catch, and
      `delivery.ts:8` names "an assignment list that never arrived" as one of its cases. The
      session already knows: `sentVersion === null` means nothing was ever computed. `ProbeLink`
      carries it as `configured` now, and `verdict` answers `unconfigured` rather than
      `nothing-assigned` — a distinct reason because it is a distinct fault with a distinct fix,
      and the message an operator reads must not send them to a probe host that is behaving.

      **With `configurable` beside it, so one outage stays one alarm.** A probe below the
      config-push version also has `configured: false`, and it also scans nothing — but `R-06`'s
      `protocol` channel already says so with its own lookup. That case short-circuits to
      `too-old` and this rule stays quiet about it.

- [x] **P-97 — A resume erased the idempotence guard the probe protocol depends on** · M · M-02,
      R-02 · Findings 28 and 7, which are one column doing two jobs. `last_result_at` is the
      high-water mark that makes the at-least-once protocol safe — `isStaleResult` discards
      anything no newer, and `writeRuntimes` refuses it a second time — and it was *also* how
      "nothing has been measured since the resume" was expressed, by being set to NULL. §3 needs
      the second; `drain.ts`'s guarantee that "a dropped connection costs a duplicate write rather
      than a lost reading" needs the first.

      **After any resume, duplicates stopped being duplicates.** A batch the core stored but never
      acknowledged — the probe keeps it spooled until it hears back — was re-offered and applied
      in full: `sensor_state` rows timestamped before the resume row, the two-step failure policy
      advanced a second time, `sensor_runtime` reading Down since 09:59 while the newest history
      row said Unknown at 10:05, and the alarms view raising an outage inside a window the
      operator had paused and already ended.

      **And it admitted readings measured inside the pause.** A probe that lost its link keeps
      scanning and spooling; it cannot be told about a pause it never received.
      `docs/state-machine.md` §3 assumes this away — "a paused sensor is not in its probe's
      configuration at all" — which is true only of a probe currently connected to receive that
      configuration. Neither the spec nor the code had a name for "a disconnected probe still
      scanning a sensor the core has since paused", and those readings wrote Up and Down
      transitions into a planned maintenance window that uptime and SLA are computed from.

      Migration 042 adds `resumed_at`. `last_result_at` keeps its one job and is never nulled; a
      sensor reads as never-scanned while `resumed_at` is at or after it, and a result is stale
      unless newer than **both**. The third test is the one that matters for the shape of the
      fix — a result measured *after* the resume still applies, because the guard is a floor and
      not a wall.

- [x] **P-98 — Two queries build the same row and only one of them was updated, twice** · S ·
      M-02 · Found by `P-97`'s own suite run, and it is the second instance. `RuntimeRow` is
      asserted from raw SQL so the compiler cannot check it, and two queries feed `toRuntime`:
      `loadRuntimes`, which the machine decides on, and `readSensorState`, which answers
      `GET /sensors/:id/state`. They carry separate column lists.

      `P-85` added `channel_state`/`channel_cause` and updated only the first. The read side got
      `undefined`, which `channelVerdict` read as "nothing judged" — so the API reported no
      channel verdict while the machine had one, **silently**, and it shipped. `P-97` added
      `resumed_at` the same way, and `neverScanned` calls `.getTime()` on it: that one threw, so
      `GET /sensors/:id/state` answered 500 for every sensor. It was caught by an acknowledgement
      test asserting over HTTP — nothing that was looking for it.

      Both columns added, and `runtime-row.test.ts` now parses `RuntimeRow` and asserts that
      every **required** field is selected by both queries and every **optional** one by at least
      one. The optional/required split is not a convenience: the type already says which fields a
      query may skip — `acknowledged_by_kind`/`_label` are the single-sensor read's alone
      (`M-13`) — and the guard was written asserting both queries carry everything, which failed
      immediately and correctly on exactly those two.

      A guard rather than a convention, because the convention *was* written down, in the first
      query's own comment, and did not survive the second column.

- [x] **P-99 — One future-dated result froze a sensor's history permanently** · S · M-02, R-06 ·
      Finding 10. `CheckResult.at` was bounded only by "parses to a number" — no upper bound
      anywhere. `last_result_at` is a high-water mark: `isStaleResult` discards everything no
      newer and `writeRuntimes` refuses to move a row backwards.

      So one result from a probe whose RTC is wrong — a VM restored from a snapshot, a dead CMOS
      battery — set the mark to 2030, and every genuine result after it was counted stale and
      dropped, including the ones reporting a real outage. No `sensor_state` row was ever written
      for that sensor again; its SLA read 100% through a multi-day outage and no alarm could fire
      because the state never moved. The alarms view sorts on `since`, so a future `since` sorted
      it to the wrong end and rendered a negative duration.

      Nothing self-healed. The only thing that ever reset `last_result_at` was a resume, and
      `P-97` deliberately stopped even that — so this got permanently worse the same day, which
      is the argument for fixing both together.

      **Refused, not clamped.** Clamping writes a reading at a time nobody measured it, and a
      value the system cannot stand behind is a gap. The bound is fifteen minutes, which is
      generous on purpose: honest forward skew is seconds, and a tight bound would discard good
      data during ordinary NTP drift. What is being excluded is a clock that is years out.

      **And it is visible.** The panel noted that the counter which saw this was unreachable —
      `IngestionService.stats()` reaches no health sensor at all. `resultsFutureDated` is now a
      Core Health channel, so refusing the result does not simply move the silence: a rising line
      is one probe host with a wrong clock, and it names a fix an operator can carry out. Zero on
      every healthy installation, which is what makes any movement worth looking at.

      The other discard counters are deliberately not on it: they describe batches that were
      rejected and will be re-offered. This one describes data that is gone.

- [x] **P-100 — The duplicate-lookup-id guard could never fire for an id this build ships** · S ·
      M-06 · Finding 25. The condition was `replacing !== undefined && !builtIn &&
      !this.#builtInIds.has(definition.id)` — a question about the *id* rather than about what
      currently holds it. `#builtInIds` is populated when a built-in registers and is never
      cleared, so for every id shipped in this build the third clause was permanently false.

      Two operator files claiming `ms.snmp.if-oper-status` were therefore resolved by directory
      order, with nothing in `problems()` and one clean entry in `GET /lookups`. Every interface
      sensor was judged by whichever file happened to sort later, and **renaming a file silently
      changed sensor states**. The same mistake on an id with no built-in was correctly refused,
      which is exactly what made this invisible — and is why the existing test, which uses such
      an id, stayed green.

      Asks whether the *held entry* is a built-in now. Overriding a built-in once is still the
      whole point of the directory; the second override is what nobody decided.

- [x] **P-101 — A lookup entry that can never match, and one that matches everything, were both
      accepted** · S · M-06 · Finding 26. One entry shape serves both lookup types and is not
      discriminated on `type`, so the JSON schema marks `value`, `from` and `to` all optional.

      A singleInt entry with a forgotten `"value": 3` passed the schema and `validateLookup`, and
      `applyLookup`'s `each.value === value` never matched it: the reading fell to
      `undefinedState` — Up, on most definitions — while the message told the operator the lookup
      "does not define" a code they can see in their own file. An interface in testing state read
      Up for ever. The mirror case is a range entry with neither bound: `(-inf, +inf)` trips
      neither the empty-range check nor the overlap check when it is the only entry, so one
      unbounded entry was accepted and forced **every** reading to its state.
      `docs/state-machine.md` §2.2.1: a definition that is wrong is refused, not repaired.

      Open at one end stays legal — "above 90 is critical" is what these are for — so the rule is
      that a range must bound at least one side, not both. A test asserts that half too, because
      a fix that refused those would be worse than the defect.

      **`LookupDefinition` in TypeScript already required `value`; the JSON schema did not.**
      That disagreement is the finding, and it settles where the fix belongs. Nothing constructed
      in this codebase can be malformed this way — only something read off disk — so the schema
      is the only thing that can see it, and `CLAUDE.md` says validate at boundaries with JSON
      Schema. The `items` schema is discriminated on `type` now: `value` required for singleInt,
      at least one of `from`/`to` for range.

      Written first as a hand-rolled check inside `validateLookup`, which passed its tests and
      then failed lint with "unnecessary conditional, the types have no overlap" — the compiler
      correctly pointing out that the parameter type already promises the field is there. That is
      the same disagreement showing up from the other side, and moving the rule to the boundary
      resolves both. The tests go through `register` for the same reason, over a JSON round-trip:
      calling `validateLookup` directly would assert on a shape the compiler says cannot exist.

- [x] **P-102 — A multi-tag filter could not match tags spread across the inheritance chain** ·
      S · D-05 · Finding 14. The recursive CTE's base case was `tags_folded(tags) @> $tags` — one
      object had to carry **every** requested tag before the descent started. So an AND-filter
      whose tags sit at different levels of one chain matched nothing at all: a group tagged
      `paris`, a device under it tagged `production`, and `?tag=paris&tag=production` returning an
      empty page.

      The effective-tag rule the rest of the system uses is the union of an object's own tags with
      its ancestors' — `MessageContextLoader.#factsOf` computes exactly that for `%tags`, under a
      comment asserting "the object filter already resolves them that way". It did not. A
      notification about that sensor interpolated "paris, production" while a search for those two
      tags could not find the sensor it was about, and `repository.ts` says in as many words that
      a filter which quietly under-reports is worse than one that errors.

      One walk per tag, intersected. An object effectively carries a tag exactly when it is in the
      subtree of something carrying it, so "carries all of them" is the intersection of those
      subtrees — which keeps the cheap shape, each walk still starting from the few rows the GIN
      index finds, rather than accumulating tags down a walk of the whole tree on every filtered
      list.

      The existing case passed because `Berlin DC` carries both of its tags itself. Every fixture
      in that file put the ANDed tags on one object, which is the single arrangement the old query
      could match.

- [x] **P-103 — A sensor moved off a dead probe stayed Unknown for ever** · M · R-05 · Finding 16.
      `lost` snapshots which sensors a probe was carrying, and the snapshot outlived the topology
      it was taken from. Moving the device onto a working probe — which is what an operator does
      when a probe host dies — left every moved sensor in `#unreachable`, so `#withProbeFacts`
      overlaid `probeReachable: false` and layer 3 answered `unknown`/`probe` for every result the
      *new* probe delivered.

      No transition was recorded, because the state did not change, and the cached facts kept
      `probeReachable: false` so every later result short-circuited the same way. The sensors were
      dark and unable to alarm for as long as the dead probe stayed away — permanently if it was
      decommissioned, which is the usual reason the device was moved. Neither the code nor
      `docs/state-machine.md` had a name for "a sensor whose current probe is delivering but which
      the core still believes is behind a lost one".

      `resync` re-derives the overlay from the tree, wired to `object.moved`/`created`/`cloned`/
      `deleted` through an audit sink. **Free when nothing is offline** — an empty map means there
      is no overlay to invalidate — so the `object.created` objection that shaped `P-93` does not
      apply: an installation with nothing offline pays one `Map.size` check per mutation.

      **Through the caller's transaction**, which the first version got wrong: reading on its own
      connection saw the tree as it was *before* the move, which is the whole thing being
      corrected. That is `P-88`'s mistake from the other direction, and the test caught it
      immediately because it went through the sink rather than calling `resync` by hand.

      Both directions are pinned: a sensor leaving an offline probe goes back to what its last
      reading says, and one arriving under an offline probe becomes Unknown — saying Up about a
      sensor nothing is scanning is the claim `WORKFLOW.MD §12` forbids.

- [x] **P-104 — Threshold triggers were dead between state changes, and four tests said otherwise**
      · M · N-03 · Finding 17, and the largest single hole the panel found. The ingestion write is
      the only path that sees new channel readings, and it called `AlarmEngine.react` **only when
      the batch produced a state transition**, passing only the sensors that transitioned.

      A state trigger fires on a transition, so that is complete for it. A threshold trigger fires
      on a *reading*, and a reading changes without the state changing. So:

      - **It never armed.** A device with `rtt above 80`, created while rtt was 20, on a sensor
        that stays Up: rtt rises to 200 and stays there for hours. Every batch produces a
        `RuntimeWrite` and no `StateTransition`, so `react` is never called, `notification_alarm`
        stays empty, and no notification is ever queued.
      - **It pages about breaches that ended.** An alarm armed by `TriggerSync` with a ten-minute
        latency, cleared two minutes later while the sensor is still Up: no transition, so no
        stand-down, and the sweep fires eight minutes after the breach ended with the stale value
        on the row.

      `react` has three call sites — this one, `reevaluate`, and `TriggerSync` on configuration
      edits — and none of them is periodic. The engine's own sweep comment relies on the opposite:
      "`react` stands the alarm down the moment a reading clears it". Nothing was calling it to.

      **The gate is global on purpose.** Working out which sensors in a batch are covered by a
      threshold trigger *is* the inheritance walk `react` performs, so asking that first would
      cost the thing it is meant to avoid. One indexed existence check answers `false` on every
      installation that has not configured a threshold trigger, and those pay nothing on the hot
      path; one that has pays a full reconcile per batch, which is what making the feature work
      costs.

      **The tests were green because the helper made the call production did not.**
      `threshold-engine.test.ts`'s `scan` called `engine.react` unconditionally — more generous
      than the ingestion path has ever been. It mirrors the production rule now, and reverting the
      fix turns four of them red, including the two the panel named: 'notifies nobody about a
      breach that clears before its latency' and 'waits out the latency, then notifies and
      clears'. Seventeen tests over a feature that did nothing.

- [x] **P-105 — Leaving the armed state deleted the alarm, losing a recovery and re-paging an
      outage that never ended** · M · N-02 · Findings 18 and 19, which are one rule seen twice.
      `reconcile` ended an alarm outright on any non-Up exit: `isRecovery(current) ? recover :
      cancel`.

      **Finding 18 — no recovery after coming back through Warning.** A ping sensor with a `loss`
      warning limit goes Down and pages. The link returns flaky: 30% loss, so query state Up,
      channel state Warning, worst Warning. The alarm is cancelled with nothing queued. The next
      scan is clean, `reconcile(null, 'up', …)` is `idle`, and the operator paged "ping-01 is
      down" is never told it came back — while `CAPABILITIES.MD §5.1` promises a recovery
      notification on return to Up, and the sensor did return to Up. `docs/state-machine.md §4`
      lists `down -> warning` as ordinary.

      **Finding 19 — a probe blip re-arms a fresh chain.** 09:00 the sensor goes Down, the initial
      page is delivered, escalation due 09:30. 09:10 the probe restarts: sensors read
      `unknown`/`probe`, the alarm is cancelled and the 09:30 deadline with it. 09:11 it
      reconnects, `found()` puts the sensor straight back to Down with `since` reset, and a *new*
      alarm arms at phase `pending` with zero latency — a second "is down" for an outage that
      never ended. A probe flapping every twenty minutes never escalates at all and pages once per
      flap per Down sensor. `CLAUDE.md`: one outage, one alarm.

      One rule fixes both: **only a pause ends an alarm.** That is a decision that the outage is
      not being watched any more (§3), so there is nothing to escalate and nothing to announce.
      Everything else — flaky, Unknown, anything that is neither recovered nor switched off —
      *suspends* it, reusing the `suppress`/`resume` machinery written for an acknowledgement
      lapsing, which is the same question about a different interruption. Nobody is paged in
      limbo, the eventual return to Up still owes its recovery, and a return to the armed state
      picks the chain up where it stopped.

      The test that asserted the old behaviour bundled `unknown`, `paused` and `warning` into one
      loop expecting `cancel` — the mechanism, not the requirement. The requirement is that none
      of them is a *recovery*, which still holds and is asserted separately.

      **And the two scenario tests were rewritten before they were trusted.** Written first from a
      hand-built suppressed alarm, they passed under the mutation that removes the fix — a state
      production could no longer reach, which is entry 7's defect exactly. Walked as sequences,
      all three die under it.

- [x] **P-106 — Every counter reading in a batch divided against the pre-batch baseline** · S ·
      T-02 · Finding 23. `counterBaselines` is loaded once per batch and was never advanced while
      the batch was walked, so each reading was compared against the sample that preceded the
      *whole batch* rather than the one before it. `counterSeen` fed only the end-of-batch save.

      A batch routinely carries many consecutive scans of one sensor — a spool drain after an
      outage is exactly that, up to `spoolCatchUpMaxRows` of them — so every stored rate became
      the running average since the pre-batch sample. Traffic of 6,000 octets in the first minute
      and none afterwards stored 100, 50, 33.3, 25 … instead of 100, 0, 0, 0. Worse, the span from
      the frozen baseline grows with every reading, so once it passed `MAX_GAP_MS` every remaining
      one came back `stale`: a two-hour replay produced **zero** counter samples for the whole
      window and `counterStale` climbed by one per reading.

      Every existing test submitted one result per `acceptResults` call — the single shape that
      cannot show this — and a constant-rate fixture would have hidden it anyway, because the
      running average equals the instantaneous rate exactly when the rate is constant. Both new
      cases are deliberately non-constant.

      The batch is also sorted by time now. The state machine already sorts each sensor's results
      because it is a fold over time; a counter is the same kind of fold, and nothing in the
      protocol *promises* the order a running baseline needs.

- [x] **P-107 — The counter baseline was committed before the batch that moved it** · M · T-02,
      R-02 · Finding 24. `#prepare` saved `channel_counter` in its own transaction, before
      `#decide` and before `Ingestor.submit`. A refused batch — queue-full during an alarm storm —
      was never stored, and the probe kept it spooled and re-offered it; but the baseline had
      already advanced to that batch's own last sample.

      On the resend every reading divided against itself: `current.at - previous.at` is zero for
      the last and negative for the earlier ones, so `rateFrom` answered `no-elapsed` for all of
      them and produced no samples at all. The interval's traffic was gone for good, with nothing
      counted and no log line, during exactly the pressure event an operator was investigating.

      `SensorStateService.forget` exists for precisely this hazard on the state side; the counter
      store had no equivalent. Rather than add a second rewind, the baselines now ride the batch
      and are written in the samples' own transaction — the same argument `IngestBatch.states`
      already makes in as many words. If the write rolls back, the baseline rolls back with it.

      **The empty-batch short-circuit had to learn about them too.** `submit` accepts a batch with
      no samples and no state rows without queueing it, and a counter's *first* reading produces
      no sample — it is the one reading that has nothing to divide by, and the one that most has
      to move the baseline. That is the same point the comment above that check already makes
      about failed checks, which is how it was spotted: twelve counter tests went red at once.

- [x] **P-108 — The unique index silently ate transitions, three different ways** · M · M-02 ·
      Findings 8, 22 and 9. `sensor_state` is keyed on `(sensor_id, time)` with `ON CONFLICT DO
      NOTHING`, and that guard was doing two jobs it cannot both do. It makes a *replayed* batch
      idempotent, which is right. It also discarded any genuinely new transition landing on an
      occupied instant — and `writeStateChanges` has no such guard, so `sensor_runtime` took the
      change the history threw away. The two then disagree about what the sensor is, permanently,
      and uptime is computed from the one that lost the row.

      - **Two callers reusing one `now`.** `sweepPauses` takes a single timestamp and passes it to
        `releaseElapsed` and to every iteration of both loops; `CompositeAuditSink` hands
        `ScheduleSync` and `DependencySync` the same `at`, and both return true for
        `object.moved`. A sensor released by a dependency and paused by a window in one tick
        wrote `unknown` then `paused` and kept only the first — so a maintenance window was
        accounted as Unknown for its whole length, and `U-02`'s stream never announced the pause.
      - **Two clocks.** Result transitions carry the probe's wall clock, which the protocol says
        the core does not rewrite; every other transition carries the core's. A probe two minutes
        fast leaves its sensors' newest row *ahead* of the core, so a pause at 12:00:30 sorts
        before an `up` at 12:02:00. `GET /state-log` reported Up with `durationMs: null` while the
        badge said Paused, the `previous_state` chain read backwards, and any uptime booked the
        entire maintenance window as monitored Up. The same shape with `reachability.lost` books a
        whole probe outage as Up.
      - **The backstop that could not report.** `reevaluate` discarded this function's return and
        reported `transitions.length` — the count it *tried* to write — as its result, as
        `#transitions` and as `#reevaluations`. The comment promising "the row count comes back so
        a drop cannot pass unnoticed" was honoured by no caller.

      `reactionTime` in `dependencies/pauses.ts` had already fixed this by construction for one
      caller, with a doc comment explaining that the collision "is a corrupted SLA rather than a
      cosmetic glitch". It was right; it was in one of the four places that needed it. The rule
      now lives in `writeStateHistory`, so no future caller has to know.

      **An identical row is still left to collide**, and that half is pinned by its own test:
      same sensor, same instant, same state and cause is a batch arriving twice, and advancing it
      would duplicate the timeline instead of deduplicating it.

- [x] **P-109 — A sensor created inside a closed schedule window scanned before anything paused
      it** · S · M-09, M-10 · Finding 21, and the same shape as `P-93` one subsystem over.
      `ScheduleSync.invalidates` skipped `object.created`, justified by "a sensor created inside a
      closed window starts unpaused and is paused by the next sweep, within a minute and before
      its first scan interval has usually elapsed".

      The cost half of that was right — a recompute walks every sensor and discovery creates them
      in thousands, which is the regression `P-04`'s budget caught in `M-08`. **The timing half was
      contradicted by the probe's own scheduler.** `TimingWheel.add` documents and implements the
      opposite: "the first firing is the next tick that lands on the sensor's own phase — not a
      whole interval away", so the first scan lands uniformly in (0, intervalSeconds] while the
      sweep is armed at the next wall-clock minute. At the registry default of 60 s that is a coin
      flip; below 60 s the scan always wins.

      So a sensor created at 02:00 on a weekend-maintenance window scanned the target being
      patched, wrote a `down` transition timestamped *inside* the window, and armed a chain — a
      page at 02:00 out of the exact window that exists to prevent one. §3 says a paused sensor
      has "no scans, no notifications, no uptime accrual", and its storage note says the flags are
      derived "on every pause, resume, move and create". The manual source was already asymmetric
      with this: `ObjectService.create` recomputes parent pauses at birth, with the comment
      "without this it would scan, alarm and record readings inside a maintenance window nobody
      reopened".

      The subtree-scoped recompute that was filed for later is here: a create resolves the flag
      for the sensors it made and nothing else. A bulk create emits one mutation per object, so
      the whole batch is named.

      **`object.cloned` takes the full recompute instead**, and was missing from the list
      altogether — undocumented, in both this sink and the dependency one. It cannot be narrowed:
      cloning a device emits *one* mutation, for the device, and the sensors it produced are not
      in it. Clones are rare and bounded, which is the argument that already admits
      `object.moved`.

- [x] **P-110 — A probe already gone when the core started was never marked lost** · S · R-05 ·
      Finding 27. `lost()` has exactly two callers: `ProbeEndpoint.#handleClose`, which fires only
      for a session that *existed*, and `ProbeDeliveryWatch.settle`, which returned early for any
      probe whose link is absent — `verdictFor` answers null for a disconnected probe, because
      delivery is `R-05`'s question rather than that rule's. Nothing in `main.ts` seeds the set at
      boot.

      So a probe whose host or site went away while the core was down had no session to close and
      no verdict to reach. `loadRuntimes` restores `probeReachable: true` optimistically — for the
      good reason that a restart must not generate its own alarm storm — and layer 3 never fired:
      its sensors read Up, green in the tree, absent from the alarms view, `since` from before the
      crash, and **no `sensor_state` row at all**, so the whole multi-day absence integrated as Up
      for any uptime or SLA figure. The same probe dropping while the core is running becomes
      Unknown within seconds, so a restart silently reversed the correct answer for an outage that
      was still in progress.

      This file's own comment claimed the staleness is corrected by "the probe's own reconnect *or
      its absence*". Absence corrected nothing.

      The sweep already iterates every probe in the object table, so the branch goes there, after
      the same grace the delivery rule uses and for the same reason. `#handleClose` still marks the
      ordinary disconnect, so this is a backstop for the case nothing else covers rather than a
      second opinion on one that is covered — `held !== undefined` is what keeps it to one.

      **Not reproduced end to end.** The panel's own settle is a six-step manual procedure — kill
      the core, stop the probe, restart, wait past the grace and two sweeps — which the unit suite
      cannot express. The defect is settled by reading (two callers, neither reachable for a probe
      that never connects, nothing seeding at boot) and the fix is pinned at the sweep: marked
      after the grace, silent during it, and once rather than once per sweep. What is *not*
      covered is the wiring from a real restart to that sweep.

- [x] **P-96 — `pool-sizer`'s timer test was load-sensitive, and only under the whole-repo run** ·
      S · P-44 · Noticed while verifying `P-94`/`P-95`: `recomputes on its own timer, and stops
      when told` (`packages/probe/test/pool-sizer.test.ts:129`) failed once in a full `npm test`
      and has not failed since under any narrower run.

      **Measured, so the flake is not a guess:** 0 failures in 60 runs of the test alone, 0 in 12
      runs of its file, 0 in 4 runs of the whole `@ms/probe` suite. The one failure was in the
      monorepo run, where core's ~2,000 database tests are saturating the same Docker VM.

      The shape is rule 2 from `docs/findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md`
      — a constant chosen so the assertion holds. `intervalMs: 5` against a `delay(40)` window
      asserts `>= 2` ticks, which needs the event loop to be responsive within ~20 ms; under
      contention it is not. Nothing about the sizer is wrong, and a slower interval with a
      proportionally longer window would prove the same property without racing the scheduler.

      Not folded into `P-94`/`P-95`: it is in a package neither of them touches, it predates them
      (`packages/probe/test/pool-sizer.test.ts` last moved in `P-75`), and a flake fixed in the
      same commit as a behaviour change is a flake nobody will be able to attribute later.

      **Fixed by waiting for the property instead of sleeping past it.** `>= 2` ticks after a
      fixed `delay(40)` is a claim about how responsive the event loop is, not about the sizer;
      the loop now waits until the timer has fired twice, with a deadline generous enough that
      only a *stopped* timer trips it. The stop half was already deterministic and is kept as it
      was — `clearInterval` is synchronous and `size` is synchronous, so nothing can be in flight
      when `stop()` returns, and anything arriving after it is a timer that was never cleared.

      Both halves mutation-tested: a `stop` that does not clear, and a timer that fires without
      sizing. 0 failures in 15 consecutive runs of the file.

- [x] **P-95 — The restart catch-up window advanced past whatever the batch limit truncated** ·
      M · M-10 · Findings 15 and 29, which are the same defect reached from two directions.
      `PauseSweep` starts at the epoch so the first pass after a restart reconciles every window
      that opened while the core was down — which means `startedIn` returns *every pause currently
      in force*, oldest first, capped at 200. `#since` then advanced to the sweep's start time
      whether or not the page was full, so anything past the cap could never match
      `starts_at > since` again.

      Unlike the `expired` half, which is level-triggered on `paused_until <= now` and self-heals
      over successive sweeps, this one is window-triggered and the truncation is permanent.
      Nothing else sets those flags: `recompute` only derives them for pauses in force when it
      runs, and it runs on a pause, a resume, a move, a create or a clone of that subtree. An
      installation with a couple of hundred long-standing pauses would silently never apply a
      maintenance window that opened during a restart — its sensors keep scanning through the
      planned outage and alarm, which is the failure pausing exists to prevent — and the window
      later "expires" through the `due` loop, whose recompute finds the flags already false and
      writes nothing, so no log line records that it did nothing.

      **Two things had to be right, and the second only showed up under test.**

      The obvious fix — "advance only when the page was not full" — starves: `startedIn` returns
      in-force pauses regardless of whether their flags are applied, so re-asking the same window
      returns the same oldest rows for ever and the 201st is never reached. The watermark has to
      be a **keyset** — `(starts_at, object_id)`, unique and totally ordered, the same reason
      `object_parent_name_id_idx` carries `id`. Ties matter: a bulk pause written in one
      transaction shares an instant.

      And the cursor cannot round-trip through a JS `Date`. `timestamptz` holds microseconds and
      `Date` holds milliseconds, so a truncated cursor lands *before* the row it was taken from
      and the walk reads that row again for ever — which is exactly what the first version of
      this fix did, silently, until the test caught it. The cursor is Postgres's own `::text`
      form, opaque to everything but the query that produced it.

      The finding's own suggested check — `report.started.length < batchSize` — would also have
      been wrong: `started` holds only the windows that actually moved a flag, not the page.

- [x] **P-94 — A schedule window opening wrote the schedule's name over the operator's pause
      message** · M · M-09, M-10 · Finding 20. `SchedulePauses.recompute` passes the schedule's
      text to `reevaluate` in *both* directions, justified by "reevaluate blanks the message for a
      sensor that is resuming, so the same call covers both". That holds only when the sensor
      fully resumes — precisely the case where the message does not matter.

      `operatorDecided` is true for **any** paused decision, and `PAUSE_SOURCES` ranks `schedule`
      above `manual`. So a sensor held by both reported cause `schedule`; when the window opened
      the cause moved to `user` — a real change, so a transition was written — and the message
      written was the schedule's text at the instant that schedule stopped being the reason for
      anything. At 08:00, with office hours open, the detail page and the state log both read
      "outside the Office hours schedule", the operator's "replacing the PSU" was gone from the
      row and the newest history entry, and `since` reset so "paused for 12h" restarted at zero.

      **The message has to describe the cause that is reported**, so the fix is not to suppress
      the schedule's words but to use the right ones. `reevaluate` takes the causes a caller is
      entitled to speak for; when the decided cause is not one of them, the words come from
      whoever owns it, and only `object_pause` knows what an operator typed —
      `PauseRepository.messagesFor` resolves the nearest in-force pause up each sensor's chain,
      asked only when a scoped caller actually meets a sensor paused for something else.

      `pause-precedence.test.ts` walks this exact transition and asserts `state` and `cause` and
      never `message`, which is why it was green. The new case needed the wall clock rather than
      the block's fixed dates: a manual pause is stamped `new Date()`, and a schedule
      re-evaluated at a date before that pause exists is not the situation under test.

- [x] **P-90 — The rollback `P-80` added to `lost` was never added to its mirror** · S · R-05 ·
      Finding 11. `#online` drops the `#byProbe` entry and every `#unreachable` id *before* the
      transaction that writes the recovery, and nothing put them back when it rejected — the exact
      shape `P-80` fixed one method above, comment and all.

      A rejected transaction then left the database holding `unknown`/`probe` for all 300 sensors
      while the process believed the probe was fine: `offlineReason` answers undefined, the
      sweep's `held === 'silence'` branch can never fire again, and the retry path is gone the way
      `P-77`'s shadow set lost it. The recovery transition is a permanent hole in the history, and
      the sensors read Unknown until each one's next result. The rejection also escaped `resumed`
      into `ProbeDeliveryWatch.settle`, which documents itself as never throwing, skipping every
      probe after it in the pass.

      Rolled back and swallowed now, for the reason `lost` gives. The test needed a stub that can
      succeed once and fail once, which is the only way to reach this path at all.

- [x] **P-91 — A rejected state broadcast shut the whole core down** · S · U-02 · Finding 12.
      `publishStates` is an `afterCommit` hook, and `Database.tx`'s hook loop try/catches only the
      *synchronous* call. `StateBroadcaster.publish` queries the pool outside any transaction, so
      a rejection from that query escaped to `unhandledRejection`, whose lifecycle handler logs
      fatal and calls `shutdown({kind:'error'})`.

      A pool timeout under ingestion load, or a Postgres failover, therefore stopped ms-core — at
      the moment the database is unhealthy and monitoring matters most — over a broadcast whose
      transaction had already committed and whose failure costs a repaint, not a fact.

      **The guarantee went into `publish` rather than into the caller's `.catch`.** There is
      nothing a caller could usefully do with the error, and a second hook added later would have
      to remember. `publish` now cannot reject, and a test says so.

- [x] **P-92 — Revoking a credential did not invalidate the ETag** · S · S-06, D-04 · Finding 13.
      `credential_set_touch_owner` fired `AFTER INSERT OR UPDATE` only. Every sibling trigger that
      guards inherited content includes DELETE, and `object_setting`'s carries the comment
      explaining why.

      `CredentialVault.clear` is a plain DELETE and nothing else writes to `object`, so no version
      moved and `chainValidator`'s digest was unchanged. A client holding the previous ETag got a
      304 and went on rendering — and acting on — a credential that had been taken away. The
      route's own comment says the chain digest exists so that "a 304 there would hide a revoked
      credential"; it did exactly that. Only a client that never sends `If-None-Match`, or an
      unrelated change that happened to bump a version in the chain, ever saw the revocation.

      Migration 041 redefines the trigger. `object_touch_owner` already handled `TG_OP = 'DELETE'`
      through `OLD.object_id`, so there was nothing else to write. The existing test covered the
      INSERT direction only, which is why this survived.

- [x] **P-93 — A sensor created under a Down master was never held, and the stated fallback did
      not exist** · S · M-11 · Finding 6. `invalidates` skipped `object.created`, justified by the
      claim that such a sensor "is picked up by the next state change of that master or by the
      next sweep". Neither is true. There is no periodic dependency recompute anywhere — the only
      dependency work in `sweepPauses` is `releaseElapsed`, which returns `NOTHING` unless a
      `dependency_clear_at` is due — and the next state change of the master does not arrive while
      it stays Down, because `react` runs on the transitions a *result batch* produced and a
      master sitting at Down produces none.

      So the new sensor stayed in the probe configuration, scanned through the outage, failed,
      went Down and armed its own alarm: one outage, two alarms, out of the exact topology the
      dependency exists to collapse, for the whole duration. A device-template application, a
      clone or a rediscovery reaches it the same way an operator does.

      **The original objection was right and is what shaped the fix.** Discovery creates sensors in
      thousands and a recompute walks every sensor, so a create resolves the flag for the created
      sensors *only* — `applyPauses` gained an optional id filter, and a create costs one indexed
      query over its own batch rather than a settle over the tree. A brand-new sensor is nobody's
      master, so nothing can cascade outward from it.

- [x] **P-85 — The channel verdict was the one fact the machine read and never stored** · M · M-04,
      M-08 · From the state-machine review panel, finding 1 of 29. `sensor_runtime` held every
      input §2 reads except §2.2's answer, under a comment saying so deliberately: "a limit
      breach remembered across a restart would be a verdict on a measurement nobody took."

      The reasoning does not survive the row it is written on. Two columns to the left,
      `state = 'down', cause = 'limit'` — the *conclusion* was always persisted. Only the premise
      was thrown away, so anything that re-ran the machine without a reading reached a different
      answer from the same row.

      A breach carries `consecutive_failures = 0` — the check succeeded, the reading did not — so
      rebuilding with no verdict says "last scan fine, nothing judged" and layer 5 answers Up.
      `reevaluate` then wrote that Up. **Acknowledging a sensor that was Down on a limit destroyed
      the acknowledgement it had written three lines earlier, in the same transaction**, and the
      API still answered `{acknowledged:[id], refused:[]}`. The sensor left the alarms view, a
      recovery that never happened went into the table uptime and SLA are computed from, and the
      unchanged breach raised a second alarm on the next scan — one outage, two alarms. The same
      reset fired on a lifted simulated error, which §7 promises "returns it to the truth", and on
      every probe reconnect, clearing every acknowledgement under that probe on the way.

      Migration 040 adds `channel_state`/`channel_cause`, both-or-neither by check constraint.
      Null for existing rows, because null means "nothing judged" and inventing a verdict from the
      current state would be reconstructing a measurement rather than remembering one: a row Down
      on a limit today reads Up once on its first re-decide and goes Down again on its next
      reading. A resume clears it with the rest of the interval nobody watched; a failed scan
      stores null, which is the machine's own rule rather than a shortcut.

- [x] **P-86 — Every re-decide used the default failure policy, never the sensor's** · S · M-03 ·
      Finding 3. `reevaluate` read `#policies`, and `#policies` was written only by `#warm`, which
      is reached only from `decide`. So every state change that is not a result — a pause, a
      resume, a schedule window, a dependency release, an acknowledgement, a simulated error, a
      probe returning — evaluated §2.1 with `warnFor: 1` whenever the policy was not already
      cached. It is empty after a restart, and `forgetPolicies` empties it on *any* setting change
      anywhere in the installation, so this was the ordinary case rather than a corner of one.

      A sensor under a group with `retryWarnings = 3`, sitting at two failures and Warning, went
      Down the moment its probe came back: a false transition into the history uptime is computed
      from, and a chain armed for an outage its own policy says has not begun. The mirror case is
      as bad — with `retryWarnings = 0`, a genuine Down re-decided as Warning and its alarm
      cleared.

      Resolved now, for the sensors it can change the answer for: §2.1 consults the policy on a
      failed scan and nowhere else, so pausing four thousand healthy sensors still resolves
      nothing. **Resolved and not cached**, because `resolveForObjects` reads on its own
      connection and cannot see an uncommitted move in the caller's transaction, while
      `object.moved` clears `#policies` from inside that transaction — caching the answer would
      pin the pre-move value with nothing left to invalidate it.

- [x] **P-87 — Pausing a master never released its dependents, and the test supplied the missing
      trigger itself** · S · M-11 · Finding 2, raised by three of seven lenses. §3 says a paused
      master does not hold its dependents by dependency — it is switched off, not measured Down.
      `DependencySync.invalidates` had no `object.paused`/`object.resumed` case, so they fell to
      `default: return false`. `react` is reachable only from ingestion with the transitions a
      result batch produced, and a paused master is excluded from `assignmentsFor`, so it produces
      no further results and no further transitions. Nothing had a bounded lifetime.

      Forty dependents kept `paused_by_dependency`, left the probe configuration, and were never
      scanned again — while `#dependencyView.holding` is computed from the master's *current*
      state, now `paused` rather than `down`, so `GET /objects/:id/pause` answered `paused: false`
      and `DELETE` refused with "this object is not paused". Silently unmonitored, indefinitely,
      unresumable, and unable to alarm; the switch could be repaired and they still never scanned.

      **The test that claimed otherwise called `dependencies.recompute` by hand three lines after
      the pause** — the exact trigger whose absence was the defect. Deleting those lines turned it
      red immediately. A test that supplies the missing step tests the step after it; the case now
      also asserts that the pause API agrees with the row.

- [x] **P-88 — The audit sink that exists to release a deleted master's dependents ran before the
      delete** · S · D-07, M-11 · Finding 4. `DependencySync` reacts to `object.deleted` precisely
      so that "a stale flag would not pause them for ever with no object left to point at" — but
      `ObjectService.delete` recorded the audit entry *before* `deleteIds`, and
      `CompositeAuditSink.record` fans out synchronously inside that transaction. The reactor ran
      while the master's rows were still present and still Down: `holding` still named it, nothing
      moved, `#settle` broke on round 1.

      The dependents were then dark rather than merely stuck — excluded from the probe
      configuration, and `pauseState` computing the holder from an object that no longer exists
      answered `paused: false`, so `resume` refused them too. An outage on any of them produced
      nothing at all, until some unrelated master elsewhere happened to drag a global `#settle`
      through.

      Moved after `deleteIds`, still inside the transaction. The entry is unchanged: `object`,
      `counts` and `refs` are captured before the delete, so the enumeration a mistaken delete is
      reconstructed from is exactly what it always was, and an audit entry still cannot exist for
      a rolled-back delete. The sink simply has to see the tree it is reacting to.

- [x] **P-89 — The dependency recovery delay was read from the master's chain and configured on
      the dependent's** · S · M-11 · Finding 5. `react` resolved `dependency.delaySeconds` on the
      recovered *masters*; `setDependency` writes it to the object carrying the *dependency*, with
      a comment saying why. The two coincide only in `device` mode, where the master sensor sits
      inside the device the setting lands on — which is the mode the existing test used, which is
      why it stayed green for a fortnight.

      In `object` mode — WORKFLOW.MD §5's "every branch-office device depends on the WAN link
      sensor" — the master is elsewhere in the tree, the value is not on its chain, and every
      recovery fell back to the registry default of 0. `GET` and the resolver went on reporting
      the configured value, so the UI showed a delay the engine never used. Each flap released and
      re-paused every dependent: two rows each per bounce in `sensor_state`, and a bounce longer
      than the scan interval plus the notification latency let the dependents arm and fire the
      alarms the setting exists to prevent.

      Resolved on the dependents now, via `DependencyRepository.dependentsOf` — the same downward
      walk `applyPauses` does. **The longest wins when dependents disagree**, because
      `dependency_clear_at` is one column on the master: releasing a dependent before its own
      configured delay is the failure being prevented, and holding one longer than it asked costs
      an interval on a device whose master has only just returned. In `device` mode they all
      inherit the same value and the question does not arise.

- [x] **P-84 — Tree build had not moved; the measurements had** · S · P-19 · Filed while writing up
      `P-80`–`P-83`'s budgets and settled the same evening. The answer is that there was no
      regression, and the way the wrong answer was reached is the part worth keeping.

      `creates a 5,000-object tree through the API inside its budget` has read 21.0 s (the `S-16`
      baseline recorded in `PLAN.md`), 22.8 s (2026-09-04 morning) and 25.9 s (2026-09-04
      afternoon). The budget is 30 s, so the margin is down from 30% to **14%**. Two of the steps
      have an explanation already in the test's own output — Phase 3 made each create write a
      `sensor_runtime` row (`M-02`) and check for a paused ancestor (`M-08`) — and the third has
      none. Nothing in `P-80`–`P-83` is on that path: object creation writes channels through
      `ObjectRepository.createChannels`, not the `ChannelResolver` path those tickets touched.

      **Five runs on a quiet machine gave 28.0, 26.9, 27.2, 28.0, 28.1 s — spread 1.2 s.** A tight
      spread, every sample above the recorded 25.9 s: that reads as real drift, and it was called
      real drift.

      **The bisect disagreed.** `2166bab` 23.8/23.7/23.7, `e109482` 23.6/23.7/24.3, `d6de81e`
      23.6/23.5/23.5 — no commit steps, which by elimination blamed a documentation commit whose
      only code change *removed* a duplicated query.

      **Re-measuring HEAD back to back with the bisect gave 24.1/23.7/23.8**, identical to every
      historical commit. The comparison had been against a number taken twenty minutes earlier,
      and that number was the thing that was wrong.

      **Within a batch the spread is ≤ 1.2 s; across batches on the same commit it is 23.7 to
      28.1 s.** Repeats inside one batch share whatever the environment was for those two minutes,
      so a batch reports its own *precision* and nothing about its *accuracy* — which is how five
      tight samples manufactured a regression. The tightness was the trap, not the reassurance.

      `serial` at HEAD is **23.7 s, 21% spare**, unchanged from before `P-80` when measured the
      same way in the same minutes. One systematic difference between the fast and slow batches —
      one process per container against three sharing one — is written down in the findings page
      as a hypothesis, because it is one uncontrolled variable among several and proving it was
      not what this ticket was for.

      **The rule:** two measurements are comparable only if they were taken in the same batch. The
      way to compare two commits is to interleave them, not to compare against a page written
      earlier. That now applies to every row in `docs/findings/2026-09-04-perf-budgets-*`.

- [x] **P-83 — Three tests that pinned less than their names claimed** · S · P-74, P-76, P-80 · From the
      `P-80` panel, and the sixth, seventh and eighth entries in the family
      `docs/findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md` catalogues. None is
      wrong; each simply cannot observe the property it is named for.

      **`counts an error as a completion, because the runner came back`.**
      `CheckFlowWatchdog.completed(sensorId)` takes no outcome, so the test can only call it five
      times and see `completing: 1` — it would pass identically against a `completed` that ignored
      outcomes, which is what it has. The property lives at `main.ts`, where
      `checkFlow.completed(result.sensorId)` sits unconditionally at the head of `spoolResult`, and
      `main.ts` has no test file. Wrap that line in `if (result.outcome === 'ok')` and the whole
      suite stays green — while a probe watching a network segment that has gone down reports
      nothing but errors, freezes `#lastCompletionNs`, and raises a Warning for monitoring
      correctly and reporting bad news. **Measured, then fixed**: the mutation left the whole probe
      suite green, including that test. `spoolResult` is extracted to `result-sink.ts` the way
      `P-43` extracted the config handlers, the property is asserted there against the one
      unconditional call that carries it, and the same mutation now fails two tests. The
      check-flow test is renamed to the smaller true thing it does pin — a stream of completions,
      whatever they were, is not a stall.

      **`does not fire on a probe replaying an hour of spool`**, billed in `P-74`'s commit message
      as "the trap the whole design turns on". All forty iterations pass `lastResultsAt: now` and
      `now + 30_000`, so `silentForMs` is 30,000 and `windowMs` 240,000 in every one — one
      assertion repeated forty times. `DeliveryFacts` carries no probe-clock field, so no
      implementation of `verdict` could fail it without also failing its neighbour. The property
      genuinely at risk — a probe shipping batches stamped an hour ago is not silent — belongs at
      the *endpoint*, which is where arrival and `result.at` actually differ: it is the one line
      that stamps the arrival clock, and nothing pinned it. The new test sends a batch whose
      results are stamped an hour ago and asserts the link's age is seconds. It fails against the
      rejected design — ageing from `result.at` — which the forty iterations could not do.

      **`P-79`'s own guard matched substrings** — fixed in `P-80` rather than left here, being one
      line. `code.includes(field)` meant a schema field whose name is a prefix of another
      (`sessionsOpen` against `sessionsOpened`) was satisfied by its longer sibling. The floor on
      the extracted count catches a regex that matches nothing; only a word boundary catches a
      match that is accidentally satisfied.

- [x] **P-80 — Twelve defects an adversarial review panel found in the watchdogs** · L · P-74,
      P-76, P-77, P-78, P-79 · A 109-agent review of `9a65f64..HEAD`, run in isolated worktrees,
      with three independent skeptics per finding and a majority needed to keep it. Twenty
      findings survived; twelve are fixed here, each with a test observed to fail against the
      unfixed code. The rest are `P-81`–`P-83` below.

      **Two of them are regressions this run's own tickets introduced**, which is the argument for
      the panel in one line.

      **The spool could not be trusted to say what it lost.** Three defects, all in the counter
      `P-78` had just added or the accounting around it. `#appendNow` wrote through
      `await this.#handle?.write` — an optional chain — and `close()` clears that handle, so an
      append after close short-circuited to a no-op, incremented `pending` and `bytes` for records
      on no disk, and *resolved*; because it resolved, `P-78`'s `.catch` never fired and
      `unwritten` stayed 0. It is reachable on every shutdown: the spool-drain hook runs first, so
      the runners are still settling checks into `spoolResult` when the handle goes. Second, `peek`
      consumed unparseable and blank lines without counting them into what `commit` subtracts,
      while `#countPending` counted them at load — a permanent residue in `segment.pending` that
      stopped `#reclaim` for ever, grew the spool to its cap, and then produced *two* false Errors:
      `spoolDropped` for results that were delivered, and a stalled drain. Third, `#corrupt` was
      incremented inside `peek`, which re-reads until the batch is confirmed — and the drain does
      not confirm on a retryable nack — so `P-79`'s new counter channel turned one torn record into
      a sustained per-second rate of unreadable results.

      **`P-77` broke the ordinary reconnect.** Narrowing `configSentAt` to the branch that actually
      sends configuration was right in itself, but the ordinary reconnect *is* `config-unchanged`:
      the probe keeps its fingerprint across a drop, so the core sends nothing and stamps nothing.
      That session then had no `configSentAt` and no `lastResultsAt`, so the window collapsed to
      start-up-plus-grace and a probe that reconnected two seconds ago was judged on the core's
      entire uptime — a false page, a `resultAge` of hours, and two spurious transitions per sensor
      per link flap, into the table SLA is computed from. `ProbeLink` had carried `connectedAt` all
      along; the rule was simply never given it. A probe cannot have been silent for longer than
      the session it is silent on.

      **`P-77` also fixed `checksBehind`'s worst case by creating a new one.** Counting over the
      assigned set was right; using the watchdog's own start as the reference for a sensor that has
      never completed was not. Any sensor assigned after the process came up was measured against
      the probe's whole uptime and counted behind from the instant it arrived. The amplifier is
      again the reconnect: the core's full push is chunked, so a `config-set` of the first 1,000
      drops the other 4,000 — `onDrop` clears their history — and the deltas re-add them
      milliseconds later. A probe up five days, checking all 5,000 on time, reported 4,000 behind.
      `AssignmentStore` gained the `onAdd` seam that should always have sat beside `onDrop`.

      **`P-77`'s own fix, one layer down.** `ProbeReachability.lost` writes its in-memory marks
      before the transaction — deliberately, the overlay has to be in place for the re-evaluation —
      and nothing rolled them back when that transaction rejected. `offlineReason()` then answered
      'silence' for a probe whose sensors were never touched, so the sweep read "already handled"
      for ever: exactly the failure `P-77` replaced the shadow `Set` to prevent, reached through
      the thing that replaced it.

      **Core Health said "Probes not connected" about connected probes.** `probesDown` is
      `#byProbe.size`, and `P-74` started putting `silence` entries in that map. An operator saw
      Core Health and that probe's own Probe Health flatly contradict each other. Split by reason,
      with `probesSilent` as its own channel and metric — which also gives the delivery sweep the
      installation-wide number it never had.

      **The worker pool latched itself off while it was working.** `#startFailures` is pool-wide,
      reset only by a worker reaching `ready`, and was never weighed against how many workers the
      pool still held. `#grow` spawns the whole shortfall in one burst — sixty at the v1 target,
      each loading the ~35 MB catalogue — so three bootstrap failures among sixty on a memory-tight
      host disabled a pool holding fifty-seven healthy workers, permanently, with `#admission`
      answering `disabled` before it looks at anything else. And the latch returned without
      draining `#queue`: a queued job has no timeout, because the timer is armed when it *leaves*
      the queue, so every accepted check vanished unsettled and uncounted — the guarantee
      `check-flow.ts` states verbatim, broken by the ticket that stated it.

      **The headline alarm of `P-74`, `P-76` and `P-62` could not fire on any installation that
      already existed.** `ChannelResolver` is the only path by which a newly declared channel key
      reaches an existing sensor, and its INSERT wrote limits but not `lookup_id` or
      `counter_bits`. A lookup channel with neither is judged by *nothing* — `evaluateChannel`
      falls through every branch — so `delivering`, `checksCompleting` and `poolState` existed only
      on installations created by their own build. A counter with no width is the same shape: the
      rate conversion is skipped, a cumulative total is stored, and a limit written for a rate
      latches Down for the life of the probe process. Both readers fail *quietly*, which is why
      nothing caught it; and every test in the suite creates its sensors on the current build,
      which is why no test could.

      **Two of the panel's findings were about tests rather than code**, and both were mine.
      `is untroubled by a check that is merely slow` advanced exactly `timeoutMs * 2`, so the
      conjunct it was named for was already false on its own and the window clause could be deleted
      with the file staying green. It advances 90 s now, and a discriminating case sits beside it.

- [x] **P-79 — Five numbers the probe measures, sends, and nobody can read** · S · P-78 · Found
      while wiring `P-78`'s counter through the same three files for the third time in a day, and
      asking what else had made that journey only part of the way. Five fields were in
      `PROBE_HEALTH_SCHEMA`, measured on the probe, put on the wire every heartbeat, validated on
      arrival, and then discarded: `skippedTicks`, `spoolCorrupt`, `sessionsOpened`,
      `checksOutstanding` and `checkStalledMs`.

      Nothing was failing. The probe measured them correctly, the schema accepted them, the core
      did not crash. That is the shape this family always takes — a run that reports what it
      measured and says nothing about what it never looked at, the same as `P-49`'s 88 silent
      skips, `P-52`'s missing workspace and `P-75`'s lint that never ran. `CLAUDE.md` says the
      system monitors itself; a counter nobody can read is not monitoring, it is bookkeeping.

      **Two of the five are `P-76`'s, written the day before.** `checksCompleting` says *whether*
      checks are settling and raises the Warning; `checksOutstanding` and `checkStalledMs` say how
      many are stuck and for how long. Only the alarm was wired, so an operator got "checks have
      stopped settling" and no way to see the size of it — the diagnostic half measured, sent, and
      dropped on arrival.

      **`sessionsOpened` is the sharpest of the five**, because the gap was written down. The
      comment on `sessionsEvicted` tells an operator to read eviction against openings to spot a
      pool whose `idleMs` is shorter than the scan interval, and calls it "invisible without
      this" — while `sessionsOpened` was on no channel at all. The document described a diagnosis
      that could not be made. It is also why a hand audit missed it: a broad grep for the name
      across `packages/core` matched that very comment.

      All five have channels now and all five are diagnostics without limits, because each already
      has an alarming sibling — `schedulerLag` for skipped ticks, `checksCompleting` for the two
      check counters, `spoolDropped`/`spoolUnwritten` for corruption, `sessionOverflows` for
      openings. A second alarm for one outage is the thing `CLAUDE.md` forbids. `spoolCorrupt`
      deserves a note of its own: one torn record after an unclean shutdown is a *normal* recovery
      and paging for it would be paging for the system working, so what matters is a rate that
      climbs while the probe is not crashing — a graph, not a threshold.

      **The durable half is the guard**, in `build-hygiene.test.ts`: every property of
      `PROBE_HEALTH_SCHEMA` must appear in `probe-health.ts`, the one file where a health field
      becomes a channel reading, with comments stripped so a mention in prose cannot satisfy it.
      It carries a floor on its own extraction, because a regex that quietly matched nothing would
      make the guard pass for ever while checking nothing — this exact defect, arriving inside the
      thing built to prevent it, which `P-77` had just spent a morning on.

- [x] **P-78 — A spool that cannot be written loses every reading, silently** · S · P-76 · Filed
      out of `P-76`, which spotted it and left it: `spoolResult`'s `.catch` in `main.ts` logged a
      line and the readings were gone, counted nowhere. `CLAUDE.md` has one sentence about this —
      *never drop without counting* — and this was the one place in the probe that did.

      **`spoolDropped` could not cover it, and reads zero throughout.** That counter is eviction at
      the cap: a full disk, decided deliberately, with the results already safely on it. A failed
      write is the other thing entirely — the readings never reached disk at all — and it is the
      worse of the two, because a spool that cannot be written loses *every* check the probe runs
      rather than the oldest ones. An operator watching `spoolDropped` during a broken-disk outage
      would have seen a confident, steady zero.

      Counted in `ResultSpool.append` rather than at the call site, because that is the only place
      that knows *how many* results a rejection lost — every caller sees a rejected promise and an
      error, and neither carries a number. The error is rethrown untouched, so nothing above it
      changes, and any future caller of `append` is covered without having to remember.

      `spoolUnwritten` on the wire (protocol 15), a `Results not written` channel with the same
      not-a-matter-of-degree error bound as `spoolDropped`, and
      `ms_probe_spool_unwritten_total`. The tests kill the write by removing the spool directory
      underneath it — `#roll` then fails with `ENOENT`, which is deterministic and, unlike a
      permissions trick, fails for root as well.

- [x] **P-77 — Four defects in the two tickets written to catch defects like them** · M · P-74,
      P-76 · Found by auditing `P-74` and `P-76` the day they were written, before either had run
      against anything real. All four are in the *watchdogs* — the code whose entire job is to
      notice when monitoring has stopped — and in each one the failure mode is the watchdog going
      quiet rather than going wrong, which is the failure mode a watchdog is least able to report.

      **1. The sweep recorded a marking that never happened.** `ProbeDeliveryWatch` kept its own
      `Set` of probes it had marked silent, and added to it *before* awaiting
      `ProbeReachability.lost`. But `lost` logs and returns `0` without marking anything when it
      cannot read the probe's sensors — the deliberate judgement in `reachability.ts` that a query
      failure is not a reason to decide something about a probe. The shadow then said "already
      handled" for ever, and the sensors it never marked stayed Up: `P-74`'s exact failure,
      reached through the mechanism built to prevent it. It reads `offlineReason` now, so a
      marking that did not take is simply still absent and the next sweep tries again.

      The mutation exposed a second symptom nobody had looked for: the shadow also survived a
      *reconnect*, which clears the reachability entry (`found`, `R-05`). A probe that disconnected
      while silent and came back still silent would never be marked again, because the sweep still
      held a claim on a state that had been cleared underneath it. One `Set` and two ways to be
      permanently wrong.

      **2. Routine config churn postponed the silence window.** `configSentAt` — the stamp that
      answers "when did this probe last get work it has not yet reported on" — was written on both
      branches of the config push, including `config-unchanged`. Editing one sensor recomputes
      every connected probe, so on an installation of any size the window was pushed out by a full
      cycle on every probe, continuously. A genuinely silent probe would never be caught on a busy
      system, which is the only system where it matters.

      **3. The worst case read best.** `checksBehind` iterated `#lastCompleted`, so a probe on
      which nothing has *ever* come back had nothing to iterate and reported `behind: 0` — for a
      probe that was 100% behind. It counts the assigned set now, with `#startedNs` standing in
      for a sensor that has never reported, which also makes `behind` respond to assignments
      rather than to memory: a sensor stops counting by *leaving* the assignment list, and
      `forget` releases its entry without deciding anything. `assignments.onDrop` is wired to it
      in `main.ts` so the two cannot drift.

      **4. One leaked check disabled the stall detector for the life of the process.** The
      predicate read `lastCompletionNs <= oldestNs`. A check that never settles pins `oldestNs` at
      its dispatch for ever, so the first completion after it made the comparison false and no
      subsequent stall could ever be seen — silently, with `completing: 1` reported throughout. It
      asks whether anything has completed *recently* now, which a single stuck entry cannot pin.
      The overdue clause gained the check's own timeout as well (`waited > timeoutMs * 2`), so a
      sensor legitimately configured to run longer than the window is not called stalled for
      taking exactly the time it was given.

      **Every fix carries a test that was run against the reverted code and observed to fail** —
      five mutations, five tests, each killed by its own and no other. That is the rule from
      `docs/findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md`, applied on the same
      day it was written, to the work of the person who wrote it. Four of these are mine, they are
      in the newest code in the repo, and the audit that found them was cheaper than any of them
      would have been in production.

- [x] **P-75 — `npm run lint` was in `package.json` and in no script** · S · P-49 · Found while
      running eslint over a directory rather than a file during `P-62`: a real
      `no-unnecessary-condition` error had been sitting in
      `packages/probe/test/pool-sizer.test.ts:123`, and every full run for weeks had reported
      clean. Nothing runs lint. `scripts/test-all.sh` runs `npm test` per workspace, whose
      `pretest` is `tsc -b` — types are checked, style is not — and CI is deliberately off
      (`ci-deliberately-disabled`). So the check existed, was correct, and had no way to fire.

      Same family as `P-49` and `P-52`, and the third instance of it: a run that reports what it
      measured while saying nothing about what it never measured at all. `P-49` was 88 suites
      skipped in silence, `P-52` was a whole workspace's tests missing from every total, and this
      is a whole *kind* of check missing from every run.

      The suite runs it last and fails on it, separately from the test counters — a lint error is
      not a failing test, and folding it into that number would bury the failures above it. The one
      error is fixed; the repo was otherwise clean, which is the only reason wiring it in was a
      four-line change rather than a project.

- [x] **P-63 — A simulator's `stop()` waits for connections it never destroys** · S · — · Found by
      the full suite going red in `packages/simulators` during `P-60`, in a test that had passed
      every run before it: "shuts down while a request is still hanging". It looked like
      contention — 302 s for a package that takes five — but CPU load alone would not reproduce
      it. What reproduces it every time is calling `stop()` one turn of the event loop after the
      request instead of fifty milliseconds after.

      `HttpSimulator` tracked the sockets parked in a hang route, and only those. A connection that
      has been accepted but whose request has not reached the handler yet is in no set at all and
      is still open, and `Server.close()` waits for anything open — so a teardown racing a request
      in flight waits on a client that was never going to finish. Which of those two states a
      loaded machine produces is luck, which is why this showed up as an unrelated package failing
      once in a while rather than as a bug. Every accepted connection is tracked now, and the hang
      route is just the easiest way to arrange the case.

      **The same helper, the same defect, in the mail simulators.** `serve()` in `mail-servers.ts`
      backs SMTP, POP3 and IMAP and closed exactly the same way; it destroys its sockets now too.
      `ssh-server.ts` already had a 500 ms escape hatch with a comment naming this precise problem,
      so it gives up rather than hangs — left alone.

      **The test could not report this, only suffer it.** The client is deliberately never aborted,
      because an aborted client tidies the socket up and hides the defect. The cost was that when
      the assertion failed, the socket kept the event loop alive and the run stopped with no output
      at all — the pathology the test's own comment describes, arriving in the test itself. It
      aborts *after* the race now: late enough that the client cannot tidy up before `stop()` is
      measured, early enough that a failure is a failure. The budget went from 2 s to 5 s for the
      same reason — the claim is that it does not hang, and a hang is unbounded, so a larger number
      catches the defect just as surely and never fires on a busy machine.

      Two rows, 0 ms and 50 ms. Only the first can fail against the old tracking, and the pair is
      the point: 50 ms was passing for a reason that had nothing to do with what it asserts.

      **The 0 ms row is not a reliable guard either, and saying it was is the same mistake again.**
      The review of this ticket measured it: it reproduces the defect 17 times in 100 idle runs and
      27 in 100 loaded, because whether the connection has been *dispatched* by the time `stop()`
      runs is exactly the race the defect lives in. A deterministic case has been added beside it —
      a socket that connects and never sends a request at all is permanently in the state the timed
      rows can only reach by luck, so it fails every time. The timed rows are kept for what they
      document, not as the guard.

      Proof of how badly that mattered: the full suite that certified `P-66` ran against a `dist`
      still holding this defect — an incremental build had not picked up a mutation restore — and
      came back clean, 3,602 tests. The only test that could have caught it rolled a 17% chance and
      lost. The deterministic case fails against that same build every time.

- [x] **P-54 — The documentation is a graph and nothing checked its edges** · S · H-07 · Adding a
      finding means adding a line to `docs/README.md`'s index by hand, and the two findings written
      on 2026-09-04 were missing from it until somebody happened to look. A typo in a path would
      have been exactly as silent, and the reader who follows a dead link is the one person who
      needed that document.

      `H-07` generates the two references that *can* be generated, on the argument that a
      hand-written reference is right on the day it is written and silently wrong from then on.
      This is the same argument applied to the half that cannot be generated: the prose stays
      hand-written, and a link inside it either resolves or the build goes red. 262 links across
      every markdown file under `docs/`, plus `CLAUDE.md` and `README.md`.

      The runbook's `docs/findings/<date>-field-test.md` is skipped by an explicit placeholder rule
      — it is an instruction to an operator about where to write their results, not a link to
      follow — rather than by pretending the check found nothing.

      **Ticket cross-references are deliberately *not* checked**, and the reason is `P-24`, found
      an hour earlier the same day. It waited on "`D-05`'s VMware transport", and `D-05` exists: a
      name-resolution check would have passed it every time while the ticket sat blocked on
      something that was never what it claimed. Checking that a name exists would have said
      nothing here and implied a guarantee it cannot give. All 139 referenced tickets were
      confirmed to resolve by hand, once; the useful check is a human reading what the reference
      claims.

      **And the other direction**, which is the one that actually happened: a finding nothing links
      to is silent for ever, reachable only by listing the directory. A dead link is loud when
      someone follows it; an orphan never gets followed. Two of the findings written on 2026-09-04
      sat unindexed until somebody thought to look, and there is no reason to expect the next
      author to think of it either. All 25 are reachable today.

      Mutation-checked both ways: a link to a findings file that does not exist fails the test
      naming both ends, and a findings file nothing references fails it naming the file.

      **What the orphan check does not promise**, because the first mutation written for it passed
      and said so: it asserts a finding is referenced *somewhere* outside `findings/`, not that it
      is in `docs/README.md`'s index. Deleting a line from that index did not fail the test,
      because `TASKS.md` cites the same document — which is correct behaviour for "is this
      reachable" and would be wrong for "is the index complete". The index is still maintained by
      hand and nothing checks it.

- [x] **P-53 — Nothing was checking the scripts that install on Windows** · S · P-51, H-06 ·
      `H-06` says a parse error in `ms-setup.ps1` "would break every Windows install", and that the
      only thing anywhere that would catch one is its `windows-install` CI job. **That job has
      never run**, because CI is disabled at the operator's request — so the scripts that register
      the services, open the firewall and gate an upgrade on `config check` were checked by nothing
      at all.

      `H-06` also recorded why a local check was impossible: "PowerShell publishes no arm64
      container, the amd64 one dies under QEMU on an Apple Silicon machine, and the `dotnet tool`
      package is broken — three routes tried, all dead." True of those three, and not of the
      fourth: `P-51` had just put the official `linux-arm64` tarball in the toolchain image for the
      Windows *sensor* transport, and a parser is a parser. The claim was correct when written and
      stopped being so an hour later, in a ticket that had no reason to know.

      All three scripts parse — `install-probe.ps1`, `ms-setup.ps1`, `ms-teardown.ps1` — and the
      check now lives in the build-hygiene suite beside the generated-documentation checks, so it
      runs on every `npm test` rather than in a job nobody can run. It skips with a named reason
      where no `pwsh` exists, which `P-49`'s reporting now surfaces rather than swallowing.

      **Mutation-checked**: an unclosed brace appended to `ms-setup.ps1` fails the test with the
      file and the line — `ms-setup.ps1:184 Missing closing '}'` — and the restored file passes.

      **Parsing is not running.** This cannot tell whether `New-Service` got the right arguments;
      only Windows can, and `H-06` stays open for it. It catches the class of mistake that costs a
      release, for the price of one process.

- [x] **P-52 — The totals never included the web workspace** · S · P-49 · Found by checking
      whether `P-49`'s new skip report covered every runner. It did not, and neither did the
      counters it sits under.

      `test-all.sh` sums `node:test`'s `ℹ tests` lines. `@ms/web` runs **vitest**, which prints a
      different shape — `Tests  315 passed (315)` — so its tests were absent from every total this
      script has ever reported. Verified rather than reasoned: run over the web workspace alone it
      printed **`tests 0 · pass 0 · fail 0`** and **`clean`**, for a run of 315 tests.

      **Failures were never actually missed** — a failing vitest run comes back in the exit status
      and the script checks that — so this was a reporting defect rather than a green-when-red one.
      What was genuinely invisible is skips: `P-49`'s report reads `node:test`'s
      `﹣ name # reason` shape, so a vitest suite skipping itself would have been silent in exactly
      the way `P-49` exists to prevent. The gap was in the fix, one workspace over.

      Vitest's summary is now parsed for total, passed, failed and skipped and folded into the
      counters, which also means a vitest failure trips the `failed > 0` branch on its own rather
      than relying on the exit status alone. Both shapes it emits under failure and under skips
      were checked against synthesised summaries, since neither occurs in a green log.

      **The full suite now reads 3,565 rather than 3,250** — the same run, counted properly.

- [x] **P-51 — The Windows transport was only ever tested against a fake** · S · P-49 · The last
      suite still skipping once every compose dependency was up: `no pwsh on this machine`. It
      gates `windows-transport.test.ts`'s real-PowerShell cases, and its own header says it "runs
      wherever a `pwsh` exists so that never happens again silently" — *that* being a wrapper which
      ran nothing at all and exited 0 (`findings/2026-08-27-powershell-transport.md`). The authors
      meant it to run. It never had, on any machine this project has been built on, so the four
      `windows.*` sensor types were verified only against a fake serialiser.

      **The blocker was an architecture mistake, not a real one.** An earlier attempt ran an x64
      build under emulation and got `qemu: uncaught target signal 6 (Aborted)`, which reads like
      "PowerShell does not work here". Microsoft publishes a native `linux-arm64` build; it starts
      in the toolchain container, reports 7.4.6, and round-trips `café` through `ConvertTo-Json`
      correctly — which is the exact thing the suite asserts.

      **Added to `dev/toolchain/Dockerfile`**, for the reason `ping` is already there: the product
      shells out to it, so a toolchain without it cannot test the sensor that uses it. The tarball
      rather than Microsoft's apt repository, because that repository has no `arm64` component for
      bookworm and half the developers here are on Apple silicon. Architecture is chosen from
      `dpkg --print-architecture` so an x86 machine gets `linux-x64`, and the build fails loudly on
      anything else rather than producing an image that silently skips the suite again.

      **Result: 3,250 tests, 3,250 passed, 0 failed, 0 cancelled, 0 skipped, and no suite skipped
      for a missing dependency** — the first run today with nothing at all left out. For contrast,
      the same command reported `clean` this morning at 1,945 tests with 88 suites skipped.

- [x] **P-50 — No budget covered the loop that had the 427 ms stall** · S · P-48 · The question
      `P-48` raised and did not answer: why did a synchronous 427 ms pass on the probe's own thread
      survive as long as the sizing loop has existed, with a `test:perf` suite whose whole purpose
      is measured budgets?

      Because nothing in it ran the loop. `grep` across every `test/perf` suite finds no reference
      to `poolSizer`, `poolDemand`, `setMaxSize` or `typicalDurationMs` — the probe's perf tests
      all pin `CheckPool` to a fixed `size` and measure dispatch beneath it, exactly as
      `bench.mjs` does. The budgets covered the pool and never the thing that sizes it.

      **The same shape as `P-49`, one layer up.** There, coverage that looked complete was missing
      two thirds of the core; here, a suite whose reason for existing is catching performance
      regressions had no view of the code that had one. Both were invisible because the summary
      said what a complete run says.

      **A budget now exists**: one `poolDemand` pass over the v1 target's 5,000 assignments against
      a real `CheckPool` whose duration windows have been filled by 1,000 completed checks — an
      empty window is the cheap case and would have measured the arithmetic while missing the sort
      entirely. **50 ms**, which is a ceiling and not the measurement: about 100× the 0.42–0.57 ms
      it actually takes and about 16× under the defect, loose enough to survive a loaded machine
      and tight enough that the regression cannot hide.

      **Verified by putting the defect back.** With `P-48`'s cache removed the pass measures
      796 ms and the budget fails by 16×; with it restored, 0.57 ms. Three orders of magnitude
      between them, which is why the loose ceiling is safe.

      **`npm run test:perf` was deliberately not run for this.** CLAUDE.md wants a quiet machine and
      this one was carrying load averages between 5 and 26 from another project's containers, the
      editor itself at 197% and Spotlight indexing the files the unit suite had just written. A
      budget measured there is not a measurement. Establishing that none of `P-45`, `P-46` or
      `P-48` can move an existing budget — none of that code is reachable from any perf suite —
      is what made deferring it safe rather than convenient.

- [x] **P-49 — "Clean" covered a third of the core and said nothing** · S · P-25 · Noticed by
      accident: a full run reported **3,244 tests** where every earlier run today reported about
      1,945. Nothing had been added — PostgreSQL happened to be up, because the dev stack had been
      started for a browser preview, so `@ms/core` ran **2,005** tests instead of **709**.

      **1,296 tests silently did not exist, and the summary looked identical.** The integration
      suites gate themselves with `describe(..., { skip: 'no PostgreSQL …' })`, which `node:test`
      reports as *one* skipped item however many tests are inside — so the counters read
      `skipped 15` and the script printed `clean`, exactly as it does for a run that covered
      everything. Counted properly, that run skipped **88 suites**: 77 of them for want of
      PostgreSQL, under four different wordings, plus MySQL, SQL Server and `pwsh`.

      This is the defect `test-all.sh` already exists to prevent, one category over. Its header
      says a summary reporting only pass/fail "reads twenty-five tests that never ran as a suite
      that was fine"; a skipped suite is the same sentence with a different verb. The difference is
      that skipping is *deliberate* — `npm test` is meant to work with the stack down — so unlike
      `cancelled` it must not fail the run. It only has to be impossible to miss.

      **The script now counts skipped suites, groups them by reason, and refuses to call such a run
      simply "clean"** — it prints `clean, but N suite(s) never ran`. Verified both ways: silent on
      a run with no skips, and reproducing all 88 against this morning's log.

      **It also invalidates how today's earlier work was gated.** `P-42` through `P-46` were each
      committed on a "full suite, 0 failed" that was missing two thirds of the core's tests. They
      all pass under the fuller run that gated `P-48`, so nothing was actually broken — but the
      claim was weaker than it sounded, and that is worth having written down rather than
      discovered again.

      **What was actually missing, concretely.** CLAUDE.md's hard constraint is that *every schema
      change ships with a tested rollback*, and exactly one test proves it — `migrator.test.ts`'s
      "applies the real migration set forward and all the way back", which rolls all forty
      migrations forward and then all the way down. It needs PostgreSQL. In this morning's run it
      **did not execute at all**, and the script printed `clean`. So for those runs one of the
      project's stated guarantees was unverified and nothing said so. (Checked afterwards: it
      passes, no migration is marked `irreversible`, and the constraint genuinely holds.)

      **Then the gap was actually closed**, which is the point of having found it. Every compose
      dependency up — the default services plus `--profile db` for MySQL and SQL Server — gives
      **3,246 tests, 3,246 passed, 0 failed, 0 cancelled, and one suite skipped**, that one being
      `no pwsh on this machine`, which macOS cannot help. Against this morning's 1,945 tests and 88
      skipped suites, both reported as `clean`.

      Left alone: the four wordings for "PostgreSQL is not running". Consolidating them is tidying,
      and the grouped report reads fine without it.

- [x] **P-48 — A sizing pass blocked the probe for 427 ms, re-deriving what it already had** · S ·
      P-44 · Found by auditing my own `P-46` change for cost, having changed `typicalDurationMs`
      without measuring it. The cost turned out to be almost entirely older than `P-46`, and much
      larger than expected.

      `poolDemand` called `durationMs(assignment.sensorType)` once per **assignment**. At the v1
      target that is five thousand calls for perhaps twenty distinct types, and each one slices,
      maps and sorts a window of up to 1,024 samples. Measured over 5,000 assignments with the
      windows about 40% full: **426.8 ms** a pass, against **0.146 ms** for the same pass with a
      constant duration. **99.97% of it was re-deriving medians it already had.**

      **Where it runs is what makes it a defect.** The sizing loop is synchronous, on the probe's
      own thread, every thirty seconds and again after every configuration push. The wheel fires
      once a second, so a 427 ms pass swallows a tick's dispatch — against CLAUDE.md's rule that
      nothing blocks the scheduler. At the 1,024-sample cap the sort work is about 2.9× larger
      again.

      **And it hides from the metric that should catch it.** `schedulerLag` is a p95; a stall on
      one tick in thirty is 3% of them, which lands in the p99 and the max, and neither is on Probe
      Health. The live probe read 5.7 ms of lag while doing exactly this.

      **Fixed by caching one answer per type per pass**, which is the more correct thing anyway: a
      pass that asked twice and got two numbers would be summing a workload that never existed at
      any instant. `has` rather than a truthiness check, because `undefined` is an answer and it is
      the answer for every type on a probe that has just started — the case where the loop runs
      most. **426.8 ms → 1.13 ms**, a 378× reduction, within about 15× of the arithmetic's own
      floor. Numbers in `docs/findings/2026-09-04-autosize-loop.md`.

      Mutation-checked: removing the cache fails the per-type test, and caching only defined values
      fails the fresh-probe test.

- [x] **P-46 — The smaller the pool, the slower it notices it must grow** · M · P-44 · Positive
      feedback in the sizing loop, found by fixing `P-45` and re-measuring — which is the only
      reason it was found, since the shrink defect was masking it.

      `CheckPool.typicalDurationMs` is the median of the last **1,024 completed checks of that
      type**, a window counted in samples rather than in seconds. The median only moves once more
      than half of them are new, so the time to notice a change is `512 ÷ completion rate` — and
      the completion rate is set by the pool size:

          66 workers at 1,500 ms -> 44/s -> ~12 s
          31 workers             -> 21/s -> ~25 s   (measured: crossed at 29 s)
           9 workers             ->  6/s -> ~85 s   (measured: never crossed in 70 s)

      **A pool that is too small completes fewer checks, so it measures more slowly, so it stays
      too small.** Measured at nine workers: the ceiling never rose, the queue reached 1,891, and
      lateness reached **57 seconds** with nothing deferred and nothing refused.

      **This is in the shipped code now**, not something `P-45` introduces. A probe whose workload
      is genuinely fast has a genuinely small pool and the same slow detection; `P-45`'s defect was
      accidentally holding extra workers, which sped the measurement up. The floor does not save it
      either — `defaultPoolSize()` bounds the derived *ceiling*, but the pool only grows to what is
      submitted, so a fast workload sits at a handful of workers whatever the ceiling says.

      **The direction of the fix**: the loop's only input is a lagging duration estimate, and it is
      surrounded by direct evidence it does not read. A queue that is growing, a `waitMs` p95 above
      the dispatch budget, and checks completing later than their interval are all unambiguous
      statements that the pool is too small, and none of them needs a duration at all. Adding a
      backlog term to `poolDemand` is likely better than tuning the window, because a shorter
      window trades lag for noise and still says nothing when no checks are completing. Whichever
      way, it wants its own measurement — `scripts/sizing/autosize.mjs` already reproduces it, and
      the phase-3 numbers are the regression to beat.

      **Fixed by counting the window in seconds rather than in samples** — `durationWindowMs`, 30 s
      to match the sizing cadence, injectable so a test can bury a stale reading in a hundred
      milliseconds instead of half a minute, with a floor of eight samples so a probe that measures
      nothing inside the window still answers from something real rather than sending the sizer
      back to its assumption.

      **Not the backlog term this ticket argued for, and the reason is arithmetic.** `busy + queued`
      overshoots enormously — 1,900 against a true need of 50 — because a backlog is accumulated
      debt and not a rate. The throughput ratio `size × submitted ÷ completed` gives exactly the
      right answer (9 × 33.3/6 = 50) but needs a clean "work finished" denominator, and the pool
      has none: `submitted` counts deferred and refused checks too, and `completed`, `failed` and
      `timedOut` partition awkwardly across three release sites. The window is the smaller change
      and it addresses this ticket's actual title, which is the *rate dependence*.

      **Measured** (`docs/findings/2026-09-04-autosize-loop.md`): the median now crosses in
      `W × R_old ÷ (R_old + R_new)`, so at worst the window — 13 s at 66 workers, 18 s at 31, 25 s
      at 9, against 85 s and unbounded before. It is not pool-*independent* and the finding says so
      rather than claiming it. That was enough to unblock `P-45`, and with both in place the pool
      holds nine workers where nine are wanted, spends **zero** worker-seconds above its ceiling
      over a whole run, and still recovers its ceiling to 66 when the checks slow down.

      A backlog term remains the obvious next improvement: in the measured window the queue reached
      814 while every duration-based signal still said the workload was cheap.

- [x] **P-45 — A pool that grew does not come back down, and holds the memory** · S · P-44, P-46 ·
      Measured in `docs/findings/2026-09-04-autosize-loop.md`. A pool asked to go from a ceiling of
      66 to a ceiling of 9 went to 35 workers, then 31, and **stayed at 31 for the remaining two
      minutes of the run** — 3.4× its own ceiling. The instrumented run rules out every innocent
      explanation: at two separate samples it was holding 35 workers with **`busy` 0 and `queued`
      0**, completely idle, twenty-six above a bound it had already been given, shedding nothing.

      **The mechanism is that the prompt pass is opportunistic and almost never invoked.**
      `CheckPool.#considerShrink` retires whatever is spare at the instant it runs and breaks the
      moment it meets a slot mid-check — which is correct, since a ceiling change must never take
      a worker out of a check. But it is called from exactly two places: a `setMaxSize` that
      lowers the ceiling, and the 60-second idle timer. A wheel firing every second produces
      bursts in which most slots are briefly busy, so a pass landing inside one sheds almost
      nothing and then waits a full minute for its next chance.

      **This contradicts the comment sitting directly above that loop** — "over the ceiling comes
      down now, not one worker a minute" — and the `P-39` claim that a lowered ceiling sheds at
      once. Both are true of the ceiling. Neither is true of the workers, and the workers are what
      cost memory: at the measured 35 MB a worker in a real probe, the excess here is about
      **770 MB held after a workload got cheaper**. It is the same shape as `P-26`, which changed
      the question from "has anything been submitted lately" to "has this worker been idle" —
      right, but still answered against a single opportunistic sample.

      **The fix is small and it has been written and measured — and it must not land yet.**
      Retrying the prompt pass on a 250 ms timer while the pool is over its ceiling converges it in
      about five seconds instead of minutes, needs no change to the safety rule, halved resident
      memory in the benchmark (507 MB to 255 MB) and cut worker-seconds above the ceiling from
      1,594 to 26. A regression test on `CheckPool` passes with it and times out without it.

      **Then the re-measurement showed it makes a realistic case far worse**, which is `P-46`: a
      correctly-shrunk pool of 9 workers took so long to notice its checks had slowed that the
      ceiling never rose, the queue reached 1,891 and lateness went from 11.6 s to **57 s**. The
      shrink defect had been accidentally holding extra workers, and extra workers measure faster.
      So the fix is correct and unsafe alone; it lands with `P-46` or after it. The measured
      before-and-after is in `docs/findings/2026-09-04-autosize-loop.md` (Finding 3) with raw data
      in `2026-09-04-autosize-shrink-trap.json`.

      **`P-46` landed, so this did too.** With both, the pool spends **zero** worker-seconds above
      its ceiling across the whole benchmark — down from 1,594 — and resident memory in the fast
      phase halves, 507.9 MB to 255.8 MB. Worst lateness when the checks slow again is 24.8 s
      against the baseline's 11.6 s, and that gap is this fix's honest price rather than a
      regression: the baseline was only quicker because it was still carrying 22 workers it had
      been told to release. The trade is about 250 MB in the benchmark and about 770 MB in a real
      probe, and an operator who cannot accept the transient sets `workerPoolSize`.

      Not urgent for correctness: nothing is dropped, no check is late because of it, and a probe
      restart reclaims it. It is a memory-footprint defect, and `docs/sizing.md` now warns to size
      the box for the largest pool the probe reaches rather than the one it should settle at.

- [x] **P-43 — `main()` is where the bugs are and the only place with no test seam** · M · — ·
      Filed from evidence rather than from taste. `P-41` and `P-42` are the same defect — a
      decision derived from `AssignmentStore` on every message instead of once the push has
      settled — they are **four lines apart in the same function**, and neither fix is pinned by a
      test. Both tickets had to write "tested where it can be, which is not `main.ts`".

      **The reason is structural.** `packages/probe/src/main.ts` is 571 lines of which `main()` is
      about 500: it reads config, builds the pool, the wheel, both listeners, the core client and
      the lifecycle, and closes over all of them in the message handlers. Nothing exports it and
      no test imports it, so every policy expressed *in the wiring* — what runs per message versus
      per settle, what is guarded by `autoSize`, which listeners get swept — is unverifiable by
      construction. That is also why `P-42`'s syslog half survived from `T-20` to now: no test
      could observe that one of two identical listeners was never wired.

      **What would fix it**, roughly: separate composition from policy. Have `main()` build the
      collaborators and hand them to a `ProbeRuntime` (or just an exported `wireProbe(deps)`)
      that owns the handlers, so a test can construct it with fakes, feed it a chunked
      `config-set` plus deltas, and assert that no cursor was swept until the push settled and
      that both listeners were swept when it did. The `demand.ts` extraction for `P-34`/`P-40` is
      the precedent and it worked — those decisions have real tests because they are no longer
      inside the bootstrap.

      **Done, and the seam is `packages/probe/src/core-handlers.ts`.** `coreHandlers(deps)`
      returns the four functions the client calls plus a `stop()`; `main()` builds the
      collaborators, passes them in, and owns the lifecycles as before. Every dependency is
      declared *structurally* — `Assignments` is `apply` and `ids`, `CursorSweeper` is `retain` —
      so a test asserts that both listeners were swept without constructing a `TrapListener`. The
      settle delay is injectable, so the suite does not spend two seconds a case watching a
      debounce. `main()` lost about fifty lines and gained nothing.

      **One shape change worth naming**: the listeners are now a *list* rather than two named
      fields. `P-42` was one of two identical listeners being wired and the other not, and nothing
      in the code said so. A caller that forgets one now forgets it visibly, in the composition
      root, on the line beside the other.

      **Eight tests, mutation-checked rather than trusted.** Three mutants, each a bug that
      actually shipped or nearly did — sweeping per message (`P-41`/`P-42`), sweeping only the
      first listener (`P-42`'s syslog half), and a `stop()` that forgets to cancel. All three were
      caught, each by the case meant to catch it: 5 of 8 fail on the first, 1 of 8 on each of the
      others, and the restored source passes 8/8 byte-for-byte identical. That mattered more than
      usual here — three tests earlier in this same run of work passed for the wrong reason
      (`P-36`, `P-39`, and the first cut of `P-34`), so a green suite over new tests is not
      evidence until something has been broken on purpose.

      **What is still not covered**: `main()` itself. Construction, ordering and the shutdown
      hooks remain unpinned — this moved the *policy* out, not the wiring. A much smaller gap than
      the one it closed, and both defects that prompted the ticket were policy.

      **The dispatch half of that gap closed on 2026-09-04**, and not by choice: `P-57` turned out
      to be a defect in `onDue` — exactly the code named here as uncovered — found by reading
      because nothing could test it. `due-dispatch.ts` is this same extraction applied there.
      Construction and shutdown ordering remain.

- [x] **P-25 — A sensors suite hook that fails about once in four runs** · **not reproducible** · S · — · One full
      `npm test` on 2026-08-29 reported `@ms/sensors` as 755 passed, 1 failed. Three subsequent
      full runs of that package on the same machine reported 781/781. **The arithmetic says which
      shape it is**: 755 + 1 + 25 = 781, so twenty-five tests were *cancelled*, which is what
      node:test does to a suite whose `before` hook throws. One hook, one suite, about twenty-five
      tests in it.
      Which one is not known, because the failure line was never captured — the run was filtered
      to the summary counters, and `cancelled` was not among them. That is the first thing to fix:
      a full run should keep its whole log rather than a grep of it.
      Candidate suites by size are the SNMP and SSH ones, all of which bind a listener or dial a
      dev-stack container in `before`; a port still in `TIME_WAIT` from the suite before is the
      obvious mechanism and would explain why it is rare. Worth pinning before `H-01`'s soak,
      because a harness that fails once in four runs is indistinguishable from the system failing
      once in four runs.

      **Progress 2026-08-29. The first fix is done and the hypothesis is disproved.**

      `scripts/test-all.sh` keeps the whole log under `dev/data/test-logs/` and **fails on
      `cancelled` as loudly as on `failed`** — a cancelled test did not pass, it never ran, and a
      summary carrying only pass/fail reads twenty-five tests that never ran as a suite that was
      fine. Verified by planting a suite whose `before` throws: without the check the same run
      prints "803 pass, 0 fail" and exits clean.

      **The `TIME_WAIT` mechanism is not it.** Every listener in these suites binds port 0 —
      `port-dns`, `jitter-range` and `tls` through their own `listen` helpers, and
      `TestSnmpAgent`/`TestSshServer` in `packages/simulators`, which say so in a comment. There
      is no fixed port anywhere to collide on.

      **Closed 2026-09-04 as not reproducible, on a measurement rather than a shrug.** Fifty-seven
      full-run logs now sit under `dev/data/test-logs/`, spanning 2026-08-29 to 2026-09-04, and
      **not one carries an unexplained cancellation**. The only two that carry any are
      `20260829T151823Z` and `20260829T152259Z`, both reading "803 pass, 0 fail" with 2 and 3
      cancelled — which is this ticket's own planted suite, described three paragraphs above in
      exactly those words.

      Eleven of those runs were today, on a machine under deliberately adversarial load: several
      of them shared it with an 81-agent review and a 17-agent design workflow, which is the
      contention that surfaced `P-63` and `P-65`. `@ms/sensors` reported 807 of 807 in every one.
      Today's runs did produce two failures — `P-65`'s session-replacement race and a transient in
      a test written for `P-62` — and both arrived as `failed`, not `cancelled`, which is the
      distinction this ticket turns on.

      Closing on absence of recurrence would normally be the wrong move, and is not here, because
      **the reason it was worth a ticket has been fixed rather than waited out**. A hook that
      throws now fails the run loudly and keeps its log, so the next occurrence is diagnosable at
      the moment it happens instead of being reconstructed from arithmetic a week later. What made
      this dangerous was never the flake; it was that twenty-five tests could not run and the run
      still said clean. That cannot happen again, whatever the hook was.

      What can still throw in a `before`: the simulator starts, and `ssh-session.test.ts`, whose
      hook opens a real session and reads the host key back — 34 tests behind one handshake. Its
      timeout is 15 s, though, which is not a threshold a loopback handshake crosses easily.

      **Not reproduced in ten runs**: eight of `@ms/sensors` alone (803/803 each) and two full
      parallel `npm test` runs, which is the condition the original was seen in — 3,165/3,165,
      nothing cancelled. Four of those ran while the `H-01` soak had the machine at 5,000 sensors,
      so it is not simply an idle-machine result. It stays open rather than
      closed-as-unreproducible, because the point of the logging fix is that the next occurrence
      will say what it was instead of leaving arithmetic to infer it.
      One caution for whoever picks it up: a "reproduction" here turned out to be a deliberately
      failing probe file leaking into a concurrent background run. Do not plant one while runs of
      the same suite are in flight.
- [x] **T-08 — SSH Script / Disk Free / Load Average / Meminfo** · L · T-07 · Four sensors,
      documented script output format for the first.

      **T-08 outcome.** Four types on `T-07`'s session layer, plus `support/ssh/parse.ts` — pure,
      and separate because every one of these formats has a variant that parses *almost* right
      and yields a number that is wrong rather than absent, which is worse than one that fails.

      **The script output format is line-oriented first, because the author is usually writing
      shell.** `echo "queue:12"` is one line; emitting JSON from shell means quoting and escaping,
      and a script that gets that wrong fails in a way its author cannot see by running it. Three
      shapes: a bare number (one reading, the channel called `value`), `key:value` lines with
      `message:` reserved, and a JSON object when the output starts with `{`. `=` works wherever
      `:` does, because half the world writes `key=value` and being strict about it would be a
      rule with no purpose. A script reporting a key the sensor has no channel for is **named in
      the message** rather than dropped — that is how an operator finds out their script and their
      sensor have drifted apart — and a non-zero exit fails the check with the script's own
      stderr, which is how a script refuses to answer instead of reporting a zero somebody graphs.

      **`df -P -k` and the reason it is not `df`.** Without `-P`, `df` wraps a long device name
      onto its own line and an obvious parser reads the *previous* filesystem's columns; `-k`
      pins the block size, because `df` honours `BLOCKSIZE` and `DF_BLOCK_SIZE` from the
      environment and a login shell may set them. The percentage is recomputed rather than read:
      `df` rounds its own up to a whole number, so a 40.4% volume reads as 41% — fine for a
      person, wrong for a threshold somebody set at 41. The path is single-quoted with the
      shell's own escape for an embedded quote, since a path is operator input reaching a shell.

      **`ssh.load` makes the per-processor figure primary**, and gets the processor count in the
      same round trip. A load of 4 is idle on a 32-core box and desperate on a single-core one, so
      the raw average cannot carry a threshold that means the same thing on two machines. Where
      the count is unavailable the channel *gaps* rather than falling back to the raw figure — a
      per-processor load that is secretly the whole-machine one is a number somebody would set a
      limit against.

      **`ssh.meminfo` gets `MemAvailable` for the asking**, which is the number `T-05`'s
      `snmp.memory` has to work for: over SNMP the UCD-MIB exposes `MemFree` under a name that
      sounds like availability, and the measured gap on one box was 64% used against a true 35%.
      Live on the same dev target the two agreed — 37.12% over SSH against 32.03% over SNMP,
      minutes apart — which cross-validates both. Channel keys deliberately match the SNMP
      equivalents so a summary graph across a Linux box and a switch lines up; there is a test
      asserting the two lists are identical.

      **Found live, and the most important thing in this ticket: a rotated credential never
      reached a running probe.** `ProbeAssignments.version` is computed over the whole
      configuration *including* `A-05`'s rotation stamps, so a rotation changed it and the core
      decided something had to be sent — but `diffAssignments` compared sensors one at a time with
      **no stamps**, so every sensor hashed identically and the delta was empty. The probe recorded
      the new version and went on authenticating with the old secret, indefinitely, with nothing
      anywhere saying so. Rotating a password to lock somebody out would have appeared to work and
      not have. Fixed by carrying the stamps on `ProbeAssignments` and threading them through the
      diff; `probe-config.test.ts` pins it. This is a defect in `R-04`'s delta that `A-05` created
      and neither ticket's tests could see, because it needs a credential change with *nothing
      else* changing — which is exactly what pasting a host key fingerprint in is.

      A mutation run also found a **weak test of my own**: `parseMeminfo` was asserted against
      `HugePages_Total: 0`, where multiplying by 1024 is still 0, so the unit check could be
      deleted entirely and the test still passed. The fixture now uses a non-zero count.
- [x] **T-09 — Windows check transport** · L · P-03 · PowerShell / WinRM shell-out from a
      Windows-hosted probe, with credential handling and output parsing.

      **T-09 outcome.** `ADR-001`'s open question 3 — an in-house WinRM client, or a PowerShell
      shell-out — answered: the shell-out. A client is not a protocol port, it is a cryptographic
      implementation. WS-Management's only widely-permitted authentication is NTLMv2 or Kerberos;
      Basic needs `AllowUnencrypted` or a certificate on every machine, which most estates forbid
      outright. Writing NTLMv2 with message signing and sealing, in v1, to reach machines a
      Windows probe already reaches with a supported client, is the wrong trade. **A Windows
      probe is a real constraint and it is stated rather than worked around**: one Windows probe
      monitors many Windows machines, because `Get-CimInstance -CimSession` *is* WinRM — but a
      Linux-only installation cannot monitor Windows at all, and an operator meets that as a
      sentence saying so rather than as `spawn ENOENT`.

      **The defect a real PowerShell found, and nothing else could have.** The transport handed
      the script over on stdin via `-Command -`, on the reasoning that a command line is
      world-readable and stdin is not. Pointed at `pwsh` 7.5.0, that produced **no output and
      exit code 0**: `-Command -` reads stdin as *interactive* input, so the multi-line
      `try`/`catch` this wrapper is built on never completes. `-File -` is worse — it opens a
      REPL and echoes `>>`. `-EncodedCommand` (base64 of UTF-16LE) behaves identically on 5.1 and
      7. The original reasoning was misapplied: **the script is not the secret** — it contains
      `$env:MS_WIN_PASSWORD`, not a password. The credential still travels in the environment,
      which a process listing cannot reach; what argv exposes is which CIM class a sensor asks
      about. Measured in `docs/findings/2026-08-27-powershell-transport.md`, along with three
      other properties the wrapper depends on.

      **The credential is in the environment, and that is the whole security argument.** On
      Windows any user can read another process's command line through
      `Win32_Process.CommandLine`; on POSIX it is `/proc/<pid>/cmdline`, world readable. A
      monitoring service holds the credential for every Windows machine in the estate, so a
      password in argv is that whole set readable by anybody with a session on the probe. Not in
      the script text either, which `Start-Transcript` and module logging both write to disk.
      Asserted by a test rather than described.

      **Every line of the wrapper's preamble is load-bearing**, because PowerShell is a shell
      designed for people and a check is not one. `$ErrorActionPreference = 'Stop'`, or a failed
      cmdlet writes to the error stream and the process exits 0. `$ProgressPreference`, or
      progress records land in the middle of the JSON. The output encoding, or 5.1 writes the
      console code page and a volume label arrives as mojibake that still parses. `-Depth`,
      because `ConvertTo-Json` defaults to 2 and *substitutes the type name* rather than failing
      — `"System.Collections.Hashtable"` is a string, the document parses, and a path that
      reached a number yesterday reaches a type name today.

      **`asRows`, for the sharpest edge there is.** `ConvertTo-Json` serialises one object as an
      object and two as an array; `@(…)` does not help and `-AsArray` is PowerShell 7 only, while
      5.1 is what ships on a Windows Server. A volume sensor written against a machine with two
      disks works and the same sensor on a machine with one disk reads a bare object. One place
      meets it.

      **Tested against a fake PowerShell that is a real process**, not a mocked `runProgram` —
      everything worth getting wrong here is at the process boundary, and a mock at the function
      boundary asserts only that the code calls the function the test said it would. Plus a suite
      that runs the *actual* wrapper wherever a `pwsh` exists (`MS_TEST_PWSH` to point at one),
      which is what would have caught `-Command -` on the first day.

      **`P-24` should not wait for this ticket.** It is written as "extract the pool at the third
      transport", with `T-09` named as the third. A shell-out has no session to keep, so there is
      no third instance; the two pools are still two. `P-24` moved to v2 as `V2-17` on 2026-09-04
      on exactly that basis — its third caller is `V2-08`. Whoever picks it up there decides on
      that basis rather than on this dependency.
- [x] **T-10 — Windows CPU / Memory / Volume / Service sensors** · L · T-09 · The v1 Windows set.

      **T-10 outcome.** Four types on `T-09`'s transport, one query each.

      `windows.cpu` reads `Win32_PerfFormattedData_PerfOS_Processor` rather than
      `Win32_Processor.LoadPercentage` — the latter is a single sample taken at the moment of the
      query and disagrees with Task Manager by tens of percent on a busy machine, which matters
      when somebody compares this sensor to what they can see. Per-core channels come from the
      machine (`S-07`), and the `_Total` instance is read rather than averaged from the parts:
      the counter is an interval average and the instances are sampled separately, so computing
      one would report a number the machine did not say. Empty counters fail the check rather
      than reporting an idle machine — corrupted performance counters are a real Windows fault
      and they return *nothing*, not an error.

      `windows.memory` reads `Win32_OperatingSystem`, which counts every figure in **kibibytes**
      and carries the virtual ones in the same row. The percentage is the primary because that is
      where a limit belongs: "below 10% free" is a sentence somebody writes once for an estate,
      where a byte figure is wrong the day a machine gets more RAM. A zero total gaps rather than
      dividing — Infinity is a number, and it stores and draws.

      `windows.volume` is **one sensor for the machine with a channel per volume**, not one
      sensor per volume: six drives as six sensors is six alarms when the machine goes. The
      primary is the *lowest* free percentage across the volumes it watches, so one limit says
      "alarm when any disk here gets tight" and the per-volume channels say which. A volume that
      reports no size — a locked BitLocker volume, a disconnected mapped drive — gaps and is
      named, because a zero reads as a full disk.

      `windows.service` is one service per sensor, which is what makes an alarm name the thing to
      fix. It does not restart anything: a monitoring system that restarts a service turns an
      incident into an intermittent one nobody investigates until the fourth time, and the state
      history is what makes "it has restarted itself eleven times this week" visible. `expected`
      is the second channel and the useful one — a Manual service that is stopped is a machine
      working as configured, and the same service set to Automatic is an incident, so one limit
      covers an estate of mixed configurations.

      **A defect a mutation found, and it was the bad kind.** `windowsOptions` blanked the host
      when no Windows credential was configured, so a sensor pointed at `server01` on a probe with
      no credential quietly measured *the probe's own box* and filed the numbers under
      `server01` — a wrong reading that looks entirely healthy. A credential is optional because a
      domain service account already holds a token the far end accepts; absent credentials mean
      "use who I am", not "ask somewhere else". Local is now what an operator asks for by name —
      `.`, `localhost`, a loopback address.

      Twenty-two mutations, all killed — including one killed by the type system rather than by a
      test, which is the strongest kind: weakening the "this volume reported no size" guard makes
      `free` and `size` stay `number | null` and the file stops compiling.

      **What is not verified, stated rather than implied.** No `Get-CimInstance` has run against a
      Windows machine. The transport, the wrapper and the parsing are proved — the wrapper against
      a real PowerShell 7 — but the four *queries* are written against recorded output, and the
      first run against Windows is an open item. `T-10` is complete as far as this environment can
      take it and no further; a Windows box is the remaining step, and `D-02` (device
      identification via WMI) is the natural place to do it.
- [x] **T-11 — TLS Certificate sensor** · M · P-05 · Expiry countdown, chain validation, hostname
      match, issuer and SAN channels.

      **T-11 outcome.** `tls.certificate`. Days-until-expiry is the primary channel and that is
      the whole design: an expired certificate is not an incident to detect, it is one to have
      *prevented*, and the only thing that prevents it is a number counting down where somebody
      set a limit weeks out. Every other channel is context for the day that limit fires.

      **The handshake deliberately does not verify.** A client that refused to complete would
      report nothing at all — the sensor would go Down with a TLS error instead of counting down
      the days, at exactly the moment somebody needs the number. So the socket accepts anything
      and *trusted*, *hostMatches* and the countdown become channels. That is also why an
      untrusted chain or a wrong name is a reading of 0 rather than a failed check.

      **The soonest expiry is taken across the whole chain, not the leaf.** An expiring
      intermediate takes a site down exactly as an expiring leaf does, renews on somebody else's
      schedule, and is the one nobody is watching — so the message names it when it is not the
      leaf. Wildcards match exactly one label (`*.example.com` covers `a.example.com` and not
      `a.b.example.com`), which is the browser rule and the one a naive `startsWith` gets wrong in
      the direction that accepts too much.

      The verdict is a **pure function** over a certificate, separately from the handshake, and
      that turned out to be necessary rather than tidy: `openssl req` gained `-not_before` in 3.2
      and this machine has 3.0, so there is no portable way to *issue* an already-expired
      certificate for a live test. The expiry arithmetic is tested against fabricated
      certificates, which is not a compromise — the input is a plain object either way.

      Verified live against `www.google.com`: 67 days left, issued by WR2, 3 in chain, trusted
      and matching, 117 ms handshake.
- [x] **T-12 — TLS Security Check sensor** · M · T-11 · Offered protocol versions and cipher
      suites, scored by weakness.

      **T-12 outcome.** `tls.security`. **It works by trying, because asking is not something TLS
      permits**: there is no query for "what do you support", a client offers a range and the
      server picks. So it is one handshake per version, each pinned to exactly that version, and
      what completed is what is offered. Four connections a scan — which is why the timeout
      parameter says out loud that this wants an interval in hours: what it measures changes when
      somebody edits a configuration file, not from one minute to the next.

      **The score is the weakest version still accepted, never an average.** An endpoint offering
      TLS 1.3 *and* TLS 1.0 is a TLS 1.0 endpoint as far as an attacker is concerned, because the
      attacker picks — and averaging would let a good new protocol hide a bad old one, which is
      exactly what makes a security dashboard reassuring and wrong.

      A refused *version* is the reading; a refused *connection* is a broken check, and the two
      have to look different or an unreachable host scores as a perfectly hardened one. Verified
      live against `www.google.com`: accepts TLS 1.2 and 1.3, refuses 1.0 and 1.1, score 80,
      strongest handshake `TLS_AES_256_GCM_SHA384`.

      Cipher-suite enumeration per version is deliberately **not** here: it is another dozen
      handshakes per scan, and the protocol version is what actually gets a device flagged in an
      audit.
- [x] **T-13 — HTTP Advanced** · M · P-09 · Method, headers, POST body, auth, redirect policy,
      response validation.

      **T-13 outcome.** `http.advanced`, and the request itself moved to
      `support/http/request.ts` — extracted at the moment there were three callers rather than
      guessed at with one. The three types differ in what they ask for and what they do with the
      answer, and not at all in how the request is made, which is the part holding the redirect
      rules, the two timings and the bound on how much is kept.

      **Separate from `http.request` rather than folded into it**, which is PRTG's split and the
      right one: the plain form is what most sensors are, and a form with fifteen fields makes
      the common case the hardest to fill in. This is the sensor for an API endpoint; that is a
      different job from "is the web server up".

      **Credentials come from the device, not from the parameters.** A new `http` credential kind
      (`A-05`) carries either a bearer token or a user name and password, so a hundred sensors
      against one API rotate in one place — where a token typed into each sensor's parameters
      would be a hundred places to rotate it, each returned by the API to anybody who can read a
      sensor. A token beats a password when both are set, so moving to one is the easy change.

      **Response headers are validated because a header is often the whole answer.** A cache that
      stopped setting `Cache-Control`, an API that stopped sending `X-Request-Id`, a site that
      lost its `Strict-Transport-Security` — each is a real regression that a status code and a
      response time report as perfectly healthy.
- [x] **T-14 — HTTP Content** · M · T-13 · String and regex matching, numeric extraction into
      channels.

      **T-14 outcome.** `http.content` — the type that monitors an *application* rather than a web
      server. A status code says the server answered; it says nothing about the queue depth on
      the status page, the build number that should have changed after a deploy, or the word
      "healthy" that stopped appearing. A page returning 200 with a stack trace in it is Up by
      every other measure.

      **The body is bounded and passing the bound fails rather than truncates**, because a
      pattern matched against half a document finds nothing and reports the value as *missing* —
      a far more confusing fault than "this page is bigger than this sensor reads". A number that
      genuinely stopped appearing is gapped rather than zeroed, and named in the message.

      **`support/snmp/extract.ts` moved to `support/pattern.ts` on the way**, and it should never
      have been under `snmp/`: there is no SNMP in it. It was written for `snmp.custom.string`
      and lived beside it; `snmp.table` was the second caller and this is the third, at which
      point the folder was telling a lie about what the code is. The `support/snmp` barrel still
      re-exports it, so nothing that already imported it changed. The sandbox and its watchdog
      are why an operator-supplied pattern against a remote-supplied page cannot hold a worker.
- [x] **T-15 — HTTP Transaction** · L · T-13 · Multi-step scripted sequence with per-step
      validation and variable capture between steps.

      **T-15 outcome.** `http.transaction` — the sensor for a *login*, not for a page. Every
      other HTTP type asks one question of one URL, and what an operator wants to know about a
      web application is whether somebody can sign in and reach what they came for. That is a
      form, a POST, a session cookie and a page behind it, where every part answers 200 while
      the whole thing is broken: a login page that renders perfectly and rejects every password
      is four healthy sensors and one useless application.

      **Five sensors in a row would not do this**, for three reasons that are the same reason:
      they do not share a session, they do not run in order, and five failures is five alarms for
      one outage. Here the jar carries between steps, the first failure ends the transaction, and
      there is one sensor to alarm on. The failure names the step — "step 3 of 5 (open the
      dashboard) answered 302" is a diagnosis; "the transaction failed" is a ticket somebody has
      to reproduce by hand. Per-step timings are channels for the same reason: a checkout that
      got slower got slower *somewhere*.

      **The cookie jar had to go into `fetchHttp`, not between the steps.** A login is a POST
      that answers 302 with a `Set-Cookie` and expects the very next request to carry it — a jar
      applied only between steps sends the session cookie one hop too late, and the dashboard
      comes back as the login page with a perfectly healthy 200 on it.

      **Two defects in shared code surfaced while building it.** A 302 was re-sending the POST
      body: RFC 7231 §6.4.3 permits changing to GET "for historical reasons" and every browser
      and `curl -L` do, and replaying a login form against the dashboard is a request no
      application expects — 307 and 308 exist to say "do not", and now preserve both. And
      `pattern.ts` bounded every subject at 4 KB, which is right for a string an SNMP agent
      returned and wrong for a page: a CSRF token or a queue depth below 4 KB of markup read as
      "not found", so the bound is now the caller's and `http.content` passes its own too.

      **Secrets are scrubbed out of the message on the way out.** Steps substitute
      `{{credential.password}}` from the device rather than carrying a password in their
      parameters, and a failure message is stored on the state log and returned by the API — so
      an API key in a query string, which is exactly where a transport error puts the URL, would
      otherwise be a secret the API hands to anybody who can read a sensor.

      Verified live against `ms-target`, which gained a session flow for it: sign in through a
      302, capture a token, substitute it into a later step — `3 steps in 19 ms; slowest was
      sign in at 10 ms` — and, with one step's expectation broken, `step 3 of 3 (call the api)
      answered 200 but does not contain "t=WRONG"`.
- [x] **T-16 — REST Custom** · L · T-13 · JSONPath/XPath extraction into declared channels, with
      a mapping editor. **JSON and XML delivered (`T-16`, `T-24`); the editor is `U-13`.**

      **T-16 outcome.** `rest.custom` plus `support/json-path.ts`, a bounded path language of its
      own. The difference from `http.content` is the shape of the answer and it is not cosmetic:
      a regular expression over JSON works right up until a field moves, a key is reordered, or a
      number arrives as a string — none of which is a change to the *data*, and all of which
      break a pattern. `$.nodes[?(@.state=='down')]` with a `count` says what it means and keeps
      saying it.

      **A path selects a set and the aggregate is chosen, never guessed.** "How many nodes are
      down" and "the worst load on any node" are the same path with a different aggregate; a
      language that silently took the first match would answer both wrongly and never say so.
      `count` counts what the path selected and every other aggregate counts only what is a
      number — conflating those makes both of them wrong somewhere.

      **The subset is documented rather than discovered**, and it stops short of script
      expressions on purpose: full JSONPath's `[?(...)]` evaluates JavaScript in the reference
      implementation, and an operator-supplied expression that can execute is a thing this
      codebase already refused once, in `support/pattern.ts`. Members, indexes, a wildcard,
      recursive descent and one comparison is what people actually write against a status
      endpoint. **The descent is iterative**: the recursive version overflowed the call stack at
      around 12,000 levels of nesting and reported `Maximum call stack size exceeded`, which
      tells an operator nothing and is not a diagnosis of anything. Now the visit budget is the
      only bound and it says what to do.

      **Nothing found is a gap; nothing found *anywhere* is a failure.** A metric an API stopped
      publishing is missing data, and the one thing this system does not do is draw that as zero.
      But every path matching nothing is not a gap — it is a sensor pointed at a document that
      does not contain any of what it is looking for, which would otherwise read as flat lines
      for ever.

      Verified live against `ms-target`, which gained a `/status.json` for it: `depth=12 down=2
      worst=95 oldest=4.5` — a filter and a count, a wildcard with a maximum and a scale, and a
      gauge the API quoted as a string — and, with the expectation inverted, `200, but the
      response says: $.status is "healthy" and should be "degraded"`.
- [x] **T-24 — REST Custom, the XML half** · M · T-16 · XPath extraction from an XML response,
      the other half of what `T-16` names. **Split out by `T-16`:** parsing XML properly needs a
      parser this package does not have, and namespaces, CDATA, entities and mixed content all
      have a way of half-working — a half-parsed document yields a confidently wrong number,
      which is worse than no sensor. That is a dependency decision (`fast-xml-parser` is the
      obvious candidate) and it has a second caller behind it in the v2 VMware SOAP sensors, so
      it is worth deciding once, deliberately, rather than hand-rolling a parser inside a sensor
      type. The path language in `support/json-path.ts` is the model for the XPath subset:
      documented, bounded, and stopping short of anything that evaluates.

      **T-24 outcome.** The dependency question, answered: `fast-xml-parser` — pure JavaScript,
      maintained, MIT, and eight packages in total including its seven transitive dependencies,
      none of which runs an install script. CLAUDE.md's rule is that syslog, NetFlow and WMI are
      written here *because npm has no maintained option*; XML has several, and hand-writing one
      would be inventing a bug in the part that hurts most. `support/xml.ts`
      is the whole surface: `parseXml`, `looksLikeXml`, `XmlError`, and the parser settings that
      are the real contract — every element is an array (so one `<result>` and five have the same
      shape), attributes are not (an attribute is single-valued, and wrapping one would make
      `@state` a list nobody asked for), attributes are prefixed rather than merged with children
      (`<r name="x"><name>y</name></r>` is a document where merging would make one of the two
      unreachable, and *which* one would depend on parse order), numbers stay strings, and
      namespace prefixes are kept.

      **A document is validated before it is parsed**, because `fast-xml-parser` is lenient by
      design and will happily build a tree from a truncated one — which is the case a monitoring
      check meets most often, a response cut off by a bound or a dropped connection. A tree from
      half a document is the confidently-wrong number this ticket exists to avoid.

      **XPath spelling over the same engine, not a second engine** — a deliberate divergence from
      the wording above. Two path languages would be two things for an operator to learn, two to
      test and two to get subtly wrong. So a path beginning with `/` is read as a location path
      and produces the steps `selectPath` already walks: `/prtg/result[1]/value`,
      `/prtg/result[last()]/channel`, `//channel`, `/result/unit/@state`, `/prtg/text/text()`,
      `/prtg/result[unit='%']/value`, `/prtg/result[value>100]/channel`. Two step kinds were
      added for it — `position` and `select` act on the node-set as a whole, which is XPath's
      semantics and not JSONPath's — along with the flattening every step needs, because an
      element is an array and `/prtg/result/value` must return `["91.5", …]` rather than
      `[["91.5"], …]`. **`[1]` is the first, and that is the one place the two syntaxes
      disagree**: JSONPath counts from zero and XPath from one, so the *syntax the path is
      written in* decides and the field description says which. Treating them the same would make
      `[1]` mean different things to two operators in the same field of the same form.

      Wired into two places. `rest.custom` gains `format: auto|json|xml`; and
      `exe.script.advanced` reads PRTG's advanced **XML**, which matters more, because that is
      what PRTG's own EXE/Script Advanced sensors emit *by default* — an installation moving
      across has scripts printing `<prtg><result><channel>…` and no reason to rewrite them. It
      goes through the same `channelsFrom` as the JSON form, so the two shapes cannot drift into
      disagreeing about what a channel is called.

      **A defect found by the tests, in the shared half.** `looksLikeXml` fell back to "starts
      with `<`" with only a `<!DOCTYPE html` guard, so a proxy or login page answering
      `<html><body>…` was read as XML — and HTML is *well-formed enough to parse*, which turned
      the honest diagnosis ("this is not an API response") into the useless one ("your path
      matched nothing in it"). Now HTML is excluded by content type and by root element, while a
      declaration still outranks a content type that contradicts it, so XML served as
      `application/json` — a real misconfiguration — is still read. A second one: a `SYSTEM`
      entity makes the library throw its own error, which escaped `parseXml` unclassified;
      wrapped now, found by the XXE test.

      **The XXE tests assert a property of the library, not of a setting we pass.** No
      DTD-declared entity is expanded at all — a billion-laughs document parses to the literal
      text `&lol8;` — and a `SYSTEM` entity is refused outright, so neither `file:///etc/passwd`
      nor a URL it would fetch has anything to act on. A defence nobody checks is one that
      disappears quietly on an upgrade, so all three are asserted.

      `XMLValidator` is marked deprecated in favour of the `fast-xml-validator` package and we
      are staying with it, measured: that move adds **seven** packages, including a second XML
      parser, duplicate copies of two the parser already brings, and two with install scripts. If
      it is ever removed the import fails at build time, which is the right failure — the
      alternative is losing the validation without anything saying so.

      Fourteen mutations, all killed: skipping validation, wrapping attributes in arrays, not
      wrapping elements, letting the parser coerce numbers, dropping the HTML guard, counting
      XPath positions from zero, not flattening a step's node-set, comparing a node instead of
      its string value in a predicate, `last()` not being last, ignoring PRTG's XML error flag,
      never reading advanced output as XML, ignoring an explicit `format: xml`, and not
      unwrapping PRTG's XML fields.

      Verified live against `ms-target`, which gained `/status.xml` and an unlabelled
      `/status-untyped` serving the same document as `application/octet-stream`, plus a
      `dev/scripts/prtg-style-xml.sh`. All three sensors Up: both REST ones read `depth=12 down=2
      worst=95 oldest=4.5` through XPath — the unlabelled one via the body fallback — and the
      script sensor reported `from a PRTG-style XML script` with `inodes` created dynamically
      from `<channel>Inodes</channel>`. Pointed at the HTML page, it says `200, but the response
      is not JSON: Unexpected token '<' … (it says Content-Type: text/html)`, which is the
      defect above, fixed and confirmed.
- [x] **T-17 — Mail sensors** · L · P-05 · SMTP, POP3, IMAP, and SMTP&IMAP Round Trip with
      cleanup of test messages.

      **T-17 outcome.** Four types over `support/mail/`: one connection and three protocol
      clients written here, because npm's mail libraries are all *clients* — they retry, they
      queue, they hide a `452` behind a reconnect, and every one of those behaviours is the
      opposite of what a check must do. A sensor that retried would report a healthy relay while
      one message in three was being refused.

      **All three protocols are the same transport wearing different words**, so the socket, the
      CRLF line splitting, the per-reply deadline, the abort and the in-place `STARTTLS` upgrade
      live in `connection.ts` and the protocols only supply "has this reply ended" — SMTP by a
      space after the code, POP3 by a lone dot, IMAP by its own tag coming back. Three copies of
      that would be three chances to get the timeout subtly wrong, and the failure mode is a
      worker that hangs rather than a check that fails.

      **A TCP connect is not a mail check.** Port 25 accepts a connection long after the relay
      behind it stopped taking mail: a full queue answers `452` at `MAIL FROM`, an anti-spam
      layer out of licence answers `451` at `RCPT TO`, and both are perfect to a Port sensor.
      **And SMTP, IMAP and a mailbox all answering is still three green sensors on a system where
      mail has not moved for six hours** — which is what the round trip is for: it is the only
      one of the four that measures the pipeline rather than its parts.

      **Cleanup is not optional and its failure is a check failure.** The round trip puts a
      message in a real mailbox every scan, so it deletes by a token generated per check — never
      by position, because POP3 renumbers — and reports anything of its own left behind by an
      earlier scan on a channel of its own. `DELE` is not a delete until `QUIT` (RFC 1939 §6) and
      `STORE \Deleted` is not one until `EXPUNGE`, so both failures are noticed rather than
      reported as a clean round trip while the mailbox fills at one message a minute.

      **Two things found while writing it.** `STARTTLS` that is asked for and not offered fails
      rather than continuing — a silent downgrade would report a healthy relay while sending the
      password in plain text. And an address is a sensor *parameter*, so a carriage return in one
      ends the `MAIL FROM` command and lets whatever follows be read as another: that is
      injection through a configuration form, and it is refused at the protocol rather than at
      the caller so a new caller cannot forget. A newline in the subject is folded instead of
      refused, because that one is a typo in almost every case.

      `mail` joined the credential kinds, which took migration `024` — the kind is a Postgres
      enum value, and an installation that could store a kind the database rejects would fail at
      the moment somebody types a password in. `ALTER TYPE … ADD VALUE` is transactional on
      PostgreSQL 12+; the rollback rebuilds the enum and says plainly that it deletes mail
      credentials, because Postgres has no `DROP VALUE`.

      Tested against three in-house simulators (`test/support/mail-servers.ts`) sharing one
      mailbox, since what is worth asserting — a relay that accepts a connection and refuses at
      `RCPT TO`, a `QUIT` that fails so a deletion never happened — is unreachable against a
      server behaving normally. Verified live against **GreenMail**, added to the dev stack for
      this: MailHog is a sink that speaks no POP3 or IMAP, and a round trip needs both halves on
      one server. `delivered in 342 ms`, `INBOX: 1 message, 1 unread`, `1 message waiting (69
      bytes)`, `delivered in 539 ms after 1 mailbox check`, and IMAP over implicit TLS on 3993
      with the "certificate is not being verified" note on every scan.
- [x] **T-18 — Database sensors** · L · P-05 · PostgreSQL, MySQL, MSSQL: connect, run a query,
      execution time and first-result-cell channels, statement timeout.

      **T-18 outcome.** Three types over `support/db/`, which is one interface and three files
      that import a driver each — the isolation `support/ssh/session.ts` gives `ssh2`, so
      replacing one is a file rather than a search and a probe that never runs a MySQL check
      never loads `mysql2`. The engines differ in how you connect and in how you tell the server
      to stop, and in nothing an operator configuring a check would notice, so everything else is
      written once in `db-shared.ts`.

      **Three dependencies, and the rule read the right way round.** CLAUDE.md says syslog,
      NetFlow and WMI are written here *because npm has no maintained option*. `pg` was already a
      dependency of `packages/core`, so PostgreSQL costs an installation nothing. MySQL's default
      authentication since 8.0 is `caching_sha2_password`, an RSA exchange where a subtle mistake
      means a sensor that works until somebody rotates a password; SQL Server's TDS is a binary
      protocol with its own TLS-inside-the-protocol arrangement. Both have maintained drivers —
      `mysql2` and Microsoft's own `tedious` — and writing either by hand would be inventing a
      bug in the part that hurts most.

      **No connection pool, which is the opposite of the SNMP and SSH decision and deliberately
      so.** Those pool because a session costs a handshake. A database connection costs the
      *server* a backend process and a slot against `max_connections`, and a monitoring system
      holding one open per sensor is a monitoring system that takes a database down on the day it
      is needed. Connecting per scan also makes the connect time a real reading — exhausted
      connection slots move it and leave the query time exactly where it was, which is the only
      way to tell that apart from a slow query.

      **The statement timeout is asked of the server, and the live test is what proved it
      matters.** A client that gives up and closes its socket leaves the query running: a check
      that did that every sixty seconds would become the outage it was meant to warn about. So
      PostgreSQL gets `statement_timeout` on the session, SQL Server gets `LOCK_TIMEOUT` plus
      `tedious`'s protocol-level cancel, and MySQL gets — **both** of its variables. Setting only
      MySQL's `max_execution_time` (milliseconds, `SELECT` only) is what this did first, and a
      live MariaDB let a ten-second query run to completion under a three-second timeout: MariaDB
      has `max_statement_time` instead, in *seconds*. That was a real defect no unit test would
      ever have found.

      **`verifyTls` defaults to false here and nowhere else in the catalogue.** Almost every
      database server is running the self-signed certificate its installer generated; the
      connection is still encrypted, it is simply authenticated against nobody, and a default of
      `true` would mean every database sensor in every installation starts Down for a reason that
      has nothing to do with the database. The parameter description says exactly that rather
      than leaving it as a surprise.

      The first cell of the first row is the primary channel — not the execution time, because if
      the timing were what you were watching you would have written a Port sensor. Extra columns
      of one query become extra channels rather than five more connections, a cell that is not a
      number is a gap rather than a zero, and `expectRows` catches the query that quietly started
      returning nothing, which a response time reports as perfectly healthy. The `database`
      credential kind was already in migration 001's enum, so unlike `T-17` this needed no
      migration.

      Verified live against all three: `1 row in 13.086 ms; value=1 oldest=0` (PostgreSQL, with a
      second column as its own channel), `1 row in 3.036 ms` (MariaDB), `1 row in 22.353 ms;
      value=27` (SQL Server), and the row-count guard reporting `the query returned 1 row and
      this sensor expects 5`. MariaDB and SQL Server joined the dev stack behind a `db` compose
      profile — **Azure SQL Edge rather than `mssql/server`**, because SQL Server's image is
      amd64 only and under emulation on Apple silicon it starts, reports healthy, and then
      segfaults (`qemu: uncaught target signal 11`, measured). Edge speaks the same TDS, so the
      driver has a real target on every machine rather than on some of them.
- [x] **T-19 — EXE/Script sensors** · L · P-03 · Simple and Advanced variants, documented output
      formats, sandboxing, timeout, working directory and env control.

      **T-19 outcome.** `exe.script` and `exe.script.advanced`, both declaring
      `isolation: 'process'` — which is what `P-03` was built for, and the order was not
      accidental: a fault in code somebody else wrote must not take the probe down.

      **This is the escape hatch, and it is why the plugin contract does not have to cover
      everything.** Every other type answers a question somebody anticipated; this one answers the
      question nobody did — a vendor's CLI, a licence count, a business metric out of a report, a
      queue depth from an application with no API. It is what stops "we need a sensor for X" being
      a release.

      **The sandboxing is one function, and it is the whole ticket.** `resolveProgram` takes a
      *name* and resolves it inside a directory the operator configured **on the probe**. Not an
      absolute path, not a relative one, not `..`. Without that, anyone who may add a sensor may
      run any command as the account this probe holds every credential in — creating a sensor
      would be remote code execution with extra steps. The directory is `probe.scriptDir` and it
      is **empty by default**, so a probe nobody has deliberately given scripts to runs nothing.
      `realpath` runs *before* the prefix comparison, not after: a symbolic link inside the
      directory pointing at `/bin/sh` is the obvious way around a check made on the name, and
      resolving first is what closes it. A name may only contain letters, digits, dot, dash,
      underscore and a slash — nothing is run through a shell, so a name needing anything else is
      a name pointing somewhere it should not.

      **Warning is not an outcome a check can report, and that is a deliberate divergence from
      PRTG.** Its format has a Warning return code; here Warning comes from a limit on a channel
      (`M-04`), which is visible, editable and inheritable — where a Warning baked into a script
      is a threshold nobody can see or change without editing the script on every probe. A
      non-zero code fails the check and the message names what the script meant by it.

      **Three output formats for the simple sensor and two JSON shapes for the advanced one**,
      including PRTG's own `returncode:value:message` and `{"prtg":{"result":[…]}}`, so an
      installation's existing scripts work unchanged. A comma decimal separator is read, because
      that is what a script written on a German-locale machine prints. XML was not accepted here
      for the reason `T-16` gave; `T-24` settled it and added PRTG's advanced XML, which is what
      its own EXE/Script Advanced sensors emit by default.

      **The advanced sensor's channels come from the program, not from the form** — the core
      creates a channel the first time a sensor mentions it (`S-07`), so a script that starts
      reporting a new metric gets a new channel on its next scan. What the form does declare is
      *which* channel is primary, because that one cannot be discovered and a sensor without one
      is a sensor nothing alarms on.

      **The environment is built, never inherited**, and there is a test that the probe's own
      `MS_*` overrides do not reach a script. One write-only `secret` parameter reaches the
      program as `MS_SECRET` — in the environment rather than an argument, because arguments are
      world-readable through `ps`.

      **Found live:** `probe.scriptDir` was handed to the child process as written, so a relative
      path resolved against the *child's* working directory rather than the probe's — every other
      path in that config file is relative to where the probe was started. Resolved in `main.ts`
      now.

      Verified live: `34 jobs waiting on ms-target` from a PRTG-format script with `%host`
      substituted, three dynamically created channels from an advanced one, and a PRTG-style
      script's `Free Space`/`Inodes` arriving as `free_space` and `inodes`. Three sensors naming
      `/bin/sh`, `../../../bin/sh` and `sh -c id` were each refused with a message saying why.
      `dev/scripts/` holds the three examples. Six mutations of the boundary killed.
- [x] **T-20 — Syslog Receiver** · L · P-05 · In-house RFC 3164 and 5424 parser, UDP + TCP
      listeners, filter rules, severity/facility count channels, message retention.

      **T-20 outcome.** `syslog.receiver`, and it needed **no change to `T-06`'s listener
      contract at all** — which is the point of having had one. The probe owns one socket, a
      check runs in whichever worker is free and only while it is running, and
      `CheckContext.received` hands each sensor what it has not seen. A second protocol arrived
      and the seam held.

      **The ring came out at the second caller, and that is not the same call `P-24` made.** It
      says extracting the SNMP and SSH session pools at two instances would have guessed which
      half varies. These two are not *similar*: the ring, the cursor arithmetic, the drop
      counting and the retain sweep are byte-for-byte identical, and what varies — which socket,
      which filter, how a message is rendered — is entirely outside them. `NotificationRing` is
      the extraction; `T-06`'s tests passing unchanged is the evidence it was transparent.

      **Both formats, and the older one is not optional.** RFC 5424 is what anything modern
      emits; RFC 3164 is what a switch bought in 2014 still sends, and a receiver that only
      understood the new one would work against a test rig and not against a network. The tag is
      split from the pid (§4.1.3) because `sshd[1234]` as one field is a field nobody can write a
      rule against, and a message stamped December arriving in January is read as *last* year —
      getting that backwards puts a line eleven months into the future, where nothing looking at
      a time range will ever find it.

      **A message that parses badly still becomes a notification.** Dropping it loses exactly the
      line somebody needs during an incident, because the devices that emit malformed syslog are
      disproportionately the ones going wrong.

      **TCP syslog has two framings and they are not compatible** — RFC 6587 §3.4.1
      octet-counting and §3.4.2 newline-separated — so both are read. Guessing wrong on
      octet-counting turns one message into several with the count glued to the front of the
      first, which is the kind of corruption that gets blamed on the sender for weeks.

      **Counting by severity is the reading and matching is the alarm.** A sensor that only
      counted lines goes Down on a busy night and Up on a quiet one; per-severity channels let a
      limit say "more than five errors a minute", which is the thing an operator means. Rules are
      ANDed, because if they were ORed then adding a second rule would *widen* the sensor. Two
      things it refuses to call zero: a listener that is not running, and a buffer that
      overwrote messages before this sensor read them.

      **The sender allow-list is a filter, not a lock**, and saying so is the point — syslog
      authenticates nothing whatsoever, so an operator who believed otherwise would put this on a
      port reachable from the internet. The listener is **off by default** and binds 10514 rather
      than 514, which needs privilege a probe should not have.

      Verified live end to end: five messages over UDP and one octet-counted frame over TCP,
      through a sensor filtering on `appName = sshd` at `minSeverity: warning` — `4 messages`,
      three `error` and one `critical`, with the `cron` line and the informational
      "Accepted publickey" correctly excluded and the last three lines shown. Eight mutations
      killed, one of which first survived because "keep the severe ones" and "keep the mild ones"
      both count two out of three — only the per-severity breakdown tells them apart.
- [x] **T-21 — Sensor Factory** · L · M-04 · Formula language over other sensors' channels
      (`channel(id, ch)` arithmetic), its own channels and limits, cycle detection.

      **T-21 outcome.** `core.factory`, and it is **the one sensor type the core evaluates rather
      than a probe**. It has to be: its inputs are channel values this process already holds, and
      asking a probe would mean shipping other sensors' history out to every probe that had one.
      `SensorType.evaluatedBy: 'core'` is the declaration that keeps it out of every assignment
      list — read from the catalogue, exactly as `listener` and `isolation` are, so there is no
      sensor id hardcoded in the probe configuration path.

      **The results go through `acceptResults` exactly as a probe's do**, which is the decision
      everything else falls out of: channel creation, scaling, limits, the state machine,
      dependencies, notifications. A factory sensor therefore has history, thresholds and alarms
      with no special case anywhere downstream — which is what makes "one sensor to alarm on
      instead of twelve" (CLAUDE.md: one outage, one alarm) something an operator can use rather
      than a slogan.

      **The formula language is hand-written and is deliberately not a sandbox around
      JavaScript.** `new Function(formula)` would let anybody with sensor-create rights run code
      in the core process, which holds the vault key and the database — and `support/pattern.ts`
      already went to real trouble to bound an operator-supplied *regular expression*. So it
      parses what it accepts and can evaluate nothing else: numbers, five operators, brackets,
      `channel(id, 'key')`, `status(id)`, and ten functions. Trailing rubbish after a complete
      expression is refused rather than ignored, because `1 + 2 nonsense` evaluating to 3 is a
      formula quietly meaning something other than what it says.

      **A gap propagates through the whole expression**, which is the rule the system is built on
      applied where it is easiest to get wrong: `channel(1,'in') + channel(2,'in')` with sensor 2
      missing must not report sensor 1's traffic as the total. That is a number which looks like
      data and is wrong, and it is the failure mode a factory is most likely to produce.
      `default(…, 0)` is how an operator says otherwise — in the formula, where a reader can see
      it. A division by zero is a gap too, because a factory going Down over a briefly-zero
      denominator would be an alarm about arithmetic.

      **A stale reading counts as absent.** A source that stopped reporting leaves its last value
      behind for ever, and arithmetic over something that stopped being true an hour ago is worse
      than no number at all.

      **Cycles are refused before anything is evaluated**, not discovered at a stack overflow: a
      factory over a factory is legitimate and useful, a ring is not, and every member of one
      fails its check naming the sensors that form it. Within one sweep, factories are evaluated
      in dependency order, so a factory over a factory sees *this* sweep's value — a layer of
      staleness per level would be a whole scan interval each.

      **One sweep for the whole installation rather than a scan interval per factory.** They have
      no device to be polite to and no packet to send: two queries per sweep however many there
      are, where honouring each sensor's own interval would mean a second scheduler in the core to
      stagger work cheaper than the staggering. An overrunning sweep is skipped and counted, the
      same rule the probe's pool follows for a sensor.

      Verified live: a factory over the development tree's two ping sensors reporting
      `total_rtt=0.201 worst=0.113 up=3; gap had nothing to compute from` — a sum, a maximum, a
      cluster count from `status()`, and a channel reading a sensor that does not exist correctly
      blank rather than zero. The probe never received it. Eight mutations killed.
- [x] **T-22 — Ping Jitter and Port Range** · M · P-08, P-10 · Completes the v1 connectivity set.

      **T-22 outcome.** `icmp.jitter` and `port.range`, both reusing what `P-08` and `P-10`
      already built rather than adding a second way to ping and a second way to connect.

      **Jitter is RFC 3550 §6.4.1's estimator, not a spread.** A link answering in 20 ms every
      time and one alternating 5/35 ms have the same minimum, maximum and mean, and one of them
      makes a voice call unusable — no summary statistic of the *set* can tell them apart,
      because jitter is a property of the order the packets arrived in. Using RTP's own
      estimator rather than a simpler mean deviation is deliberate: a figure that disagreed with
      every other tool on the network would be argued with rather than acted on. The test that
      proves this is load-bearing feeds it `[10,10,30]` and `[10,30,10]` — identical sets,
      1.25 ms against 2.422 ms — and it is the one that fails when the estimator is replaced by
      a spread. Fewer than two replies gaps rather than reporting zero, because one reply has no
      variation and "perfectly stable" is the opposite of what a link that answered once in
      twenty is doing.

      **`runPing` moved to `support/ping.ts` with the second caller**, so the abort handling and
      the message that names the missing binary are not duplicated.

      **The port set counts rather than judges, and is deliberately not a scanner.** "These five
      must be open" is a back-end pool — five Port sensors would be five alarms for one outage —
      and "this range must stay closed" is a firewall canary that wants zero. The same sensor
      does both because it reports the count and leaves the verdict to a limit on the channel.
      Sixty-four ports is the cap: enough for either job, and small enough that a probe cannot
      become the thing that trips somebody's intrusion detection every sixty seconds. A real
      scan is `nmap`, run by a person, once. A port a firewall *drops* counts as closed, because
      from the outside it is.

      Verified live against `ms-target`: `20-25,161,443,8080` reads "1 of 9 open: 22" at 11.11%
      (161 is UDP and correctly not open over TCP), and ten packets give 0.059 ms of jitter
      against a 0.062–0.391 ms range — well under the spread, which is the estimator working.
- [x] **T-23 — Sensor type authoring guide** · S · P-05 · Documentation plus a worked example,
      proving a new type is a one-file, half-day job.

      **T-23 outcome.** `docs/adding-a-sensor-type.md` brought back into line with what the
      contract has become, and a real worked example added: `dns.blocklist`.

      **The guide had drifted into telling people the wrong thing.** It was written at `P-05`,
      before the contract grew `isolation` (`P-03`) and `evaluatedBy` (`T-21`) — and its testing
      section still said that a type which shells out should "set `costHint: 'heavy'` and say so
      in review", which was true when there was no mechanism and is now simply wrong. It also
      listed one shared transport where there are ten. A guide that is out of date is worse than
      no guide: it is confidently wrong in exactly the places somebody new will trust it.

      **The worked example is a real sensor, not a toy.** A mail relay that lands on Spamhaus
      stops delivering to half the internet and does it silently, while every other sensor on the
      host stays green. One file, two lines of registration, one test file with a forty-line
      `node:dgram` DNS simulator in it, and nothing else in the system changed.

      **Writing it found two defects, and the second is the argument for live verification.** The
      timeout did not work — Node's `Resolver` retries four times by default and `timeout` is per
      *try*, so a check configured for five seconds takes twenty; the test that found it now
      asserts elapsed time. And the *live* run, pointed at one real zone and one fictional one,
      reported "on none of 2 blocklists": `NXDOMAIN` means "not listed" **and** "no such zone", so
      a typo in a list name is a sensor that reports clean for ever. An unlisted answer is now
      confirmed by asking whether the zone exists. Both are the same shape — a sensor that always
      answers the reassuring thing — and the type's own docstring warned about that shape while
      walking into it.

      **What the guide gained.** `isolation` and `evaluatedBy` sections; the table of all ten
      shared transports with the ticket that built each; why `support/pattern.ts` exists (86
      seconds, measured, for `(a+)+$` against forty characters) and why `support/json-path.ts`
      stops short of filter expressions; the catalogue's defaults check; mutation testing and live
      verification written down as expectations rather than folklore, with the two real cases
      where a passing test was asserting nothing.

      **Cost, honestly:** about 190 lines of sensor and 200 of test, in one sitting. The bounded
      part of the claim holds — nothing outside those files and two lines of registration changed.

## Phase 7 — Discovery and templates

- [x] **D-01 — Network sweep** · M · P-08 · Ping sweep across an IP range; resumable,
      cancellable, rate-limited so it never starves live checks.

      **D-01 outcome.** Three properties, three mechanisms, and each is worth naming separately
      because they are not the same problem.

      *Resumable* is one integer. A run's position is how many addresses have been offered, held
      in a column on the core rather than on the probe — because the probe is the thing that
      restarts. A probe crash, a reconnect and a core failover all resume the same way: read the
      cursor, send it back. **The cursor is a floor, never a promise**: it advances only after
      the hosts in the same message are stored, and re-sweeping a few addresses after a crash is
      free because the unique key on `(run_id, address)` makes a repeated host a no-op. Writing
      the cursor first would be a host silently missed — and the run would report itself
      complete, so nobody would ever know to look.

      *Cancellable* is an `AbortController` per run, and cancellation is a **message** rather
      than a disconnect: an operator who typed the wrong range wants the pings to stop now, not
      when the last of 65,536 timeouts expires. The decision is recorded before it is sent, so a
      cancel works while the probe is disconnected — otherwise the click did nothing and the
      sweep resumes the moment it comes back.

      *Rate-limited so it never starves live checks* is the one that needed more than a number.
      `concurrency` and `ratePerSecond` bound the sweep absolutely, but a bound chosen in advance
      cannot know what else the probe is doing at three on a Tuesday — so **the sweep watches the
      check pool and stands down entirely while anything is queued**, and counts the time it
      spent doing so, because backpressure is visible and never silent. The rate is a token
      bucket rather than a delay per address: a fixed delay makes the floor the rate, so a
      network that answers instantly runs at exactly the limit and one that times out runs far
      below it.

      **`@ms/shared` owns the range parser**, so the core's "that is 16,777,214 addresses" and
      the probe's enumeration cannot disagree — a disagreement shows up as a progress bar that
      never reaches the end, which is the kind of bug that gets lived with rather than reported.
      Four spellings (`10.0.0.0/24`, a pair, the last-octet shorthand, one address) in any comma
      mix. **A CIDR excludes its network and broadcast addresses**, because pinging `.0` and
      `.255` draws a reply from every host on some networks and none on others — but a /31 and a
      /32 keep everything, since RFC 3021 point-to-point links are entirely host addresses and
      the usual rule would sweep nothing at all. **IPv4 only, stated rather than omitted**: the
      smallest IPv6 subnet anybody assigns is a /64, so sweeping IPv6 is not slow but impossible,
      and an IPv6 literal is refused with that sentence.

      One ping per address rather than the sensor's four: a sweep asks "is anything here", and
      four packets across a /16 is 262,136 packets for an answer that has not improved. **An
      address that could not be *attempted* is counted separately from one that did not answer**,
      because a firewalled network and an empty one look identical otherwise.

      **A defect live verification found and nothing else could have.** The four new protocol
      members were written into the wrong union: `sweep-start` and `sweep-cancel` landed in the
      *probe→core* schema, so the core sent a message the probe's own validator had never heard
      of, the probe closed the connection on a protocol violation, and the pair sat in a
      half-second reconnect loop. Every unit test passed. The fix is two lines; the lasting fix is
      the test block that now asserts each message from the side that receives it **and refuses
      it from the side that must not**, which is the assertion that was missing.

      A second defect, found by a test written for it: `ORDER BY address` on a query that renames
      `host(address) AS address` binds to the *output* column, so the rows came back sorted as
      strings and `10.0.0.10` preceded `10.0.0.9`. The whole reason the column is `inet` is to
      sort as an address, and an operator scanning the list for gaps is exactly who a string sort
      misleads.

      Nineteen mutations, all killed. One turned out to be **equivalent** rather than surviving —
      `>>> 0` on the CIDR mask does nothing, because `network` and `broadcast` coerce on the way
      out — so it was deleted rather than tested around; a defensive coercion that cannot be
      removed by a mutation is a coercion that is not doing anything.

      Verified live against the dev network. A sweep of twenty addresses found eleven in address
      order with sub-millisecond RTTs; a run left `queued` by the protocol defect above **resumed
      by itself on the next connect** and completed, which is the resume path proven rather than
      described; and a /24 cancelled at three seconds stopped at 15/254 with the eleven hosts it
      had already found still recorded.
- [x] **D-02 — Device identification** · L · T-01, T-07, T-09 · SNMP sysObjectID/sysDescr, WMI,
      SSH banner, open ports, reverse DNS → a device fingerprint.

      **D-02 outcome.** **Not blocked on `R-09`, which the ticket above assumed it would be.**
      That note was written before `D-01` existed. `R-09` is a *synchronous* request/response for
      an API call that is waiting — an interface picker, a "test this sensor now" button — and
      identifying two hundred hosts is not something anybody waits on. It is a second stage of
      the same job `D-01` already established: a job with a cursor, progress that carries
      findings, one finish. `R-09` is still needed for what it was actually added for.

      **A stage on the same run, not a second run.** An operator starts one discovery and watches
      one thing finish; two rows would mean two progress bars, two cancels, and a question about
      what cancelling one does to the other. `status` gains `identifying` between `running` and
      `done`, and the two stages carry their own cursors so they resume independently — one
      cursor would make a resumed identification restart the sweep.

      **The classifier is pure and lives in `@ms/shared`**, and that split is the whole design.
      The probe opens sockets; `classify` draws every conclusion. A misclassified host gets the
      wrong sensor set from `D-03`, every one of those sensors fails from its first scan, and an
      operator concludes discovery does not work — so it is the half that has to be exercisable
      without a network, and every fixture below is a string a real device sends.

      **Evidence is ranked by what it is worth, not by what is easy to check.** `sysObjectID` is
      a vendor naming its own product and outranks everything; `sysDescr` is prose by the same
      vendor and is nearly as good; a banner is next; a port is a guess and only decides when
      nothing better has; a reverse name is what somebody typed years ago and can only *raise* an
      answer nothing else reached. Two orderings earned their comments. `VMware ESXi` is matched
      before the Linux rule, because an ESXi agent reports a Linux-looking string and the other
      order would give every hypervisor in the estate a Linux sensor set. And the generic
      `switch|router|firewall` rule sits *after* the OS rules — `sysDescr` very often contains the
      host's own name, so `FreeBSD firewall.example.com 13.2-RELEASE` was being read as network
      equipment until a test caught it. `445 && !22` is Windows and `445 && 22` is not, because
      SMB with SSH is a Linux box running Samba.

      **`unknown` is a real answer and the most important one.** A host that answered a ping and
      nothing else exists, and a Ping sensor is the right thing to create for it. Guessing would
      create sensors that fail from their first scan.

      **Two defects, both found live and neither reachable from a test that had not seen them.**
      A service on the development network answered a TCP connect with NUL bytes; `jsonb` cannot
      hold `\u0000` at all, so the write failed with `22P05` and took the whole batch of
      fingerprints with it. And then the interesting one: the failure **retried for ever** — 298
      passes in three minutes. Every component behaved correctly on its own. The endpoint caught
      the error rather than dropping the connection; the probe answered every job it was handed;
      the service resumed from the cursor it had. What was missing was anybody noticing that no
      progress was being made. Banners are now stripped of control characters at the source, and
      a batch offered more than three times from the same cursor fails the run with a message and
      a counter — because a stall nobody counts is a stall that recurs.

      A third the compiler could not have caught: `DiscoverySink.identified` takes `unknown[]` and
      the service's method took `Fingerprint[]`, which compiles because TypeScript's method
      parameters are bivariant. The wire schema deliberately does not enumerate a fingerprint's
      fields — the shape grows, and refusing a newer probe's good answer would defeat the version
      negotiation — so the core validates instead, strictly on `address` and `kind` and
      permissively on everything else.

      Eighteen mutations, all killed. Verified live: a twenty-address sweep found eleven hosts and
      identified all eleven — `sysDescr` classified two of them as Linux at 88, the open ports
      picked up PostgreSQL, MariaDB and SQL Server, and reverse DNS named the rest.
- [x] **D-03 — Device templates** · L · D-02 · Fingerprint → sensor set mapping; a built-in
      template set; save-this-device-as-a-template.

      **D-03 outcome.** The same shape as the lookup catalogue — definition, built-ins,
      catalogue, loader, override-by-id from `<dataDir>/device-templates` — and deliberately so:
      an operator who has learnt where lookups go and how an override works knows this too. It is
      also the mechanism `CAPABILITIES.MD §3.7` chooses over PRTG's dozens of hardcoded vendor
      sensor types, so being a *data file* is the whole point.

      **Matching is data, never an expression**, for the reason `T-21`'s formula language gives
      about the same process: a template that could evaluate something would be an
      operator-supplied expression running in the core. Criteria are ANDed — a template that ORed
      them would *widen* as it was made more specific, which is the opposite of what anybody
      writing one expects — and each contributes a weight reflecting how specific it is, so a
      template pinned to a `sysObjectID` prefix outranks one that says "network device" without
      anybody maintaining an order by hand.

      **`matchTemplates` returns every match rather than the best**, because a device is
      genuinely several things at once: a Linux box serving HTTP wants both sets, and picking one
      would mean somebody writing "Linux server that also serves HTTP" and then "…and also
      PostgreSQL". Deduplication is by type *and* parameters — two templates naming `icmp.ping`
      mean one Ping sensor, two naming `http.request` on different paths mean two — with the keys
      sorted, because two templates written by two people will not agree on key order and
      `JSON.stringify` preserves it.

      **The whole set is written to avoid one failure: a discovery that creates thirty sensors
      per device, twenty of which fail from their first scan.** That is how an operator learns to
      distrust the feature and turns it off. So `requires` is per *sensor* — an SSH Disk Free
      sensor on a Linux server with port 22 firewalled is a sensor that fails for ever — and
      `credential` names the kind a sensor cannot work without, so a device whose ancestry can
      authenticate nothing gets Ping and nothing else. A test asserts that every built-in spec
      whose type declares a credential kind says so. `ms.generic` matches everything and scores
      zero, which is what makes the rest safe: a host nothing recognised is still monitored.

      **Save-as-template does not infer a match rule, and that is the interesting decision.** It
      would be easy to guess one from the device's fingerprint — same vendor, same OID prefix —
      and it would be wrong about half the time: only the operator knows whether the template is
      for *this model*, *this vendor* or *every switch*. So it comes back matching nothing until
      somebody says, because a template that matched everything by accident would put a Cisco
      sensor set on every printer in the estate. It also drops parameters nobody set, since a
      template pinning every default would stop a later release's better default from ever
      reaching devices made from it. Nothing needs redacting: a monitored device's credentials
      live in the vault and never appear in `params`, which is a property of the object model
      rather than of that function — so it is written down where somebody will read it.

      Twenty mutations, all killed. **One found a test asserting the wrong thing and passing
      anyway**: the OID-prefix boundary check was tested with a *longer* prefix against a shorter
      arc, which `startsWith` gets right by accident. The assertion that earns its place is
      enterprise 99 against a prefix of enterprise 9. One mutation was equivalent — adding `g` to
      a `RegExp` constructed fresh on every call does nothing — which is what the "constructed
      fresh" comment is about.

      Verified live against `D-02`'s run: `172.19.0.4` (SNMP, no SSH) planned the four SNMP
      sensors and no SSH ones; `172.19.0.6` (SSH, HTTP and SNMP) matched `ms.linux`,
      `ms.web-server` and `ms.generic` and planned nine sensors with exactly one Ping; and with
      no credentials named, every host planned Ping alone — except the web server, whose HTTP
      sensor needs none.
- [x] **D-04 — Provisioning and idempotency** · L · D-03 · Create devices and sensors; match on
      IP/DNS within the target group; re-runs create zero duplicates.

      **D-04 outcome.** Idempotency is the whole ticket and it is not a nicety: a discovery is
      re-run — on a schedule (`D-07`), or by an operator who has just configured a credential —
      and a second run that duplicated everything would double the object tree, double the load
      on every device in it, and double every alarm.

      **Three keys, in order of how much each means.** The address is what the sweep found and is
      exact. The reverse name is next, because a device somebody created years ago as
      `web01.example.com` is the same machine the sweep just found at an address. The short name
      is last and is only consulted when nothing else matched — two sites can each have a
      `web01`, and consulting it first would merge `web01.london` and `web01.paris` into one
      device the first time both were discovered. **Within the target group**, because the same
      address legitimately exists twice in one installation: two sites behind NAT, a lab that
      mirrors production.

      **A device created during the pass joins the index immediately**, or two addresses that
      resolve to the same name in one run would become two devices — the second being exactly the
      duplicate this ticket exists to prevent.

      **The duplicate check compares the parameters the *spec* names, not the sensor's.** A
      sensor created by hand carries every default its schema has; requiring those to match too
      would make every re-run create a second copy of everything. Two `http.request` sensors on
      different paths are still two sensors, because the spec's own parameters differ.

      **It goes through `ObjectService`, not the database.** Creating a device or a sensor has to
      get the same validation, audit and version bookkeeping every other creation does — a
      discovery that wrote rows directly would be a second way to make an object, with a second
      set of rules to keep in step.

      **One host at a time rather than one transaction for the lot.** A /24 is two hundred
      devices and a thousand sensors; one transaction holding the tree lock for all of it would
      block every other write in the installation for as long as it took, and a failure
      three-quarters through would roll back work that was perfectly good.

      **Two defects, and the first found the second.** Provisioning failed the moment it first
      ran: `ms.linux` and `ms.nas` named `snmp.diskfree` without the mount point that type
      requires, so `create` threw. `validateTemplate` had only been checking that the sensor
      *type* existed, which is half of it — the create call then fails at provisioning time, once
      per device, long after anybody is looking at the template. It now validates the parameters
      against the type's own schema, and the built-in set has a test asserting the whole shipped
      catalogue passes. And the failure exposed the second: the `try`/`catch` was per *host*, so
      one unmakeable sensor lost every sensor after it on that device — which came out with a
      Ping and nothing else while the report said nothing was wrong. It is per sensor now, and
      the problem names the type.

      Seventeen mutations, all killed. **Three of them found fixtures that could not
      discriminate**: the short-name ordering test had only one candidate device so either order
      found it; the duplicate check's parameter comparison was tested against a hand-made sensor
      with no parameters, where both directions agree; and no test made a sensor creation fail
      once the template bug was fixed. Each is now the case it was meant to be.

      Verified live end to end: a sweep of twelve addresses found eleven hosts and created eleven
      devices with twelve sensors; **the second provision created nothing** — eleven matched,
      twelve skipped, no problems; and adding an SNMP credential to the group and provisioning a
      third time added exactly eight sensors, to exactly the two hosts that had answered SNMP,
      skipping the twelve already there.
- [x] **D-05 — Default master dependency** · S · D-04, M-11 · Each discovered device's Ping
      sensor becomes its master object.

      **D-05 outcome.** `M-11` already had the mechanism — `device` mode writes the setting on
      the *device*, so every sensor under it inherits that one as master and the master is
      excluded from its own dependency — so this is discovery using it, plus the two places it
      deliberately does not.

      **The master is a template property, not a hardcoded `icmp.ping`.** "The reachability
      sensor" is not always a Ping: a switch reached only over SNMP has none, and an appliance
      behind a firewall that drops ICMP is watched by its certificate. A template says which of
      its sensors goes Down when the device is gone, and one that says nothing gets no master —
      which is honest, and better than a rule nobody can see in the file. `validateTemplate`
      refuses two in one template, because which won would depend on the order somebody wrote
      them in, and a dependency that moves when a file is reordered is worse than none. The
      built-in set marks its Ping, and a test asserts every plan produces **exactly one** master
      — `ms.generic` matches everything, so a device nothing recognised still gets one.

      **Only on a device this pass created**, and that is the decision that matters. A device an
      operator already set up has dependency choices of its own — possibly "none", deliberately —
      and a discovery that overwrote them would be editing a decision somebody made on purpose,
      silently, on every re-run. `D-04`'s promise is that a second run changes nothing, and this
      keeps it even in the sharper case: an operator who deleted both the Ping and the dependency
      gets the sensor back on the next run and *not* the dependency.

      **A master that could not be created leaves the device with none.** `applicableSensors`
      filters first, so a master whose port is closed or whose credential is missing is simply
      not there — and a master that cannot scan would pause every sensor on the device for ever.
      Failing to set one is a recorded problem rather than a failed host: a device with its
      sensors and no master is a working device, and failing the host would lose the sensors to
      save the wiring.

      Save-as-template carries it across, because it is one of the decisions the operator already
      made and not having to make them again is the point of saving one.

      Seven mutations, all killed. Two needed sharper fixtures: overwriting a matched device's
      master is invisible unless the re-run actually recreates the master sensor, and "last
      marked wins" is invisible unless two *different* templates each mark one.

      Verified live: three discovered devices, three masters set, `dependency.masterId` on each
      *device* and on none of its sensors, the HTTP sensor inheriting it with `definedOn` naming
      the device — and the Ping sensor itself pointing at itself with `holding: false`, which is
      `M-11`'s `a.master_id <> o.id` keeping the master scanning while its dependents are paused.
      PRTG carried that bug through v19.1.
- [x] **D-06 — Discovery levels** · M · D-04 · Ping-only through detailed, with time estimates
      shown before starting.

      **D-06 outcome.** Three levels, and each is a real trade of time against what it finds
      rather than a slider with names on it. `ping` sweeps and stops. `standard` asks a dozen
      ports, reverse DNS and the SNMP system group. `detailed` asks about thirty-two ports and
      waits twice as long for each, which is worth it where hosts are slow or firewalls drop
      rather than refuse. The extra ports were chosen because each one changes what gets created
      — a port no template mentions and no classifier rule reads costs a connection per host and
      tells nobody anything, which is the difference between a discovery level and a port scan.

      **The level table lives in `@ms/shared` and the job carries its choices**, so the estimate
      an operator was shown is about the run that actually happens. `D-02` had identification
      using the *sweep's* timeout, which made `detailed` no more patient than `standard`; the
      level's own budget is sent now, along with its ports.

      **The estimate is a range, and the arithmetic is the interesting part.** The two halves of
      a run pull in opposite directions: an address that does not answer the sweep costs a full
      timeout, so an *empty* range is the sweep's worst case; one that does answer costs almost
      nothing there and then has to be identified. Written out, the cost is linear in the
      fraction alive, so the two endpoints bracket every possible outcome and no hit rate has to
      be guessed at. **The first version got this wrong** — it added the two halves' worst cases
      together and reported "33 to 33 seconds" for a /24 where the answer for a half-alive
      network is 20, a range that does not contain the truth. There is now a test that walks the
      model across seven hit rates and asserts every one falls inside the bracket.

      A mutation found the estimate's `if (level.identify)` guard was unreachable: a level that
      does not identify has a timeout of zero, so the guard said the same thing twice. Removed,
      with the table's invariant asserted instead — one mechanism and one test, rather than two
      mechanisms that can drift.

      **Templates are a filter rather than a fourth level.** "Detailed, but only these templates"
      is a thing somebody wants and a level could not express it. Empty means all of them, and a
      run filtered to templates that match nothing creates the device and no sensors — honest
      rather than helpful, because quietly falling back to the generic set the operator excluded
      would be worse.

      The migration renames `identify` to `standard` in one place, rather than leaving a reader
      in the service that would live for ever and that nobody could safely delete.

      Twelve mutations, all killed. Verified live: the preview reports 1–8 s, 8–32 s and 8–64 s
      for a /24, and 17, 136 and 273 minutes for a /16 — which is PRTG's "may take days" warning
      with a number on it. And a detailed run against the dev network found ports the standard
      run had not: `8080` on two hosts and `135` on the SQL Server.
- [x] **D-07 — Scheduled rediscovery** · M · D-04, M-09 · Hourly/daily/weekly, **off by default**,
      with optional auto-creation of newly appeared devices.

      **D-07 outcome.** Off by default in the strongest sense the schema allows: there is no
      schedule until somebody creates one, a new one is created *disabled*, and
      `auto_provision` is a **second** flag that is separately off. So the default behaviour of
      a schedule an operator has switched on is to sweep, identify and leave the plan at
      `GET /discovery/:id/plan` for somebody to read — `WORKFLOW.MD §2`'s "surprise objects are
      a support burden" as three independent gates rather than one checkbox. Turning
      auto-provisioning on is safe only because `D-04` is idempotent: it creates what has
      appeared since and nothing else.

      **A schedule is a stencil, not a run.** Each firing creates an ordinary `discovery_run`
      with the schedule's parameters, so `D-01` through `D-06` have no second code path and
      nothing downstream has to know a run was scheduled. The one thing that does know is
      `discovery_run.schedule_id`, which is what lets `runFinished` provision a scheduled run
      and refuse a hand-started one — a run somebody started is theirs to provision, and doing
      it for them would be creating objects nobody asked for.

      **The cadence is an event and `M-09`'s schedule is a window, and conflating them would
      have been the easy mistake.** "Every Sunday at 03:00" is not a weekly calendar of active
      periods, and `isActiveAt` cannot express it — so the cadence is its own small pure module
      and an `M-09` schedule is available *alongside* it as a permission window: "weekly, but
      not during the change freeze" is one expression of two mechanisms rather than a third
      mechanism meaning both. A window that is never open books nothing, which reads as "never"
      rather than as a crash; a window that has been deleted books *without* it and logs a
      warning, because a rediscovery that runs when it should not is visible and one that
      silently never runs again is not.

      **The next firing is searched forward a minute at a time rather than computed**, and that
      is the whole reason the module exists. Adding 24 hours to 02:30 lands on 03:30 the night
      the clocks go forward; the test that asks for the run *after* the first one found a daily
      cadence firing **twice** on the morning they go back, because 01:30 happens twice and both
      instants have the right local time. `alreadyFired` looks back two hours for an earlier
      instant with the same local time and skips the duplicate — and hourly is exempt on
      purpose, since "every hour" on a twenty-five-hour day means twenty-five runs. The scan is
      bounded at a week plus a day and only runs when a schedule fires or is edited.

      **The next run is booked before the discovery is started**, so a start that throws does not
      leave the schedule due for ever — one bad configuration would otherwise become a sweep
      retrying it every minute, which is `D-02`'s stall failure arrived at before it happened
      rather than after.

      Thirteen mutations, all killed. **Live verification found the routes** — every other path
      in `routes/discovery.ts` carries its own `/discovery` prefix and these were written at
      `/rediscovery`, so `GET /discovery/rediscovery` was being answered by `/discovery/:id` with
      "params/id must be integer" and the POST was a 404. They are `/discovery/schedules` now,
      which is safe beside `/discovery/:id` because a static segment beats a parametric one.
      Live verification also found the errors: an invalid cadence threw a bare `AppError`, which
      `toHttpError` maps to a 500 saying nothing — an hourly cadence asked for minute 180 and an
      unknown time zone are the caller's mistake, and both answer 400 with the sentence that
      says which value was wrong. A schedule in `Europe/London` set to 03:00 books
      `2026-08-28T02:00:00Z`, which is the zone being honoured rather than assumed.
- [x] **D-08 — Discovery run summary** · S · D-04 · Scanned, found, created, errors — persisted
      and viewable.

      **D-08 outcome.** `GET /discovery/:id/summary`, and the design decision is that the
      summary is **derived rather than stored**. Every number comes from the run row and the
      host rows, so it cannot drift from what happened and a second provisioning pass updates it
      for free. A stored summary blob would have to be rewritten by the sweep, by identification
      and by every provisioning attempt, and the first writer to forget would leave a page
      confidently reporting numbers nothing else agreed with. `WORKFLOW.MD §2`'s "auditable
      summary" is satisfied by the records being immutable, not by copying them.

      **A headline, because the counts alone do not answer the question that was asked.**
      Somebody runs a discovery to find out whether it worked, and "254 / 18 / 11 / 20 / 2" is a
      table they then have to interpret. One sentence says what happened and the table underneath
      says it precisely — the same division `D-06`'s estimate and `T-21`'s factory report make.
      It is written as a set of cases rather than a template with optional clauses, because the
      sentences worth reading are the unhappy ones: *"Cancelled after 132 of 254 addresses"* and
      *"nothing new — 18 devices already existed"* would each be a missing clause in the middle
      of a success message.

      **Three distinctions the summary refuses to collapse.** `unidentified` is not `unknown` —
      one is a host identification never looked at (a `ping` run), the other is one the
      classifier examined and could not place, and merging them would make the most restrained
      level look like the most broken one. *Not provisioned yet* is not *created nothing* — one
      is a discovery waiting for an operator to review the plan, which is `D-07`'s whole default
      posture. And *created nothing* is not *created nothing new*: a re-run that made nothing
      because everything was already there is idempotency working, which is exactly what
      somebody re-running is checking.

      **Errors are in the summary rather than behind a second request**, because a run that
      created eleven devices and could not create two is the case where somebody stops reading
      at the good number.

      `discovery_run.schedule_id` is now on the row `D-07` wrote it into: the question "where did
      this run I did not start come from" is asked from the run's end, and a schedule holds only
      its most recent one. **Known limitation, found by verifying live**: the column is
      `ON DELETE SET NULL`, so deleting a schedule makes every run it started read as
      operator-started. There is no cheap right answer at this size — `RESTRICT` would make a
      schedule undeletable once it had ever run, and dropping the foreign key leaves an id
      pointing at nothing an operator can look up. Snapshotting the schedule's *name* onto the
      run at firing time is the fix and it is a migration; it is written down in the code rather
      than left to be rediscovered.

      The breakdown counts are `count(*)::int` rather than the default bigint, which
      node-postgres hands over as a *string* to keep 64-bit values exact — `"3" > "12"` would
      have sorted the breakdown wrong in a way that only appears past ten of something.
- [x] **D-09 — Bulk operations** · M · S-03 · Multi-select edit, clone, move, delete across the
      tree.
      **Added by S-03:** `ObjectService.batch(mode, fn)` composes any number of repository
      operations into one transaction under one advisory lock — D-09 is a loop, not an API
      redesign. Bulk selection **must** page with `sort=id`: under `sort=name` a keyset scan can
      return a renamed object twice or miss it, so a bulk delete could skip objects the operator
      selected.

      **D-09 outcome.** `POST /objects/bulk` with an `operation` discriminator over six verbs —
      pause, resume, move, clone, delete and set-a-setting, the last being what "multi-select
      edit" actually is. One route rather than six, because a UI's bulk bar is one control with
      a menu on it.

      **It is a loop over the single-object methods, and `batch` is deliberately not used —
      which contradicts the note above, so it is said out loud rather than quietly diverged
      from.** Two reasons. `batch` hands out `(q, repo)`, the *repository*, and every rule this
      system has about changing an object — hierarchy validation, write-only redaction, audit,
      version bookkeeping, dependency and inheritance recomputation — lives in the service method
      above it; composing repository calls would be a second way to update an object, which is
      exactly what `CLAUDE.md` forbids and the kind of thing that is correct the day it is
      written and diverges quietly after. And one transaction over a selection holds the
      **exclusive tree lock** for the whole batch: `ObjectService.delete` already worries about
      that for a single subtree, and five hundred of them would block every write in the
      installation — a self-inflicted outage in the thing that is meant to notice outages.
      `batch` remains right for repository operations that genuinely must be atomic; a selection
      of independent objects is not that.

      **So each object is atomic and the batch is best-effort, with a per-object outcome.** An
      operator who selects forty sensors and pauses them, one of which a colleague deleted a
      moment ago, wants thirty-nine paused and a line naming the fortieth; all-or-nothing gives
      them neither, plus an error they cannot map back to a row. `D-04` made the same call per
      host for the same reason.

      **The judgement worth the most in the report is the smallest.** Selecting a device *and*
      its sensor and deleting both: the device goes, and the sensor is then genuinely absent.
      Reporting "object 812 does not exist" is true and useless — it reads as somebody else
      changing the tree underneath them and sends an operator looking for a problem that is not
      there, when their own selection did exactly what they asked. The batch remembers what it
      destroyed and says *"it was removed with an object deleted earlier in this batch"*, while
      an id it never touched still reports a plain absence.

      **Cascade goes through the delete guard rather than around it.** `delete` refuses a
      non-empty subtree unless told exactly how many descendants to expect, which is what stops a
      client that thought it was deleting one object from deleting five thousand. A bulk cascade
      cannot know that number in advance, so it asks for the safe delete first and reads the
      count out of the refusal — and the retry's `exact` check then catches a subtree that
      changed between the two attempts, which is the race the guard exists for. Counting
      separately and passing the answer straight to `exact` would have the same shape and none
      of the protection.

      Repeated ids are collapsed and counted rather than silently dropped — a tree UI hands the
      same id over twice when a row and its ancestor's "select all" are both ticked, and applying
      an operation twice is at best wasted work and at worst a second audit entry for one change.
      The cap of 500 is checked *after* deduplication, so a client sending one id six hundred
      times is a selection of one rather than a refusal.

      Twelve mutations, all killed. **Live verification found the revert.** The first version
      read `value: null` as "go back to what you inherit", and it failed on every object,
      because the null went straight to the setting's own schema, which wants an integer. It is
      its own `revertSetting` operation now — the split the single-object routes already make
      between `PUT` and `DELETE`, so there is one grammar rather than two. Null as an
      instruction would have been a trap besides: it is a legitimate stored value for a setting
      whose schema allows one, and a route that read it as a command could never store it. A
      *missing* `value` is now a malformed request rather than being folded into the same case.
- [x] **D-10 — Discovery UI** · M · U-03, D-06 · Range entry, level and template selection, live
      progress, cancel.

      **D-10 outcome.** A `/discovery` page: probe and group, a range box, the three levels with
      `D-06`'s estimate beside each, templates, an SNMP community, then a progress bar with a
      cancel button and `D-08`'s headline when it stops.

      **The estimate is shown before the choice, not after it.** That is the whole reason `D-06`
      exists: an operator picks `detailed` on a /24 knowing it is a minute, and declines it on a
      /16 knowing it is hours. A level picker without the numbers beside it is the picker PRTG
      has, and its warning — "may take days" — is true and helps nobody decide anything. Levels
      are offered cheapest first so the list reads as a ramp and the expensive one is never where
      a thumb lands first, and anything over ten minutes is flagged, because that is roughly
      where somebody walks away — and a discovery they walked away from is one whose plan they
      never read.

      **One progress bar over two phases, and the split is not even.** A run sweeps every address
      and then identifies only the ones that answered: a /24 with three live hosts is 254 sweeps
      and 3 identifications. Weighting by count would make the bar leap from 5% to 100% the
      instant the sweep ended. So the sweep owns a fixed 70% and identification the rest — a bar
      that moves at a believable rate, which is the only thing a progress bar is for. `ping`
      never identifies, so its sweep owns the whole bar rather than stopping at 70%.

      **Progress is polled, and that is a decision rather than an omission.** `U-02`'s WebSocket
      carries sensor state; a discovery run is not a sensor. It lives for minutes, one operator
      is watching it, and pushing its progress would mean a new message kind, a subscription for
      it, and a fan-out to every connected client for something one of them cares about. One
      request every two seconds against an indexed primary key is cheaper, and it stops the
      moment the run does. The timer is chained from each answer rather than an interval, so a
      slow reply cannot stack requests behind it.

      **The browser forms no opinion about a range.** An empty box is a local answer; everything
      else waits for `POST /discovery/preview`, because the core's parser is the only thing that
      knows what a range means and a second one here would eventually disagree with the one that
      actually runs. The parser's own sentence is what gets shown — "that is 16,777,214 addresses
      and one run may sweep 65,536; the usual cause is a /8 where a /24 was meant" is worth far
      more than "invalid range".

      **Nothing on this page creates anything.** A finished run shows what it found and offers
      its group; turning that into devices stays behind `POST /discovery/:id/provision`, because
      `WORKFLOW.MD §2` is explicit about surprise objects and this is the screen where that
      promise is kept or broken.

      Choosing a probe clears the group, since a group under the previous probe is a selection
      that still looks valid and that the core would refuse. The Start button says which box is
      empty rather than being mysteriously grey.

      Twenty mutations, all killed. **Four defects found by driving the page rather than by any
      test**, and each of a kind a unit test could not reach:

      - Every earlier run wore a "scheduled" badge. `ms:discoveryRun` has
        `additionalProperties: false`, so `scheduleId` — added to the row in `D-08` but never to
        the response schema — was *stripped* rather than merely undocumented, and `!== null` was
        true for all of them. A field missing from that list is a field the API does not return.
      - The hint under each field was folded into the control's accessible *name*, so a screen
        reader announced "Range 10.0.0.0/24, 10.0.0.1-10.0.0.50, or a single address, IPv4 only"
        on every focus. The name is "Range"; the rest is `aria-describedby`. Found by reading
        the page's accessibility tree, which is the only way this kind of defect is ever found.
      - "1 seconds" on a /29, and "1 sensors" against a one-sensor template.

      The estimate's unit is chosen from the *low* end of the bracket, not the high one: picking
      by the high end reported a /16 standard sweep as "0.3–2.3 hours" where `D-06` measured it
      as 17–136 minutes — the same number, said worse.

## Phase 8 — Remote probes

- [x] **R-01 — Probe identity and approval** · L · F-09 · GID generation, access keys,
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

      **R-01 outcome.** Reaching the port is no longer the same as being trusted, and until this
      it was: a probe that presented the shared access key was handed configuration immediately
      — it became part of the installation because it connected. `probe_registration` is the gap
      between the two.

      **A pending probe is welcomed, not rejected, and that is the central decision.** It gets
      its identity, it heartbeats, and it appears in the queue with the name, version and address
      it reported — and it gets **no configuration at all**, so it scans nothing. Rejecting it
      would leave an administrator approving something they cannot see, and would make the probe
      re-enrol under a fresh identity on every retry, filling the queue with a row per reconnect.
      The check lives in `#queueConfig` rather than at its four call sites, so an unapproved
      probe scans nothing because there is only one door.

      **The session exists before the decision does, and it has to.** Asking the registry is a
      database round trip and messages keep arriving during it — a probe that says hello and then
      heartbeats would otherwise be torn down for "a message before the handshake". So the
      session opens unapproved, every later message chains behind the admission through
      `pending`, and nothing reaches the probe until the answer is in. A registry that cannot
      answer is not permission to come in: the probe is rejected and retries.

      **The per-probe key is what makes revocation mean anything.** Revoking one probe otherwise
      means rotating the enrolment key every probe shares, which nobody does, which means in
      practice nothing is ever revoked. A key is generated at approval, sent in that one welcome,
      and stored only as a **SHA-256** — not argon2, deliberately: argon2 exists to make guessing
      a human-chosen password expensive, this is 32 bytes from `randomBytes` so there is nothing
      to guess, and a deliberately slow hash on the handshake path would only make a reconnecting
      probe wait. `A-01`'s account passwords are the opposite case for the opposite reason.

      **The probe now persists what it is.** The assigned GID lived only in memory, so every
      restart enrolled again under a fresh identity — a queue that grew a row per restart and a
      probe that could never stay approved. It is stored beside the spool, `0o600`, written to a
      temporary name and renamed. Keeping it out of the config file also means copying
      `probe.json` to a second machine does **not** clone an identity: the second machine enrols
      as itself, where a GID in the config would have had two probes claiming one branch and
      scanning the same sensors twice.

      **An address filter is a permission, not a sweep.** It shares `D-01`'s spellings, so an
      operator who has written a discovery range already knows how to write one — but with no
      size cap, because stating that your probes live in `10.0.0.0/8` is a fact about a network
      rather than a request to enumerate sixteen million addresses, and refusing it would push
      somebody to write no filter at all. A CIDR keeps its network and broadcast addresses here,
      because excluding them is a statement about which addresses answer a ping.

      **Revoked rather than deleted**, so the same GID cannot come back by reconnecting and the
      record of what was refused survives. Two places had to learn that a revoked identity does
      not hold a branch — the conflict check and the unique index — or replacing a probe would
      mean deleting its record first, and deleting the record is exactly how a revoked GID gets
      back in. **Found by the test that replaces the machine beside the core.**

      **The local probe cannot be deleted**, matching PRTG, and the flag is set explicitly rather
      than guessed: an address proves nothing on a host with several interfaces, and "the first
      one approved" is wrong for anybody who stood up a remote probe first. It is only ever
      raised, never cleared by a later approval, so replacing that machine does not quietly make
      the branch deletable. The installers (`H-05`, `H-06`) are what will set it automatically.

      Protocol 6: `welcome` carries `approved` and, once, the issued `accessKey`. Both optional,
      so a version-5 core — which had no notion of approval and trusted whatever presented the
      key — still reads as approved rather than leaving every probe idle after an upgrade.

      Twenty mutations, seventeen killed on the first pass. **All three survivors were real test
      gaps, and each was a case I had reasoned about and then not written down:**

      - Nothing tested the *returning* pending probe — which is the only thing a probe waiting
        for approval actually does, every few seconds, for as long as it takes somebody to look.
        Reading the second hello as approval would have been approval by persistence.
      - Nothing tested an address the filter cannot express: an IPv6 peer against a list of IPv4
        ranges. Refusing is the only answer that keeps the filter meaning what it says, and it
        was one flipped return from allowing everything.
      - Nothing tested that a filter CIDR keeps its network and broadcast addresses, which is
        the whole documented difference from `parseIpRange` — a probe really can sit on
        `10.0.0.0/31`.

      **Live verification then corrected the design.** Revoking the running probe and approving
      it again locked it out: the key was minted at *approval* and delivered in the `welcome`,
      and a probe that is offline at that moment never receives that welcome — it comes back on
      the enrolment key and is refused by a key it was never told about. Approving a machine that
      is switched off is an ordinary thing to do, so it cannot be the thing that locks it out.

      **The key is now issued at the next handshake instead**, by `admit`, exactly once. That is
      better in a second way: nobody ever sees it. It goes straight to the probe over the
      authenticated link rather than through an operator's clipboard, a browser, or a support
      ticket — so `POST /probes/:gid/approve` returns the registration and no secret at all.
      Re-approving clears the stored hash, which makes re-approval the recovery path for a probe
      whose key has got out of step, and means a key that leaked before a revocation does not
      survive the decision to let the machine back in.

      Verified live end to end: the upgrade approved the existing probe rather than suspending it
      into a queue nobody knew to look at; revoking it refused the reconnect with the operator's
      own sentence and released its branch; re-approving issued a fresh key on the next
      handshake, after which it claimed its branch and took its 47 sensors; and the local probe
      refuses deletion through both the object route and a bulk cascade.
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
      **Corrected by `T-08`:** the delta compared each sensor without `A-05`'s credential
      stamps, so a credential rotation produced a *changed version* and an *empty delta* — the
      probe recorded the new version and kept the old secret for ever. The stamps now travel on
      `ProbeAssignments` and go into both the whole-config fingerprint and the per-sensor diff.

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
- [x] **R-05 — Probe offline handling** · M · R-01, M-02 · One alarm for the probe; its sensors go
      Unknown, not Down. **`M-02` left the layer:** `StateFacts.probeReachable`, evaluated third
      and deliberately **not persisted** — restoring it from a table would record a transition
      for every sensor on every core restart, an alarm storm generated by the restart itself.

      **R-05 outcome.** The state machine has always known the right answer; nothing ever told it
      the probe was gone. `ProbeReachability` is that wiring: the endpoint says when a link goes
      and comes, and the sensors under that branch become **Unknown, cause `probe`** rather than
      Down. Down would be a claim the system cannot support — nobody asked those sensors
      anything — and it would page whoever is on call once per sensor for a single cable.

      **The set is of sensor ids, not probe ids.** The question asked of it is "is *this* sensor's
      probe up", once per sensor per decision; answering that from probe ids would mean walking
      the tree on every decision, where a set of at most the installation's sensor count answers
      in constant time and costs a few hundred kilobytes at the v1 target.

      **The overlay lives in one place, and that is the whole of why it is correct.** A sensor
      whose probe is gone has to read Unknown however its state comes to be re-decided — a pause
      clearing, a dependency releasing, a schedule window opening. `loadRuntimes` restores
      `probeReachable: true` because there is no column for it, so a re-evaluation for an
      unrelated reason would quietly flip the sensor back to Up while its probe was still
      missing. `SensorStateService` overlays the live set onto everything it loads, so no path
      can forget. There is a test for exactly that flip.

      **A probe that returns gives its sensors back their last reading**, rather than holding them
      Unknown until a fresh result. That reading is the most recent thing the system actually
      measured and the next scan corrects it within one interval; holding them would add a second
      transition per sensor for no information, and turn one outage into two.

      `operatorDecided` gained the `probe` cause, so the sensor carries *"the probe carrying this
      sensor stopped answering"* rather than an unexplained Unknown — the same rule a pause and a
      simulated error already followed, for the same reason.

      Still in memory and never persisted, as `M-02` intended: a core that has just started has
      not learned that a probe is missing, and a pessimistic restore would write a transition per
      sensor on every restart.
- [x] **R-06 — Version skew detection** · M · F-09 · Core and probe negotiate a protocol version;
      incompatibility is reported clearly, never silently mishandled.

      **R-06 outcome.** The negotiation already worked; what it did not do was *say* anything.
      Incompatible was handled — the link closes and both ends log why — and that was never the
      dangerous case, because a closed link is loud. The dangerous case is the one in between:
      a probe on protocol 2 connects, heartbeats, passes every health signal this system has,
      and is refused configuration, so nothing under it is ever scanned. That was an
      `info`-level log line and nothing else.

      **The version numbers were scattered, and that is the defect underneath.** `probe-endpoint`
      compared against a bare `3` for configuration and a bare `4` or `5` for the two discovery
      stages, each with its meaning in a comment beside it. `capabilitiesFor` in `@ms/shared` is
      now the one map from version to capability, `versionFor` gives the number back for a
      message, and every gate reads them — so adding a version is one table entry rather than a
      search for comparisons, and the cost of missing one was never a crash but a probe that
      quietly does nothing.

      **`describeSkew` separates compatible from current**, which the old boolean could not.
      `isProtocolCompatible` answers whether two ends can hold a conversation; the skew verdict
      answers what that conversation may contain — `current`, `outdated` with what it cannot do,
      or `incompatible` with why. `explainSkew` names *both* versions every time: "probe is
      outdated" is not something anybody can act on and "speaks protocol 2, this build speaks 6,
      so it cannot be sent sensors to scan" is.

      **A discovery run assigned to a probe that is too old used to wait forever.** `sendSweep`
      answered `false` both for a probe that is offline and for one that will never understand
      the message, and the caller — having no way to tell them apart — waited, which is right
      for the first and wrong for the second. It is now a three-way `SweepDelivery`, and a
      `too-old` answer fails the run naming the probe's version, the version the stage needs and
      what to do about it, instead of reporting "waiting for a probe" indefinitely.

      **The refusal is recorded where refusals are recorded.** The version check ran in the
      endpoint, before the registry had seen the probe, so the one refusal an operator is most
      likely to meet — they upgraded one end and not the other — was the only refusal that left
      no row behind. It moved into `ProbeRegistry.admit`, *after* the sighting is written, so the
      queue shows the version the probe is actually running rather than the one it spoke the last
      time it managed to get in. A probe this core has never seen and cannot speak to is still
      refused without a row: enrolling it would put something in the approval queue that
      approving cannot help.

      **The skew is derived at read time, never stored**, because it is a statement about this
      build as much as about the probe — the same protocol-4 probe is current against a
      protocol-4 core and outdated against this one, and a stored verdict would go stale at
      exactly the moment it matters. A recorded `0` reads as `unknown` rather than as protocol
      zero, so the probes `R-01`'s migration carried over are not condemned before any of them
      has reconnected.

      Not done here: there is no probes page yet — `R-01` shipped the API without one — so the
      skew is answerable over HTTP and from the log, and a UI for it belongs with whatever ticket
      builds that page.
- [x] **R-07 — Probe installers** · L · F-07 · Linux and Windows probe-only packages with a
      guided enrolment flow.

      **R-07 outcome.** `install.sh --probe-only` already existed, so this looked like packaging
      work. It was not: underneath it was a security defect. `install.sh` issues exactly one
      `probe.crt`/`probe.key`, on the core host, and a remote probe could only be brought up by
      copying that pair — so **every probe in an installation presented the same TLS identity**.
      `R-01` made the *access key* per-probe and revocable; the certificate beneath it was
      shared, and revoking one probe at the transport layer was not possible at all.

      **`ms-enrol` issues a certificate per probe**, from the CA on the core host, and packs it
      with `ca.crt`, the enrolment key and the core's address into one file an operator carries
      to the probe host. A random serial rather than `-CAcreateserial`: the `.srl` file sits
      beside the CA key and two operators enrolling at once would race for it, which is the one
      thing a serial exists to prevent. It refuses to guess the core's address when the core
      binds a wildcard — `0.0.0.0` is what a service binds and never what a probe can dial, and
      a bundle that cannot connect is worse than a question.

      **The bundle carries a private key, and the flow is built around that being true.** It is
      written `0600`, it is meant to be carried once and deleted, and the probe it enrols still
      waits for a person to approve it — so a leaked bundle is an identity that can knock, not
      an identity that monitors. The key is generated on the core rather than by the probe
      because submitting a CSR would need a trusted channel to the core, which is the very
      channel being established; `R-01`'s approval queue is what makes carrying it acceptable.

      **A probe host now receives a probe.** `package.sh --probe-only` builds `shared`,
      `sensors` and `probe` and nothing else. Measured on linux/aarch64 at 0.1.0 it is 12M
      against 16M — most of the weight is the sensor catalogue's dependencies and the probe is
      exactly what needs those, so `pg` ships either way because the probe runs the PostgreSQL
      *sensor*. The win is not megabytes: the probe host has no core it could be pointed at, no
      `core.json` to misconfigure, no web root, and no Fastify.

      **`install-probe.sh` and `install-probe.ps1` validate the bundle before writing anything.**
      A bundle that turns out to be unreadable halfway through leaves a service pointing at a CA
      that is not there, which starts, fails, and reports a TLS error rather than the truth. An
      upgrade keeps the operator's `probe.json` but does update the endpoint and key when a new
      bundle is given — that is usually why a second bundle was issued.

      **`scripts/smoke-enrol.sh` is two boxes, because one would prove nothing.** A bundle that
      depended on a path only the core host has, a certificate whose SAN only matches localhost,
      or a `probe.json` still pointing at `127.0.0.1` all pass on a single host and fail on the
      day it matters. It asserts the probe crossed the network, arrived *pending* under the name
      it was enrolled with, was sent no configuration before approval, that two enrolments
      produce different certificates, and that no core was installed on the probe host.

      Found on the way and fixed here because nothing could be verified without it: **the full
      release tarball had been unbuildable since `T-18`** (`f5f245b`). `@ms/sensors` declares
      `pg ^8.23.0` while `@ms/core` still said `^8.13.0`, and `package.sh` refuses conflicting
      ranges across the merged production manifest. Nothing caught it because the packaging
      smoke test builds its own tarball and failed identically. Aligned to `^8.23.0`, which is
      what the lockfile already resolved.
- [x] **R-08 — Disconnect/reconnect soak test** · M · R-03 · A one-hour disconnect replays with
      zero data loss and no ingestion stall.

      **R-08 outcome.** The criterion has two clauses that fail in different places, so it is
      measured in two: **zero data loss** is the probe's spool, and **no ingestion stall** is the
      core's pacer. One test spanning both would have needed `@ms/core` and `@ms/probe` to import
      each other, which `ADR-001` deliberately does not allow — they are separate services and
      share only `@ms/shared`.

      **An hour is a quantity, not a duration.** Sleeping for an hour would measure a clock. At
      `PLAN.md`'s v1 target — 5,000 sensors on a 60-second interval — an hour of disconnection is
      300,000 readings, and producing them and replaying them is what measures the thing that
      breaks. Both tests run a small fraction in the ordinary suite and take the full criterion
      under an environment variable, the convention `P-15`'s scheduler benchmark already set.

      Measured, the probe side (`MS_SOAK_MINUTES=60`):

      ```
      spooled       300,000 readings, 61.7 MB in 8 segments, 935 ms to write
      an hour     62 MB projected at 216 bytes a reading, against a 2 GiB default (3.0% of it)
      replayed    1773 ms in 150 batches, 169,233 readings/s
      lost 0, duplicated 0, corrupt 0; caught up 2031x faster than the outage
      ```

      Measured, the core side (`MS_SOAK_FRACTION=1`), two probes each replaying an hour while a
      third reports live:

      ```
      live, quiet     p50  263.7 ms   p99  274.6 ms    40 batches
      live, replaying p50  263.6 ms   p99  279.2 ms   300 batches   -> 1.02x, budget 3x
      replay          p50   24.5 ms   p99   48.5 ms   600 batches, cleared in 96.1 s
      pacing          the replaying probes waited up to 50 ms; the live one 0 ms
      ```

      **The capacity number is the one worth reading.** An hour at the v1 target is 3% of the
      shipped spool, so the default is not sized for an hour — it is sized for about a day and a
      half. That is the right shape: the outage that loses an operator data is the one over a
      weekend, not the one over lunch.

      **The pacer does not slow a lone catch-up, and writing the test taught me that.** The first
      version used one replaying probe, asserted it was paced, and failed — correctly. One probe
      emptying its spool is not a fairness problem, it is just work; the delay begins when more
      probes are catching up than the core will run at full speed. The test now runs two against
      a limit of one, which measures the mechanism rather than its absence.

      Live p99 moved 2% while 600,000 spooled readings went past it. The ~263 ms floor on every
      live figure is the ingestion flush timer rather than the database — one probe offering one
      batch at a time never fills a write — and it is identical in both arms, which is what makes
      the ratio the measurement rather than the machine.

      Also covered: a link that keeps dropping mid-replay. Nothing leaves the spool until the core
      acknowledges it (`R-02`), so a batch in flight when the link drops is re-offered rather than
      skipped — the failure this guards against loses exactly one batch per flap, silently.

## Phase 9 — Users, RBAC and security

- [x] **A-01 — Accounts and authentication** · L · S-01 · Read/write and read-only accounts,
      argon2 hashing, secure-cookie sessions, login throttling.

      **A-01 outcome.** Everything before this ran as `anonymous`. The `Actor` union has carried a
      `user` variant since the audit log was written and nothing ever produced one — four route
      files each had their own `actorFor` returning the request's IP address. The audit log was
      recording *that* a thing happened without being able to record *who* did it, which is half
      of what an audit log is for. Those four are now one, in `api/authentication.ts`, the same
      rule this codebase already applies to inheritance and to credential redaction.

      **argon2id for passwords, SHA-256 for session tokens** — they look like the same problem and
      are opposites. A password is drawn from a space small enough to search offline, so the cost
      of a guess is the whole defence; a session token is 32 bytes from the CSPRNG with nothing to
      guess, and a slow hash there would only make every request slower. The stored session id is
      a hash of the cookie, never the cookie, so a database dump is not a login (`R-01`'s rule).

      **Server-side sessions rather than a signed token** (`ADR-001`). A JWT would save the table
      and cost the ability to *end* a session: revoking a stateless token means a deny-list — a
      table, so nothing was saved — or waiting for expiry, which is not revocation. Expiry is
      rolling with an absolute ceiling, so a long incident does not log an operator out and a
      session that is used constantly still ends.

      **Login throttling counts on two axes, and it has to be both.** Locking an account after N
      failures is a denial of service: anybody who knows an operator's login can lock them out of
      their own monitoring system by failing to log in as them, during the outage they are
      investigating. Counting only per address stops nothing distributed. So an address that keeps
      failing is refused outright — including for logins that do not exist, which is exactly the
      enumerator traffic worth stopping — while an account that keeps failing is *delayed*, never
      locked. Counted in the database, so a restart does not hand back an allowance.

      **Every login failure is one code and one sentence.** "No such account" and "wrong password"
      as distinguishable answers is a login enumerator, and a login is half a credential — so the
      reason goes to the log and never to the caller, a login naming no account still spends a
      real argon2 verification against a decoy so the absence cannot be timed, and the `disabled`
      check runs *after* the password because answering earlier would say the login exists.

      **`Secure` on the cookie is decided per request rather than configured**, because guessing
      wrong is bad in both directions: always, and login over plain HTTP silently fails because
      the browser never returns the cookie; never, and a session issued over TLS travels in clear
      on the next plain-HTTP request.

      **The guard is off by default, and that is deliberate.** Turning it on before `A-03` gives
      per-object rights would mean an installation where every account sees everything — a worse
      answer than the honest one, that authentication exists and is not yet load-bearing. An
      upgrade must also not find its API shut off before anybody has an account.

      Live verification earned its keep: the bootstrap logged its generated password as a
      `password` field, and **every logger in this system redacts that** — correctly, since a
      credential in a log is a credential in a log shipper, a search index and a backup. Renaming
      the field to slip past it would be defeating a control that was doing its job, so the
      secret is written where the installer already writes secrets: one file, mode 0600, and the
      log carries the path. Confirmed live: `-rw-------`, nothing in the log, and the first
      authenticated create wrote `user | 2 | admin` into an audit table whose every previous row
      said `anonymous | 172.19.0.1`.

      Tests: 34 against the services, 19 over HTTP.
- [x] **A-02 — User groups and primary group** · M · A-01 · Group membership, one primary group
      per user.

      **A-02 outcome.** Groups exist so that rights are not granted per person. `A-03` hangs
      per-object access off a group rather than an account, because an installation with forty
      operators and six hundred devices cannot be administered one grant at a time — and because
      a right attached to a person has to be reissued when somebody else joins the rota, while a
      right attached to a group is one somebody is added to.

      **The primary group is the *default* one, not the strongest one.** It answers exactly one
      question — which group owns an object this user creates — and nothing else. What a user may
      see and change is the union of all their groups, because any other rule would make *adding*
      somebody to a group able to take access away, which is the opposite of what an
      administrator expects when they do it.

      **The invariant is "at most one primary, and never zero while they have any", and only half
      of it is a database rule.** A partial unique index gives the first half. The second cannot
      be a constraint, because a membership row exists before anything decides which is primary —
      so the service holds it, and the cases that could break it sideways all have tests: leaving
      the primary group, having it deleted out from under you, and being re-added to a group you
      are already in. A user with groups and no primary among them is a state object ownership
      would have no answer for.

      **Built-in groups can be described and nothing else.** Renaming Administrators or clearing
      its admin flag is a one-way door out of your own installation. Deleting a group does not
      delete its members — an account belonging to no group is a real state, and it is what a
      suspended operator looks like.

      **`administers()` asks the groups, not the account's role.** `A-01`'s role says what an
      account is allowed to be; membership says what it currently grants, and removing somebody
      from the administrators group has to take effect without anybody remembering to change
      their role as well.

      Every route needs an administrator, because group membership *is* the access-control
      mechanism — an account that can add itself to a group can grant itself whatever that group
      holds. Verified live: **401 `AUTH_REQUIRED`** with no session, **403 `AUTH_FORBIDDEN`** with
      a valid read-only one, which is the distinction those two codes exist to make.

      Tests: 22.
- [x] **A-03 — Per-object access rights** · L · A-02, S-04 · none/read/write/full; inherited up
      the tree; explicit beats inherited; highest across groups wins.

      **A-03 outcome.** A grant is `(object, group, right)` — never `(object, user, right)`.
      Rights on a person have to be reissued when somebody else joins the rota and revoked when
      they leave, and both are jobs somebody forgets. `A-02` exists so this table can point at a
      group.

      **The three rules are applied per group, then combined, and that order is the whole
      design.** For each of the account's groups, the nearest ancestor defining a right *for that
      group* wins; only then is the maximum taken across groups. The other reading of "resolve at
      the nearest ancestor that defines the right" sounds equivalent and is not: granting one
      group `read` on a deep device would silently strip another group's inherited `full`. Adding
      a grant must never take one away — the same principle `A-02` applies to the primary group.
      The matrix row *highest wins even when the lower right is nearer* is that case, and it was
      **verified live**: an account whose Beta group holds `full` on a probe and whose Alpha group
      holds an explicit `read` on a sensor beneath it resolves `full`, sourced from the probe.

      **`none` is a storable right, and revoking is a different operation.** Revoking restores
      inheritance; granting `none` overrides it. An administrator needs both — one undoes a
      mistake, the other carves a hole in a branch somebody else has access to.

      **Administrators short-circuit the walk entirely.** "May do anything, including to objects
      that do not exist yet" is not a statement about a position in the tree, so it is not
      expressible as a grant — and making it depend on a row is how an installation locks itself
      out by deleting one.

      **The ordering is a number in two places, and they are checked against each other.**
      `max()` over the text form would order the rights alphabetically — `full` < `none` < `read`
      < `write`, wrong in every position — so SQL gets an `access_rank` function and TypeScript a
      table, with a test asserting they agree.

      **Resolved in one SQL query, and this is the only place that walks the tree for rights**,
      which is `CLAUDE.md`'s rule about inheritance living in one place. `resolveMany` exists
      because a list view would otherwise be one walk per row, and a test asserts it agrees with
      resolving one at a time — a second implementation that disagreed would be an access-control
      bug visible only in a list.

      **A forbidden object answers 403, not 404.** Hiding existence is the stronger posture and it
      makes every "why can I not see this?" unanswerable for the operator *and* the administrator.
      Revisit under `A-04` if the read-only case needs it.

      Mutation-tested at 11/11. The one that survived the first sweep was the important one:
      dropping `AND g.is_admin` from `administers()` made *any* group membership confer full
      administration, and every existing test still passed — because they only ever put the
      account in the administrators group. There is now a test for somebody in three ordinary
      groups and no admin one.

      Tests: 31, including a 13-row table-driven matrix over a real probe → group → device →
      sensor tree — `PLAN.md` Phase 9's first exit criterion.
- [x] **A-04 — Read-only account restrictions** · M · A-03 · Enforced at account level: no admin
      groups, no credential visibility, optional acknowledge permission.

      **A-04 outcome. A role is a ceiling, not a starting point** — that is the whole ticket.
      `A-03` answers what an account's *groups* grant on an object; this caps that by what the
      account is allowed to be. A read-only account holding `full` through some group still may
      not write, because somebody made it read-only on purpose and a group membership is not a
      way to undo that. Applied in `resolveFor`, where the right is resolved, rather than at each
      route — the same reason redaction lives at one boundary. The cap is *reported* rather than
      silent: "you have full on this device and may not edit it" is incomprehensible without it.

      **There are three ways into a read-only administrator, and writing the tests found the
      third.** Adding a read-only account to an admin group; making an existing administrator's
      account read-only; and leaving both alone while making the *group* administrative
      underneath them. All three are refused by a trigger, and all three were verified live
      against the running installation. The service turns the first two into sentences a client
      can act on. Two enforcement points for one rule is usually a smell — worth it here, because
      the failure is silent and total: an account somebody believes is read-only that administers
      everything.

      **The refusal is a refusal, not a repair.** Dropping a role change and removing the account
      from the admin group mean completely different things, and picking one for the
      administrator would be guessing at intent in the one place guessing is worst.

      **Acknowledging is opt-in per account.** An operator who may look but not change is exactly
      the person on the end of a phone at 3am, and "silence this, I am dealing with it" is a note
      on an alarm rather than a change to the monitored estate. Off by default: a permission that
      grants itself is not a permission.

      **Credential invisibility was already stronger than this ticket asks.** `PLAN.md` Phase 9's
      second exit criterion — a read-only user cannot retrieve any credential by any route — is
      not met by a role check but by there being no route that returns one *to anyone*: redacted
      at `ObjectService.#redact`, with a `credentialView` schema that has no field a secret could
      occupy. A test now pins that shape, so adding one has to be a deliberate act.

      One defect found on the way, by the tests: a single trigger function branching on
      `TG_TABLE_NAME` fails at runtime, because PL/pgSQL resolves every field reference in a
      statement it runs — so naming both `NEW.id` and `NEW.user_id` breaks on whichever table
      lacks the other, whatever condition guards it. One function per table.

      Tests: 17.
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
- [x] **A-06 — API tokens** · M · A-01 · Per-user tokens, scoped, revocable, with last-used
      tracking.

      **A-06 outcome. A token acts as its owner and never as more than its owner.** Its scope only
      ever *narrows*: the effective right is the lesser of the scope, the account's role (`A-04`)
      and what its groups grant on the object (`A-03`). The alternative — a token with rights of
      its own — is a second access-control system to keep in step with the first, and the two
      would disagree the first time somebody changed a group.

      **The scope is capped at creation *and* at every use, and both are needed.** Capping only at
      use would let an account mint a `full` token, be demoted to read-only, and leave a token in
      somebody's script that the list calls `full` and the system treats as `read`. Capping only
      at creation would let that later demotion be escaped entirely.

      **A token cannot mint a token.** Otherwise a leaked read-scoped token is one request away
      from a full-scoped one and the scope stops being a limit at all — verified live as a 403.
      There is likewise no route to issue or list a token for somebody else: an administrator who
      could would be one who could act as any account without leaving a trace saying so. Stopping
      somebody else's tokens is done by disabling their account, which stops all of them at once.

      **Stored as a hash, shown once, identified by a prefix.** The same rule `R-01`'s probe keys
      and `A-01`'s sessions follow — a value a database dump can yield is a value that works.
      SHA-256 rather than argon2, because there is nothing to guess in 32 random bytes and a token
      is presented on *every* request, where a slow hash would tax all of them. The prefix is
      stored in clear on purpose: somebody with six tokens needs to tell them apart, and it is
      short enough to be useless to anybody who learns it.

      **`Authorization: Bearer` only.** A token in a query string is a token in every access log,
      proxy log and browser history between here and the caller, so one offered that way is not
      read at all rather than read with a warning. A request presenting both a cookie and a bearer
      token resolves as the token: that combination is almost always a client bug, and picking
      whichever happens to work would make it an intermittent one.

      **`last_used_at` is written at most once a minute.** A polling script would otherwise turn
      every read into a write — a lot of WAL for a column nobody reads at that resolution.

      Tests: 24.
- [x] **A-07 — TOTP MFA** · M · A-01 · `otpauth` enrolment with QR, recovery codes, enforcement
      per group.

      **A-07 outcome. Enrolment is two steps, and the second is what makes it safe.** A secret is
      generated and stored *unconfirmed*, doing nothing at all, until the person proves they can
      read a code from it. Confirming immediately is how somebody locks themselves out of their
      own monitoring system with a mistyped setup — their authenticator never received the
      secret, and the account now demands codes from it.

      **A used code cannot be used again inside its own window**, enforced by recording the step.
      Without it an observed code works for the whole thirty seconds it is displayed, which is
      the entire attack against a code read over a shoulder or pasted into the wrong window.
      **Verified live**: the same code replayed immediately is refused.

      **A window of ±1 step, not 0 and not 3.** Zero refuses anybody whose phone clock is a
      second out, which is most phones; three accepts a code for ninety seconds either way, which
      gives away most of the point of rotating it.

      **Recovery codes exist because a dropped phone should not take down an installation.**
      Hashed with argon2 like passwords rather than SHA-256 like tokens — each is short enough to
      be worth attacking offline — single-use under concurrency via `used_at IS NULL` in the
      UPDATE, and drawn from an alphabet without `0`, `1`, `l` or `o`, because somebody typing
      one has just lost their phone and a code they cannot transcribe is not a recovery code.

      **Enforcement is a property of a group, not an account.** "Everybody who can change the
      monitoring configuration uses MFA" is the policy an administrator actually wants to write,
      and per-account means remembering it whenever somebody joins. Required if *any* group
      demands it — the same "highest wins" shape `A-03` gives to rights, so joining a group never
      quietly relaxes a requirement.

      **Required-but-not-enrolled answers `MFA_REQUIRED` with `enrolled: false` rather than
      refusing outright**, or switching the policy on would lock out everybody it was just
      switched on for. Disabling MFA needs the account password: doing it from a session alone
      would make a stolen session enough to remove the thing that protects against stolen
      sessions.

      Found by the tests: recovery codes were hashed in their displayed form (`abcde-fghij`) and
      compared in their typed form (`abcdefghij`), so every one of them failed — and failed
      looking exactly like a wrong code, to somebody who had just lost their phone. Normalised in
      one function used by both paths. Lint found the other: an unawaited `assert.rejects`, which
      is an assertion that never runs.

      Tests: 29.
- [x] **A-08 — Audit log UI** · M · S-10, U-01 · Per-object history with diffs and actor.
      **Added by S-10:** the per-object route and its paging exist
      (`GET /api/v1/objects/{id}/audit?before=&limit=`), and the entry shape is final. What is
      missing is a **global feed** — "everything that changed this week", "everything this user
      did" — which the `audit_log_at_idx` and `audit_log_actor_idx` indexes are already there
      for. Note that a subtree delete writes one entry, on the object the delete was aimed at,
      listing what it destroyed; a destroyed child has no entry of its own, so the UI has to
      look at ancestors to explain where something went.

      **A-08 outcome.** Most of the ticket was already standing: `S-10` shipped the global feed
      with diffs and category, kind and time filters, and `U-01` put a per-object Changes tab on
      the detail view. Auditing what existed before building anything is what turned up the
      defect below, which no amount of new UI would have fixed.

      **The audit log named nobody, and nothing failed.** The web types declared the actor as
      `{ kind, label? }`; the API sends a discriminated union — `{ kind: 'user', userId, login }`
      and three siblings — with no `label` anywhere in it. `actor.label ?? actor.kind` therefore
      rendered the word "user" against every entry a person had ever made, and "anonymous" against
      every address. **The login was in the response the whole time.** A log that attributes
      nothing looks exactly like a log with nothing to attribute, which is why this survived two
      tickets and a phase exit. The web type is now the union itself, so the compiler forces the
      question "which kind?" before anything can be read off it, and `api/actors.ts` answers
      "what to show" and "what to filter by" in one place for both views.

      **"Everything this person did" is the question an audit log is opened for**, and it was the
      one filter missing. `actorKind` narrows to *all* users, which during an incident is
      everybody. `actorRef` now filters to one, and `audit_log_actor_idx` — `(actor_kind,
      actor_ref, id DESC)` — has been there since `S-10` for exactly this. Every actor on every
      entry is a link that asks it. **Always with the kind**, because a ref is unique only within
      one: user 4 and token 4 are different actors, and half this filter would attribute one
      person's changes to another, which is the single thing an audit log may not do.

      The per-object panel also paged to fifty and stopped. It answered "when was this last
      touched?" correctly and "who changed the interval last spring?" not at all, while looking
      identical either way; it is on `usePaged` now, like the global feed.

      **Putting it on `usePaged` is what exposed the paging bug, and it was in `usePaged` itself**
      — so in every paged log in the UI since `S-10`. A null cursor meant two opposite things,
      "no cursor yet" and "the cursor ran out", and the exhausted one therefore fell through to
      the *first* page's cursor, which is never null. The button never went away, and each press
      past the end re-fetched and re-appended the final page. Measured live on a sensor with 77
      changes: one press past the end took the list to 104, showing twenty-seven entries twice.
      **In a log, a repeated entry is a second event that did not happen.** There was already a
      test for the cursor running out — on the *first* page, the one case where the two meanings
      coincide. Fixed with a `paged` flag; verified live at both scales, 77 and 512, each ending
      on the exact row count in the table.

      Mutation: 14 mutants, 14 killed. Two survived first time. A route that ignored `actorRef`
      entirely, because the test had only one *user* in the log so filtering by kind alone
      returned the same rows — a second user killed it. And paging state surviving a filter
      change, which would tell the reader "that is the whole log" about a log they had seen a
      fraction of.

      Tests: 5 (core) + 19 (web).
- [x] **A-09 — Security hardening pass** · L · A-03 · Rate limiting, CSRF, security headers,
      dependency audit, SSRF guards on all user-supplied URLs, script-sensor sandboxing.

      **A-09 outcome.** Three of the six were already delivered by earlier tickets — script-sensor
      sandboxing (`T-03`'s `node:vm` watchdog), the webhook SSRF guard (`N-08`), and login
      throttling (`A-01`). Auditing them first is what turned up the one that mattered.

      **The SSRF guard covered webhooks and not sensors, and sensors are the better vector.**
      Both fetch a URL somebody typed; only one was checked. An HTTP sensor is worse than a
      webhook, because a sensor's *response* is stored and rendered — so credentials taken from a
      cloud metadata service end up on a dashboard rather than merely in flight. The guard moved
      from `@ms/core`'s notification directory to `@ms/shared`, where `@ms/sensors` can reach it,
      and now runs on every sensor fetch. **A guard covering one of two callers is a guard whose
      absence is invisible.**

      The default stays `link-local` and only that. A monitoring system fetches URLs inside the
      network it watches — that is the job — so a guard blocking private addresses would make the
      HTTP sensor useless and be switched off within the hour, which is worse than a narrow guard
      nobody disables. Addresses are checked, not names, because a name that resolves to a
      blocked address is one DNS record away.

      **Security headers, CSRF and rate limiting are written here rather than taken from
      plugins.** Each is a few dozen lines and one policy judgement; a plugin is a dependency to
      audit, update and ship inside an installer, which `CLAUDE.md`'s standalone constraint makes
      an operator's problem too.

      - **CSP without `unsafe-inline`**, which is what makes an injected `<script>` inert and why
        the UI ships a stylesheet rather than style attributes. **HSTS only over TLS** — a
        year-long HSTS issued over plain HTTP makes an installation reachable on both schemes
        unreachable on one of them, for a year.
      - **CSRF checks `Origin`, not a token.** A synchroniser token needs to live in a cookie or
        a meta tag, both readable by the injected script it is supposed to help against; `Origin`
        is set by the browser and cannot be forged by page script. Token-authenticated requests
        are exempt and must be — a bearer token carries no ambient authority, and demanding an
        `Origin` from `curl` would break every integration for nothing.
      - **Rate limiting is a backstop, not a quota.** Set high enough that no legitimate client
        meets it, because what it defends against is a loop in somebody's script; a limit low
        enough to shape traffic would page an operator whenever the UI opened a busy page. Keyed
        by account where there is one and by address where there is not, so one NAT is not one
        bucket and an unauthenticated flood is still counted. The budget is reported on *every*
        response, so a client can slow down before it hits the wall.

      **`npm audit --omit=dev --audit-level=high` in CI.** Production dependencies only: a
      dev-only advisory is worth knowing and is shipped to nobody, and failing the build on one
      trains everybody to ignore the step that would have caught the production advisory.
      Currently zero.

      Caught by the build-hygiene test on the way through: moving `ssrf.ts` between packages left
      its compiled output behind, which that test exists to notice.

      Tests: 18 for the hardening layer, 7 for the sensor SSRF guard.
- [x] **A-11 — `allowedOrigins` is an option nothing can set** · S · A-09 · The cross-origin
      write guard in `api/hardening.ts` takes an `allowedOrigins` list and **no caller ever passes
      one** — it is not in the config schema, not in `main.ts`, and not in `dev/core.json`. So the
      only origin that can write is the one serving the API, and every other is refused with "this
      request came from another origin".
      **Found by `U-12`**, driving the real form in a browser: `docker-compose.dev.yml` has a
      `ui` profile that serves Vite on :5173 against the core on :8080, and **nothing in that UI
      can save**. Every developer who uses it hits this on their first click.
      The fix is a config key and a line in `main.ts`, not a change to the guard: the guard is
      right, and an installation behind a reverse proxy on a different hostname needs the same
      key for the same reason. Worth doing before `H-07`'s documentation set describes a
      development setup that does not work.

      **A-11 outcome.** `api.allowedOrigins` is now a config key, defaulting to `[]`; `server.ts`
      passes it to `registerCsrfGuard` (not `main.ts` — the api block reaches the server whole);
      `dev/core.json` lists both spellings of the dev server. The guard itself is unchanged.

      **The failure is more general than the dev server, and the ticket had it slightly wrong.**
      It is not that :5173 and :8080 are different origins in the browser's sense — with Vite's
      `changeOrigin` the browser sees a same-origin call to :5173 and sends no preflight at all.
      It is that the *proxy* rewrites `Host` while forwarding `Origin`, so the two headers the
      guard compares disagree about a request that was never cross-site. Every reverse proxy in
      front of a production install does the same thing, which is why this is a shipped config
      key rather than a development flag.

      **Entries are normalised and refused at startup, not skipped.** `https://ms.example.com/`
      and `https://ms.example.com/app` both become the origin a browser would send. A value that
      could never appear in an `Origin` header — `127.0.0.1:5173` with no scheme, a `file:` or
      `ftp:` URL — throws by name at registration. Skipping it would have looked exactly like a
      config file that was never read, which is the bug this ticket is.

      Not CORS, and deliberately: the API sends no `Access-Control-*` headers, so this does not
      make it callable from another origin. Listing an origin an attacker controls would hand
      them every session cookie's authority, and the doc comment says so.

      Verified live: with the dev stack running, a `POST` through the Vite proxy from
      `http://127.0.0.1:5173` creates an object (201) where it was refused before, and the same
      request carrying `Origin: http://evil.test` through that same proxy is still refused (403).

      Tests: 8 new in `hardening.test.ts` — a proxied write accepted, a pasted URL with a path
      matched on its origin, scheme and port distinguished from an accepted neighbour, everything
      unlisted still refused, and three shapes refused at startup — plus 2 in `auth-api.test.ts`
      for the wiring itself, which is the half `hardening.test.ts` cannot see and the half that
      was missing. Mutation 6/6, each killed by a named test rather than by the compiler.
- [x] **A-10 — Access-control test matrix** · L · A-03…A-05 · Every combination of role, group
      and tree position; explicit test that no route leaks a credential to a read-only user.

      **A-10 outcome, and it earned its place by finding a bug the other tickets could not see.**
      `A-03` proves the resolver and `A-04` proves the ceiling; both were correct. The route
      called `/objects/:id/access/effective` was calling `resolve` — what an account's *groups*
      grant — rather than `resolveFor`, which is that capped by the account's role and by the
      token in hand. A read-only account was told it held `full` on a device it could not edit.
      **The unit tests could not catch it because the bug was not in the unit**; it was a route
      that forgot to ask. Fixed, and verified live: the same account now reads `read` with
      `cappedByRole: true`.

      **The credential sweep is swept, not sampled.** A hand-maintained list of "routes that might
      leak a credential" goes stale on the day somebody adds a route — precisely the day it was
      meant to catch something. So `ApiServer` exposes the routes it registered, a real secret is
      planted in a sensor's `writeOnly` parameter, and **every** GET route is called and checked.
      A route added tomorrow is covered by construction. There is a guard against the vacuous
      pass, too: the sweep asserts it found routes at all, because a sweep over an empty list is
      the worst kind of green.

      **Checked for all three roles, not only the read-only one.** The exit criterion names a
      read-only user; the system's actual claim is stronger — credentials are write-only *to
      everyone*, redacted at `ObjectService.#redact`. A test that only checked read-only would
      pass on a system where the answer was a role check rather than a boundary, which is a
      weaker system that looks identical from that one test.

      Also asserted: the parameter is reported as *redacted* rather than omitted, because a form
      that cannot tell "unset" from "set and hidden" makes somebody retype a secret they did not
      need to; and the audit log's stored summary and diff carry the parameter's name and never
      its value.

      Tests: 12 matrix rows over HTTP plus 6 credential-boundary tests.
- [x] **A-11 — Every route declares who may call it** · L · A-03…A-06, A-10 · Authorisation
      declared per route and enforced in one hook; a route that declares nothing stops the build.

      **What was wrong: nothing enforced any of it.** `AccessService` — the resolver carrying
      `A-03`'s three rules, `A-04`'s role ceiling and `A-06`'s token scope — was called by exactly
      one route in the installation, and that route only *reported* the answer. Every mutating
      route was open to any authenticated principal. A read-only account could delete every
      trigger, template and schedule; a token issued with `scope: 'read'` performed every write;
      `POST /templates/:id/test`, which really sends, was callable by anybody with a session; and
      `may_acknowledge` — stored, defaulted to false, documented in migration 034 as the one
      exception a read-only account gets — was read by no code at all, so every principal could
      acknowledge and the flag did nothing.

      **Why A-10 could not see it, which is the part worth keeping.** The file is named for this
      criterion. Its matrix asserts twelve combinations of role, group and position — through
      `GET /objects/:id/access/effective`, the *reporting* endpoint, so it asserted the resolver
      against itself and would have passed on a build with no enforcement anywhere. Its route
      sweep filters to `GET`. A sweep of reads cannot notice that no write is guarded.

      **The fix is declarative, and the guard is the build.** Each route carries
      `config: { access }` — `PUBLIC`, `READS`, `WRITES`, `ADMIN`, `SELF`, or a right on the
      object named by a path, body or query parameter — and one `preValidation` hook enforces it.
      A route that declares nothing does not fall open and does not fall closed: `ApiServer.build`
      throws with its name, the same enforcement the response-schema guard already had, for the
      same reason. 119 routes now declare a bar.

      **`preValidation`, not `preHandler`, and the reason is provable.** Fastify validates the
      body first, so a caller who may not touch a route at all was answered 400 for a malformed
      body rather than 403 — which meant the sweep below could not tell a guard from a schema,
      and a mutation that let a read-only account write everything passed it. Refusing before
      validating is also the better order on its own terms.

      **The sweep now has the half it never had**, and it consults no list. Every non-GET route
      is called as a read-only account and must answer 401 or 403 — and separately, every one of
      them must *declare* a bar above read, read off its own declaration, so a new `POST` that
      declares `READS` fails on the day it is written. The one honest exception, a `POST` that is
      a read because its input will not fit in a URL, says so in its own source with
      `changes: false` rather than being listed here. The token scope gets its own sweep with a
      read-scoped token held by an administrator, so the account's role cannot be what refuses it.

      **The matrix harness registers the library services now.** It did not, so triggers,
      templates and schedules were not in any sweep — the routes G01 named were literally absent
      from the test that was supposed to cover them. With them registered a mutation widening the
      role table fails three tests instead of none.

      **Bulk is partitioned rather than barred.** A bulk request names its objects in the body, so
      one bar for the whole request cannot express "may pause four of these six". The ids are
      split by `resolveManyFor` — one query, not one walk per id — and the refused ones come back
      as ordinary failed outcomes, because a selection made in a tree view routinely includes
      something the operator cannot touch.

      Tests: 6 new in `access-matrix.test.ts` — the mutating sweep, the declaration-shape check,
      the read-scoped token, both halves of `may_acknowledge`, and the bulk partition — plus four
      existing ones repaired: they granted rights without clearing the matrix's leftover `none`,
      so they were asserting against a wall of 403s that no credential could leak through.
      Mutation 4/4.

### Panel round two — notifications, schedules, triggers

Eight lenses over `packages/core/src/{notifications,schedules,triggers}`, merged to 34 distinct
claims, each put to three skeptics briefed to refute it; a completeness critic then named five
areas nobody had looked at and those were run and verified at the same bar. 27 + 18 confirmed.

- [x] **P-112 — A pending alarm was destroyed by any state change, restarting its latency**
      `chain.ts` tested `phase === 'pending'` before the `P-105` rule and answered `cancel`, so a
      probe blip — `down -> unknown` — deleted the alarm, and the reconnect armed a fresh one from
      the sensor's new `since`. A target down continuously behind a link flapping every three
      minutes never reached its five-minute latency: no notification, ever, and a notification
      queue that reads clean. The comment justified sending nothing, which is right; it never
      justified re-reading `since`. `P-105` had fixed the same shape for `notified` only.

      Now the only paths that cancel a pending alarm are the ones where the alarm is genuinely
      over — a recovery, or a pause — and everything else suspends, so the return picks the
      latency up where it stopped. Also fixed here: **a trigger retargeted onto the state the
      sensor is already in** now arms in the same reaction instead of cancelling and stopping.
      Reactions are driven by transitions, and a sensor Down for a week has none coming, so the
      retargeted trigger was inert and looked identical to a working one.

- [x] **P-113 — A trigger configured for `up` notified once per sensor, ever**
      `up` is an offered trigger state, and for an alarm armed on it the recovery branch is
      unreachable: `isRecovery` is true only for `up`, so leaving `up` suspended the alarm and the
      return matched `stillStanding` and took `resume` — and a resumed `notified` phase with no
      escalation and no repeat has nothing left to send. The operator who asked to be told when
      sensors come back was told once and then never again, silently, with the alarm row flipping
      suppressed true and false and nothing anywhere saying why. `endsAlarm` now takes the state
      the alarm is *about*: suspension is for an ongoing problem whose escalation must survive a
      blip, and there is no ongoing problem to escalate about a healthy sensor.

- [x] **P-114 — An unreadable trigger had its standing alarm deleted rather than skipped**
      The engine claims each trigger out of an orphan map and deletes whatever is left. It read
      the settings *before* claiming, so a trigger this build cannot parse — a downgrade, or a
      shape written by a newer build — logged a warning and then lost its alarm to the orphan
      sweep, cancelling an outage that was still happening on the strength of not understanding
      it. Claimed first now: this build cannot judge it, so it changes nothing.

- [x] **P-115 — Changing a trigger's kind orphaned the alarm and blocked the pair for ever**
      `PUT /triggers/:id` is whole-document and does not refuse a change of `kind`, so a standing
      threshold alarm can find itself under a state trigger. Its `state` is null, the engine's view
      collapses, and `reconcile` can only answer `idle` or `arm` — neither of which clears a row —
      while the trigger has already been claimed out of the orphan sweep. The row was unreachable
      by every clearing path: the state arm was swallowed by `ON CONFLICT DO NOTHING` while the
      counters reported it armed, so that (sensor, trigger) pair could never notify again, and the
      sweep re-read a `next_due_at` in the past at the scheduler's floor of 25 ms — forty times a
      second, for ever, each one logging that the settings were unreadable. The row is cleared now,
      and **the writes were reordered so clears land before arms**: `ON CONFLICT DO NOTHING` means
      a pair that is both cleared and armed in one reaction would otherwise have its insert
      swallowed by the row it is replacing and then lose that row to the delete.

- [x] **P-116 — The sweep erased an acknowledgement that landed while it was deciding**
      `due` read without a lock and `advance` wrote back blind, so an acknowledgement committing
      between the two halves was overwritten by the sweep's own `suppressed = false` and the
      escalation went out to everybody the operator had just told they were handling it. Both
      readers take the row lock now — `FOR UPDATE OF a SKIP LOCKED` on the sweep so two sweeps
      divide the work rather than queue, and `FOR UPDATE OF a` on the reaction's read, because
      they are the only two writers of the table and both are read-modify-write.

- [x] **P-117 — A resumed chain did not wake the scheduler**
      Only an arm poked it, on the reasoning that a reaction which cleared alarms has made the next
      due time later and never sooner. True of a clear; not true of a resume. A probe blip suspends
      the chain leaving nothing due, and the reconnect gives it back the escalation it had already
      earned, due at once — which the scheduler then slept straight past until the next unrelated
      event, however far away that was.

      Tests: 15 new — 9 in `notification-chain.test.ts` over the three chain rules, 5 in
      `notification-engine.test.ts` including a two-transaction test for the lock, and the resume
      poke. Mutation 7/7.

- [x] **P-118 — An HTML email inserted probe-controlled values with no escaping**
      The email transport declared no `bodyEscaping` at all, so `html: message.body` put whatever
      a device reported straight into a document. A sensor named after a tag lost a piece of its
      email; a hostile response to a `rest.custom` sensor wrote whatever it liked into the inbox
      of everybody on the notification list. The escaping machinery was already there and already
      right — `json`, `form` and `mrkdwn` all escape per *substituted value*, so the operator's
      own syntax survives — and email was simply not using it. An `html` escaping was added and
      the transport asks for it when the template's format is HTML.

- [x] **P-119 — A part-rejected email was recorded as delivered**
      `sendMail` resolves for a partial send and names the refusals in `rejected`, which was
      thrown away. An alarm that reached nobody on the list — every address unknown at the relay —
      was recorded `delivered`, counted as a success on Delivery Health and never retried; the one
      place an operator would look said it went out. Every recipient rejected is now a permanent
      failure naming them (retrying a RCPT TO rejection ten times changes nothing but how long the
      operator waits to find out), and a partial send is still delivered — somebody got it — with
      the missed addresses in the detail and a warning in the log.

- [x] **P-120 — A program template silently dropped its secret arguments**
      Two numbers for one limit: the schema allowed 32 visible arguments plus 8 secret, and the
      transport capped the concatenation at 32. A template using its full complement of visible
      arguments had every secret one dropped — so the program ran, exited non-zero for want of a
      credential nobody had removed, and the notification was recorded as a failed delivery with
      nothing anywhere to say why. The two schema limits are named constants now and the cap is
      derived from them.

- [x] **P-121 — Placeholders in a method's settings were substituted but never validated**
      A program template's arguments carry `N-06` placeholders like any other content, and
      `substitute`'s report of the ones it did not know was discarded — so a typo was neither
      refused at save, where the subject and body have been refused since `N-06`, nor reported at
      send. The program was handed the literal text `%lastvlaue` as an argument and failed for a
      reason nothing in the system could explain.

      **The fields are declared by the method rather than swept for.** A percent-encoded webhook
      URL is indistinguishable from a placeholder — `%AF` in an encoded segment is a name called
      `af` — so validating every string in a settings document would refuse templates that are
      perfectly correct. `placeholderFields` names the places an operator is invited to write one.

      Tests: 10 new — 3 on the HTML escaping, 1 on the transport's choice of it, 2 on partial
      rejection, 1 on the full argument complement reaching the program, and 3 on the settings
      walk including the encoded-URL case. Mutation 5/5.

- [x] **P-122 — One undeliverable digest window starved every other template's digests**
      A closed window whose template had since been disabled, or whose method has no transport in
      this build, holds requests the claim will never take. So it came back from `owing` on every
      pass, produced no members, and consumed one of the caller's slots for ever. Enough of them
      and no digest arrived anywhere — and nothing said so, because each pass looked like an
      ordinary quiet one. `owing` now asks the same question the claim does; the rows stay in the
      table, because re-enabling the template still owes those people the digest.

- [x] **P-123 — A failed digest came back as several fragments, each labelled part 1 of 1**
      Every member got its own jittered backoff, so a digest of forty that failed fell due at
      forty different moments. The next pass claimed whichever handful had ripened, assembled them
      into a digest of their own and labelled it complete. One outage arrived as half a dozen
      fragments, in an order the jitter chose. One delay is now drawn per part and shared.

- [x] **P-124 — Delivery Health counted failures by when they fell due**
      `notification_request.at` is when the obligation *fell due* — migration 016 says so, and
      that is the right meaning for a digest naming when an outage started. Counting failures by
      it asks a different question: `DEFAULT_RETRY` spends 45 to 90 minutes on nine backoffs
      against a 60-minute window, so a notification that exhausted its retries — the one failure
      the whole subsystem exists to prevent — usually fell due outside the window and counted
      zero. It stopped being `pending` at the same moment, so it dropped out of `oldest_retrying`
      too: **Delivery Health flipped from Down back to `ok` at the exact instant the alarm was
      abandoned**. Migration 043 adds `settled_at`, written on every terminal transition.

- [x] **P-125 — A message waiting on purpose was counted as undeliverable**
      A request collecting into an open digest window, or parked because its template is outside
      its activation schedule, is doing exactly what an operator configured. Both were counted as
      pending, so `notifyOldest` climbed all night and Core Health went Down telling an operator
      to check a relay that was working, for a digest due at eight in the morning. They are
      counted and reported separately now — "forty messages are waiting for the eight o'clock
      digest" is worth showing and is not a fault. The parked set travels from the dispatcher's
      own evaluation rather than the health reader growing a second opinion about schedules.

- [x] **P-126 — `GET /core-health` answered 500 when the database was unreachable**
      Two callers, two right answers, and only one was implemented. The sweep writes a *sensor
      reading*, and a Core Health sensor whose numbers are unavailable must fail with a message
      and no channel values — a row of zeros is what a perfectly idle, perfectly healthy core
      looks like. The route is the other case: an operator asking how the core is, at the moment
      it is least well, lost the CPU, the memory and the ingest queue as well, none of which need
      a database at all. The four database-backed channels are gaps there now and the rest
      answers.

      Tests: 8 new — the starved digest batch, the shared backoff, the settled-at window, both
      parked cases, and both core-health callers. Mutation 5/5.

- [x] **P-127 — A grid read back and submitted again inverted an inactive schedule**
      `toGrid` applies the polarity on the way out, so a schedule stored as "inactive during
      Sunday" is served as a grid of the six days it *does* monitor — together with
      `polarity: 'inactive'`, because that is what is stored. A client that read that view and
      sent it back unchanged, which is what a form does, stored the monitored hours as the
      inactive ones: the maintenance window became the only time anything was watched. A grid is
      stored as `active` now, whatever polarity travels with it — polarity is not a second degree
      of freedom on top of a grid, it is the thing the grid has already resolved.

- [x] **P-128 — `nextChangeAfter` was an hour late every spring**
      Week-minutes are local time and the delta is elapsed time, so a spring-forward between now
      and the next edge makes the edge arrive an hour *sooner* than the arithmetic predicts. The
      candidate therefore already read as changed, the verification was satisfied by exactly that,
      and the answer was an hour late — every year, in every zone that does it. The candidate is
      verified in both directions now.

- [x] **P-129 — A delete refusal reported a page size as the number of objects**
      `usedBy` returns fifty rows and the message was built from its length, so a schedule
      assigned to two hundred objects said fifty. The operator clears fifty, tries again, and is
      told fifty again.

- [x] **P-130 — Deleting a schedule a rediscovery rule used raised a raw constraint violation**
      `discovery_schedule.schedule_id` is a `RESTRICT` foreign key and nothing checked it, so the
      delete reached the database and came back as a 500 with a constraint name in it. The other
      two users of a schedule are refused by name; this one is now too.

- [x] **P-131 — No schedule recompute at startup, so probes scanned inside a closed window**
      `paused_by_schedule` is a stored flag and the probes' configuration is built from it. A core
      that was down when a window closed came back with every flag as it stood before the
      boundary and handed the probes a list that said to keep scanning — for up to sixty seconds,
      on every restart, when the whole point of a maintenance window is that nothing scans in it.
      `ScheduleSweep.start` sweeps once before arming, and `main` awaits it before the probe
      endpoint exists.

      Tests: 8 new. Mutation 5/5.

- [x] **P-132 — A master forced Down never paused its dependents**
      `M-14`'s simulated error puts sensors into the state the whole dependency mechanism exists
      to react to — it fires the real notification chain at real people, which is what it is for —
      and `invalidates` matched none of its mutations. So the storm the dependency was configured
      to prevent arrived in full, from the button whose purpose is to rehearse exactly that; and
      lifting the force never released anything it had held.

- [x] **P-133 — `DependencySync` was wired into the schedule sinks for an effect it could not have**
      It is in `scheduleAuditSinks`, deliberately and asserted by a test, and `invalidates`
      matched none of the three schedule actions — so the sink was inert. A master pausing on a
      schedule window is switched off rather than Down (`docs/state-machine.md` §3), so its
      dependents must be released, and they stayed dark until something unrelated recomputed
      them. `pause-precedence.test.ts` did not have the sink in its schedule service at all,
      which is why nothing noticed; it composes what production composes now.

- [x] **P-134 — The dependency cascade read its own output, so a loop of masters was permanent**
      `holding` selected masters that were `paused_by_dependency` — the column the same statement
      then writes. That is the recursion the cascade needs and it is also a fixpoint that can
      sustain itself: two sensors pointing at each other, which a *move* can arrange because only
      the assignment path checks for master loops, held one another with both flags true, each
      true because the other was, no outage anywhere. Permanently unmonitored, permanently
      unresumable, and nothing logged, because from the row's point of view nothing had changed.
      The closure is computed from ground truth now — a real outage, an acknowledged one, or a
      recovery inside its delay — and propagated with `UNION`, which is what makes a cycle
      terminate holding nobody.

- [x] **P-135 — A master whose probe went away held its dependents for ever**
      A probe going offline moves its sensors to Unknown, and Unknown is not Down. Nothing
      recomputed the dependency flags: the reaction is reachable from ingestion, with the
      transitions a *result batch* produced, and a probe that has gone produces no results. The
      dependents kept `paused_by_dependency`, dropped out of the probe configuration and were
      never scanned again — while the pause API, which computes what is holding them from the
      master's current state, reported nothing holding them and refused to resume them. `P-87`'s
      failure exactly, down a path `P-87` did not cover. The recompute now runs in the same
      transaction as the re-evaluation, on loss, on return and on a topology change, and the
      dependency reactor is a **required** constructor argument for the reason `P-111` gives.

      Tests: 5 new. Mutation 5/5.

- [x] **P-136 — A window closing on the clock left a master's dependents held**
      The last way into `P-87`'s failure. A schedule *edit* reaches `DependencySync`; a window
      closing at 18:00 does not — there is no mutation, only the sweep. So the master was paused
      and its dependents kept `paused_by_dependency`, dropped out of the probe configuration and
      were never scanned again, while the pause API said nothing was holding them and refused to
      resume them. The sweep settles the dependency flags in its own transaction now, and the
      settler is a required constructor argument.

- [x] **P-137 — `%priority` was documented upside down**
      "1 (highest) to 5", against an object model whose own filter is `priority >= n` and whose
      alarms list sorts descending. The placeholder list is the one place the meaning is written
      down for an operator, and following it would put the least important sensors at the top of
      somebody's triage. (A *template's* priority really is 1-high — it becomes `X-Priority` and
      every mail client agrees on that — which is presumably where the confusion came from.)

- [x] **P-138 — The configuration push could fire before the mutation committed**
      The notifier rides the audit sink, which runs inside every mutation's transaction, and
      debounces for 250 ms. Any transaction slower than that — a bulk operation, a tree plan, a
      clone of a large subtree, a busy database — had its push fire against the uncommitted tree:
      the recomputation produced the fingerprint already in place, decided nothing had moved and
      pushed nothing, and the spent timer scheduled no other. The probes stayed on the old
      configuration until something else happened to change something. The class comment argued
      that running *after* a transaction is safe, including after a rollback — true, and never
      the risk. It is armed from `afterCommit` now, so a rollback schedules nothing at all.

- [x] **P-139 — One trigger of an unknown kind broke the whole tab, and could not be deleted**
      A row written by a newer build, or left by a downgrade, made `triggerKinds.get` throw on the
      *list* — so the whole trigger tab was refused and the operator could not see any of their
      triggers, including the one causing it. (`TriggerError` maps to a 400 `TRIGGER_INVALID`,
      not the 500 this entry originally claimed; the list was equally unusable either way, but
      the diagnosis written down for the next reader was wrong — `G14`.) It threw again in `delete`, which builds its audit
      summary through the kind, so the one action that would clear the row was the one action that
      could not be taken. Reading tolerates an unknown kind now and says so in the summary;
      *saving* still goes through `get`, because a kind this build cannot validate is one it must
      not accept.

      Tests: 6 new. Mutation 4/4.

- [x] **P-140 — The pause API spoke for every cause, including ones it does not own**
      `P-94` gave `reevaluate` a `sources` parameter — which causes a caller may supply words for
      — and taught the schedule sweep to use it. The pause API, the other operator-facing caller,
      was never given one, and an absent `sources` means *every* cause. Fixed by symmetry, and it
      ships **without a test that fails without it**: every sequence tried reaches the
      higher-precedence pause through a re-evaluation that already sets the state, so the later
      manual pause decides the same state and cause and writes nothing at all. Said out loud
      rather than papered over with a test that passes either way.

- [x] **P-141 — A clone carried the trigger fence and none of the triggers**
      The clone copies `inherits_triggers` deliberately — a clone of a lab device is still a lab
      device, and one that notified nobody must not start notifying — and copied none of the
      triggers behind the fence. So a cloned object with the fence up inherited nothing and owned
      nothing: it notified **nobody**, which is the one failure a monitoring system must not
      arrive at quietly, and it looked identical to a working one. The triggers travel now,
      `enabled` included, and the clone reports how many.

- [x] **P-142 — Acknowledging an alarm reset how long it had been broken**
      The alarms list's duration column and its "what has been broken longest" sort read
      `sensor_runtime.since` — when the sensor entered its *current state*. Acknowledging a Down
      is a state change, so at the moment an operator said "I am on it" the duration reset to zero
      and the sensor dropped to the bottom of that sort; the acknowledgement lapsing reset it
      again. `CLAUDE.md` already says where a duration comes from — uptime is computed from state
      history, not from the runtime row — and this was the one place that did not. The outage is
      dated from the earliest transition after the last non-alarm state, falling back to the
      runtime row for an outage older than the retained history.

      Tests: 3 new. Mutation 2/2 (`P-140` has none by construction, as above).

- [x] **P-143 — The HTTP timeout was idle-based, so a trickling endpoint stalled a hop for ever**
      `request.setTimeout` fires when the socket has been *quiet* for that long, and the deadline
      across redirect hops is only consulted between them. An endpoint sending one byte a second
      reset it indefinitely, and the delivery loop that awaits it is not concurrent: one endpoint
      held up every notification behind it. A wall-clock deadline per hop now runs beside the idle
      one. The mutation that removes it does not fail the test — it hangs it, which is the point.

- [x] **P-144 — A future-dated result was rejected but its readings were written anyway**
      The horizon that refuses a result no clock could have produced (`P-99`) ran *after* the loop
      that turns readings into samples. A probe years out wrote graph points stamped 2030 that
      nothing would overwrite and no query would reach, while the sensor's state never moved. Half
      a result believed and half not is the one outcome a bound like this must not produce.

- [x] **P-145 — A spool replay rewrote hours of history into consecutive milliseconds**
      `P-108` stamps every transition after that sensor's newest stored row. Right for the core's
      own decisions — they happen now — and wrong for results, which carry the probe's clock and
      arrive late by design. A probe replaying an hour of spooled history had every row rewritten
      to `newest + 1 ms`, `+ 2 ms`, `+ 3 ms`: a four-hour outage became four milliseconds in the
      table `CLAUDE.md` says uptime is computed from, and the SLA read 100% through it. The two
      callers now say which they are; results are stamped as measured, and only a genuine
      collision moves, far enough to make room.

- [x] **P-146 — A spool replay paged, escalated and repeated for an outage that had ended**
      The chain's clock is not `now`: `arm` takes `initialDueAt(sensor.since)`, and `since` is the
      replayed result's own timestamp. A Down replayed from six hours ago armed with a due time
      six hours past, `onArmed` woke the scheduler, the sweep fired within a second — then the
      escalation, then the repeat, because every deadline from that `since` was also past. The
      recovery was still in the probe's spool, tens of batches behind. Every blip a probe spooled
      was paged in full, and the initial latency bought nothing. A batch whose newest result is
      older than the catch-up grace is written to history and not reacted to; the drain ends with
      a live batch, and that one decides the present. Counted, not silent.

- [x] **P-147 — A pause committing mid-batch was clobbered back to Down, and armed a chain**
      `decide` evaluates layer 1 — a pause dominates everything — from an in-memory cache, and the
      write that lands up to `batchMaxDelayMs` later had no pause guard of its own. It set
      `state = 'down'` on a row whose pause flags were true, and the alarm reaction in the same
      transaction read that row back and armed a chain: exactly the alarm the pause was pressed to
      stop, produced by the press itself. Nothing self-healed until the next scan. The write keeps
      everything the check measured and leaves the state to the pause — which is what `decide`
      would have produced had it seen it.

      Tests: 5 new. Mutation 5/5.

- [x] **P-148 — `config-delta` was not chunked, so a large pause killed the connection**
      `config-set` is chunked at 1,000 sensors precisely because the schema caps it at 5,000 —
      that is what `P-?`'s 426-closures wedge was about — and the delta branch had no chunking at
      all, against a schema that caps **both** `upserted` and `removed` at 5,000.
      `assignmentsFor` filters out every paused sensor, so pausing a probe object, or any group
      above it, on a probe carrying more than that produced one message the probe's own decoder
      rejects, and a protocol violation destroys the socket. The pause an operator is told takes
      effect immediately instead took a reconnect cycle, in both directions, every time.
      `worthADelta` never saved it: it weighs the *upserts* against a resend and has no opinion
      about removals.

- [x] **P-149 — An interrupted chunked push left a probe confidently scanning a fraction**
      A full push is one `config-set` plus N-1 deltas at the same version, and the probe stamps
      itself as holding that version on the *first* one — `config-set` is authoritative, so chunk
      one drops every sensor outside it and chunks two onwards put them back. A link that drops in
      between leaves the probe with a fraction of its sensors and a version that says it is
      current. It reconnects, presents that version, the fingerprint matches, and the core answers
      `config-unchanged`. Nothing ever re-pushes — `pushAllConfigs` short-circuits on an unchanged
      fingerprint — and the probe keeps delivering results for what it kept, so the delivery watch
      reads it as healthy. The rest are never scanned again, and their rows sit frozen.

      The disagreement was already on the wire and already discarded: `config-ack` carries the
      count the probe actually scheduled, and `#applyConfig`'s own comment says the core logs any
      disagreement — logging it was all that happened. Acting on it needs no protocol change.

      Tests: 3 new. Mutation 3/3.

- [x] **P-150 — `P-149` re-pushed on every partial ack, in a loop**
      A regression in the fix immediately above it, and it announced itself the first time a real
      probe connected: **a push is several messages and the probe acknowledges every one of
      them.** A chunked set is a `config-set` plus N-1 deltas at one version, applied and acked
      separately, so the acks arrive carrying 1,000, then 2,000, then 3,000 — each a truthful
      report of a push still in progress. `P-149` compared the first against the total and
      re-pushed, producing six more messages, another partial ack, and another re-push. The dev
      stack at 5,047 sensors re-sent its whole configuration continuously, and because the
      re-push nulled `sentVersion` to defeat the fingerprint check, every in-flight ack also
      logged "a configuration version the core did not send".

      Three things were wrong and all three are fixed. The count is judged only when the last
      message of the push has been acknowledged — the session counts its outstanding acks, which
      is the only moment the probe's total can be compared with the core's. The forced push says
      so explicitly instead of lying about what was sent. And a forced push never sends a *delta*:
      a delta is relative to state we believe the peer has, and a forced push is one made because
      that belief has just been shown to be false, so diffing against `sentSensors` computed
      "nothing to do" and sent an empty delta — the one answer that leaves the probe short.

      **`P-149` had a test and it passed.** It pushed three sensors, which is one message, so the
      single ack was also the last one and the loop could not appear. The new test replays what a
      real probe sends: six messages, six acks, and nothing may come back. Mutation 1/1.

- [x] **P-151 — the webhook hard timeout could crash the core from a timer**
      `P-142` armed a hard timeout *before* building the request, so a `send()` that blocks or
      throws is still bounded. But it closed over a `const` that `http.request` never got to
      initialise: that constructor throws **synchronously** for a header name it will not accept,
      and `x-ms-subject` carries a rendered subject with whatever characters a sensor name has.
      The executor unwound, the promise rejected as an ordinary retryable failure — and the timer
      stayed armed against a binding in its temporal dead zone. Two hundred milliseconds later it
      fired `ReferenceError: Cannot access 'request' before initialization` from a timer callback,
      which has no catcher: it reaches `uncaughtException` and takes the whole core down. Every
      retry re-armed it.

      The handle is now a `let` initialised to `undefined` and the timer destroys it optionally,
      so a throw before the assignment leaves the timer with nothing to do. Tests: 1 new — a
      delivery with a space in a secret header name, then a wait past the timeout, which crashed
      the process before. Mutation 1/1.

- [x] **P-152 — an unreadable trigger left its alarm spinning the scheduler**
      `P-114` stopped the sweep deleting a standing alarm whose trigger this build cannot parse —
      correctly: an outage that is still happening is not something to forget because a newer
      build wrote a settings shape we do not know. But bailing out left the row exactly as it was,
      with `next_due_at` in the past, so `due` returned it on the next pass and every pass after
      that. The scheduler clamps an immediately-due row to its 25 ms floor: forty sweeps a second,
      two queries and a warning line each, for as long as the alarm stands.

      The sweep now *parks* the alarm instead — `next_due_at = null`, `suppressed = true`, the
      state it already has for "standing, but not owed anything right now" — through the same
      `advance` write, and parked rows are not counted as fired. It stops being due, keeps its
      history, and the reaction resumes it if the trigger becomes readable again. Tests: extends
      `P-114`'s own test, which asserted the alarm survived and never asked what happened next.
      Mutation 2/2.

- [x] **P-153 — a probe that reconnects mid-push is never reconciled**
      `P-149` acts on the count disagreement a `config-ack` reports, and `P-150` made it wait for
      the last ack of a chunked push. Neither covers the case the probe reports on its *heartbeat*:
      a probe that dropped halfway through applying a set reconnects presenting the version it was
      given, the fingerprint matches, the core answers `config-unchanged`, and no ack is ever
      exchanged — so the only place that compares counts never runs. The probe keeps scanning the
      fraction it kept, delivery looks healthy, and the rest are frozen.

      Heartbeats carry `scheduled`, and it was only ever displayed. It is now compared against
      what the session was sent, once no push is outstanding, and a mismatch forces a full push.
      Tests: 1 new — 3,000 sensors fully acked, then a heartbeat claiming 1,000. Mutation 1/1.

- [x] **P-154 — the authorisation layer was switched off in the only wiring that ships**
      **`A-11` was written, tested and inert.** `registerAuthorization` returns at its second
      line when `auth.required` is false, and `main.ts` — the one place `ApiServerOptions.auth`
      is built outside tests — set it to `false`, under a comment saying it would be flipped
      "when `A-03` lands". `A-03` and `A-04` both landed; the same file reads `may_acknowledge`
      off the principal. So every sentence the `A-11` entry states as fixed was still true of
      `ms-core` as shipped, and the sweep that proves otherwise builds its own app with
      `required: true`.

      It is a configuration key now — `api.requireAuthentication`, **defaulting to on**, so an
      installation that has never heard of it gets the enforcing behaviour on upgrade. Off is a
      real answer for an install behind something else that authenticates, and it has to be an
      operator's sentence in a file rather than a constant nobody revisits.
      `ensureFirstAdministrator` already creates an account with a generated password in
      `<dataDir>/first-admin-password`, so a fresh install is not locked out by the flip.
      **`dev/core.json` sets it to `false`**: the web UI has no login screen yet, and a dev
      stack nobody can open is not a dev stack.

      Five more holes in the same layer, all of them found by one new sweep and none of them
      visible to the two that existed:

      - **`/objects/tree` and `/discovery` create under a parent nobody checked.** The rule
        `onBodyObject` was written for — "an account that may not write to a probe must not be
        able to hang a device off it" — was applied to `POST /objects` and to nothing else.
        `POST /objects/tree` takes the same `parentId` and creates up to five thousand objects
        under it; `POST /discovery` and `POST /discovery/schedules` name the group they
        provision devices into. All four are `onBodyObject('write', …)` now, and the routes
        addressed by a run or a schedule resolve the group from the row.
      - **`PUT` and `DELETE /triggers/:id` asked only for the role.** A trigger is addressed by
        its own id, so the only bar readable from the path was `readwrite` — and a grantless
        `readwrite` account could delete every trigger in the installation, including on
        objects it is refused sight of, which is how alarming stops with nothing looking wrong.
      - **`move` and `clone` checked the source and not the destination.** Both take a
        `targetParentId`; neither the hook nor `ObjectService` ever resolved a right on it, so
        an operator holding one device could clone it — and everything it goes on to alarm
        about — into a branch they were explicitly denied.
      - **`POST /objects/:id/as-template` served one device's whole sensor set** — names, types
        and parameters — under a role check, for a device the same account is refused by
        `GET /objects/:id/tree`.
      - **The bulk partition was the one check that did not stand down with the layer.** It
        gated on whether an `AccessService` was passed, which it always is, so with
        authorisation off an ordinary `readwrite` account had *every* id in a selection refused
        while the single-object route beside it succeeded for the same object.

      Two new declaration shapes carry this: `every(…)`, for a route with more than one
      question to answer, and `onDerivedObject`, for a route addressed by something that
      belongs to an object rather than by the object. A derived lookup that finds nothing is
      allowed through for the handler's own 404 — a guard that answered 403 to a missing id
      would be an existence oracle.

      Tests: 5 new in `access-matrix.test.ts` and 1 in `config.test.ts`. Mutation 7/7.

- [x] **P-155 — the access-matrix sweep could not see a third of the API**
      `A-11` added `triggers`, `templates` and `schedules` to the harness with a comment saying
      that without them the sweep "would be a claim about a third of the API". Nine more
      services were still missing — `tester`, `discovery`, `provision`, `rediscovery`,
      `probeRegistry`, `deviceTemplates`, `queries`, `probeConfig`, `stream` — and `ApiServer`
      registers each group behind an `if (this.#X !== undefined)`, so their routes were absent
      from `server.routes` and from every sweep. **Including `POST /templates/:id/test`, the
      route the ticket singles out by name as the one that "really sent for anybody with a
      session".** A sweep that cannot call the route it is cited for is not evidence, and its
      floor of 25 mutating routes was so far below the real 48 that nothing noticed.

      Three things were wrong with the harness and all three are fixed. Every optional service
      is registered. The floor is close to the real number, and beside it is a list naming the
      routes an absent module takes with it — a count could not catch one missing service, and
      the absence is in the harness rather than in any route's source, so nothing in the source
      can declare it. And the routes addressed by a trigger, a run or a rediscovery schedule
      are filled with **real rows**, because a derived guard on an id that does not exist
      answers 404 and looks exactly like no guard at all.

      **The sweeps were also blind by construction.** Both passes used a principal stopped at
      the role gate — a read-only account and a read-scoped token — so a bar that is too
      *coarse* refuses them and looks identical to a correct one. The new pass uses `readwrite`
      with no `object_access` row anywhere: it clears every role gate and holds `none` on every
      object, so anything it gets through was never guarded on an object. It found all five
      holes in `P-154` the day it was written.

      The `A-11` entry's own claim of "12 new tests" was six; corrected to six.

- [x] **P-156 — the bulk report counted duplicates differently depending on the caller**
      `partitionByRight` iterated the raw id array, so duplicates were collapsed on the allowed
      side — `BulkService` does it — and not on the refused side. The same selection answered
      `requested: 2, duplicates: 1` with one outcome row for an object the account may write,
      and `requested: 2, duplicates: 0` with two identical failure rows for one it may not. The
      route's own description promises "repeated ids are collapsed and counted, never applied
      twice" with no qualification, and `BulkReport.requested` is documented as the count after
      collapsing while the route was overwriting it with the raw one. Collapsed once, before
      the partition, and `duplicates` derived there. Tests: 1 new. Mutation 1/1.

- [x] **P-157 — an outage that began during a spool drain was never alarmed at all**
      `P-146` stopped the alarm reaction running on a batch a probe is replaying, which was
      right, and skipped it outright, which was not. Its justification — "the drain ends with a
      live batch, and that one decides the present correctly" — is false as written, because the
      reaction is keyed on *this batch's* transitions. A sensor that goes Down during the spooled
      window transitions once, in a skipped batch, and never transitions again while the outage
      continues: every later batch has it in `runtimes` and not in `transitions`, so `scanned` is
      empty and nothing is ever armed. A remote probe loses its link for two hours, a router it
      watches goes Down ninety minutes in and is still down — the dashboard says Down, the state
      history says Down, and nobody is told. One outage, zero alarms.

      The moved ids are **deferred** now rather than dropped, and folded into the first batch
      that is not a replay, which reconciles them against their current state: arming what is
      still Down, standing down what recovered while the spool drained. Visible on the ingestor's
      stats as `deferredReactions`, because a number that never comes back to zero is a probe
      whose alarms are not being armed and that has to be legible.

      Two more defects in the same guard, both about what "stale" was measured from:

      - **It folded over transitions, not results.** The ticket's own text says "a batch whose
        newest *result* is older than the catch-up grace", and so did the comment beside it.
        During a drain most batches change no state at all, so those batches read as live — and
        on any installation with a threshold trigger anywhere, `reconcilesReadings` widens the
        scan to *every sensor in the batch*, reacting over runtime rows written from hours-old
        readings and arming from a `since` six hours past. The storm `P-146` describes, one
        batch later. Every result has a runtime write, including the Down ones that record no
        reading, so measuring from those is both correct and available.
      - **It compared two machines' clocks.** `transition.at` is the probe's wall clock — the
        premise of `P-145` — and backward skew is deliberately unbounded because a replay
        depends on it. A probe host five minutes slow stamps every *live* result in the past, so
        every batch it ever sends is judged a replay and no sensor under it is ever armed:
        connected, heartbeating, delivering results, no notifications, permanently. `backlog` is
        already on the wire for the pacer and answers the question without a clock — a probe
        reporting zero has nothing left to replay whatever its clock says. The timestamp test
        remains the fallback for a probe that does not report it.

      Tests: 3 new in `state-ingestion.test.ts`. Mutation 2/3 — and the third is the point:
      the transitions-versus-results change was never mutated, and the test written for it could
      not have caught the mutation anyway (`P-169`).

- [x] **P-158 — the pause guard exempted the acknowledgement's own cause**
      `P-147` stopped a batch decided before a pause committed from overwriting that pause, with
      a guard reading "a write whose own cause *is* a pause is the pause being applied, and must
      not be held by itself" — implemented as `cause NOT IN ('user','parent','schedule',
      'dependency')`. But `user` is also the cause of both halves of an acknowledgement:
      `acknowledged()` returns `down_acknowledged`/`user`, and an acknowledgement lapsing on a
      still-failing sensor returns `down`/`user`. Both reach `RuntimeWrite.cause` verbatim.

      So on any sensor carrying an acknowledgement — which is to say, during exactly the outage
      an operator is most likely to pause for maintenance — the race `P-147` exists to stop was
      still unguarded. The pause is overwritten with the result's own state and `react` in the
      same transaction arms a chain for the sensor the operator just paused; being paused, it is
      out of the probe configuration, so nothing re-decides it and the row stays wrong until
      somebody resumes.

      The discriminator is the write's **state**, not its cause. Tests: 1 new. Mutation 1/1.

- [x] **P-159 — a trigger kind this build does not know still lost its alarm**
      `react` claims a trigger out of the alarm map only inside the two `if (trigger.kind === …)`
      branches, so a trigger whose *kind* is unrecognised never claims its alarm and the orphan
      sweep at the end of the sensor deletes it — silently, counted as `cleared`. This is exactly
      what `P-114` fixed one commit earlier for an unreadable *settings* shape, and its own
      comment states the rule: a trigger this build cannot judge is not a trigger that has gone
      away. `P-139` then taught every read path to tolerate an unknown kind, on the premise that
      such rows exist, and left the one path that destroys data.

      A roll-back deletes the standing alarm; the roll-forward arms the chain fresh from the
      sensor's current `since` — a second initial page for one continuous outage with the
      escalation deadline reset. Tests: 1 new. Mutation 1/1.

- [x] **P-160 — `parked` was computed, reported, and deleted on its way out**
      `P-125` separated "waiting on a relay" from "waiting on purpose" so that a digest
      collecting overnight would stop putting Core Health Down. The count reached the API route
      and no further: both response schemas declare `additionalProperties: false`, so
      fast-json-stringify removed the key — the same mechanism this repository documents at
      `routes/health.ts`. Requests that used to appear in `pending` appeared in neither, and
      `GET /notification-health` answered `pending: 0` over forty undelivered alarms.

      The second half is *which* templates count. The parked set was an argument defaulting to
      an empty array; Core Health passed it and the route did not, so the same question had two
      answers depending on which of them you asked. The reader takes the activation service
      instead, and the argument stays only for a caller that has already evaluated the schedules
      this pass. **No test exercised this route at all**; there is one now. Mutation 1/1.

- [x] **P-161 — the dependency settle nobody pushed, and the sweep that never ran at boot**
      Two probe-visible pause changes that reached the database and not the probes.

      `P-136` gave the schedule sweep a dependency settle and discarded its result: the push
      decision read only the schedule half. `applyPauses` computes `holding` from
      `dependency_clear_at > now`, so the minute a master's recovery delay elapses it is *this*
      sweep that releases its dependents — with `moved: 0` on the half that decides whether to
      push, therefore no `flush()` and no log line. `PauseSweep` was the component meant to
      handle that event, and by the time it ran `releaseElapsed` settled nothing, so it did not
      push either. Forty sensors unpaused in the database, absent from the probe's assignment
      list, unscanned until an unrelated change happened to poke the fingerprint. Both halves
      are counted and either one pushes now.

      `PauseSweep.start()` armed without sweeping, while `ScheduleSweep.start()` sweeps first and
      `main` awaits it — on reasoning that applies word for word to the flags this one writes.
      `paused_manually` and `paused_by_parent` are filtered by the same predicate in
      `ProbeConfigService`, and this sweep is the only thing that applies a maintenance window
      whose `starts_at` passed while the core was down. Its first tick landed up to thirty
      seconds after boot; the probe endpoint opens in between, the local probe reconnects within
      a second, and it is handed a list built from flags that say to keep scanning the box
      somebody is patching. Now async, sweeps once, and awaited beside the other.

      Tests: 2 new. Mutation 2/2.

- [x] **P-162 — a grounded cycle erased the outage instead of alarming on it**
      `P-134`'s comment says "a cycle contributes nothing and holds nobody", and that is true
      only while nothing in the cycle is independently Down. With A and B as each other's
      masters — which a move can arrange, and only the assignment path refuses — and A genuinely
      failing, `holding` seeds `{A}`, the recursion adds B through A and then A again through B.
      So A was paused by a hold whose entire justification was A itself: inside one transaction
      A went down → paused → unknown, the alarm was never armed, three history rows were written
      per sensor, and the next scan did it again. A real outage suppressed for as long as the
      cycle exists.

      Each hold carries the outage it came from now, and a sensor is never held by one it is
      itself the ground of. The genuinely down sensor stays down and alarms; everything
      downstream of it is still suppressed, which is the point of the feature. The existing
      cycle test set every sensor Up first, so it exercised only the ungrounded loop. Tests: 1
      new. Mutation 1/1.

- [x] **P-163 — the mover's words under a schedule's cause**
      `P-140` passed `sources: PAUSE_CAUSES_THIS_API_OWNS` at six `reevaluate` call sites and
      missed two. The clone path is benign — a fresh clone's schedule and dependency flags are
      false, so the decided cause is always one this API owns — but the move path is the one
      caller that can genuinely write a transition with a foreign cause: moving a subtree out
      from under a paused group flips `paused_by_parent` true→false, and a sensor still held by
      a maintenance window changes its reported cause from `parent` to `schedule`. That is a
      written transition, and without `sources` it carried "moved under a paused parent" as its
      message — for a sensor moved *out* from under one, whose actual reason is the window.
      `P-94` and `P-140`'s defect verbatim, on a caller both tickets missed. Declared at both
      sites; the clone one because "it happens to be unreachable" is not a property a later
      change preserves. Tests: 1 new. Mutation 1/1.

- [x] **P-164 — the next schedule change, when the clocks move twice or by two hours**
      Two defects in `P-128`'s verification of a predicted edge.

      Its backward branch walked to the start of the *contiguous* changed run containing the
      candidate, which is the first change only if the schedule does not flip again inside the
      shifted window. `su:09:00-su:09:10 su:09:50-su:17:00` on a spring-forward Sunday put the
      candidate inside the second period, the walk stopped at 09:50, and the answer was fifty
      minutes after the 09:00 the schedule actually opens. One forward scan from the floor
      answers both directions and needs no branch.

      And the ±90-minute bound was justified with "which covers every transition the zone
      database contains (the largest is an hour)". `Antarctica/Troll` is a current IANA zone
      whose seasonal shift is **two** hours, so the edge was outside the window in both
      directions — and the backward branch had no fallback, returning its floor, a minute at
      which nothing happens. 150 minutes, with the margin stated. Tests: 2 new. Mutation 2/2.

- [x] **P-165 — a partial rejection reported as a total one, and a duplicate sent**
      `P-119` decides "the relay took it for nobody" by comparing `rejected.length` against the
      number of recipient *entries* the template resolved. An entry is a 320-character string,
      and nothing forbids two addresses in one — `ops@x, oncall@x` passes the `includes('@')`
      check the template applies. The relay parses that into two envelope recipients; reject one
      and accept the other and `1 >= 1` holds. A message a real person received is reported a
      permanent failure, the fallback relay sends them a second copy, and with no fallback
      Delivery Health goes Down over an alarm that was delivered.

      nodemailer reports exactly who took it. The test stub did not — it returned
      `{ messageId, rejected }`, a shape the real client never sends — which is why the case was
      invisible. Tests: 1 new, and the stub now reports `accepted`. Mutation 1/1.

- [x] **P-166 — a chunked delta could half-land and claim it was current**
      `P-148` chunked the delta path. A delta was one message before that, so it arrived whole
      or not at all; chunked, it is N messages at one version — and the probe stamps its
      `#configVersion` on the first message it applies. A link that drops between chunks leaves
      it holding part of the change under a fingerprint that says it is current: it reconnects,
      the fingerprint matches, the core answers `config-unchanged`, and the rest is never sent.
      An operator pauses three thousand sensors, the probe goes on scanning two thousand of
      them, and nothing anywhere disagrees. `P-149`'s ack check cannot rescue it — the acks for
      the missing chunks never arrive, because the connection is what broke.

      `config-set` and `config-delta` carry `final` now, and the probe claims a version only on
      the message that completes the push. Absent means final, so an older core is unaffected;
      not claiming is what makes it recoverable, exactly as a failed apply already was. Tests: 2
      new. Mutation 2/2.

      **And it shipped broken for ten minutes, which is the part worth writing down.** The
      TypeScript union and the runtime schema are two declarations of one wire format, and only
      the first was widened — so the probe's own `parseCoreToProbe`, whose schemas are
      `additionalProperties: false`, refused every configuration message and closed the
      connection on a protocol violation, reconnected, and refused it again. The `P-148` failure
      exactly, by a different route. Every test passed, because `TestProbe` **cast** what it
      decoded instead of parsing it: a fake probe strictly more permissive than the real one, in
      the file whose whole subject is what the core puts on the wire. It parses now, and removing
      `final` from the schema turns six tests red.

- [x] **P-167 — four comments that had become false, and one contract that always was**
      Not defects in behaviour, and each one is a load-bearing sentence a reader would reason
      from.

      - `DependencySync` and `DependencyPauses` both say there is no periodic dependency
        recompute anywhere. `P-136` made `ScheduleSweep` call one every minute, in every
        installation. Corrected in both, and in the test comment that repeats it, without
        weakening the reason `object.created` still settles its own flags: a repair on the
        minute is not a schedule to wait for.
      - `MessageContext.priority` still said "1 (highest) to 5" — the exact sentence `P-137`
        corrected eighty lines below it, on the field the placeholder resolves from.
      - `tryGet`'s comment and the `P-139` entry both say the unknown kind made the tab answer
        500. `TriggerError` maps to a 400 `TRIGGER_INVALID`; the tab was equally unusable, but
        the diagnosis written down for the next reader was wrong.
      - `POST /schedules` and `ms:scheduleInput` promised that `polarity` says what the periods
        mean, with no qualification, while `P-127` had made a grid override it. A client written
        to the documented contract got the exact complement of what it asked for with a 201 on
        it. Refusing the combination was the other option and is the wrong one: a schedule
        stored as `inactive` periods is *served* as `polarity: 'inactive'` beside a grid of the
        hours it does monitor, so the round trip `P-127` exists for sends exactly that pair. The
        documentation is what was wrong.

- [x] **P-168 — `final` was added to the wire without a version, so every un-upgraded probe wedged**
      `P-166` widened two core→probe schemas and left `PROTOCOL_VERSION` at 15. The doc block ten
      lines above that constant states the rule it broke, in as many words: the bump is required
      by `additionalProperties: false`, not by the fields themselves, because a peer that does
      not know a field does not ignore it — it rejects the whole message with nothing to say why.
      An older probe receiving `final` threw `ProtocolError`, destroyed the socket, reconnected
      and received it again, for ever. Never scanning a sensor, and looking like a reconnect loop
      rather than a version skew. **That is verbatim the `P-148` wedge `P-166` was written to
      postmortem**, reached from the other side.

      Version 16, and the field is gated through `capabilitiesFor` — the registry that exists
      because these numbers used to be scattered as bare comparisons. Below it the core omits
      `final` and the probe keeps stamping on the first message, which is what `P-153`'s
      heartbeat reconciliation covers. Tests: 1 new. Mutation 1/1.

- [x] **P-169 — `backlog` does not mean what `P-157` used it for**
      `P-157` replaced a clock comparison with the probe's `backlog`, on the reasoning that only
      the probe knows whether it is replaying history. It does — but this is not that number.
      `SpoolDrain` computes `backlog = pending - batch.length`: rows still on disk *right now*.
      Every result goes through the spool, so a live probe whose scan tick outruns one batch
      reports thousands. At the dev stack's 5,047 sensors and a 500-row batch that is not an edge
      case, it is every tick: **the core was deferring live alarm reactions on a healthy
      installation**, which is the failure `P-157` was fixing, inverted.

      `sentAt` is the honest signal and it is new on the wire (protocol 16, gated the same way).
      Both it and `CheckResult.at` are the probe's own clock, so `sentAt - newest result` is a
      duration measured on one machine — seconds for a live batch, hours for a drain, right
      however far that machine's clock is from the core's, which is what `R17` was about.
      `backlog` goes back to pacing, which is what `R-03` added it for.

      **And the deferral is per source now.** `#deferredReactions` was one process-wide set and
      staleness was judged per *write* — but one write coalesces submissions from every connected
      probe, so the local probe, live by definition, emptied a draining remote's set and reacted
      over its hours-old rows. The storm `P-146` exists to prevent, restored for every
      installation with more than one probe. Tests: 3 rewritten or new. Mutation 3/3.

- [x] **P-170 — a parked threshold alarm was a one-way trip**
      `#park` nulls `next_due_at` so the sweep stops finding an alarm whose trigger this build
      cannot read, and its comment says the reaction resumes it when the trigger becomes readable
      again. True of a *state* alarm, which goes through `reconcile` and its `resume` branch.
      `reconcileThreshold` has no such branch — `#applyThreshold` says so thirty lines below the
      park — so the only branch a parked threshold alarm could reach was `hold`, which wrote
      `nextDueAt` back unchanged. Still null, never due, never notified; and when the value came
      back under its limit the row was cancelled and deleted, so the recovery was silent too. A
      disk fills, a page is owed, and neither the filling nor the emptying is ever said.

      The `hold` branch un-parks it: reaching there means `readThreshold` just succeeded, so the
      deadline is recomputed from the alarm's own `since`. Tests: 1 new. Mutation 1/1.

- [x] **P-171 — the cycle guard still erased both outages when both members were Down**
      `P-162` made each hold carry the ground it came from and refused a hold a sensor is its own
      reason for, which fixes a cycle with one member down. With **both** down, each is held by a
      ground that is the *other*, the guard never fires, and the pair went down → paused →
      unknown inside one transaction: two real outages erased, no alarm armed for either. Two
      devices either end of a WAN link, each watching the other, reach that state the moment the
      link dies — both fail in the same scan interval, so one batch carries both transitions.

      The cycle is named now rather than reasoned around: a node that reaches itself through the
      master chain is exempt from being paused, keeps its own state and its own alarm, and still
      *holds* whatever hangs off it. **The trade is deliberate**: an ill-formed cycle can now
      produce two alarms for what may be one outage, where before it produced none at all. A
      duplicate page is recoverable; an erased outage is not. Tests: 2 new, 1 changed to assert
      the new rule. Mutation 1/1.

- [x] **P-172 — "nobody is locked out by it" was not true of the UI shipped beside it**
      `P-154` defaulted `api.requireAuthentication` to on and justified it with the generated
      administrator password. That makes the *API* usable from first boot; `packages/web` has no
      login view, no password field and no 401 handling, so an install that serves the UI gets a
      page that loads and then fails every request it makes. `dev/core.json` was set to false and
      `deploy/examples/core.json` — the production example, with `webRoot` set — was not.

      The default stays on, and the reason is worth stating: false does not mean "authenticated
      principals may do everything", it means the API needs no principal at all, and shipping
      that as the default would put an unauthenticated monitoring system behind every reverse
      proxy that forwards to one. What changes is that the core now says so at startup when
      `webRoot` is set and this is on, because the silent version of that is an operator staring
      at an empty tree. `U-17` is the login view.

      **The warning is gone as of `U-17`**, which is what it was waiting for: the UI asks
      `GET /auth/session` before anything else and puts up a login form when the answer says one
      is needed. A warning that outlives the condition it describes is worse than no warning.

- [x] **P-173 — the sweep exemption swallowed the route the ticket was written for**
      `P-155`'s grantless sweep skipped `^/api/v1/(templates|schedules)(/|$)` as "routes whose
      subject is not in the object tree". That prefix also matches `POST /templates/:id/test` —
      the route `P-155` cites **twice** as the one the old harness could not see, and the reason
      nine services were wired into it — which now carries a per-object bar on the sensor it
      renders against. Wired in, then exempted from the only sweep whose principal can exercise
      it. The exemptions are named one at a time now: a list somebody has to justify adding to.
      Mutation 1/1 — deleting the bar turns the sweep red, which it did not before.

- [x] **P-174 — `G12`'s fix let a move overwrite an operator's own pause reason**
      `PAUSE_CAUSES_THIS_API_OWNS` is `['user','parent']`, the ownership set of the *pause* API,
      which genuinely applies manual pauses. A move applies none: the only flag it can change is
      `paused_by_parent`. Declaring `user` too meant a sensor paused by hand for "disk
      replacement", under a paused group, moved out of it, reported cause `user` with the message
      "moved under a paused parent" — `P-94` and `P-140`'s defect verbatim, on the caller their
      own fix had just touched. A move owns `parent` and nothing else. Tests: 1 new. Mutation 1/1.

- [x] **P-175 — a parked notification still drove Delivery Health down through `retrying`**
      `P-125` stopped a message waiting on purpose from counting as pending, and applied that to
      `pending` and `oldest_pending` and to neither `retrying` nor `oldest_retrying`. A request
      that failed once — the relay blinked — and was then held by its activation schedule left
      `pending`, arrived in `parked`, and went on counting as retrying. `retrying > 0` forces
      warning by itself and `oldest_retrying` drives `stalledMs` and therefore down: "a
      notification has been undeliverable for 400 minutes", all night, about a message an
      operator told the system to hold until morning. `P-160` widened its reach by defaulting the
      parked set from the activation service. Both columns carry the exclusion now. Tests: 1 new.
      Mutation 1/1.

- [x] **P-176 — the boot sweep reconciled one page, and the window that mattered was last**
      `P-161` made `PauseSweep.start()` sweep before arming. One sweep is one page of at most
      `batchSize`, and `startedIn` selects every pause *currently in force*, oldest `starts_at`
      first — so on an installation with a few hundred long-standing pauses the page is spent on
      windows already applied, while the one whose `starts_at` passed during the restart has the
      newest `starts_at` and is last. The probe endpoint then opened on flags that still said to
      scan the box being patched, which is the whole failure the await was added to close.
      `start()` drains until the page is not truncated, bounded at 100 pages with a warning if it
      is reached. Tests: 1 new. Mutation 1/1.

- [x] **P-177 — an arm lost to a restart was lost for good**
      The ingestor's deferred reactions live in memory, so a core that stops mid-drain drops
      them: the sensor is still Down, transitions in no later batch because its state does not
      change, and is armed by nothing — the exact hole `P-157` claims to close, reopened by a
      restart. Nothing else re-reconciled at boot.

      `main()` now reconciles standing alarms once at startup, through the same
      `reconcileSubtree` a trigger edit uses. It is state-based and idempotent — a sensor that is
      Down without an alarm gets one, a sensor whose alarm stands is held rather than re-armed —
      so it repairs every way an arm can be lost while the process is not running, not only the
      deferred ones. Not awaited before the port opens: the answer is the same a second later,
      and blocking every boot on a full-tree pass would be the wrong trade.

- [x] **P-178 — a protocol bump was a fleet-wide outage, and did not need to be**
      `isProtocolCompatible` refused a peer *above* this build as well as below it, on stated
      reasoning: the newer end knows messages this one has never seen, and treating its silence
      as agreement is how a skew becomes a data-loss bug. That was right when version numbers
      were compared inline at each send site. It stopped being right when `capabilitiesFor`
      became the only gate — the newer end now gates its own sends on the older end's version, so
      it cannot send a field the older one will refuse.

      Meanwhile the refusal was not clean, which is what made it worth changing rather than
      documenting. Bumping to 16 for `P-168`'s two optional fields would have taken **every
      deployed probe offline until the fleet caught up**: the probe refuses the welcome, destroys
      the socket and reconnects a minute later, for ever — while the core, which accepted the
      hello, opens a session, restores every sensor under that probe to its last reading,
      computes and sends a full configuration push, and is hung up on. Once a minute, per probe,
      with nothing scanned. Upgrading the probes first fails symmetrically at the old core's
      `describeSkew`. There was no working order, and nothing said so anywhere.

      Both ends negotiate down now: `negotiatedVersion` is the older of the two, computed
      independently at each end from the other's declared version, and every capability gate
      reads that number rather than `PROTOCOL_VERSION`. A peer ahead of this build is served what
      this build speaks and reported as `ahead` — a new skew kind, because `outdated` says the
      *peer* is behind and here it is this end, and an operator reading "cannot run discovery"
      about a probe newer than their core would look in the wrong place. Below
      `MIN_PROTOCOL_VERSION` is still a refusal: that is a floor, not a feature.

      **The rule `P-168` exists for is unchanged** — a new field still needs a version and a
      capability. What changes is that obeying it now costs one end at a time. Written up as
      **ADR-001 Decision 13**, because it reverses a rule whose rationale was stated in the
      source and the reversal turns on a fact about the code that has since changed.

      Tests: 8 new or rewritten across `capabilities.test.ts`, `messages.test.ts`,
      `probe-endpoint.test.ts`, `probe-registry.test.ts` and `probe-health.test.ts` — five of
      them existing tests that encoded the old policy, which is what a policy reversal should
      look like. Mutation 2/2.

- [x] **P-179 — a batch that decided nothing was read as "the drain is over"**
      `P-169`'s per-source staleness pass registered a submission's source in `sensorsBySource`
      *before* the `newestHere === 0` guard, and recorded a verdict in `staleBySource` after it.
      So a submission that decided no state was a member of the write with no verdict — and
      `liveSources` filtered on `!== true`, which reads "no verdict" as live. That flushed the
      probe's whole deferred set and reacted over rows the drain had written hours earlier,
      arming from a `since` six hours past.

      The trigger is the modal one, not an edge: a batch re-delivered after a lost `results-ack`
      is entirely duplicate, so `decide` skips every result and returns nothing — and a lost ack
      is exactly what the link flap that creates a spool does. The drain's own storm, out of its
      own repair.

      Fixed twice over, because the two halves are independent: membership is recorded only for a
      submission that decided something, and `liveSources` now requires an explicit `false`.
      Tests: 1 new — and it pins the *behaviour*, so either half alone satisfies it; it fails
      only against the original. **The first version of that test could not fail at all**: it
      used failed checks, which record no channel values, so the duplicate batch carried neither
      samples nor states and never reached the write. Mutation 1/1 (against both halves).

- [x] **P-180 — the field the replay guard rests on was never validated**
      `sentAt` is declared on the wire as a 1-64 character string, deliberately without
      `format: 'date-time'` because the validator runs without ajv-formats — where an unknown
      format is silently no validation at all. The consumer built a `Date` from it unchecked, so
      an unparseable value arrived as an Invalid Date. That is not `undefined`, so the documented
      "fall back to the core's clock" path could not fire: `against` became NaN, `NaN - newest >
      grace` is always false, and **the replay guard failed open permanently for that peer**,
      with nothing logged and `staleReactions` flat — indistinguishable from a healthy probe.

      Parsed and checked now, with an unreadable value counted as `discardedInvalidSentAt` and
      logged, falling back to the core's clock. Every other probe-supplied timestamp in this path
      was already checked and counted; this was the one that was not, and it was the one the
      whole of `P-169` rests on. Tests: 1 new. Mutation 1/1.

      Worth recording for the next reader: the obvious example of a bad timestamp,
      `2026-09-05 14:03:11`, is **not** this case — V8 parses it happily as local time. The
      failure needs a string `Date` genuinely cannot read, which is what the test now uses.

- [x] **P-181 — the boot reconciliation recreated the storm it was written to repair**
      `P-177` added a full-tree reconciliation at startup, to arm sensors whose alarm was lost to
      a restart. `chain.reconcile` arms with `initialDueAt(since, settings)` — armed from the
      state's own beginning, which is right for a trigger edit: an outage already an hour old is
      already past a five-minute latency. It is wrong at boot, and precisely for the population
      `P-177` targets, whose `since` is as old as the outage: *every* deadline computed from it —
      initial, escalation, repeat — is already past, so the sweep fires all three on consecutive
      passes, for an outage whose recovery may still be sitting in a probe's spool. The `P-146`
      storm, produced by the pass written to repair a missed alarm.

      `react` and `reconcileSubtree` take a `ReactionOptions` now, and the boot pass asks for
      `armFrom: 'now'`. The alarm still happens — the hole `P-177` closes stays closed — and it
      happens once, after its normal latency, by which time a drain has usually said whether the
      outage is still real. Tests: 1 new. Mutation 1/1.

- [x] **P-182 — the simulator's SSH host key was malformed one time in 256**
      Raised as a report rather than picked from the backlog, and there was no ticket for it.
      `TestSshServer.start()` generated a fresh ed25519 host key per server. About one key in 256
      comes out of `ssh2.utils.generateKeyPairSync` with a 31-byte public key inside the OpenSSH
      blob — a leading zero byte trimmed where the format keeps it — and `new ssh2.Server` throws
      `Cannot parse privateKey: Malformed OpenSSH private key`. The `before` hook throws and every
      test in `ssh-sensors.test.ts` fails at once, each named for an SSH sensor never reached.

      **Measured on an idle machine: 26 unparseable in 6,000** (0.43%, against 1/256 = 0.39% for
      "the first byte of the public key is zero"); the old `start()` reconstructed exactly threw 16
      times in 3,000. The report came in as load-dependent — red under `npm test --workspaces`,
      green 26/26 running the file alone — and it is not. It is a coin flipped once per key, and
      the sweep that measured it had the machine to itself. A whole-workspace run makes three
      draws, one host key per SSH test file plus one `keyPair()` in `ssh-session.test.ts`, so it
      reddens about 1.3% of the time; `ssh-sensors.test.ts` alone makes one draw, about 1 run in
      230. Twenty-six green single-file runs is what a 1-in-230 event looks like every time anybody
      has the patience to try it.

      `start()` defaults to a committed constant now, flagged in place as a fixture with no
      security value, so the throw is gone by construction rather than by luck. `keyPair()` still
      generates fresh — those tests want a key nothing else has seen — but sifts with `parseKey`
      and gives up loudly after sixteen. Five green whole-workspace runs, and they are **not** the
      evidence: five runs before this would have been green 94% of the time. Recorded in
      `docs/findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md` as that document's
      inverse — a test that failed for a reason unrelated to its subject.

## Phase 10 — Hardening and release

- [x] **H-01 — 24-hour soak test** · L · P-15, T-* · 5,000 sensors for 24 hours: no memory
      growth, no scheduler lag drift, rollups correct throughout.

      **H-01 outcome. All three hold, measured over 23.99 h at 5,047 sensors** —
      `docs/findings/2026-08-30-soak-24h.md`, with the raw samples and every rollup check beside
      it. Core RSS moved **+1.10 MB/h** on a 310 MB footprint and probe RSS **+0.68 MB/h** on
      1,790 MB, which is a quarter of one percent across the day. Scheduler lag p95 was 10.7 ms
      against `P-15`'s 1,000 ms budget with a slope of **−0.02 ms/h**. Rollups were verified every
      fifteen minutes against a recomputation of the rows beneath each bucket: **225 runs,
      13,694,541 bucket comparisons, zero disagreements**, across 7,544,624 readings written.

      **Three of the eight series first reported FAIL and none was a fault** — all three were the
      report's own thresholds, and each is a way to make a soak worthless. It compared the
      absolute slope, so a *draining* queue read as drift. It judged rollup lag against 1% of its
      own mean, forty times stricter than the channel's declared warning bound. And it gave
      `checks waiting`, whose mean is 0.08, a budget of 0.001/h — a threshold no measurement
      clears, on a series that was non-zero in five samples out of 1,439 and spent its whole last
      quarter at zero. Checks are one-sided now, judged against declared limits where a channel
      has them (`S-18`), and a slope only counts as drift if the run also ended higher than it
      started. Each relaxation was checked against a synthetic leak rather than assumed: 60 MB/h
      still fails, and a rollup lag climbing 200 s/h still fails.

      **The harness could not say what it had measured**: every sample recorded `sensorCount:
      null`, because it asked a keyset-paginated endpoint for a `total` it does not return. The
      load was in the data all along as the probe's `scheduled` channel.

      **`P-26` came out of the run** — the check pool grew to 48 workers during provisioning and
      shrank zero times in 24 hours at 0–3% usage, because its idle clock resets on every submit
      and a probe watching 5,000 sensors never goes a minute without one. That is also the whole
      of the probe's 1,790 MB, and it is flat, so it is headroom rather than a leak — but it is
      set by the worst burst the probe ever saw.

      **Harness landed; the 24 hours are running.** `scripts/soak.sh` provisions 5,000 `port.tcp`
      sensors, samples the installation's own Core Health and Probe Health once a minute, checks
      every settled rollup bucket against a fresh aggregate of the rows beneath it every fifteen,
      and reports a verdict on the slope rather than the maximum — a run that ended at 400 MB says
      nothing, one that rose 4 MB an hour for a day says it falls over in a fortnight. The first
      fifteen minutes are dropped as warm-up and a window under an hour reports no verdict at all,
      because a per-hour slope fitted to five minutes is extrapolation.

      **Building it found a defect that silently stopped all result delivery.** A probe that had
      drained its spool to empty stopped delivering for ever the next time it rolled a segment:
      `peek` returned an empty batch while the spool reported thousands pending, the drain read
      that as "no work", and readings accumulated on disk until the spool cap began dropping them
      — link up, nothing logged, nothing counted. The dev stack had 30,193 results stranded and no
      probe-executed sensor had stored a reading in hours; only the core-evaluated types had any.
      Fixed in `615c9f3`, with the sequence reproduced as a test, and `92ec56a` makes the drain
      notice when it is making no progress so that the next one of these cannot be silent.
- [x] **H-02 — Failure-mode verification** · L · H-01 · Every row of `WORKFLOW.MD §13` tested:
      core restart, DB loss, probe loss, delivery failure, hung check, scheduler lag, disk full,
      clock jump.

      **H-02 outcome. Five rows hold and are proved; two were proved only in pieces and now have
      a scenario; one is not implemented.** The audit is
      `docs/findings/2026-08-29-failure-modes.md`, row by row, naming the test that proves each
      claim — because "we tested the failure modes" is exactly the kind of statement that decays
      into folklore unless it says which test.

      Held already, and better than expected: probe loss (`probe-offline.test.ts`, thirteen tests
      including Unknown-not-Down and one transition per sensor rather than two), delivery failure
      (`notification-health.test.ts`, including the distinction between a retryable failure and a
      rejection no waiting fixes), the hung check (`check-pool.test.ts` terminates and replaces
      the worker, and reports the timeout at the deadline rather than when the check notices),
      and the clock jump (`timing-wheel.test.ts` ignores a wall-clock step **and says it saw
      one**). Restart and database loss each had every part covered and the sentence not.

      New: `packages/core/test/failure-modes.test.ts`, 8 tests. The restart half asserts what
      replay actually rests on — that a batch offered three times across two ingestor lifetimes
      is stored once — plus a pause found by a service built from nothing. The database half runs
      against a wrapper that can be taken away and given back: nacks while it is gone, nothing
      written, an overlapping replay after, and the distinct count. The test worth naming is the
      last: **a batch accepted into the queue and then hit by the outage still comes back as a
      nack**, because `submit` resolves at the commit and not at the enqueue. Resolving early
      would have a probe drop from its spool a batch the core never wrote, and nothing anywhere
      would say so.

      **Two gaps found, both filed rather than folded in.** `S-17`: nothing knows how full the
      disk is — row 7 is not untested, it is absent, and a full disk today is discovered when
      ingestion stops. `S-18`: the health sensors ship with no thresholds, so a fresh install
      alarms on none of its own numbers; that is what makes rows 6 and 7 say "warns" where the
      system only "records".

      Mutation 4/4 against the ingestor, which is the right check for a ticket whose deliverable
      is tests: break the behaviour, see whether the new tests bite. **One did not, at first.**
      Removing `ON CONFLICT DO NOTHING` was killed by the *second* restart test and not the
      first, because without it the replay does not duplicate — it errors on the unique index,
      leaving the row count right and the probe unable to clear its spool. The first test now
      asserts the replay was **accepted** as well as counted, and dies on its own mutant.

      What this is not: the soak. Rows 6 and 7 are verified against forced conditions, which
      proves the behaviour and not the sizing — the numbers want `H-01` behind them.
- [x] **H-03 — Upgrade and migration path** · L · S-01 · Schema migration with rollback, config
      backup before upgrade, version-skew handling between core and probes.

      **H-03 outcome. Two of the three held; the middle one did not exist, and the first had a
      hole exactly where an upgrade goes wrong.**

      *Schema migration with rollback* held. Every migration ships a `down`, `migrator.test.ts`
      applies the real set forward and all the way back, and drift and newer-than-this-build were
      already refused by `migrate up`. **The hole was start-up.** With `autoMigrate: false` the
      core only counted *pending* migrations — and a build older than its database has none, the
      schema being past it rather than before it, so a **downgrade started happily against tables
      it was never written for**. That is the likeliest of the three in practice: rolling back a
      bad upgrade is what an operator does at 3 a.m. `refuseSchema` now knows all three shapes,
      and reports the downgrade *before* the pending count, because "run migrate up" is the first
      thing anybody would try and is wrong for a mismatched pair — `migrate up` refuses it too, so
      the advice would send them round the loop. That ordering was found by writing the test's
      comment honestly and noticing it contradicted the code.

      *Config backup before upgrade* did not exist. `install.sh` never clobbered a configuration,
      which is right, and that is exactly what leaves a new binary reading a file written for an
      old one: a setting renamed or made required is discovered when the service fails to start —
      after the old one has been stopped, with the answer in `journalctl` rather than in front of
      whoever ran the installer. So: a timestamped `.bak` (0600, root) before anything touches
      `/etc/ms`, and a new `config check` verb that validates a file against *this* build without
      connecting to anything. `install.sh` runs it for every service **before it restarts
      anything**, and refuses — leaving the installation up on the previous version — rather than
      taking it down to report a typo.

      `config check` lives in `@ms/shared`, not the core, because `ms-probe` had **no
      command-line verbs at all**: `ms-probe config check` would have started a second probe on a
      host that already had one.

      *Version skew* held, and needed nothing. `MIN_PROTOCOL_VERSION`, the `incompatible` verdict
      distinguishing "too old" from "newer than this build", the capability gates and Probe
      Health's skew channel were all in place and tested.

      **Found by running the smoke test, which had been red and unnoticed.** Two of its
      assertions were wrong. `grep -q` in a pipeline under `set -o pipefail` reports *failure on a
      match*: grep exits at the first hit, the producer takes SIGPIPE and returns 141, and
      `pipefail` propagates it — so "housekeeping pass complete" was in the journal and the
      assertion said it was not. And "the probe was told what to scan" had been wrong since
      `R-01`: a fresh install's probe is registered pending and given nothing until approved,
      which is what `smoke-enrol.sh` exists to prove. Both fixed. `smoke-install.sh` also built
      its tarball with the host's `npm` when one was present — and a host `npm` can be present
      and wrong, which is what failed here minutes into a run that looked healthy.

      Tests: 8 in `config-check.test.ts`, 5 in `schema-gate.test.ts`, 2 in `cli-args.test.ts`,
      and 4 new assertions in `smoke-install.sh` — configuration kept and backed up at 0600 root,
      `config check` accepting what the services run on, an installer re-run refusing a broken
      configuration **with both services still active**, and the schema gate refusing a core
      older than its database. The whole smoke test passes end to end.

      Moving `config check` into `@ms/shared` left its compiled output behind in the core's
      `dist`, and `build-hygiene.test.ts` failed on exactly that — the trap `A-09` documented,
      caught by the test written for it.
- [x] **H-04 — Backup and restore procedure** · M · H-03 · Documented and tested end to end,
      including a restore onto a clean host.

      **H-04 outcome.** `ms-backup` and `ms-restore` in `bin` — not beside the installer, because
      they are run for the life of an installation, long after the unpacked tarball is gone, and a
      procedure whose first step is "find the release you installed from" is one nobody runs.
      The runbook is `docs/runbook-backup-restore.md`.

      **"Onto a clean host" is the whole ticket, and it is the reason the test is two containers.**
      Restoring over the installation a backup came from proves almost nothing: the data is
      already there, the vault key is already there, the certificates are already there, and a
      restore that quietly did nothing would pass. `scripts/smoke-restore.sh` installs onto a
      second box that has never seen the first one, restores, starts the service, and asserts the
      object tree by id, 500 readings unchanged, and the credential by **both** of its inputs —
      the vault key and the stored ciphertext, each byte-identical. That pair yielding the
      plaintext is the vault's own property (`vault-crypto.test.ts`); what a *backup* gets wrong
      is losing or substituting one of them.

      **The archive holds the vault key, and that is not optional.** Without it a restore produces
      a system that cannot log in to anything it monitors, unrecoverably. It also makes the
      archive equivalent to the plaintext of every stored credential — 0600, and the runbook says
      where it belongs. What is deliberately *not* in it: the probe's result spool, which is a
      queue rather than data and would replay readings a rebuilt machine never took; and
      `/opt/ms`, which comes from the release tarball and whose restore over a newer install is a
      downgrade nobody asked for.

      **Writing the test found three real defects, in the order a hand-rolled restore hits them.**
      All three are TimescaleDB, and all three produce a database that looks restored:
      `COMMENT ON EXTENSION` aborts a `--exit-on-error` restore hundreds of tables in, because
      only the extension's owner may set it; hypertable chunks come back as **ordinary tables**
      unless `timescaledb_pre_restore()` ran first, which needs a superuser; and the dump COPYs
      into `_timescaledb_catalog`, where the application's role has no rights, because on the
      original machine the extension wrote those rows with its own privileges. `ms-restore`
      filters the extension out of the archive's table of contents, tries the application role
      then a local `postgres` for restore mode and refuses with the exact statements to run by
      hand if neither works, and grants the catalog rights for the restore — which gives the role
      nothing it did not already have, and keeps the restored objects owned by the application
      rather than by `postgres`.

      Also asserted: the archive is 0600, and a restore **refuses while ms-core is active** —
      restoring under a live core would have it writing into a database being replaced beneath
      it. Both smoke tests are wired into CI, which is **disabled at the moment** — they were
      last run by hand on 2026-09-03 and passed.

      One of `S-17`'s own tests turned out to be flaky and was fixed here: it compared the
      watcher's `statfs` with its own, taken a moment later on a live filesystem, and the free
      block count moves between them. It now compares against the *reserve*, which is a
      percentage of the disk where the drift is kilobytes — and still kills the `bfree` mutant.
- [x] **H-05 — Linux installers** · M · F-07 · `.deb` and `.rpm` in addition to the tarball, with
      upgrade paths.

      **H-05 outcome.** `scripts/package-deb.sh` and `scripts/package-rpm.sh`, both packaging the
      tree `package.sh` already staged rather than building a second time, so the three artefacts
      are the same bits by construction. Neither ships `/etc/ms/*.json`: configuration is created
      by the installer and never overwritten, so shipping it as a conffile would put dpkg's merge
      prompt in front of an operator for a file the installer already knows to leave alone.

      **The real work was `deploy/setup.sh`.** `install.sh` had grown the service users, the PKI,
      the access key, the config-preservation rule and the `config check` gate inline — and a
      `postinst` and a `%post` each need all of it. Three copies would have meant the one nobody
      smoke-tests being the one that is wrong, so it is now one script that all three installers
      run, and `install.sh` is reduced to placing files and calling it.

      **Two defects found by running it.** rpm gives a scriptlet
      `/sbin:/bin:/usr/sbin:/usr/bin` and nothing more, while dpkg follows Debian policy and adds
      `/usr/local/*` — so the identical setup script found Node under dpkg and failed under rpm.
      That is the normal case, not an edge one: no enterprise distribution ships a Node this new,
      so the one an operator installs comes from the official tarball and lands in `/usr/local`.
      Separately, `chmod` from a container onto a macOS bind mount does not persist, so rpm was
      silently stripping the executable bit off every document in the payload; `rpmbuild` now
      works in the container's own filesystem, which is also faster.

      **And a pre-existing one: CI's `shellcheck` step has been failing since `H-04`.**
      `backup.sh` and `restore.sh` read their connection settings through an `eval`, which
      shellcheck cannot follow, and eight `SC2154` warnings had been red since they landed.

      `scripts/smoke-packages.sh` installs, upgrades in place and removes each package on a real
      systemd — Debian for the `.deb`, Rocky for the `.rpm` — asserting the configuration, the CA
      and the access key survive, a 0600 backup and a `.json.new` appear, and the units are still
      enabled afterwards. That last one is the rpm trap: `%preun` runs for the old package *after*
      the new one is installed, so a scriptlet written like a dpkg `prerm` disables the service on
      every upgrade and nothing reports it. Mutating the guard away fails the test, as does
      mutating the config-preservation rule.

      **Not covered, and deliberately: the package tests do not start the services.** TimescaleDB
      publishes no aarch64 RPMs for EL9 — the repository exists and is empty — so a Rocky box with
      a working database cannot be built on an arm64 machine at all, and a test that only ran on
      x86_64 would be a test that did not run. What a *package* owns is files, users, PKI and
      scriptlet semantics; that the services then reach `active` is `smoke-install.sh`, and since
      all three installers now run the same `ms-setup`, proving it there proves it everywhere.
- [ ] **H-06 — Windows MSI** · L · F-06 · Installer with service registration, firewall rules and
      an upgrade path.

      **Built, structurally verified, and not installed.** `scripts/package-msi.sh` produces
      `ms-<version>-x64.msi` and `ms-probe-<version>-x64.msi` with `wixl` — msitools' WiX
      compiler, which runs on Linux, so the MSI comes off the same staged tree as the tarball,
      the `.deb` and the `.rpm`. `deploy/windows/ms-setup.ps1` is the Windows counterpart of
      `setup.sh` and does what H-06 asks for: registers the WinSW services, **opens the firewall
      for the two ports the core actually listens on, read from the configuration rather than
      hardcoded**, keeps an existing configuration with a timestamped backup, and runs
      `config check` before restarting anything. `ms-teardown.ps1` is the uninstall half and
      leaves ProgramData alone, for the reason the Linux packages leave `/etc/ms` alone.

      **What is not done is the half that needs Windows**: nothing here has installed the MSI.
      Service registration, the firewall rules, the upgrade path and the uninstall all execute on
      Windows and are unproven. The build prints that in place of a success message, and this
      ticket stays open for it.

      **But "needs hardware nobody has" was wrong, and that mattered.** `windows-latest` on GitHub
      Actions *is* Windows Server 2022 — the missing thing was a job, not a machine. CI now has a
      `windows-install` job that downloads the MSI the Linux job built, installs it with
      `msiexec /qn`, and asserts what H-06 actually asks for: the files land and `app.zip` was
      expanded (which is the proof the custom action ran at all), both services registered, both
      firewall rules exist, an upgrade over it keeps an edited configuration and leaves a backup,
      and an uninstall removes the services while leaving ProgramData. The three `msiexec` logs
      are uploaded whatever happens, because the first failure on a machine nobody has tested is
      exactly when the log *is* the finding.

      It also parse-checks every `.ps1`. A parse error in `ms-setup.ps1` would break every Windows
      install, and for a while nothing anywhere would have caught it: PowerShell publishes no arm64
      container, the amd64 one dies under QEMU on an Apple Silicon machine, and the `dotnet tool`
      package is broken — three routes tried, all dead.

      **A fourth route works, and the check no longer depends on this job** (`P-53`). `P-51` put
      the official `linux-arm64` PowerShell tarball in the toolchain image, so the parse check runs
      in the ordinary test suite on every machine, disabled CI or not. All three scripts parse.
      That is not this job's other assertions — installing, the services, the firewall, the upgrade
      — which still need Windows and still keep this ticket open.

      **The job has never run**, because CI is disabled at the operator's request. Tick H-06 when
      it goes green, not before.

      Three things the build taught, all recorded in the script:

      - **wixl segfaults above about ten thousand components** (a hundred compile instantly), so
        the application ships as one `app.zip` that `ms-setup.ps1` expands. The cost is named:
        Windows Installer no longer tracks the application file by file, so its repair cannot
        restore one file and the teardown script removes the tree instead.
      - **wixl drops a custom action it cannot compile and still writes an MSI, with exit status
        zero.** A `Directory`-form action produced a GLib assertion on stderr and a package that
        installs files and registers nothing — the exact shape of a defect that ships. The build
        now asserts both actions exist and are sequenced, and fails if either is missing;
        `Property` is the form wixl implements, `Directory` and `BinaryKey` are not.
      - **Backticks in an interpolating heredoc are command substitution**, which is how a
        prose comment mentioning `Directory` became "command not found" mid-build.
- [x] **H-07 — Documentation set** · L · — · Installation, administration, sensor reference,
      API reference generated from OpenAPI, troubleshooting runbook.

      **H-07 outcome.** Five documents: `installation.md`, `administration.md`,
      `troubleshooting.md` hand-written, and `sensor-reference.md` and `api-reference.md`
      generated — from the catalogue and from the OpenAPI document respectively, with
      `--check` modes that `build-hygiene.test.ts` runs. A hand-written reference is correct on
      the day it is written and silently wrong from then on, so the two that can be derived are
      derived, and the build goes red when they drift.

      **Writing the generators found four defects, all in the API surface rather than the
      prose.** 36 of 68 routes carried no OpenAPI tag, so a generated client had a third of the
      API in one unnamed bucket — now tagged, and 22 groups instead of 9. Ten route modules
      register only when an optional service is passed, so the first generator silently produced
      a reference missing a third of the routes; the completeness guard that catches that is
      derived from `server.ts` rather than from a list, so a route group added later cannot go
      quietly undocumented. `/metrics` was missing for the same reason and had no schema at all —
      found by diffing the generated page against a **running** core, which the module scan could
      not have caught because that route is declared inline. And `@fastify/websocket` sets
      `schema.hide = true` on every websocket route unconditionally, so `/api/v1/stream` can
      never reach the OpenAPI document; it is now recovered from the router and documented.

      Verified against the running dev stack: 119 live routes and 21 live tags match the
      reference exactly, plus the one deliberate addition (`/api/v1/stream`); all 43 sensor
      types, every parameter, and every `writeOnly` marker match the live catalogue. The sizing
      section cites the measured figures rather than inventing any — CPU and RAM guidance stays
      absent until `H-08`, which is honest rather than helpful-sounding.
- [x] **H-08 — Published sizing guidance** · M · H-01 · Measured numbers per hardware tier, not
      estimates.

      **H-08 outcome.** `docs/sizing.md` is the guidance and
      `docs/findings/2026-09-03-sizing.md` is the measurement behind it — a 15-point sweep,
      {2, 4, 8} cores × {100, 500, 1000, 2500, 5000} sensors, run in containers given real
      `--cpus` limits at the pool settings the release ships. Raw data committed as
      `2026-09-03-sizing-sweep.jsonl`.

      **Cores are not the constraint, and that is the headline.** At 5,000 sensors the p95
      dispatch jitter was **208.5 ms on two cores, 212.3 on four and 208.6 on eight** — the tiers
      are indistinguishable and every one is a fifth of `P-15`'s 1,000 ms budget, with nothing
      deferred or refused anywhere in the sweep. A check waits for a packet, not for a core, so
      sizing a probe by core count sizes it by the wrong number.

      **What does constrain it is the per-tick burst**, and the sweep produced a rule rather than
      a table: the wheel fires per-second buckets, so `burst = sensors / interval`,
      `rounds = ceil(burst / workers)`, and `jitter ≈ (rounds − 1) × checkMs`. That predicted all
      fifteen points — within 12 ms where it predicts 200 ms, and 6–18 ms of wheel overhead where
      it predicts zero. It also says the thing a table cannot: **the check duration is the
      multiplier, not the sensor count**. **Corrected by `P-33`:** that rule bounds the jitter of
      one burst and omits Little's floor, `workers ≥ burst × check duration`, below which the
      backlog grows for as long as the probe runs and nothing is refused. Every number it gave on
      its own was low — 5,000 HTTP sensors at 2 s need **167** workers rather than 83, and 5,000
      pings at their real 600 ms need **50** rather than 14, which is above the shipped ceiling
      of 48 (`P-32`).

      **Memory was the pool ceiling rather than the workload** — 500 sensors need 1.7 workers and
      reached 27 — which is what the sweep turned `P-26` into a measured ticket for. Since it
      landed, the pool tracks the burst below the ceiling (14 workers and 216 MB at 500 sensors,
      24 and 312 MB at 1,000) and pins at 48 only above 2,500, where the burst genuinely exceeds
      it. `sizing.md` now sizes memory from the burst and treats `workerPoolSize` as the cap it
      is.

      **The benchmark's RSS is not a probe's.** It loads a fixture registry; a real probe loads
      the sensor catalogue into every worker — 12 MB a worker here against 35 MB in `H-01`'s
      soak, 578 MB against 1,790 MB at the same 48 workers. The guidance uses the soak's figure
      and says why.

      Not measured, and said so on the page rather than estimated: x86, more than one probe
      against a core, remote probes over a real network, `exe.script` sensors that genuinely
      compute, and Windows.
- [ ] **H-09 — Release candidate field test** · L · H-01…H-07 · Clean installs on Ubuntu and
      Windows Server monitoring 100 real devices for a week without intervention.

      **The Ubuntu half of the first clause is done.** It is wired into CI, which is disabled;
      last run by hand on 2026-09-03 and passing. `smoke-install.sh` now takes
      `MS_SMOKE_DISTRO=ubuntu` and runs against an Ubuntu 24.04 box with PostgreSQL 17 from PGDG
      and TimescaleDB from packagecloud's `ubuntu` repository — services reach active, an upgrade
      keeps the configuration, both refusal gates hold and both services stop with exit 0.
      Proving Debian and assuming Ubuntu would have been assuming the half that differs: different
      PostgreSQL packaging, different TimescaleDB repository.

      **The rest needs hardware and a week**, and the procedure for it is
      `docs/runbook-field-test.md` — written now rather than at the time, because a test that has
      to be designed before it can be run is a test that gets run badly. It says what is already
      proved so it is not re-proved, what to install and keep the log of, which channels to put
      triggers on (all of which have declared limits from `S-18`, so only delivery needs adding),
      what to record at start / 24 h / end, and what counts as a failure.

      **Step 2 of that runbook is "restart everything, once, before you start counting", and it
      is there because of `P-28`.** A probe at the v1 target could never reconnect — the core sent
      a configuration too large for one message and the probe looped, 426 closures in three
      minutes, with the core logging only "link to core closed". Twenty-four hours of soak with
      the same 5,047 sensors never saw it, because the probe never restarted. Anything that only
      breaks on restart is invisible to every other test here.

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
- **V2-17** One session pool for every transport — the shared half of the SNMP and SSH session pools (was `P-24`; its third caller is `V2-08`). Full record below.

---

### V2-17 — One session pool for every transport

`support/snmp/pool.ts` and
      `support/ssh/pool.ts` share their lease counting, idle eviction, LRU room-making and
unref'd sweeper, and differ in async open, in-flight sharing and liveness checking.
**Added by `T-07`:** extracting it at two instances would have guessed which half varies;
`T-09`'s WinRM transport is the third and the point at which the shape is known. **`T-09`
landed and is not a third instance** — it is a shell-out with no session to keep, so the two
pools are still two and this ticket's trigger never fired. Whoever picks it up decides on
that basis: either two instances are enough to see the shape, or this waits for a third
transport — which is `V2-08`, and therefore v2. See the re-check below. Keep the SNMP pool's synchronous `acquire` working or update its 21 tests
deliberately, not incidentally.

**Decided 2026-09-03: wait for `D-05`, and here is the evidence so nobody re-derives it.**
The shape *is* now visible without a third instance — the two pools differ on exactly one
axis, `open`: SNMP's is synchronous, SSH's is `async` with in-flight sharing (`#opening`),
a liveness check and an `#attach` step. Everything else is shared, and it is not
approximately shared:

| Method | Difference |
| --- | --- |
| `sweep()` | **byte-identical** but for `sessions` / `connections` |
| `#makeRoom()` | byte-identical but for the same rename and one word of prose |
| `#lease`, `#startSweeping`, `#stopSweeping`, `stats()`, `closeAll()` | same |

**And that is the argument for waiting rather than against it.** Byte-identical after
months means the duplication has cost nothing — no fix has landed in one and missed the
other, which is the failure extraction prevents. Against that: the shared code is
credential-keyed session handling, the stat names `sessions` and `connections` are not
interchangeable prose, and a third transport is the instance that would say whether the
varying half is "async open" or something wider. Refactoring working, tested, undrifted code
in that area for tidiness alone is a bad trade; refactoring it when a third caller forces the
shape is a good one.

**The re-check this ticket asked for has been done, and its trigger was pointing at the wrong
thing** (2026-09-04). It said "re-check the diff when `D-05` lands", and named "`D-05`'s
VMware transport" as the third instance. `D-05` is *Default master dependency*; it landed and
has no transport in it. Virtualisation sensors are **`V2-08`**, which is v2 — so the third
caller this ticket waits for **cannot arrive in v1**, and the instruction to re-check had
silently come due without anyone noticing, because it named a ticket that was never about
what it claimed.

**The re-check itself says: still no drift.** Neither `support/snmp/pool.ts` nor
`support/ssh/pool.ts` has been touched since 2026-08-27 — nine days, one commit each, the
ones that created them — and the only difference in their method sets remains SNMP's
`acquire` against SSH's `#attach`. So the "waiting has cost nothing" argument holds on its
own evidence; what has changed is that waiting now means waiting for v2.

**Moved here on 2026-09-04, by the operator's decision**, of the two options this ticket had
narrowed itself to: extract at two instances and accept the guess `P-19` warns about, or follow
the trigger to where it actually lives. The trigger is a third transport, the third transport is
`V2-08`, and the two now sit in the same backlog — which is the point, since the extraction is a
good trade exactly when that third caller forces the shape and a bad one until then.

**It keeps the name `P-24` as well as its new one.** `P-36`, `T-01`, `T-07`, `T-09`, `T-20`,
`P-54` and a comment in `support/windows/powershell.ts` all cite it by that name; renumbering live
cross-references in order to record a scope move would trade one kind of staleness for another.

**Whoever picks this up starts by re-running the diff above.** It was byte-identical on
2026-08-27 and again on 2026-09-04. If the two have drifted by then, that changes the answer on
its own and the argument for waiting is void.
