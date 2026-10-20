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
- **The model is held to glibc, not to the name policy, in two steps.** Its table
  (`GLIBC_QUESTIONS`) is its own, never `system-names.ts`. The third block holds the table's wire
  to every recording of D30's recording (A) that it can play (`system-names-recordings.json`: a
  walk with one server, one candidate, no `rotate`, nothing in the environment, under the
  `answer`, `nxdomain` or `all-silent` plan): 427 recordings, 217 of family 0, 84 of family 4 and
  126 of family 6, 21 of them silent. Every family and the silent plans are compared in each of
  the seven images by name, not by a count one image could clear. The wire must be the table's
  exactly, try by try, and a silent plan must have taken its tries' waits and less than a second
  more. Four wrong tables are shown to fail it. Then it plays `glibcLookup`, the code the arms ask
  with, at the DNS simulator on loopback (families 0, 4 and 6, each plan, `timeout:1 attempts:2`)
  and holds what reached the simulator, try by try, and when it gave up, to the table's wire and
  schedule, so that the code that runs is the code held to the recordings.
- **What the model does not play:** a try that ends with some of a family's types answered and
  not every one. glibc then asks them one at a time on the same try (`single-request`, then
  `single-request-reopen`) and answers with what it got, which no recording has; the model ends
  the lookup with its own code, `EMODELPARTIAL`, which an arm would count as a failure. No arm
  meets it: SNMP's family 4 asks one type.
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
each assertion is shown failing on a run made to break it (the third block, 75 such cases, one for
each assertion and for each rule's call of the ones rules share), and is not only ever seen
passing.

| Assertion | Why |
| --- | --- |
| `system`: the forwarder's most slots held at once for the probe ≤ q × 6 | P-426's six lanes are its bound (§1.6). q is 1: SNMP's family 4 asks one question. |
| gate: ≤ q × 6 + 12 = 18; in P1 and P2, 8q more only in each loss's window | D16: six tokens, the walk's heard 8 and discovery 4; the transient for at most 10 s after a loss, at a forwarder that merges per client. P1 and P2 read the forwarder's peak in windows cut at each loss and 10.5 s after it (`gauge` with `resetPeak`), the half second being the read's own round trip and timer: the windows after a loss are held to 26 and every other stretch, the cold start included, to 18. The windows must reach the arm's end, and a read that failed fails the arm, since the stretch it ends was held to nothing. P2's losses are seen by a poll that reads the peak before each look, so the window that read closed is the loss's too: its transient can form before the look. Each run of windows with the transient is judged as one, since P2 cuts one at every look until its `hung` loss, and must lie where the losses' own times put it: from the loss, or a second before a poll saw it, to 10.5 s and a late timer's second after it, the stretches of losses that meet taken together. The times are the arm's stamps (P1's kills, P2's look), not the windows'. |
| No question dropped at the forwarder | 30 slots are left for the probe: a bound broken by more than 12 shows as drops, not only as a peak. |
| `system` asks no walk question | `system` is P-426 with P-438 exactly (N9). |
| gate: the walk's questions to each server within D19's bucket | 20 at once, refilled at 10 a second, with one more for the time between a token and its datagram. Check now's walk is cut (S6), so every question the check sends counts. |
| Nothing left asking on the probe's lanes once the arm is torn down | The model's lookups hold a socket and a 15 s timer each, and the resolver's `stop` lets its lane lookups run and starts what it has queued as each ends; torn down without closing the model, they ran into the next arm's measured window. |

**"Given up" in the arms' rows means more than the words.** Where an arm says a group's checks are
0 given up, it asserts that every one of them answered: none failed naming the resolver
(`the probe’s resolver is not answering`), and none failed in any other way. The gate's own
refusals (a poison name, an avoided one while the helper rests or is down) and a lookup lost with
the helper end `RESOLVER_FAULT`, which the check words as "could not be resolved", never as given
up, so a bound on the words alone could not see the gate failing names that answer.

**Printed in every arm**: results by group; refused, deferred, timed out; jitter and check run time;
event-loop delay p50, p99 and max (`monitorEventLoopDelay`, net of its 10 ms resolution); Probe
Health's `lookupsInFlight` and `lookupsGivenUp`; the forwarder's peak, its drops, and its questions
by source (walk, probe lanes, helper); the budget's own `questionsOpen` peak; the walk's questions,
its busiest second and any past the bucket; routes by kind and pool, with each unvouched reason;
sampled; keys routed both heard and silent; `getaddrinfo` on the probe's lanes and in the helper by
group; the gate's counters (`GateHealth`: Probe Health's, and those its hourly summary logs); the helper's state, losses, poisoned names, children,
`stuck` messages and resident set; `lookupHelperTrouble`; the process's resident set at the
wheel's start, its most at a 1 s sample and at the drain, and its file descriptors before the arm
and once it is torn down (`/proc/self/fd`); the resolver's most running and queued at a 1 s sample;
the walk's channels and their busiest second; the lookups each of the helper's children was asked,
by group; in P1 and P2 the forwarder's peak by window (runs of windows of one kind merged, with the
number read, the arm's end and the losses' times); in P3 the replies the simulator sent to every client while the main
thread was held, and its own lookup's three facts with how long after the stall it was answered.
Not printed, by decision (below): the helper's at-risk peak, first looks, overshoot and class caps
hit.

## The arms

| Arm | World | Modes | Asserted, besides the above | Read |
| --- | --- | --- | --- | --- |
| `slow` | every name 100 ms, cold | both | 0 given up, 0 refused | check run p95 (overflow is cut, so no overflow lanes) |
| `warmzone` | a scan interval answering, then zone b silent (one name in ten) | both | the answering zone 0 given up. Gate: after the silence, zone b on the probe's lanes only as sampled refreshes, at most `SAMPLED_PER_KEY` (2), none first or retry; each answering name's longest gap between answers ≤ 30 s + its own longest gap between checks + 1 s; at steady state (from 60 s after the silence) the walk ≤ 1 + keys × q = 3 a second | the longest gap |
| `zone` | zone b silent, cold | both | gate: every answering check answered (31,500 of 31,500 at full size) and none refused; zone b never on the probe's lanes; zone b at most 3 of the helper's lanes at once; each answering name kept within 1 s of its first ask | `system`'s numbers beside it |
| `partial` | zone b silent upstream, half its names in the forwarder's cache, cold | both | gate: the answering zone and the cached names 0 given up; zone b's uncached names never on the probe's lanes; with the check on, zone b at most 3 in the helper | `system`'s and check-off's lanes |
| `steady` (new) | every name answering in two zones, a scan interval then `MS_DNS_STEADY_MINUTES` | both | 0 given up; gate: the walk ≤ 1 + keys × q = 3 a second at steady state (from the scan interval plus 30 s) | the walk against the probe lanes' `getaddrinfo` rate |
| P1 | zone, the child SIGKILLed at 5 s and 95 s, per-client forwarder | gate | the answering zone 0 given up; zone b never on the probe's lanes; 2 `exit` losses and no other; `lookupHelperTrouble` 0; the forwarder's peak ≤ 26 in the 10.5 s after each kill and ≤ 18 everywhere else | each child's lookups, by group |
| P2 | zone, the child SIGSTOPped at 10 s, per-client forwarder | gate | as P1, with 1 `hung` loss, the windows after the detach (the route leaving `up`) and after the `hung` loss, each from the read before the look that saw it; from the stop, the route off `up` by 4 s, the `hung` loss by 22 s, the next child up by 23 s | checks failed meanwhile (the silent zone's) |
| P3 | zone, the main thread held 15 s at 40 s | gate | no helper loss, and the helper never judged not answering; no zone marked unsafe and no answering name said passed-stuck by the stall (D25); the stall begun on a probe-lane lookup of an answering name whose reply waited through it: the reply sent before the stall ended, by the simulator's log; the lookup still open as the stall began; and answered after it | given up by the stall itself; how long after the stall its lookup was answered |
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
  server (the check's state never reads 5); per-name walks of a key's queued lookups when it is
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
  `P-465`. The rest are decided in the review's round below.

### The review's first round (2026-10-20)

Decided 2026-10-20 by Claude, under the user's delegation (also in `docs/TASKS.md`, under S7):

- **"0 given up" means every check answered.** The judge had only the given-up count, the checks
  that failed in the resolver's words for a name it did not hear, so an answering check failed in
  any other way was counted and never judged: the gate's own refusals and a lookup lost with the
  helper (`RESOLVER_FAULT`), `RESOLVER_BUSY` or `ENODATA`. Each group's failures otherwise now go
  to the judge beside its given up, and every rule that names a group fails both. P3 alone reads
  its stall's failures and asserts none, as the design's P3 row reads them. `P-426`'s block
  already asserted the same (`answering.other`) for `warmzone` and `zonefile`.
- **`zone` in gate mode asserts no check refused**, beside every answering check answered: the
  design's "answering 31,500 of 31,500" is every check run, and one refused at the pool is one
  that never came back.
- **The transient is a window after each loss, not the run.** A peak read once for the run held
  P1 and P2 to 26 everywhere. The forwarder's peak is now read in windows: P1's losses are its
  kills; P2's are the detach (its lookups in flight let go and their names asked elsewhere, D26)
  and the `hung` loss, since the SIGSTOP itself asks nothing again. A loss's window runs 10.5 s:
  a lost child's questions were all sent by the loss and are let go `FORWARD_HOLD_MS` after it,
  and the half second is the gauge's round trip and the timer's rounding. A window ends as its own
  loss's, wherever its timer fires, and the next takes the transient only from a later loss. The
  judge also fails a window with the transient that ran more than a second past that (a late
  timer), a stretch of the run not read, and no window read at all.
- **The code the arms ask with is held to the table, and sends every type at each try.**
  `glibcWire` was held to the recordings and `glibcLookup`, which the probe's lanes and the
  helper's child run, to nothing. The third block now plays `glibcLookup` at the simulator. It
  resent only the types that had not answered; it now sends every one at each try, as the table
  and glibc's silent recordings do, and ends a try left with some types answered with its own code
  rather than play a wire no recording has (above).
- **The recordings cover each image by name**, every family and the silent plans in each of the
  fixture's images. A count of 7 a family and 14 silent was cleared by one image alone.
- **The model has a stop.** `glibcLookup` returns a `close` that ends every open lookup at once
  (`EAI_AGAIN`, its timer cleared, its socket closed) and fails every later one before it asks; the
  world closes the probe's lanes before it stops the resolver, and each arm asserts that nothing is
  left asking on them. The resolver's own `stop` lets its lane lookups run, and `#pumpProbe` starts
  the next one queued as each ends, whether stopped or not. That is production code, a probe exits
  after it, and S7 changes no production code: left to the orchestrator to ticket.
- **P3's setup is read from the simulator's log.** "A probe-lane lookup in flight as the stall
  began" was true by construction: it was read in the send callback of a lookup already counted.
  The fact is now that the reply to the stall's own question was sent before the stall ended, by
  the log of the simulator, which answers in its own thread: so it waited unread in the probe's
  socket while its lookup's stuck timer came due. It can be false, and was shown to be with a
  model that begins the stall before its question is sent.
- **Round 2's reads, as built.** Printed now in every arm: the change in file descriptors, the
  process's resident set across the arm, the resolver's most running and queued, the walk's
  channels and their busiest second, and each of the helper's children's lookups (P1's "each
  child's lookups"). Datagrams a second are the questions by source over the arm's length. Not
  printed: the helper's at-risk peak, first looks, overshoot and class caps hit. The resolver
  keeps the at-risk peak only for its hourly summary, which no arm of at most 11 minutes reaches,
  and exposes none of the other three; S7 changes no production code, and the arm that asserts
  them is `spread10` (at risk ≤ 5 plus the overshoot counted), so the hook belongs to `P-465`. The
  helper's queued peak is the resolver's queued, both lane sets: the helper has no queue of its
  own.
- **Round 2's other arms are not 1.0's.** Not built, with what each asserted:
  - `hung`, every name silent, cold: 0 refused; jitter p95 ≤ max(2×, + 100 ms) of `addresses`';
    no `getaddrinfo` on the probe's lanes; the helper ≤ 5;
  - `hungdead`: as `hung`, with the check unproven;
  - `spread`, 50 silent domains: the answering zone 0 given up; the helper ≤ 5 + 2;
  - `deaf`: the answering zone 0 given up; misses ≥ 3; zone a skipping;
  - `warmbig`, the check off: zone a 0 given up; zone b ≤ 4 at every 1 s sample, ≤ 3 after its
    first episode;
  - `singles`, 500 single labels with 40 silent, the check on and off: on, `sw-a` 0 given up and
    `d:b.corp` ≤ 3; off, given up ≤ `system`'s;
  - `deadns1`: read only (queue, wait, stale serves, given up in both modes);
  - `walkmemory`: 100,000 walks, RSS flat within 32 MB;
  - P4 `helperipc`: read only (hosts-file names forced through the helper: IPC p95, event-loop
    p99).

  Why: the design's verdict names what `gate` as the field test's setting needs, the arms built
  here and `P-465`'s, and none of these is in it. What they assert at full size is held at the
  unit and scenario level: the key rule and the at-risk gate (`lane-rule.test.ts`,
  `helper-lanes-model.test.ts`), misses and the stand-down (`dns-check.test.ts`), single labels
  and the check off (`name-resolver-gate.test.ts`'s K4, the M-17 scenarios SC11 and SC12).
  `walkmemory`'s bound is held nowhere, and `deadns1` belongs with the design's deferred "dead
  first nameserver" ticket, which is not filed. Each is an arm's settings in this world, so
  building any of them later is small; if they are wanted after 1.0, one ticket, for the
  orchestrator to number.

### The review's second round (2026-10-20)

Decided 2026-10-20 by Claude, under the user's delegation (also in `docs/TASKS.md`, under S7):

- **P3's setup is three facts, each measured.** Round 1's fact, a reply to a question of the
  stall's name sent before the stall ended, held where the probe had already read that reply
  before the busy loop began: the send's callback, where the stall begins, can come after the
  reply's read, and a question in the second before bounded the reply from neither side. The
  stall's own lookup is now read as it begins, from the probe lanes' list of each name's open
  lookups (`ProbeSide.openFor`), and again for how it settled. The judge fails a reply not sent
  before the stall ended (to a question asked since its lookup began), a lookup that had settled
  before the stall began, and one never answered or answered during it. Together they say the
  reply waited unread in the socket while the lookup's stuck timer came due. The lanes' list is
  right at the send's callback because a lookup settles in the turn its reply is read: the
  model's promise and the lanes' continuation run before the next I/O callback. Nothing bounds
  how long after the stall the lookup is answered: after a 15 s stall the timers run first, a
  quarter of the sensors due at once, so the read of the waiting reply can come late without
  being another reply's; it is printed. The replies the simulator sent during the stall stay a
  print: they are every client's, so they cannot say the stall's own was among them.
- **P2's polled losses take the window read before the look that saw them.** The detach is
  seen by a 50 ms poll after the resolver has acted on it: it falls the helper's queued lookups
  back to the probe's lanes at once (D24), while the stopped child's questions are still held at
  the per-client forwarder, so D16's transient (up to 6 old, 6 new and 12 for the walk, 24 of 26)
  can peak before the poll looks, and the read the loss's cut asked for came after. That peak
  was judged against 18. Until the `hung` loss the poll now reads the peak before each look, and
  a loss it sees takes the window that read closed as well as the one it opens
  (`PeakWindows.lossSeen`): the loss came after the look before, so after every read but the
  last. The transient is allowed from at most a poll and a read's round trip before the loss was
  seen, and no earlier. Not a window from the SIGSTOP: that would allow the transient through the
  seconds before the detach, while the stopped child's tokens are still held and nothing can pass
  18. Not a hook on the helper's route: that is production code, and S7 changes none. P1's losses
  are its own kills and are cut as before: the read is posted in the kill's own turn, before the
  helper can see the exit, fork and have the next child ask again. The printed windows merge
  runs of one kind, since P2 reads one every 50 ms or so until its `hung` loss.
- **The windows reach the arm's end, and a read that failed fails the arm.** A read that failed
  in the middle of the run left a gap the judge named, but the last one, at the arm's end, only
  dropped its window, and the failure was printed. `PeakWindows` now records where it cut the
  last window, the facts carry that and any failure, and the judge fails a last window short of
  the end, an end not measured, and any failed read: a stretch held to no bound is not a stretch
  that held one.

### The review's third round (2026-10-20)

Decided 2026-10-20 by Claude, under the user's delegation (also in `docs/TASKS.md`, under S7):

- **The transient is judged a run at a time, and placed by the losses' own times.** Round 1's
  bound on its length was read one window at a time, and since round 2 P2 cuts a window at every
  50 ms look until its `hung` loss: every window with the transient in a real P2 run is a few tens
  of ms long, and the bound could never fire. A fault that kept the transient on from the detach
  through the `hung` loss's window (`lossSeen` at every look, say) allowed 26 across 27.5–34 s,
  where 18 is the bound, and passed. The judge now merges the windows that meet with the transient
  (`stretches`, which the print already used), and each run must lie inside the stretch its losses
  allow: from the loss to `LOSS_WINDOW_MS` (10.5 s) and a late timer's second after it, a poll's
  losses from a second before it was seen, the stretches of losses that meet taken together. A
  run past it fails, and so does one with no loss to open it.
- **By the losses' times, not a fixed length per run.** A run bounded by a length alone (10.5 s,
  the late timer's second, and a poll and a read's round trip) would fail two losses whose windows
  meet, which D16 allows (10 s after each loss, at most 5 losses in 10 minutes), and would pass a
  transient of the right length where no loss was. The times are the arm's own stamps, not
  `PeakWindows`': P1 stamps each kill before its cut, and P2's are its look's `downAt` and
  `hungAt`, carried onto the windows' clock (`PeakWindows.since`). So a fault in what cuts the
  windows is judged against something the windows did not say. Windows with no loss times fail.
- **A loss a poll saw may open its transient a second early; one the arm made, not at all.** P2's
  look stamps a loss after the read before it, and the window that read closed began a poll's
  50 ms and two reads' round trips before the stamp: a second, behind a busy event loop, as the
  late timer's. P1's kill is stamped before its cut, so its transient starts at the kill, and a
  run that starts before it fails.

## How each arm was shown to run

Scaled down to 500 sensors on 50 devices, a pool of 16 and a minute an arm, on the VM with other
sessions' runs beside it, not a quiet machine, so nothing here is a measurement. S7 ran the ten
arms its list names, the two added after them (P5 and `forwarder`) and `partial` with the check
off, in three runs; the review's first round ran all eighteen again after its changes, in one, with
`warmzone` given the 90 s after its silence that its steady window needs (at
`MS_DNS_WARM_MINUTES=1` the window from 60 s after the silence to the arm's end was about nothing,
so S7's run never read `warmzone`'s steady walk rate), and `partial` with the check off again:

```
./scripts/dev.sh "timeout 2800 sh -c 'cd packages/probe && MS_DNS_SENSORS=500 MS_DNS_POOL=16 MS_DNS_MINUTES=1 MS_DNS_WARM_MINUTES=1.5 MS_DNS_COLD_MINUTES=1 MS_DNS_STEADY_MINUTES=1 MS_DNS_RESOLVER=system,gate MS_DNS_ARMS=world/slow,world/warmzone,world/zone,world/partial,world/steady,world/forwarder,P1,P2,P3,P5,P5b,P6 node --test --test-concurrency=1 dist/test/perf/name-lookups.test.js'"
./scripts/dev.sh "timeout 540 sh -c 'cd packages/probe && MS_DNS_SENSORS=500 MS_DNS_POOL=16 MS_DNS_COLD_MINUTES=1 MS_DNS_CHECK=off MS_DNS_RESOLVER=gate MS_DNS_ARMS=world/partial node --test dist/test/perf/name-lookups.test.js'"
```

Every arm ran in every mode it runs in and held every assertion: the eighteen runs in 1,742 s,
and `partial` with the check off in 66 s. P1 and P2 ran again (136 s and 66 s, both held) once a
mutant's run had shown a window judged with the transient for 19 s: the timer that ends a loss's
window can fire a little early on the clock, and the next window then read as still inside it.
Each window now ends as its own loss's, and the next takes the transient only from a later loss.
S7's three runs held every assertion too, in 1,424 s, 293 s and 67 s. What the runs show is that each
arm reaches what it asserts, not that it holds at full size (the numbers are the review round's):

- **The bound and the walk were exercised, not idle.** The gate's runs walked 52 to 184 questions,
  their busiest second 9 to 13 and none past the bucket; the forwarder's most slots held for the
  probe was 0 to 13 of the gate's 18 and 0 to 5 of `system`'s 6, and nothing was dropped. In the
  re-run P1's windows held 5 and 2 in the 10.5 s after its kills and at most 5 outside them, P2's
  4 and 3 after its detach and its `hung` loss and at most 3 outside: no transient at this size.
- **Every check the arms judge answered.** Every answering check in every arm, but for `system`'s
  in `forwarder` (27 of 200) and the four P3's stall failed (507 of 511, which P3 reads), and all
  30 cached ones in `partial`; no check refused in any arm. What failed otherwise was only the
  silent zone's in P2 (22, while the child was stopped) and the crash name's in P6 (10), neither
  judged.
- **Zone b went where the gate sends it.** In `zone`, `partial` and P1 to P3, its names were
  routed `silent/helper` (5 to 11 routes), held at most 3 of the helper's lanes, and were never on
  the probe's lanes, where `system` put them (6 lookups, 3 at once, in `zone`). Each answering name
  in `zone` was kept within 92 ms of its first ask in `system` and 32 ms in the gate.
- **The warm arms read their steady state.** `warmzone`'s walk asked 0.87 questions a second from
  60 s after the silence, `steady`'s 1.13 from its scan interval plus 30 s, against 3; after the
  silence zone b was on the probe's lanes neither sampled nor otherwise, and the longest an
  answering name went between answers was 60.0 s in the gate and 66.0 s in `system`.
- **`forwarder` shows the difference the gate is for**, even scaled down: 30 silent names over 10
  keys left `system` answering 27 of its 200 answering checks, the gate all 200, with 11 lookups
  routed `unvouched (budget)` to the helper.
- **The helper's arms did what each was set up to do.** P1: two `exit` losses, the latch at 0, the
  children asked 0, 7 and 2 of zone b's names. P2: off `up` 3.6 s after the SIGSTOP, `hung` at
  20.6 s, the next child up at 20.7 s. P3: the stall held 15.0 s, begun on a probe-lane lookup of
  an answering name whose reply the simulator sent during it (one reply in all), and left no zone
  unsafe and nothing passed-stuck. P5 and P5b: four forks each, ready in 56 to 256 ms and 63 to
  253 ms, the event loop's most within a second of each 10 to 19 ms and 5 to 26 ms against 17 and
  10 ms before the first; the helper at 53 and 51 MiB at 55 s; P5b's pool at its memory gate at
  every kill (ceiling 8 of 16), P5's at its full 16. P6: three `exit` losses, the crash name
  poisoned and never asked on the probe's lanes.
- **Torn down clean.** 19 file descriptors before and after every arm, and no lookup left on the
  probe's lanes; the process's resident set rose at most 30 MiB above its start in any arm.
- **The check off is the gate with every name unvouched.** `partial` with `MS_DNS_CHECK=off`:
  the check's state 2, no walk, every lookup routed `unvouched (off)` to the helper (100), the
  answering and cached names all answered (450 and 30) and the silent ones given up (20).
- **Read, not asserted:** after four kills in two minutes `lookupHelperTrouble` reads 1 in P5 and
  P5b, as D27's three failures in ten minutes say it should, and P6 logs the poisoned name once.

The review's second round ran P1, P2 and P3 again after its changes, in one run of 276 s, all
held (`MS_DNS_SENSORS=500 MS_DNS_POOL=16 MS_DNS_MINUTES=1 MS_DNS_RESOLVER=gate
MS_DNS_ARMS=P1,P2,P3`, the same scale, not on a quiet machine, so not a measurement):

- **P2 read its peak 401 times**, every 50 ms or so from the SIGSTOP to its `hung` loss. The
  detach was seen 3.3 s after the SIGSTOP and its window, from the read before that look, ran
  18.0 to 28.6 s on the forwarder's clock (10.6 s); the `hung` loss's ran 35.0 to 45.6 s. The
  peak was 3 and 2 in them and at most 3 outside: still no transient at this size. P1's five
  windows were as before (5 and 2 after its kills, at most 5 outside), and both arms' windows
  reached their end (134.7 s and 64.8 s).
- **P3's stall held its own lookup's reply unread**: the lookup was open as the stall began, its
  reply was sent before it ended (the simulator sent one reply in all during it), and the lookup
  was answered 66 ms after it.
- **The round's own case fails the arm.** A P3 made to begin its stall only once its lookup had
  settled (the probe having read the reply first) failed with that lookup settled before the
  stall began and never answered after it, while its reply was still sent before the stall
  ended: round 1's fact alone passed it.

The review's third round ran P1 and P2 again after its change, in one run of 202 s, both held
(`MS_DNS_SENSORS=500 MS_DNS_POOL=16 MS_DNS_MINUTES=1 MS_DNS_RESOLVER=gate MS_DNS_ARMS=P1,P2`, the
same scale, not on a quiet machine, so not a measurement):

- **The transient's runs lay where their losses put them.** P1's kills came at 10.4 s and
  100.4 s on the forwarder's clock, and its runs with the transient were 10.4–20.9 s and
  100.4–110.9 s. P2 read its peak 402 times, and its losses were seen at 18.1 s and 35.1 s. Its
  runs were 18.1–28.6 s and 35.0–45.6 s, the second from the read before the look that saw it.
- **The round's own case fails the arm.** In a P2 whose look took every look as the detach's
  loss, the finding's own fault, the transient ran on from 18.0 s through the `hung` loss's
  window to 45.6 s, across 736 windows each too short for round 1's check. It failed as past the
  10.5 s after a loss. A P1 that stamped each kill after its cut's read, not before, failed both
  its runs as having no loss to open them. Each mutant changed only its own arm, so the two were
  run in one build.

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
./scripts/dev.sh "timeout 1200 sh -c 'node scripts/perf-conditions.mjs; MS_DNS_CHECK=off MS_DNS_RESOLVER=gate MS_DNS_COLD_MINUTES=7 MS_DNS_ARMS=world/partial node --test packages/probe/dist/test/perf/name-lookups.test.js'"
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
