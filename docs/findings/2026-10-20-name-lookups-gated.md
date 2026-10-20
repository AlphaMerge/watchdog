# The name gate at 5,000 sensors: its perf arms (`P-432` S7)

2026-10-20, `P-432` S7 on `feat/p432-s7-perf` (on `a95c3302`, `integ/r5-1019`: S3, S6 and S8
integrated). `packages/probe/test/perf/name-lookups.test.ts`, the second and third blocks. **This
file has the method and the command. The results are owed to a quiet window:** every number below
the results heading is `TODO(quiet-window)`. The scaled-down runs that proved each arm executes are
not results and are recorded only as that.

## What is measured, and on what

`P-426`'s arms (the first block, `docs/findings/2026-10-18-name-lookups-through-the-resolver.md`
and `2026-10-19-name-lookups-answer-file-and-lanes.md`) model `getaddrinfo` as libuv's lanes, with
no DNS behind them: a name's kind says what its lookup does. That cannot measure the gate, whose
whole point is what reaches the site's DNS server and in what order: the walk's questions, the
probe lanes' and the helper's. So the gate's arms run each arm in each mode
`MS_DNS_RESOLVER` names, `system` and `gate`, on one world:

- **The site's DNS server** is the DNS simulator (`P-432` S5, `@ms/simulators`), in its own worker
  so that it answers on time whatever the probe's main thread is doing. It plays dnsmasq:
  `dns-forward-max` 150 with 120 slots held by other clients (`occupy`), so 30 are left for the
  probe; a slot held 10 s for an upstream that does not answer; identical questions merged
  (dnsmasq 2.83 on). In P1, P2 and `forwarder` it merges only a client's own resend and goes
  silent when full, as dnsmasq before 2.83 does: the forwarder at which D16's transient after a
  helper loss exists. Zone `zone-a.test` answers at once, `zone-b.test` is silent or goes silent
  (in `forwarder`, as a hundred keys `k<n>.zone-b.test`), `zone-s.test` answers after
  `MS_DNS_SLOW_MS` (100 ms), `zone-c.test` is silent. No recursion cache, except in `partial`.
- **`getaddrinfo` is a model of glibc's wire** (`test/support/glibc-model.ts`), over real UDP: one
  socket a lookup; every type of the family sent together, each with its own ID, which each try
  sends again; a try every `timeout` seconds, `attempts` tries; SERVFAIL or REFUSED moves to the
  next try at once. The world's resolv.conf says `options timeout:15 attempts:2`, so a silent name
  gives up at 30 s, as the lane model's silent zone does (`MS_DNS_HANG_MS`), in a shape glibc has.
  The probe's own lanes ask with it in the test's process, from 127.0.0.2; the helper's child with
  it in its own, from 127.0.0.3.
- **The model is held to glibc, not to the name policy.** Its table (`GLIBC_QUESTIONS`) is its
  own, never `system-names.ts`. The third block holds it to every recording of D30's recording (A)
  that it can play (`system-names-recordings.json`: a walk with one server, one candidate, no
  `rotate`, nothing in the environment, under the `answer`, `nxdomain` or `all-silent` plan): 427
  recordings, 217 of family 0, 84 of family 4 and 126 of family 6, 21 of them silent, in all seven
  images. The wire must be the table's exactly, try by try, and a silent plan must have taken its
  tries' waits and less than a second more. Four wrong tables are shown to fail it.
- **The walk is the shipped check**: c-ares (`caresAsker`) asking the simulator, counted on the
  way. **The helper** is the real `LookupHelper`, forking the real child (`runHelperChild`) over the
  model (`test/support/dns-world-child.ts`), its channel read on the way for what it is asked and
  says. **The policy** is the real `GlibcNamePolicy` on a hosts file, resolv.conf and nsswitch.conf
  the arm writes, so the check is on (state 1, proven by its canary) before the wheel starts.
  `buildNameResolution`, the build `main.ts` calls, builds all of it. **The pool, the wheel and
  Probe Health** are `P-426`'s: 5,000 sensors at 60 s on 500 devices, a real pool of 64 workers,
  SNMP's 2,500 ms lookup bound and 200 ms of work after it.

## Asserted in every arm, and why

All of it is `test/support/name-gate-judge.ts`, a pure function of what the arm measured, so that
each assertion is shown failing on a run made to break it (the third block, 34 such cases), and is
not only ever seen passing.

| Assertion | Why |
| --- | --- |
| `system`: the forwarder's most slots held at once for the probe ≤ q × 6 | P-426's six lanes are its bound (§1.6). q is 1: SNMP's family 4 asks one question. |
| gate: ≤ q × 6 + 12, and + 8q in P1 and P2 | D16: six tokens, the walk's heard 8 and discovery 4; the transient for 10 s after a loss at a forwarder that merges per client. |
| No question dropped at the forwarder | 30 slots are left for the probe: a bound broken by more than 12 shows as drops, not only as a peak. |
| `system` asks no walk question | `system` is P-426 with P-438 exactly (N9). |
| gate: the walk's questions to each server within D19's bucket | 20 at once, refilled at 10 a second, with one more for the time between a token and its datagram. Check now's walk is cut (S6), so every question the check sends counts. |

**Printed in every arm**: results by group; refused, deferred, timed out; jitter and check run time;
event-loop delay p50, p99 and max (`monitorEventLoopDelay`, net of its 10 ms resolution); Probe
Health's `lookupsInFlight` and `lookupsGivenUp`; the forwarder's peak, its drops, and its questions
by source (walk, probe lanes, helper); the budget's own `questionsOpen` peak; the walk's questions,
its busiest second and any past the bucket; routes by kind and pool, with each unvouched reason;
sampled; keys routed both heard and silent; `getaddrinfo` on the probe's lanes and in the helper by
group; the gate's Probe Health counters; the helper's state, losses, poisoned names, children,
`stuck` messages and resident set; `lookupHelperTrouble`.

## The arms

| Arm | World | Modes | Asserted, besides the above | Read |
| --- | --- | --- | --- | --- |
| `slow` | every name 100 ms, cold | both | 0 given up, 0 refused | check run p95 (overflow is cut, so no overflow lanes) |
| `warmzone` | a scan interval answering, then zone b silent (one name in ten) | both | the answering zone 0 given up. Gate: after the silence, zone b on the probe's lanes only as sampled refreshes, at most `SAMPLED_PER_KEY` (2), none first or retry; each answering name's longest gap between answers ≤ 30 s + its own longest gap between checks + 1 s; at steady state (from 60 s after the silence) the walk ≤ 1 + keys × q = 3 a second | the longest gap |
| `zone` | zone b silent, cold | both | gate: the answering zone 0 given up; zone b never on the probe's lanes; zone b at most 3 of the helper's lanes at once; each answering name kept within 1 s of its first ask | `system`'s numbers beside it |
| `partial` | zone b silent upstream, half its names in the forwarder's cache, cold | both | gate: the answering zone and the cached names 0 given up; zone b's uncached names never on the probe's lanes; with the check on, zone b at most 3 in the helper | `system`'s and check-off's lanes |
| `steady` (new) | every name answering in two zones, a scan interval then `MS_DNS_STEADY_MINUTES` | both | 0 given up; gate: the walk ≤ 1 + keys × q = 3 a second at steady state (from the scan interval plus 30 s) | the walk against the probe lanes' `getaddrinfo` rate |
| P1 | zone, the child SIGKILLed at 5 s and 95 s, per-client forwarder | gate | the answering zone 0 given up; zone b never on the probe's lanes; 2 `exit` losses and no other; `lookupHelperTrouble` 0; the forwarder's peak ≤ 26 | each child's lookups |
| P2 | zone, the child SIGSTOPped at 10 s, per-client forwarder | gate | as P1, with 1 `hung` loss; from the stop, the route off `up` by 4 s, the `hung` loss by 22 s, the next child up by 23 s | checks failed meanwhile |
| P3 | zone, the main thread held 15 s at 40 s | gate | no helper loss, and the helper never judged not answering; no zone marked unsafe and no answering name said passed-stuck by the stall (D25); a probe-lane lookup of an answering name in flight as it began | given up by the stall itself |
| `forwarder` | three devices in five silent, 300 names over 100 keys (`k<n>.zone-b.test`) and 200 answering, cold, at a forwarder that merges per client and goes silent when full | both | gate: the answering zone 0 given up. `system`: only every arm's (0 dropped) | `system`'s answering given up beside the gate's; routes by kind |
| P5 | every name answering, the child SIGKILLed 4 times 30 s apart, the pool at its full size | gate | 0 given up; fork to `ready` ≤ 1,000 ms; the event loop's most within 1 s of each fork ≤ its most in the 20 s before the first kill + 100 ms; the helper's resident set at 55 s ≤ 128 MB | each fork's time; the probe's resident set at each kill |
| P5b (new) | P5, with the pool's ceiling held to half its size by memory | gate | as P5, and held at the memory gate at every kill | as P5 |
| P6 (new) | one name whose `getaddrinfo` crashes the child, its zone silent | gate | 3 `exit` losses and no other; one name poisoned; the answering zone 0 given up; the crash name never asked on the probe's own lanes | the latch |

## What was built differently from the design, and why

Decided 2026-10-20 by Claude, under the user's delegation (also in `docs/TASKS.md`, under S7):

- **A world, not the lane model.** The gate's invariants are about the site's DNS server, so the
  arms ask a forwarder. `P-426`'s arms stay as they are, in the first block, so their committed
  numbers stay comparable; the blocks' names overlap and `MS_DNS_ARMS` takes `world/<name>` and
  `lanes/<name>`.
- **The gate's arms are skipped while `MS_DNS_RESOLVER` is unset.** Twelve arms, six of them in
  both modes, take about half an hour at the default's minute an arm, past the coffee break
  CLAUDE.md keeps `test:perf` to, whose name-lookup arms already take about ten. A default run
  prints how to run them and still holds the model to glibc and the judge to its cases, which take
  no time.
- **"Walk questions a second ≤ 10" is D19's bucket**, 20 at once and 10 a second after. Read
  literally, every second at most 10, it would fail at a cold start by D19's own burst.
- **A silent lookup is 15 s × 2 tries, not 5 s × 6.** The design's model resends every 5 s and
  gives up at `MS_DNS_HANG_MS`; at its 30 s that is six tries, which glibc never makes
  (`RES_MAXRETRY` 5), and a table held to glibc's recordings cannot play it. `timeout:15
  attempts:2` gives up at the same 30 s, and each try outlasts the forwarder's 10 s hold, so a
  lookup that gives up holds no slot after it ends.
- **Mixed keys are printed as "keys routed both heard and silent"**, from the resolver's debug
  log. The check's own `mixedKeys` is not exposed, and the hourly summary that logs it does not
  fall inside an arm. No production hook was added: the routes, their pools and the unvouched
  reasons come from the same log line (`routed a lookup`).
- **P3's "no helper lookup with `ranMs` ≤ 1,000 judged stuck"** is asserted as "the helper never
  judged not answering, and no loss": only the child says stuck (D4), on its own clock, so the
  probe's stall can make the probe judge a helper lookup only by judging the child, which those
  two catch. The stall is begun the moment a probe-lane lookup of an answering name has sent its
  question, so that its reply waits in the socket and its stuck timer is due through the stall:
  the case D25's marks must survive.
- **S6's cuts, as each arm adapts:** overflow (1) is cut, so `slow` reads its check run p95 with
  no overflow lanes; the pressure detector (3) is cut, so nothing is asserted of walks off at a
  server (`nameCheckState` never reads 5); per-name walks of a key's queued lookups when it is
  heard again (4) are cut, so no arm asserts recovery speed; Check now's walk (5) is cut, so no arm
  asks Check now and every walk question counts against the bucket.
- **P5 and `forwarder` are built, though S7's list names only the arms round 3 changed.** The
  design's verdict on `gate` as the field test's setting (under its open risks) needs both
  committed beside P5b, P1 to P3, P6, `steady` and the full-size `zone`, `warmzone` and
  `partial`, and the user has decided the field test sets `gate`. In this world each is an arm's
  settings: P5 is P5b without the memory gate, and `forwarder` is round 2's row with its keys
  spread under zone b.
- **Not in S7's list, so not built here:** P4 (`helperipc`), `hung`, `hungdead`, `spread`,
  `deaf`, `warmbig`, `singles`, `spread10`, `deadns1`, `walkrate` and `walkmemory`. The verdict
  also needs `spread10` and `walkrate`'s event-loop p99 read before the runbook sets `gate`:
  `P-465`.

## How each arm was shown to run

Scaled down to 500 sensors on 50 devices, a pool of 16 and a minute an arm, on the VM with other
sessions' runs beside it, not a quiet machine, so nothing here is a measurement. The ten arms S7's
list names, the two added after them (P5 and `forwarder`), and `partial` with the check off:

```
./scripts/dev.sh "timeout 2600 sh -c 'cd packages/probe && npx tsc -b && MS_DNS_SENSORS=500 MS_DNS_POOL=16 MS_DNS_MINUTES=1 MS_DNS_WARM_MINUTES=1 MS_DNS_COLD_MINUTES=1 MS_DNS_STEADY_MINUTES=1 MS_DNS_RESOLVER=system,gate MS_DNS_ARMS=world/slow,world/warmzone,world/zone,world/partial,world/steady,P1,P2,P3,P5b,P6 node --test dist/test/perf/name-lookups.test.js'"
./scripts/dev.sh "timeout 1400 sh -c 'cd packages/probe && npx tsc -b && MS_DNS_SENSORS=500 MS_DNS_POOL=16 MS_DNS_MINUTES=1 MS_DNS_COLD_MINUTES=1 MS_DNS_RESOLVER=system,gate MS_DNS_ARMS=world/forwarder,P5 node --test dist/test/perf/name-lookups.test.js'"
./scripts/dev.sh "timeout 540 sh -c 'cd packages/probe && MS_DNS_SENSORS=500 MS_DNS_POOL=16 MS_DNS_COLD_MINUTES=1 MS_DNS_CHECK=off MS_DNS_RESOLVER=gate MS_DNS_ARMS=world/partial node --test dist/test/perf/name-lookups.test.js'"
```

Every arm ran in every mode it runs in and held every assertion: 15 runs in 1,424 s, 3 in 293 s,
and 1 in 67 s. What the runs show is that each arm reaches what it asserts, not that it holds at full
size:

- **The bound and the walk were exercised, not idle.** The gate's runs walked 49 to 182 questions,
  their busiest second 9 to 13 and none past the bucket; the forwarder's most slots held for the
  probe was 0 to 12 of the gate's 18 and 0 to 5 of `system`'s 6, and nothing was dropped.
- **Zone b went where the gate sends it.** In `zone`, `partial` and P1 to P3, its names were
  routed `silent/helper` (6 to 11 routes), held at most 3 of the helper's lanes, and were never
  on the probe's lanes, where `system` put them (6 lookups, 3 at once, in `zone`). Each answering
  name in `zone` was kept within 177 ms of its first ask in `system` and 93 ms in the gate.
- **`forwarder` shows the difference the gate is for**, even scaled down: 30 silent names over 10
  keys left `system` answering 24 of its 200 answering checks, the gate all 200, with 13 lookups
  routed `unvouched (budget)` to the helper.
- **The helper's arms did what each was set up to do.** P1: two `exit` losses, the latch at 0.
  P2: off `up` 3.8 s after the SIGSTOP, `hung` at 20.8 s, the next child up at 20.9 s. P3: the
  stall held 15.0 s with a probe-lane lookup of an answering name in flight, and left no zone
  unsafe and nothing passed-stuck; 3 answering checks failed in it, which P3 reads and does not
  assert. P5 and P5b: four forks, ready in 57 to 274 ms and 87 to 99 ms, the event loop's most
  around each 6 to 38 ms against a baseline of 36 to 63 ms, the helper at 51 to 52 MiB; P5b's
  pool at its memory gate at every kill (ceiling 8 of 16), P5's at its full 16 with the probe at
  858 MiB. P6: three `exit` losses, the crash name poisoned and never asked on the probe's lanes.
- **The check off is the gate with every name unvouched.** `partial` with `MS_DNS_CHECK=off`:
  `nameCheckState` 2, no walk, every lookup routed `unvouched (off)` to the helper, the answering
  and cached names 0 given up.
- **Read, not asserted:** after four kills in two minutes `lookupHelperTrouble` reads 1 in P5 and
  P5b, as D27's three failures in ten minutes say it should, and P6 logs the poisoned name once.

## The quiet-window command

With `ms-server` stopped and no other toolchain run, after a build of its own
(`./scripts/dev.sh "timeout 600 npx tsc -b"`):

```
./scripts/dev.sh "timeout 9000 sh -c 'node scripts/perf-conditions.mjs; MS_DNS_RESOLVER=system,gate MS_DNS_WARM_MINUTES=7 MS_DNS_COLD_MINUTES=7 MS_DNS_STEADY_MINUTES=10 MS_DNS_ARMS=world/slow,world/warmzone,world/zone,world/partial,world/steady,world/forwarder,P1,P2,P3,P5,P5b,P6 node --test --test-concurrency=1 packages/probe/dist/test/perf/name-lookups.test.js'"
```

About 100 minutes: `slow` 1 minute a mode, `warmzone` 8, `zone`, `partial` and `forwarder` 7,
`steady` 11, P1 2¼, P2 1, P3 1¼, P5 and P5b 2½, P6 1, each with its pool's start and drain.
`MS_DNS_ARMS` leaves out the lane model's arms, whose numbers are the third and fourth windows';
leave it out to re-take those too (about 20 minutes more). The check-off half of `partial` is a
second run, about 8 minutes:

```
./scripts/dev.sh "timeout 1200 sh -c 'MS_DNS_CHECK=off MS_DNS_RESOLVER=gate MS_DNS_COLD_MINUTES=7 MS_DNS_ARMS=world/partial node --test packages/probe/dist/test/perf/name-lookups.test.js'"
```

## Results

TODO(quiet-window): the perf conditions, and each arm's printed row in both modes.

| Arm | `system` | gate |
| --- | --- | --- |
| `slow` | TODO(quiet-window) | TODO(quiet-window) |
| `warmzone` | TODO(quiet-window) | TODO(quiet-window) |
| `zone` | TODO(quiet-window) | TODO(quiet-window) |
| `partial` | TODO(quiet-window) | TODO(quiet-window) |
| `steady` | TODO(quiet-window) | TODO(quiet-window) |
| `forwarder` | TODO(quiet-window) | TODO(quiet-window) |
| P1 | — | TODO(quiet-window) |
| P2 | — | TODO(quiet-window) |
| P3 | — | TODO(quiet-window) |
| P5 | — | TODO(quiet-window) |
| P5b | — | TODO(quiet-window) |
| P6 | — | TODO(quiet-window) |

TODO(quiet-window): whether each assertion held at full size, and what the read-only rows say
(`slow`'s check run p95, `warmzone`'s longest gap, P2's checks failed while the child was stopped,
P3's given up by the stall, P5's and P5b's forks).
