# What a check in its own process costs

`P-03`, measured 2026-08-27. Reproduce with:

```bash
scripts/dev.sh "node --test packages/probe/dist/test/perf/process-runner-startup.test.js"
```

## Why this was measured

`P-03`'s design decision is that isolation is **opt-in per sensor type**, declared as
`SensorType.isolation: 'process'`, rather than a probe-wide setting or the default. That is only
defensible if the cost is small enough to be irrelevant beside a script that shells out, and
large enough to be unreasonable for an ICMP check. Both halves of that claim needed a number.

The related decision is **one process per check rather than a pool of them** — the opposite of
`CheckPool`'s trade, made for the opposite reason: not amortising start-up is the feature, since
nothing survives from one check to the next and so a leak, a stuck handle or a corrupted global
cannot accumulate. That is only affordable if a start-up is cheap.

## What was measured

Wall-clock from `submit` to the result callback, minus the duration the check itself reported.
The difference is `spawn`, Node boot, module resolution, the registry import, and the JSON in
both directions. Node 24.19.0 in the pinned toolchain container on the development machine.

| Case | p50 | p95 | max |
| --- | --- | --- | --- |
| 20 serial checks, one-file test registry | **20.8 ms** | 29.2 ms | 29.2 ms |
| 10 serial checks, the **real** catalogue (`icmp.ping` to loopback) | **22.1 ms** | — | — |

Concurrency, at the default cap of 4: 8 trivial checks completed in **63 ms** total — 8 ms each
against a 21 ms serial start-up, so start-ups genuinely overlap rather than queueing.

## What the numbers say

**About 21 ms, and the real catalogue costs almost nothing extra.** The gap between the one-file
test registry and the whole shipped catalogue is about 1.3 ms. That is a direct consequence of the
rule in `docs/adding-a-sensor-type.md` that a type's heavy imports live inside `execute`:
registering 30 types builds 30 JSON-Schema validators and imports no protocol stack at all, so a
child that runs one ICMP check never loads `net-snmp`, `ssh2`, `mysql2` or `tedious`. If that rule
were ever relaxed, this measurement is where it would show up first.

**21 ms is the right shape for the decision it supports.** Against a `T-19` script that runs `df`
or a PowerShell one-liner — tens to hundreds of milliseconds — it is noise. Against an ICMP check
to a device on the same LAN, which completes in single-digit milliseconds, it would be three to
twenty times the cost of the check itself. Opt-in per type is the correct default, and making
isolation the default for everything would have been a measurable regression on the cheapest and
most numerous sensors in any installation.

**The concurrency cap stays small regardless.** 8 ms per check at a cap of 4 is not an argument
for raising it: the constraint is memory, not latency. Each child is a Node process at roughly
40 MB resident, where a pool worker awaiting a packet costs a slot and almost nothing. 48 of these
would be about 2 GB.

## What is not measured here

Memory per child, and the cost under contention with a busy worker pool. Both belong to `H-01`'s
soak, where the probe is doing everything at once; measuring them in isolation would produce
numbers that do not describe any real probe.
