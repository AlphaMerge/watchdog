# Measurements: the pool default against the sensor type we ship (P-32)

- **Date**: 2026-09-03
- **Method**: `scripts/sizing/bench.mjs`, the same wheel and pool as `P-15`'s gate, swept over
  `MS_SIZING_POOL_MAX` at **600 ms checks** — what `P-07` measured a real `icmp.ping` to cost —
  with 5,000 sensors on a 60-second interval, 90 seconds a point.
- **Raw data**: `2026-09-03-pool-default-sweep.jsonl`
- **Reproduce**: `MS_SIZING_SENSORS=5000 MS_SIZING_CHECK_MS=600 MS_SIZING_SECONDS=90
  MS_SIZING_POOL_MAX=64 node scripts/sizing/bench.mjs`
- **Measured on**: 8-core arm64, `node:24-bookworm-slim`, `ms-server` stopped

## Why this was measured at all

`P-15` chose a pool default of 48 against a **200 ms** check model. `P-07`, three days later,
measured a real `icmp.ping` at **600 ms** — four packets at `-i 0.2`. At the v1 target the
arrival rate is `5,000 / 60 = 83.3` checks a second, so Little's floor is `83.3 × 0.6 = 50`
workers. **48 was one worker under the line for the type this project actually ships**, and
`P-07`'s own finding had already recorded that 83/s "needs about 55 now". Nobody put 55 next
to 48.

## The sweep

| Ceiling | Ratio to the floor of 50 | Tranches | Model predicts | p50 | **p95** | p99 | Benchmark RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 48 | **0.96×** | — | **unstable** | 3,081 ms | **5,082 ms** | 5,840 ms | 656 MB |
| 56 | 1.12× | 2 | 600 ms | 220 ms | 822 ms | 866 ms | 753 MB |
| **64** | **1.28×** | 2 | 600 ms | 8 ms | **614 ms** | 719 ms | 851 MB |
| 80 | 1.60× | 2 | 600 ms | 4 ms | 608 ms | 614 ms | 1,037 MB |
| 96 | 1.92× | 1 | 0 ms | 4 ms | 7 ms | 592 ms | 1,215 MB |
| 128 (held 127) | 2.54× | 1 | 0 ms | 3 ms | 9 ms | 437 ms | 1,514 MB |

**Nothing was refused at any point**, including at 48. That is the whole difficulty: the pool
that cannot keep up does not shed work and raise an alarm, it accumulates it. A p50 of 3.0 s
means the *median* check is three seconds late — a backlog, not a tail.

## What the numbers say

**The floor is a cliff, not a gradient.** 48 to 56 is one eighth more workers and takes the p95
from 5,082 ms to 822 ms. Everything below the line is unbounded; everything above it is governed
by the tranche model.

**Above the floor the tranche model is exact again.** 56, 64 and 80 are all two tranches and it
predicts 600 ms for each; 96 and 128 take the batch in one and it predicts zero. Measured: 822,
614, 608 — and 7, 9.

**The margin above the floor is what the tranche model leaves out.** 56 and 64 have identical
predictions and differ by 208 ms, because at 1.12× the floor the queueing the model ignores is
still on top. By 1.28× it is gone. This is the same effect `P-33` recorded from the other
direction, where 1.02× the floor measured 2,427 ms against a prediction of zero.

## The choice: 64

- **It clears the floor by enough that the model holds** — 614 ms measured against 600 predicted,
  39% inside the 1,000 ms budget.
- **96 is not worth its price.** It buys the last 600 ms by taking the batch in one tranche, and
  costs 32 more workers — about **1.1 GB** in a real probe, where each worker carries the sensor
  catalogue at ~35 MB rather than the benchmark's ~12 MB. The budget is already met at 64.
- **56 is too close to the line.** 822 ms leaves 18% of the budget on a quiet machine, and this
  hardware varies by more than that between runs.

## What it costs the workload it does not help

Stated plainly, because it is a real cost and not a rounding error: **a probe at the v1 target
whose checks are fast now holds 64 workers where it held 48 — about +560 MB in a real probe —
and gains nothing.** 83 checks in two tranches either way. The pool is demand-driven since `P-18`
and tracks its load since `P-26`, so nothing below the v1 target pays this at all; a large probe
watching fast checks does.

**The honest fix is not a different constant.** It is a ceiling derived from the measured
duration of the checks actually assigned to the probe, which is a number the system does not
currently have — `costHint` is a three-value enum (`light`/`medium`/`heavy`), not a duration, and
mapping it to milliseconds would put a guess underneath Little's law. That is exactly the mistake
`P-33` was about, so it needs its own ticket and its own measurement rather than being smuggled
in here.

## Caveats

- **One check duration.** 600 ms is `icmp.ping` after `P-07`. A probe with a mixed catalogue has
  a mixed floor, and this sweep does not model that.
- **Sleeping checks**, as in every measurement built on this harness, and for the same reason.
- **90 seconds a point.** Long enough for a stable pool to settle and for an unstable one to show
  its slope; not long enough to state where an unstable one ends up, which is unbounded anyway.
- **arm64 only**, like everything else in this directory.
