# A name lookup a scan, at 5,000 sensors on 500 named devices (`A-66`)

2026-10-17, `A-66` at `b8ded6b4` on `e4b6adda`. `packages/probe/test/perf/name-lookups.test.ts`,
at its defaults, run twice in one quiet window:

```
./scripts/dev.sh "timeout 1900 sh -c 'node scripts/perf-conditions.mjs; node --test --test-concurrency=1 packages/probe/dist/test/perf/name-lookups.test.js'"
```

**Conditions.** For the window:
- `ms-server` was stopped (`scripts/dev-services.sh stop`).
- The other project's containers on the VM were paused, at the user's word.
- No other toolchain run was going.

Run 1 began while the load of the full suite before it was still draining. Run 2 is the clean
one, and the two agree to within a few percent on every line below.

```
  perf run conditions                       (run 2)
  ----------------------------------------------------------------
  load average   0.63 / 3.42 / 8.14  over 8 CPUs  (0.08 per CPU)
  delivered CPU  267 ms for a fixed loop  (1.00x the reference machine's 267 ms)
  database       nothing else is connected
  ----------------------------------------------------------------
  (run 1: 0.96 per CPU, 1.10x)
```

**The case.** Each arm uses a real wheel and a real pool at its shipped ceiling (64 workers) and
queue (1,000). It has 5,000 sensors at 60 s on 500 named devices, runs for one minute, and
starts on a fresh pool. Each check is SNMP's resolution: `checkedTarget` with a 2,500 ms lookup
bound, then 200 ms of work.

There are six arms:
- **Addresses:** no lookup, the baseline.
- **System resolver:** real `getaddrinfo` from the hosts file.
- **Four through lanes.** These model libuv's discipline: two lookups at a time, first come
  first served, with `UV_THREADPOOL_SIZE` unset.
  - **Answering:** a real `getaddrinfo` inside each lane.
  - **100 ms a lookup.**
  - **Not answering:** 30 s, then `EAI_AGAIN`.
  - **One device in ten not answering**, beside the rest answering.

## The numbers

Run 2, with run 1 in brackets where it differs.

| Arm | Results of 5,000 | Answered | Given up at the bound | Refused (queue full) | Jitter p50 / p95 | Probe Health in flight, highest | Given up |
| --- | --- | --- | --- | --- | --- | --- | --- |
| addresses | 5,000 | 5,000 | 0 | 0 | 5 / 215 ms (209) | 0 | 0 |
| system resolver | 5,000 | 5,000 | 0 | 0 | 5 / 215 ms (217) | 4 (0) | 0 |
| lanes, answering | 5,000 | 5,000 | 0 | 0 | 6 / 242 ms (237) | 4 (3) | 0 |
| lanes, 100 ms a lookup | 2,523 (2,553) | 58 (54) | 2,465 (2,499) | 2,477 (2,447) | 33.8 / 39.3 s | 634 (653) | 2,465 (2,499) |
| lanes, not answering | 2,536 | 0 | 2,536 | 2,464 | 34.0 / 40.0 s | 2,530 | 2,536 |
| lanes, one zone in ten silent | 2,542 (2,537) | 6 (1) | 2,536 | 2,458 (2,463) | 34.2 / 39.6 s | 2,500 (2,495) | 2,536 |

The lanes, at the end of each arm:

| Arm | Deepest queue | Still queued after the pool drained | Wait p95 (served and still queued) | Busy |
| --- | --- | --- | --- | --- |
| answering | 62 | 0 | 53 ms (38) | 5% |
| 100 ms a lookup | 650 (662) | 600 (614) | 24.7 s (25.2) | 98% (99%) |
| not answering | 2,528 | 2,528 | 95.6 s (95.8) | 99% |
| one zone in ten silent | 2,498 (2,493) | 2,498 (2,493) | 95.4 s (96.0) | 99% |

In the zone arm, the nine zones that answered fared as the silent one did: **6 of their 2,287
lookups were answered (1 of 2,283 in run 1), and 2,281 were given up.**

The thread pool's `fs.stat` p95 stayed between 1.8 and 3.8 ms in every arm. In the lane arms it
cannot show contention, because the lanes are a model and hold no libuv thread. Even for real,
libuv keeps half its threads from `getaddrinfo`, so the file system's share is not what is at
stake.

## What it says

**With a resolver that answers, a lookup a scan costs nothing measurable.** The hosts file and
the answering lanes ran all 5,000 checks, as the address arm did, at the same jitter. Probe
Health read at most four lookups in flight. The address arm's jitter p95 of about 215 ms is the
case's own, since every check holds a worker for 200 ms. It is the line the other arms are read
against, not a claim about the scheduler (`P-15` measures that).

**A resolver that answers in 100 ms takes the probe down.**
- **The arithmetic.** Two lanes serve 20 lookups a second, and 5,000 sensors a minute ask for
  83. Within the minute, 650 lookups were queued.
- **Every check gave up waiting.** Each check waited out its 2,500 ms bound and gave up (check
  run p95 2,516 ms). That held its worker for the whole bound, so the pool fell to about 25
  checks a second.
- **The queue filled.** The queue of 1,000 filled, and half the scans were refused.

That leaves 58 checks answered, 2,465 failed naming the resolver, 2,477 refused, and a median
jitter of 34 s. Nothing here is down; the resolver is only slow and has no cache in front of
it. The `A-66` outcome reads the threshold from the arithmetic, at about 24 ms a lookup. This
window did not sweep `MS_DNS_SLOW_MS` to find where the collapse begins.

**One zone that does not answer takes every named device on the probe with it.**
- **Which arm.** A device in ten silent: 500 of the minute's lookups, against 4,500 that would
  answer at once.
- **What happened.** The result was the same as the whole resolver silent. Two silent lookups
  hold both lanes, and everything asked after them waits behind them, whichever device it is
  for.
- **The cost.** 2,281 of the 2,287 answering devices' lookups were given up.

This is the "one outage, many alarms" shape that `CLAUDE.md` exists to prevent: an operator
whose DNS loses one zone sees every named device on that probe go Down.

**Probe Health says so.** In the healthy arms, `lookupsInFlight` read 0 to 4. In the slow arm it
read 634, and in the silent arms 2,500 to 2,530. `lookupsGivenUp` equalled the checks that
failed at the lookup's bound in every arm, as the case asserts. An operator looking at Probe
Health during either outage would see the resolver named as the cause, not 2,500 devices.

## What it decides

**`P-426` should not be closed as "not changing".** The measurement answers its question.
- **The two lanes are the whole of the probe's capacity for names.** Both a slow resolver and
  one silent zone exhaust them at the 5,000-sensor class.
- **A larger thread pool alone moves the slow threshold, not the zone failure.** Eight lanes
  serve 80 lookups a second at 100 ms, and eight silent lookups still stop all of them.
- **What removes both:**
  - answers kept for a TTL, so a device is asked about once a TTL and not once a scan;
  - a resolver off the thread pool, `dns.resolve*` (c-ares), with a per-query timeout, so a
    silent lookup holds nothing.

  Either needs its arms run again to show what it bought.

**What the case does not show.**
- **The lanes are a model.** They are not `getaddrinfo` against a slow DNS server. glibc's own
  timeouts and retries (`resolv.conf`'s `timeout` and `attempts`) decide how long a silent
  lookup really holds a lane, and the model's 30 s is one such setting.
- **The local cache.** A host with `systemd-resolved` or `nscd` answers repeat names from a
  local cache. That narrows the slow case, not the silent one, since a cache does not answer
  for a zone whose server is gone once the TTL runs out.

## What the case costs `test:perf`

About 9.5 minutes at its defaults: six arms of 73 to 119 s each. The slow and silent arms take
longest, as their checks drain. `MS_DNS_ARMS` runs a subset.
