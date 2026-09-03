# Observation: today's probe changes on a live stack (P-42 … P-46)

- **Date**: 2026-09-04
- **Method**: the dev stack, not a benchmark — `docker compose up postgres`,
  `scripts/dev-services.sh start`, then reading `ms.probe.health` through the API over 40 minutes.
- **What was running**: `main` at `2800fa7`, so `P-42`–`P-46` inclusive.
- **Scale**: 5,051 sensors on a 60-second interval across 269 devices, one local probe.

This exists because every change in `P-42`–`P-46` was validated by unit tests and a synthetic
benchmark, and none of it had been seen on a probe talking to a real core. That debt was recorded
twice; this pays most of it.

## What the probe says about itself

| Channel | Reading | Against |
| --- | --- | --- |
| `scheduled` | 5,046 sensors | 5,051 configured |
| `schedulerLag` | **5.7 ms** | `P-15`'s 1,000 ms budget |
| `checkWait` | 10.1 ms | — |
| `deferred` / `refused` / `timedOut` / `workerCrashes` | **0** | — |
| `memory` | 2,300 MB at 64 workers | formula predicts 2,360 MB |
| `clockJumps` | 0 | — |

**`P-15`'s gate holds with today's code**: 5.7 ms of scheduler lag is a two-hundredth of the
budget, at the v1 target, with nothing deferred or refused.

**The memory formula is right to 3%.** `docs/sizing.md` says `probe RAM ≈ 120 MB + workers × 35 MB`.
At 64 workers that predicts 2,360 MB and the probe holds 2,300 MB — 36 MB a worker against the
37 MB `H-01` measured over 24 hours at 48 workers. The formula was derived at the old default of
48; it survives `P-32`'s raise to 64 unchanged.

**Resident memory climbs and then stops, and the shape matters.** 1,731 MB at 5 minutes, 2,254 MB
at 34, 2,300 MB at 40 — that is +1,082 MB/h, then +427, then +220. Decelerating toward `H-01`'s
+0.68 MB/h steady state, which is warm-up rather than a leak. **Do not read a probe's memory inside
its first hour**; two samples half an hour apart would have said 1 GB an hour and meant nothing.

**No-data is not zero, in production.** The second probe (`n01`) has never connected here, and
every one of its channels reads `null` rather than `0` — the rule holding where it counts, on a
sensor an operator would otherwise read as a healthy probe scoring zero on everything.

## A defect I thought I had found, and did not

`poolUsage` read **4.7%** while the pool held 64 workers, and no worker had been retired in 34
minutes though `workerPoolMinSize` is 4. That looks exactly like a dead shrink policy, and there is
a mechanism ready to blame: `P-26` changed the decay's question from "has anything been submitted
lately" — true on any busy probe — to "has *this worker* been idle for the whole window", and with
84 checks a second arriving in per-second bursts against 64 workers, every worker is handed a job
every tick and no individual worker is ever idle for a minute. Same question, same answer, one
level down.

**It is wrong, and the reason is the metric rather than the pool.** `poolUsage` is
`poolBusy ÷ poolSize` sampled at the instant the heartbeat is built — not an average and not a
peak. A burst of 84 checks clears in about 20 ms, so a random sample catches the pool busy roughly
2% of the time. 4.7% is what a pool that is *fully* saturated once a second looks like through an
instantaneous gauge. `checkWait` at 10.1 ms is the corroboration: 84 checks against 64 workers
means about twenty of them wait one check-duration, which is exactly what it reads.

So the pool genuinely needs its 64 workers, for about 20 ms in every 1,000, and a decay that
declines to shed them is correct. A change was written to make the decay ask about the pool's peak
concurrency rather than about one worker's idleness; it was reverted, because peak concurrency
*is* 64 here, so the new rule would have declined for the same reason at extra cost per dispatch.
The two rules only disagree when the burst is smaller than the pool, and there `#pump`'s preference
for low-index slots already leaves the high ones idle for the old rule to find.

**What to take from it**: `poolUsage` is a gauge, not a duty cycle, and reading a bursty workload
through it understates the pool by more than an order of magnitude. Anyone sizing from that number
will size wrong. `schedulerLag` and `checkWait` are the signals that do not lie about a burst.

## The probe key handshake, end to end (`P-34`, `P-37`)

Recorded twice as never having been observed live. It has now been, both halves, and the dev stack
happened to be in the awkward state that exercises the recovery path as well.

**Issue.** The probe presented a stored key the core did not recognise:

    [warn]  probe-registry   an approved probe presented the wrong key
    [warn]  probe-endpoint   rejecting probe                    code=bad-access-key
    [warn]  core-client      the core does not know the key this probe holds;
                             falling back to the enrolment key
    [info]  probe-registry   issued this probe a key of its own
    [info]  core-client      stored this probe's identity

That is `P-37`'s `staleKeyAction` doing what it was written for — a probe that cannot get in with
the key it holds gives up on it and re-enrols, rather than retrying a key the core has forgotten
for ever.

**Confirm.** The database then held `access_key_hash` set and `access_key_confirmed_at` **null** —
exactly the state `P-34` added the column to represent, since `hasOwnKey` requires both. On the
next connection:

    [info]  probe-registry   this probe used the key it was issued

and `access_key_confirmed_at` became `2026-09-03 23:17:15`. No re-issue, no enrolment fallback.
`P-34`'s migration 039 and the `'own'` branch of `#keyAccepted` work end to end against a real
core.

## The chunked push is real, and the numbers behind `P-41`/`P-42`/`P-43`

Those three tickets rest on a premise proved only in unit tests: that `P-28` sends a full
configuration as a `config-set` plus deltas, so between the first chunk and the last the
`AssignmentStore` legitimately holds a *fraction* of the probe's sensors. On the reconnect above:

| chunk | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| sensors held | 1,000 | 2,000 | 3,000 | 4,000 | 5,000 | 5,046 |

**Six messages, and after the first the probe held 20% of its own workload.** The whole push took
**69 ms**, from 23:17:15.624 to 23:17:15.693.

Two things follow, and they point opposite ways:

- **`P-42` was a real production path, not a theoretical one.** The cursor sweep ran on every one
  of those six messages, so five times per reconnect it deleted the ring cursors of every trap and
  syslog sensor outside the current chunk. The window is 69 ms but the *loss* is not: a deleted
  cursor discards everything the ring buffered for that sensor since its last drain — up to a full
  scan interval of traps — and reports `dropped: 0`.
- **The 2,000 ms settle has about 29× margin here**, which is comfortable and worth knowing is
  comfortable. It is sized against a push that might be much slower on a remote probe over a real
  link; at 69 ms on loopback it is nowhere near the edge.

**What this does not show is `P-41` working.** The ceiling never moved during or after the push —
no `pool ceiling` line, no shrink — because these checks are fast enough that the derived demand
sits below the floor of 64 and `nextCeiling` returns the same number every time. So the sizer had
nothing to thrash *with*, and a probe without `P-41` would have looked identical on this workload.
The premise is confirmed; the fix's effect is not distinguishable here. Seeing that would need a
workload whose derived ceiling is above the floor — the `autosize.mjs` benchmark, which is where it
is already measured.
