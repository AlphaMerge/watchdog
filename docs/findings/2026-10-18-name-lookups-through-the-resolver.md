# A name lookup a scan through the probe's resolver, at 5,000 sensors (`P-426`)

2026-10-18, `P-426` and `P-425` at `5b6bbd2a`, run from `1c0bd332` (tickets only since).
`packages/probe/test/perf/name-lookups.test.ts`, every arm, at full size, once, in a quiet
window:

```
./scripts/dev.sh "timeout 3000 sh -c 'node scripts/perf-conditions.mjs; MS_DNS_WARM_MINUTES=7 MS_DNS_COLD_MINUTES=7 node --test --test-concurrency=1 packages/probe/dist/test/perf/name-lookups.test.js'"
```

This is the re-measure `A-66` asked for (`docs/findings/2026-10-17-name-lookups-a-scan.md`): the
same load, now through the resolver `P-426` put in the probe's main thread. That resolver keeps
answers 30 s, serves one at most 5 minutes past its expiry while the resolver does not answer,
holds a name it does not answer, ranks a lane's next lookup by domain, and runs at most 6 lookups
of libuv's 8.

**Conditions.** For the window:
- `ms-server` was stopped.
- The 11 containers of the other project on the VM were paused, at the user's word.
- No other toolchain run was going.

```
  perf run conditions
  ----------------------------------------------------------------
  load average   0.73 / 0.59 / 1.16  over 8 CPUs  (0.09 per CPU)
  delivered CPU  273 ms for a fixed loop  (1.02x the reference machine's 267 ms)
  database       nothing else is connected
  ----------------------------------------------------------------
```

**The case** is `A-66`'s:
- **Load:** 5,000 sensors at 60 s on 500 named devices, ten sensors a device.
- **Pool:** a real wheel and a real pool at its shipped ceiling (64 workers) and queue (1,000).
- **Each check:** `checkedTarget` with SNMP's 2,500 ms lookup bound, then 200 ms of work.
- **The resolver:** the real `NameResolver`, which each worker asks over its port.
- **The lookups:** the `system` arm is real `getaddrinfo` from the hosts file. The other arms give the resolver a model of libuv's lookup lanes: 8 lanes, first come first served, with the resolver taking 6 of them.
- **Duration:** one minute an arm, except two:
  - the warm zone arm answers for one scan and then runs 7 minutes with its zone silent, which reaches past the grace;
  - the cold zone arm runs 7 minutes.
- **Zones:** a silent zone is `zone-b.test`, one name in ten, beside `zone-a.test`. A silent lookup is 30 s and then `EAI_AGAIN`.

All six arms passed their assertions. The run took 20 minutes.

## The numbers

| Arm | Results | Answered | Given up | Refused | Jitter p50 / p95 / max | Check run p95 | Probe Health in flight, highest / last | `getaddrinfo` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| addresses | 5,000 | 5,000 | 0 | 0 | 5 / 210 / 272 ms | 208 ms | 0 / 0 | 0 |
| system resolver | 5,000 | 5,000 | 0 | 0 | 6 / 216 / 384 ms | 217 ms | 0 / 0 | 995 |
| 100 ms a lookup, cold | 5,000 | 5,000 | 0 | 0 | 6 / 1,626 / 2,496 ms | 1,335 ms | 51 / 0 | 995 |
| one zone in ten silent, warm (8 min) | 40,000 | 39,088 | 912 | 0 | 4 / 215 / 371 ms | 215 ms | 449 / 50 | 4,714 |
| every name silent, cold | 5,000 | 0 | 5,000 | 0 | 5 / 28 / 1,083 ms | 48 ms | 500 / 500 | 9 |
| one zone in ten silent, cold (7 min) | 35,000 | 29,249 | 5,751 | 0 | 6 / 214 / 1,069 ms | 214 ms | 483 / 49 | 5,106 |

`lookupsGivenUp` equalled the checks given up in every arm, as the case asserts.

The zone arms, by zone:

| Arm | Answering zone | Silent zone |
| --- | --- | --- |
| warm | 36,000 of 36,000 answered | served kept answers: 2,594 of 2,768 answered. Past the grace: 0 of 738, every one given up at once (p95 18 ms) |
| cold | 29,249 of 31,500 answered, 2,251 given up; all 450 of its names kept by 31,047 ms from the wheel's start (p50 31,041 ms) | 3,500 of 3,500 given up |

In the warm arm, the longest an answering name went between answers, counted from its last
answer before the silence, was 86,061 ms. The grace allows 330 s.

## Against `A-66`

`A-66` had two lanes, no cache and no holds, so warm and cold were the same thing there. Read
its zone arm against the warm arm for what one silent zone does to the rest, and against the
cold arm for a restart.

| Arm | `A-66` (run 2) | Now |
| --- | --- | --- |
| 100 ms a lookup | 58 answered, 2,465 given up, 2,477 refused; jitter p50 33.8 s | 5,000 answered, 0 given up, 0 refused; jitter p95 1.6 s in the first scan only |
| one zone in ten silent | 6 of the answering zones' 2,287 lookups answered; 2,458 refused; jitter p50 34.2 s | warm: the answering zone 36,000 of 36,000. Cold: 2,251 of its 31,500 given up in the first 31 s, then none; 0 refused |
| every name silent | all given up, 2,464 refused; jitter p50 34.0 s | all given up, 0 refused; jitter p95 28 ms |

**Both failures `A-66` measured are gone.** A slow resolver no longer takes the probe down. One
silent zone no longer takes the other zones' devices with it on a probe that has been running.
In no arm did a check get refused for a full queue.

## What it says

**A slow resolver costs one scan's jitter, cold.** First lookups may use 4 of the resolver's 6
lanes, which at 100 ms clears 40 new names a second. The first scan brings about 55 a second for
its first five seconds: 86 in the first tick, then 57, 42, 56 and 41. Each check of a name not
yet kept holds its worker while it waits. So the pool queues behind the lanes for about the first
11 seconds. The p95 check of 1,335 ms is about 1,035 ms of lane wait, roughly 41 lookups ahead of
it at 40 a second, plus the 100 ms lookup and the 200 ms of work. Nothing reached the 2,500 ms
bound.

It does not recur at each 30 s expiry. A check after expiry is served the kept answer at once,
and one refresh runs with nobody waiting on it. The 995 lookups are 500 first lookups and 495
refreshes. The cost returns only for a name with nothing kept: a new device, a denial that lapsed,
or a key not asked before.

**A warm probe loses nothing to a silent zone but that zone.**
- **The answering zone:** it answered every check. The silent zone's refreshes held the four lanes that refreshes may use, and up to 449 lookups were in flight. But every check that needed an answering name was served its kept answer meanwhile, and no answering name went more than 86 s without one.
- **The silent zone:** its own checks were served their kept answers through their grace, then failed at once, naming the resolver. Its sensors go Warning, then Down, from about 5½ minutes after their zone went silent.
- **The 174 inside the grace:** the 174 given up while kept answers were being served are a boundary effect, not early failures. The case buckets by one boundary, the silence plus 330 s. Each name's own grace ends at its own last answer plus 330 s, 9 to 37 s earlier.

**Every name silent fails fast, and the probe stays well.** Of 5,000 checks, 9 `getaddrinfo`
calls ran:
- 4 first lookups at about 1 s;
- 4 more when those ended, at about 31 s;
- 1 retry.

Every other check failed at once because its name was held, or because every lane its lookup
could use was stuck. That is why the check run p95 is 48 ms and the jitter p95 28 ms, below the
baseline's: failed checks skip the 200 ms of work. Nothing was refused.

**A probe restarted while a zone is silent fails about half the answering zone's first scan.**
This is the one case `P-426` leaves.
- **The cache is in memory,** so a restart keeps nothing. The answering names and the silent names are all first lookups, and in the first scan's first ticks four silent names take the four first-lookup lanes and hold them for the silent lookup's 30 s.
- **What fails.** From then until those lookups end, every answering-zone check for a name not yet kept fails at once, naming the resolver. That came to 2,251 checks in ticks 1 to 31. 17 answering names were kept before the lanes filled.
- **What recovers.** The first silent lookup ended at 31,041 ms, the first tick plus 30 s. The 433 answering names queued behind it were kept within about 10 to 14 ms of that, and none of the answering zone's checks failed after 31,047 ms.
- **How it scales.** The failing span is how long `getaddrinfo` takes to give up on a silent name, once that is longer than the roughly 27 s it takes for every name to be checked once. It moves one for one with that time: about 75 answering checks a second times the span. glibc's `timeout` and `attempts` in `/etc/resolv.conf` bound it, and so does a recursive resolver's own SERVFAIL time, whichever ends first. This repository cannot say what those come to on a given host; the model's 30 s is one setting.

**What an operator sees after such a restart** (from the code and the defaults, not measured):
- **Sensor states.** Under the default `scan.retryWarnings` of 1, each sensor scanned in that span goes Warning once and clears at its next scan. Here that is about 2,250 sensors, on nearly all 450 healthy devices, since sensors' start times are hashed. A sensor at an interval of 15 s or less scans at least twice in the span and goes Down briefly. At 20 to 25 s, some do.
- **Notifications.** A fresh install has no triggers, so nothing notifies. A Down-only trigger sends nothing for sensors at 60 s. A Warning trigger at latency 0 sends the default 900 s digest, capped at 25 lines a message: at least 91 messages for the Warnings alone.
- **Dependencies don't absorb it.** A device's Ping is resolved by the ping binary, not this resolver, so the master stays Up and nothing is paused.
- **So this breaks "one outage, one alarm"** for an operator with a Warning trigger, or with sensors scanned more often than every 30 s.
- **New names keep failing for a while.** For about 5½ minutes after the restart, until the silent zone's names have each failed once, a name with nothing kept fails its first scans: a device added meanwhile, or one asked less often than every 330 s.

**Probe Health records it but does not flag it.**
- `lookupsInFlight` reached 449 to 483 in both zone arms, the warm one included, where no check failed. Afterwards it reads about 50, the names not answering.
- `lookupsGivenUp` equals the failed checks.
- Neither has a limit, so Probe Health stays Up. The resolver is named only by the failing sensors' messages and by a warning in the probe's log once a minute.
- `lookupsGivenUp` is stored as a rate, and a counter that falls is read as a reset. So after a restart, the first record may hide what was given up before it.

## What it decides

**The other session's condition for `P-426`, that both measured failures be removed, is met.**
The slow arm's failure is gone, and so is the one-zone failure on a running probe. The cold arm
no longer collapses: nothing is refused, and jitter p95 is the baseline's.

**The user's rule** was to build the `getaddrinfo` slice, re-measure, and decide c-ares (`P-432`)
for 1.0 or 1.0.1 if the restart case is still bad. **It is still bad, as above.** The user
decided on 2026-10-18:
- `P-438`, the answer cache kept across a restart and served stale while it refreshes, goes into 1.0.
- `P-432`, c-ares, is built for 1.0 too: behind a per-probe setting whose default stays `system` in rc.3, turned on for every probe in the field test, and after a clean week the default is decided again.

**What each covers, read from this run:**
- **`P-438` covers a restart inside the grace.** The answering names are served their kept answers from the first scan, with `getaddrinfo`'s semantics unchanged. It does not cover a name with nothing kept: a device added during the outage, a first install, or a restart after an outage longer than the grace.
- **`P-432` covers those too, but only where it is turned on, and only if its design lets a silent query hold no lane.** A silent c-ares query holds no libuv thread. But if the resolver kept its 4-lane cap on first lookups, a cap set for `getaddrinfo`'s lanes, the cold arm's failures would scale with c-ares's own timeout rather than fall to 0. Its design must say what the caps and the fail-fast mean for a backend with no lanes. Re-run this case's arms against it, as `P-432` requires.
- **Neither covers a device under `targetPolicy: none`** (`P-433`). Its names skip the resolver, so `A-66`'s collapse is still there for them.

## What the case does not show

- **The lanes are a model, not `getaddrinfo` against a DNS server that goes silent.** The 30 s is one setting of what glibc and the upstream resolver take to give up.
- **Not shown, only read from the code:**
  - sensors at intervals other than 60 s;
  - a probe with triggers;
  - whether the slow arm's first scan moves Probe Health's `schedulerLag` or `poolUsage`.
- **The pool is fixed at 64 here, so `P-437`'s gate is not exercised.**

## Follow-ups

- **`P-438`** (1.0) and **`P-432`** (1.0, opt-in), as decided. Re-run the cold zone arm against each and read the numbers against the 2,251 and the 31 s above.
- **`P-441`:** Probe Health does not flag a resolver that is not keeping up, and the restart burst can hide behind a counter reset.
- **`administration.md`'s name-resolution section said a silent zone "cannot hold the lanes the rest of the probe's names are asked on".** On a warm probe it holds the refresh lanes, harmlessly while answers are kept. The section now says so, and points here for the restart case.
- **The release notes' name-resolution item still describes the state before `P-426`.** It is rewritten at the rc.3 cut, once `P-438` and `P-432` have landed.
