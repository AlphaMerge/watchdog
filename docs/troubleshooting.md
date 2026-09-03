# Troubleshooting

Symptoms, in roughly the order they come up. Most of what follows is a pointer to a number the
system already publishes about itself — the fastest diagnosis here is usually Core Health or
Probe Health, not a log.

```bash
journalctl -u ms-core -u ms-probe -f
sudo /opt/ms/bin/ms-core config check
sudo /opt/ms/bin/ms-core migrate status
```

Logs are structured JSON with a correlation id on every request and every check execution. When
you have one id, `journalctl … | grep <id>` gives you the whole story of that one thing.

---

## The core will not start

Read the reason before doing anything — the refusals are deliberate and each has one correct
remedy.

**"the database has N migration(s) this build does not know"** — the database was migrated by a
newer `ms-core`. Install the matching release. Do not migrate backwards; the refusal is what
stops a newer schema from being written by an older build that misunderstands it. A backup taken
before that upgrade is the other way out.

**"N schema migration(s) are pending and autoMigrate is off"** — run `ms-core migrate up`.

**"N applied migration(s) no longer match this build"** — the schema and the record of it
disagree, so neither applying nor rolling back is safe. This means a migration file changed after
it was applied, or two builds were mixed. Restore from a backup rather than guessing.

**A configuration error** — `config check` reports *every* problem in the file, not the first, so
one pass gives the whole list. If the service started before the last upgrade and does not now,
the release's own example is at `/etc/ms/core.json.new` and the pre-upgrade copy is the
timestamped `.bak` beside it.

**The port is in use** — `api.port` defaults to 8080 and `probeEndpoint.port` to 23560, and they
are separate listeners.

---

## A sensor is Down and the device is fine

Read the sensor's message. Errors here carry the sensor id, the target, **the phase the check
failed in**, and the underlying error, because "ETIMEDOUT" alone is not a diagnosis.

- **Down at the connect phase** — routing, a firewall, or the wrong port.
- **Down at the authenticate phase** — the credential. It is inherited, so check which ancestor
  actually supplies it: `GET /objects/:id/settings` names the source. Changing it on the device
  and not in the tree is the common one.
- **Down at the parse phase** — the device answered with something the type did not expect. For
  types with a mapping language, paste a real response into the sensor form's preview and see
  what each path selects, without waiting for a scan.
- **Timed out** — the timeout is a parameter on almost every type, and a filtered port takes the
  full timeout every scan.

## A sensor is Unknown, not Down

Unknown means the system does not know, and it will not claim otherwise. The usual cause is a
**lost probe**: saying Down would be a claim about the target that nothing supports. Check
`ms.probe.health` for that probe — `connected` and `heartbeatAge`.

## A sensor will not resume after being un-paused

**Four independent pause sources hold an object**: manual, schedule, dependency, and any ancestor
being paused. They are a set, not a chain, so clearing the one being reported does not necessarily
release it.

`GET /objects/:id/pause` returns **`pausedBy`**, which lists all of them. That is the field to
read. A parent pause is the one most often missed, because nothing about the child looks paused
except its state.

---

## Graphs have gaps

**That is correct behaviour and it is deliberate.** A Down sensor records no channel values, and
those gaps survive storage, rollup, query and rendering as gaps. A line that dropped to zero
would be asserting a measurement nobody took — "no data" and "zero" are different facts, and a
graph that conflates them makes an outage look like a reading of nothing.

Uptime and SLA are computed from state history, not from samples, so they stay correct across
those gaps and across rollups.

## Graphs are wrong only at wide time ranges

Rollups are behind. Check `rollupLag` on Core Health — it warns at an hour and errors at a day.
Wide ranges read rolled-up tiers; narrow ones read raw samples, which is why the discrepancy only
shows at one end.

## Old data disappeared earlier than retention says

Check **`evictedChunks`** on Core Health. Anything above zero means the housekeeper evicted the
oldest raw chunks early because free disk space fell below the reserve, and it is an error
threshold precisely so that this is never discovered from a graph. The system chose losing the
oldest data over a database that stops accepting writes; both are bad, and it tells you which one
happened. **The remedy is disk, not configuration.**

`diskFree` errors below 10% and warns below 20%. If the database is on another host, the core
reports nothing for these rather than a number it cannot measure.

---

## Readings stop arriving

Work through these in order — each is a number, not a guess.

1. **`probesDown` on Core Health.** A probe that is not connected is not checking anything.
2. **`ingestQueue` on Core Health.** Warns at 40,000, errors at 100,000. Readings are arriving
   faster than they are being written — look at `writeLatency` and at the database.
3. **`spoolDepth` and `spoolBytes` on Probe Health.** The probe cannot reach the core and is
   spooling to its own disk. It replays when the link comes back, rate-limited so the catch-up
   does not itself become the outage.
4. **`spoolStalled` on Probe Health.** Above zero means the core is reachable and the spool is
   *not moving* — which depth alone cannot tell you, because a deep spool is also what a probe
   replaying an outage looks like. This is the channel for the case where the link is healthy and
   delivery has stopped anyway.
5. **`spoolDropped` on Probe Health.** Above zero means the spool filled and results were lost.
   That is data gone, and the error threshold is there so it is never silent.

**A database outage does not kill the core.** A write failure is reported and counted, and the
probe is told to retry rather than being acknowledged — so the readings queue at the probe rather
than evaporating. Core Health fails with a message and no channel values while it cannot read,
which is the honest answer rather than a reading of zero.

## Checks are running late

`schedulerLag` on Probe Health, which warns at 1 s and errors at 5 s. Then:

- **`poolUsage`** — the worker pool. Warns at 80%. **It is an instantaneous gauge, not a duty
  cycle**, so on a bursty workload it reads far lower than the pool's real use: measured on a probe
  whose 84-checks-a-second burst saturates all 64 workers for about 20 ms in every second, it
  reported **4.7%** (`findings/2026-09-04-live-probe-check.md`). A low reading is not evidence of a
  pool that can be shrunk. `checkWait` is the number that does not lie about a burst.
- **`deferred`** — checks the pool could not start. Backpressure is counted and surfaced, never
  silently dropped, and this is where it surfaces.
- **`queued`** and **`checkWait`** — how deep the queue is and how long a check waits for a
  worker.

The remedies are a bigger pool, fewer sensors per probe, longer intervals, or another probe.
Nothing blocks the scheduler itself — every check runs in a worker or a child process with a
timeout and an abort signal — so lag is saturation, not a stuck check.

### Check the pool against the arithmetic before you move sensors

**Lag with `deferred` and `refused` both at zero is the case that misleads.** It reads as "the
pool is coping, so the problem is elsewhere", and it is the opposite: a pool that cannot keep up
does not shed work and raise a counter, it accumulates. Nothing is refused while the queue still
has room, so the only symptom is that checks start later and later.

The arithmetic that decides it, from `docs/sizing.md`:

    burst         = sensors ÷ interval in seconds
    workers needed = burst × check duration in seconds

If the pool is under that, no amount of tolerance helps and the lag climbs for as long as the
probe runs. **The tell is `checkWait`**: a p95 in seconds, growing between readings, on a probe
that is refusing nothing.

Since `P-34` the probe works this out for itself — it measures what each sensor type costs and
moves its own ceiling — so the two cases where you have to intervene are:

- **`workerPoolSize` is set to a non-zero value.** That fixes the ceiling and turns self-sizing
  off, deliberately, because the setting is a statement about memory. Raise it or set it to 0.
- **The workload needs more than a probe will derive on its own** (256 workers). The probe logs
  `workload needs more workers than a probe may derive for itself` with the number it wanted.
  Set `workerPoolSize` explicitly, and check the box has the memory: about 35 MB a worker.

A worked case: 5,000 `icmp.ping` sensors on a 60-second interval is a burst of 83 a second, and
a ping check costs 600 ms, so the pool needs 50 workers. On 48 that measured a **median** check
3.0 s late and a p95 of 5.4 s — **with nothing refused** (`P-32`).

**`workerCrashes` above zero** points at a specific check type. Types that run somebody else's
code run in a child process for exactly this reason: a segfault in a native module would
otherwise take the whole probe down.

## The probe host's clock moved

`clockJumps` on Probe Health. Scheduling uses a monotonic clock so the wheel does not care, but
samples carry wall-clock time — a large jump backwards can put readings before ones already
stored. The counter is there to explain a graph that looks impossible.

---

## Alarms

### Nobody is being notified

- **`notifyPending` / `notifyOldest`** on Core Health. The queue is not draining: 15 minutes
  warns, an hour errors. Look at the delivery method's own failures.
- **`alarmOverdue`** on Core Health. The alarm sweep itself is not running; everything downstream
  of it is stale. Warns at 60 s, errors at 300 s.
- **`notifyFailed`** counts deliveries given up on in the last hour.

Failed deliveries back off and retry rather than being dropped. A method that is broken for a
long time shows as a growing `notifyOldest`, not as silence.

### Too many alarms for one outage

One outage should produce one alarm, and three mechanisms exist for it: **dependencies** (a
master sensor going down pauses what is behind it, instead of every sensor behind a dead router
alarming), **notification latency** (a threshold must hold, not merely be touched), and
**summarisation** (many events inside a window become one message).

If a single failure is still fanning out, the dependency is usually missing rather than
misbehaving — check that the router or the switch is actually the master of the things behind it.

---

## Access is refused and it should not be

`GET /objects/:id/access/effective` answers what the account may actually do here **and where
that came from**: the object the winning grant sits on, the group it came through, whether it was
inherited, and whether a **role** or a **token** capped it.

- **`cappedByRole`** — the account's role is the ceiling. A `readonly` account cannot write
  regardless of any grant.
- **`cappedByToken`** — the API token was issued with less than the account holds.
- Otherwise the grant itself is missing, or an explicit `none` lower in the tree is overriding an
  inherited right. Deleting a `none` grant restores inheritance; granting `read` does not, it
  pins it.

## Writes from the browser are refused

The CSRF guard compares the browser's `Origin` against the request's `Host`. Behind a reverse
proxy that rewrites `Host`, those differ for a request that is not cross-site at all, and every
cookie-authenticated write is refused. Set `api.allowedOrigins` to the origin browsers use — a
full origin with a scheme, not a hostname and not a wildcard. A bad value is refused at startup.

API tokens are unaffected: the header requirement applies to cookies, because a cookie is what a
browser attaches on its own.

## A credential is not readable through the API

Working as intended. Monitored-device credentials are write-only, stripped from every response in
one place, and no route returns them to anyone — administrators included. The read carries
`redactedParams`, which says which fields exist without saying what they hold. Set a new value;
there is no way to read the old one back.

---

## Restores

Covered in [`docs/runbook-backup-restore.md`](runbook-backup-restore.md), including the three
TimescaleDB-specific failures a hand-rolled `pg_restore` hits — the `COMMENT ON EXTENSION` abort,
the superuser needed for `timescaledb_pre_restore()`, and the `_timescaledb_catalog` permissions.
The one worth knowing here: **skipping restore mode produces a database that looks restored and
has no hypertables in it.**

## When none of this fits

Errors carry context by design — the sensor id, the target, the phase and the underlying error —
so a message with none of that is itself a finding worth reporting. `docs/findings/` holds the
measured investigations behind several of the behaviours above, and
[`docs/findings/2026-08-29-failure-modes.md`](findings/2026-08-29-failure-modes.md) is the
row-by-row audit of what this system does when each part of it fails.
