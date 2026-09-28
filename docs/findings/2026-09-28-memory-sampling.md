# Memory read every two seconds, at the heartbeat the probe ships with (P-218)

- **Date**: 2026-09-28, 17:13–17:18 UTC
- **Where**: the Docker Desktop VM on the development Mac, as in `P-208`: 8 CPUs, 7,936 MiB,
  1,023 MiB swap.
- **Conditions**, as `scripts/perf-conditions.mjs` read them just before the run:
  - load 2.21 / 2.36 / 7.81, which is 0.28 per CPU;
  - delivered CPU 299 ms for the fixed loop, 1.12× the reference machine;
  - one other client on the shared database, `ms-core`.
- **Also on the VM**:
  - `ms-server`, restarted about six minutes before the run, with the dev database's sensors. It
    was running for `P-208`'s run too.
  - A hung toolchain container from another session (`…5bf0b5c501d4`), idle at about 0% CPU and
    40 MiB for an hour.
  - Another project's stack: a web app, workers, its own PostgreSQL and CI runners.

  The machine sat at 33% available before the first squeeze, against the mid-50s in `P-208`'s run.
  No other build or suite ran; the VM was booked for this.
- **What ran**: `P-218` on `main` at `d46849d`, uncommitted. That is the real `ProbeHealthReporter`
  and `MemorySampler` from `packages/probe/dist` and `packages/shared/dist`, reported every
  **10 s** — `heartbeatIntervalMs` in `deploy/examples/core.json` and the schema's default — and
  recorded every 30 s.
- **Script**: [`scripts/sizing/machine-memory-track.mjs`](../../scripts/sizing/machine-memory-track.mjs),
  `MS_HEARTBEAT_MS=10000`, which is now its default. **Raw**:
  [`2026-09-28-memory-sampling.jsonl`](2026-09-28-memory-sampling.jsonl): 1,257 samples at 250 ms
  (never more than 0.28 s apart), 31 heartbeats and 10 records.

## The question

`P-208` measured the channel within half a point of the truth for every squeeze of five seconds or
more. It did so with the probe reporting every 2 s, which is `dev/core.json`'s heartbeat. The probe
read memory only when it reported, so that run measured two-second *sampling*. At the shipped 10 s,
the window held three readings, and a squeeze shorter than a heartbeat was seen only if a heartbeat
happened to land inside it.

**Two reporters ran side by side against the same squeezes.**
- **P-218**: reads on the `MemorySampler`'s own two-second timer, as the probe does now.
- **Before P-218**: reads once per report, as the probe did. This is a `MemorySampler` that is never
  started and is sampled just before each report.

They are the same code on the same machine at the same moments, and differ only in when memory is
read.

## What each squeeze was recorded as

The squeezes were held at 15% available, timed from reaching it. The true low comes from the 250 ms
sampler reading `/proc/meminfo` during that record's interval. Records that fell inside the squeeze
without showing anything new are left out.

| Held at the low | Record | True low | P-218 | Before P-218 | Latest value |
| --- | --- | --- | --- | --- | --- |
| 1 s | 60 | 15.4% | **19.8%** | 34.8% | 34.6% |
| 5 s — `P-206`'s fall | 120 | 15.2% | **15.3%** | 32.8% | 34.1% |
| 20 s | 150 | 15.1% | 26.6% | 15.8% | 15.5% |
| | 180 | 15.3% | **15.3%** | 15.5% | 33.4% |
| 70 s | 210 | 15.0% | 33.1% | 30.6% | 15.7% |
| | 240 | 14.8% | 14.9% | 14.9% | 15.3% |
| | 270 | 14.1% | 14.7% | 14.2% | 15.0% |
| | 300 | 14.8% | 14.2% | 15.0% | 32.6% |

**Before P-218, at the shipped heartbeat, the five-second squeeze was missed completely.** It read
32.8% for an interval in which the machine was at 15.2%, no better than a latest-value channel. The
heartbeats at 90.0 s and 100.0 s fell either side of a squeeze held from 92.0 s to 97.0 s, and
nothing read memory in between. This is the fall that ended in `P-206`'s kernel kill. **With P-218
it was recorded at 15.3%.**

**The one-second squeeze was caught partway**, at 19.8%, because a two-second sample landed on the
ramp rather than the bottom. That is still below the 20% warning. Before P-218 it read 34.8%, which
means it was not seen at all.

**Squeezes held longer than a heartbeat were caught by both**, within 0.6 points: 20 s at record 180,
70 s at 240 and 270. A heartbeat always lands inside such a squeeze, so the old reporter's one
reading per report was at the bottom.

## Late by one record, and the limit that remains

At records 150 and 210 the channel shows a reading from before the squeeze, P-218's included (26.6%
and 33.1%). **That is the heartbeat, not the sampling.** The core records whichever report reached
it last, and at 10 s that report is up to 10 s old. The 20-second squeeze reached its low at 139.5 s.
The report the 150 s record used was sent at 140.0 s, and P-218's last reading before it was on the
ramp, up to two seconds earlier. The 70-second squeeze reached its low at 202.3 s, after the report
at 200.1 s. **Both lows arrived one record later** (180 and 240), because the window reaches back
thirty seconds from each report. This is `P-208`'s "late by one interval, never lost". At 2 s the
delay was two seconds; at 10 s it is up to ten.

Per record, as `P-208` scored it:

| | Mean error | Worst error |
| --- | --- | --- |
| P-218 | 3.67 points | 18.1 points (record 210) |
| Before P-218 | 5.61 points | 19.4 points (record 60) |

**The worst figures measure different failures.** P-218's worst is a low one record late; the old
reporter's is a low never seen at all.

**Never lost holds only because 10 divides 30.** Take a record that reads the report sent at h. The
next record reads the report sent at h + 30 whenever the heartbeat divides thirty seconds, and a
thirty-second window then covers every instant between them. At a heartbeat that does not divide
thirty, the gap between the two reports a record reads can reach 30 s plus a heartbeat. For example,
at 20 s, a low in the last few seconds before one record can be missing from both reports. The
schema allows any heartbeat from 1 to 300 s. A window of thirty seconds plus the heartbeat would
close that gap. **That is `P-219`, not this ticket**, and it was not measured here.

## Not measured

- **A heartbeat that does not divide thirty seconds**, where a low can be lost (`P-219`).
- **The core.** Its sampler did not change, only moved into `@ms/shared`: two seconds, as before.
- **A disconnected probe.** Reading now goes on without a heartbeat, so the first report after a
  reconnect has a full window. That is pinned by `probe-health-report.test.ts` and not measured
  live.
