# What the machine has left, tracked under load (P-208)

- **Date**: 2026-09-27
- **Where**: the Docker Desktop VM on the development Mac — 8 CPUs, 7,936 MiB, 1,023 MiB swap —
  shared with the dev stack and with another project's stack (nine containers) that ran throughout.
- **What ran**: `P-208` on top of `f913624`, uncommitted: the real `ProbeHealthReporter` from
  `packages/probe/dist` with the real `MachineMemoryWatch`, reported every 2 s (the heartbeat) and
  recorded every 30 s (Probe Health's sweep).
- **Load**: `ms-server` on the same VM with the dev database's 5,000 `port.tcp` sensors and one
  `icmp.ping` — the probe at 2,158 MiB resident once past its start-up peak — plus the squeezes
  below.
- **Script**: [`scripts/sizing/machine-memory-track.mjs`](../../scripts/sizing/machine-memory-track.mjs).
  **Raw**: [`2026-09-27-machine-memory-channel.jsonl`](2026-09-27-machine-memory-channel.jsonl) —
  1,288 samples at 250 ms, 161 heartbeats, 10 records.

## The question

`P-208`'s done-when asks for the channel to be "measured to track it under load". Two things can
make it fail to: reading the wrong number, and reading the right number at the wrong moment. The
first is settled by reading `MemAvailable`. The second is why the channel is the **lowest of the
last thirty seconds** rather than the latest reading: Probe Health records once every thirty
seconds, and `P-206` watched a machine fall from 675 MiB available to 30 MiB, and the kernel kill a
process, inside six.

## The measurement

A worker thread squeezed the machine to 15% available and held it for 1, 5, 20 and 70 seconds, with
40 seconds between squeezes. Each hold is timed from the moment the target was reached, so the
3.4–5.6 s ramp is not counted in it. A 250 ms sampler on the main thread recorded what
`/proc/meminfo` said throughout, and that is the truth each record is judged against: the lowest it
saw in that record's interval.

| Held at the low | True low | Channel recorded | A latest-value channel would have recorded |
| --- | --- | --- | --- |
| 1 s — shorter than a heartbeat | 15.6% | 23.0% | 56.4% |
| 5 s — about `P-206`'s fall | 15.0% | **15.0%** | 54.0% |
| 20 s | 14.7% | 15.2% | 15.8%, then 55.2% |
| 70 s | 14.1% | **14.1%** | 15.8, 16.8, 17.0%, then 55.7% |

**Every squeeze held for a heartbeat or longer was recorded within half a point of its true low.**
A latest-value channel missed every one of them at the record where it ended, by around forty
points. For the 5-second squeeze — the shape of the fall that ended in `P-206`'s kill — it recorded
54% for an interval in which the machine had been at 15%.

**Two limits, both from the heartbeat's two seconds:**

- **A spike shorter than a heartbeat is caught partway.** The 1-second hold read 23.0% against a
  true 15.6%: the heartbeats landed on the ramp down, not on the bottom. That reading is above the
  20% warning, so a squeeze that brief would not have warned. `P-206`'s fall took six seconds.
- **A low reached in the last two seconds before a record lands in the next record, not this one.**
  At t=210 the channel read 21.9% against a true 15.4%: the 70-second squeeze reached its target
  at 208.7 s, after the heartbeat that record used. The record at 240 carried it (14.1%). Late by
  one interval, never lost.

Across all ten records the channel was 1.62 points from the true low on average, and 7.4 at worst —
the 1-second squeeze. The squeeze never needed its 12% floor; the machine's lowest was 14.1%.

## A first run, discarded

The first version of the script allocated on the sampler's own thread. Filling 2.3 GiB under memory
pressure blocked that thread — and the heartbeat timer with it — for 5.9 seconds, so the heartbeat
caught its "5-second" squeeze by being queued behind the allocation rather than by sampling it. Its
numbers looked better than these and proved nothing about a short squeeze. The squeeze now runs in
a worker thread, and this run's sampler never went more than 0.6 s between samples.

## Also measured

**`os.freemem()` is `MemAvailable` on Linux now** — 6,094 MiB against `MemAvailable`'s 6,096 and
`MemFree`'s 1,485, on Node 24.19 with libuv 1.52.1. The comment in `scheduler-benchmark.test.ts`
that said otherwise predates libuv 1.45 and is corrected. Probe Health still reads the file itself:
libuv falls back to `MemFree` without saying so on a kernel that lacks `MemAvailable`, and the
channel gaps there instead.

## Not measured

- **The path through the core.** The heartbeat's two fields, the core's mapping onto the channels,
  their limits and the gap for a probe older than protocol 17 are unit-tested
  (`probe-health.test.ts`, `core-health.test.ts`, `capabilities.test.ts`, `messages.test.ts`), but
  this run did not go through a live sweep into `sample`. The dev database has no health sensor,
  and creating one needs a token: the generated first-administrator password in `dev/data` has
  since been changed, so `scripts/dev-token.sh` could not log in.
- **Windows.** The Windows path is `os.freemem()` — `GlobalMemoryStatusEx`'s available figure — and
  is tested by injection only. `H-09`'s field test is where it meets a real machine.
- **The error limit firing.** The squeeze stopped at 15% by design; taking a machine another
  project was using below 10% to watch an alarm fire was not worth what it could cost.
