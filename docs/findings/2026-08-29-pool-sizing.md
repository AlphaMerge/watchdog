# What demand-driven pool sizing costs, and what it buys

`P-18`, measured 2026-08-29 on the same machine and the same harness as `P-15`. Reproduce with:

```bash
scripts/dev.sh "npm -w @ms/probe run test:perf"
```

Eight cores, 5,000 sensors at 60 s, 200 ms checks, ninety seconds a run. Stop `ms-server` first
(`P-21`).

## Why this was measured

`P-15` set the check pool to a flat 48 workers and recorded what getting the number wrong costs in
both directions: seven workers refused **21%** of checks and delayed the rest by a p95 of **15.8
seconds**, while 48 reserve about **290 MB** of resident memory whether a probe is watching five
thousand sensors or fifty.

Most installations are the second kind. A default that is right for the largest one and expensive
for every other is a default that gets changed by whoever notices, and quietly kept by everyone
who does not.

**The risk of fixing it is that growth is not free.** A pool that starts small has to reach its
working size while the first checks are already arriving, and if that ramp costs a sensor a late
measurement then the memory was better spent. That is the number this measures.

## The numbers

5,000 sensors — the v1 target, and `P-15`'s gate of a p95 dispatch jitter under one second:

| Pool | p95 jitter | p99 | Refused | Memory at start |
| --- | --- | --- | --- | --- |
| fixed 48 (what shipped) | **218 ms** | 406 ms | 0 | 557 MB at 48 workers |
| demand-driven, 4 → 48 | **217 ms** | 420 ms | 0 | 16 MB at 4 workers |
| fixed 7 (the pre-`P-15` default) | 29,176 ms | 29,293 ms | 3,494 | 34 MB at 7 workers |

50 sensors — what most installations actually are:

| Pool | Workers held | Memory |
| --- | --- | --- |
| fixed 48 | 48 | **263 MB** |
| demand-driven | **4** | **16 MB** |

## What the numbers say

**The ramp costs nothing measurable.** 217 ms against 218 ms at the p95, with the same zero
refusals, over ninety seconds that include the growth from four workers to forty-eight. The
scheduler hands over a whole second's worth of checks at a time, so the pool learns it is short
within the first tranche and doubles until it is not — the delay is spent once, at the start, on a
handful of checks, and does not reach the percentile the gate is stated at.

**The saving is 16x on a small installation**, and it is a saving of the whole thing rather than a
tuning: the pool never grows at fifty sensors, so those four workers are the entire cost.

**Nothing was given back to make it work.** The five-thousand-sensor case ends at the same 48
workers a fixed pool would have started with, so the steady state is identical; what changed is
only how it got there.

## The policy, and why it is asymmetric

Growth is immediate and shrinking is slow, because the two mistakes cost different things.

**Grow** when a check is queued *and* every worker is busy — the only state in which another
worker would have started something that is instead waiting. A queue behind an idle worker is a
worker about to pick it up, and growing there buys memory for work that was never going to wait.
The step is a doubling, capped by the ceiling and by what is actually queued: the load arrives in
tranches, so growing one at a time would spend a spawn per pump climbing to a number four spawns
could have reached.

**Shrink** one worker at a time, and only after a whole interval in which nothing waited at all.
The default interval is 60 s, deliberately longer than a scan interval — a probe is idle between
ticks by design, and a shrink policy shorter than the interval would spend its life dropping
workers it is about to re-spawn. The clock is monotonic, so a wall-clock jump cannot make a busy
pool look idle.

The failure modes are not symmetric and the policy should not be either: growing late loses
measurements, shrinking late loses six megabytes.

## What changed as a result

- `probe.workerPoolMinSize`, default **4**. `workerPoolSize` keeps its meaning and becomes a
  ceiling.
- `probe.workerPoolIdleShrinkMs`, default **60000**. Zero never shrinks, which suits a machine
  with memory to spare and spiky work.
- Setting `workerPoolMinSize` equal to `workerPoolSize` restores the old fixed pool exactly, which
  is what a probe with a known steady workload should do — the sizing loop buys nothing there and
  a re-spawn during a spike costs something.
- `PoolStats` gained `maxSize`, `grown` and `shrunk`; `size` is now what the pool holds rather
  than what it is allowed to hold. Probe Health's `poolSize` therefore moves with the load, which
  is the intended signal — a pool sitting at its ceiling with `refused` climbing is a probe that
  needs a bigger one.
