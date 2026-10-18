# A probe restarted during an outage, and a domain not known to answer, at 5,000 sensors (`P-438`)

2026-10-19, `P-438` at `0e3d6ce9` (on `358bdaa3`), the fourth quiet window.
`packages/probe/test/perf/name-lookups.test.ts`, the `zone` and `zonefile` arms, at full size,
once. Built first in a run of its own, then:

```
./scripts/dev.sh "timeout 2100 sh -c 'sleep 180; node scripts/perf-conditions.mjs; MS_DNS_ARMS=zone,zonefile MS_DNS_COLD_MINUTES=7 node --test --test-concurrency=1 packages/probe/dist/test/perf/name-lookups.test.js'"
```

The case is the third window's (`2026-10-18-name-lookups-through-the-resolver.md`): 5,000
sensors at 60 s on 500 named devices, a real wheel and a real pool at 64 workers and a queue of
1,000, each check `checkedTarget` with SNMP's 2,500 ms lookup bound and then 200 ms of work, the
real `NameResolver` taking 6 of a model of libuv's 8 lanes. One name in ten is in `zone-b.test`,
whose lookups are silent for 30 s and then `EAI_AGAIN`; the rest are in `zone-a.test`, which
answers.

**Conditions.**
- `ms-server` was stopped, and the 11 containers of the other project on the VM were paused, at
  the user's word, from 01:11 to 01:50 local time.
- No other toolchain run was going.
- The arm ran from 01:11 to 01:29. Three of the paused containers (`ddc-runner`, `ddc-runner-2`,
  `ddc-pg`) were found running again when the window closed at 01:50, at a load of 18 in the
  last minute; the load at the arm's end was 8.15 / 7.69 / 11.81, so they came back after it,
  during the scenario runs below.

```
  perf run conditions
  ----------------------------------------------------------------
  load average   1.74 / 9.64 / 14.93  over 8 CPUs  (0.22 per CPU)
  delivered CPU  345 ms for a fixed loop  (1.29x the reference machine's 267 ms)
  database       nothing else is connected
  ----------------------------------------------------------------
```

The delivered CPU is 1.29 times the reference, against the third window's 1.02: the host was
not as idle, so times here are, if anything, longer than on a quiet machine.

## One zone in ten silent, cold

| | Third window (`P-426`) | This window (`P-438`) |
| --- | --- | --- |
| Results | 35,000: 29,249 answered, 5,751 given up | 35,000: 31,500 answered, 3,500 given up |
| Answering zone | 29,249 of 31,500 answered, **2,251 given up** | **31,500 of 31,500 answered, 0 given up** |
| Answering names kept, from the wheel's start | all 450, p50 31,041 ms, p95 31,047 ms | all 450, **p50 5,062 ms**, p95 17,030 ms, last 28,225 ms |
| Lookups in flight, max | 483 | 50 |
| `getaddrinfo` | 5,106 | 5,412 |
| Jitter p95 / check run p95 | 214 ms / 214 ms | 223 ms / 249 ms |
| Refused, deferred, timed out | 0, 0, 0 | 0, 0, 0 |

The 3,500 given up are the silent zone's: every one of its checks, from the first scan, as
expected. The answering zone loses nothing: the silent zone holds 3 first lanes and never the
fourth, and the answering zone is asked on the lanes left. Its names are kept as soon as a check
first asks them, about 27 s for the wheel to reach the last, against 31 s in the third window,
where every name waited behind the silent zone's lookups. Check-run p95 rises by 35 ms: checks
that failed at once now do their 200 ms of work.

## One zone in ten silent, restarted from the answer file

A probe runs warm, stops during the outage, and a second probe starts from the file the first
wrote at stop.

- Results: 35,000 dispatched, 33,994 answered, 1,006 given up, none refused, deferred or timed
  out. Lookups in flight at most 480; 3,659 `getaddrinfo`.
- **Answers loaded before the wheel started: 500**, every name.
- **Answering zone: 31,500 of 31,500 answered, 0 given up.**
- **Silent zone, its checks before their name's grace ends: 2,478 of 2,478 answered** from
  what the file kept.
- Silent zone, within 2,000 ms of a name's grace end (not asserted): 16 of 38 answered.
- Silent zone, past the grace: 0 of 984 answered, all 984 given up, as they should be.
- Answering names answered afresh, each served from the file until then: all 450, p50 31,361
  ms, last 31,376 ms.

## The outage scenario, 20 runs

`name-lookup-outage-scenario.test.ts` 20 times in a row in the same window, after the arm
(01:29 to 01:47): **20 of 20 runs passed, 5 of 5 cases each.** The last runs shared the host with
the three containers that came back (above). A run of 20 the day before, gated only on other
toolchain runs, failed 42 cases in 12 runs from the eighth, all waiting for the pool's workers
to start, at a load of 26 to 72 with the VM's swap full.
