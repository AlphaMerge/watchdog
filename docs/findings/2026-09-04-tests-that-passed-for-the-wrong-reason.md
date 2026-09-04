# Nine tests that passed for the wrong reason, and what exposed each

`P-58`–`P-83`, 2026-09-04. **Extended the same day**, which is the finding.

A morning spent on `P-58`'s backlog turned up five tests that were green, had been green for
weeks, and did not test what their names said. None was a careless test. Each was written by
somebody who understood the defect, and each passed for a reason that had nothing to do with it.

That was the first five. Then an adversarial review panel — 109 agents over the day's own
commits, three independent skeptics per finding — was pointed at the code written to *fix* them,
and found four more. **Three of the four were in tests written that afternoon, by the author of
this document, after writing it.** One of them was in the guard built the previous ticket to catch
exactly this family of defect.

That is why the catalogue is worth keeping. The individual bugs are in their tickets; what is
here is that **nine independent instances of one failure appeared in one day**, that a different
technique was needed to expose each, and that knowing about the failure mode in detail — having
just catalogued it — did not stop somebody producing four more instances of it before dinner.

A green suite is evidence about the suite.

---

## The first five

### 1. A cut-off in the query, not the rule (`P-59`)

`factory-service.test.ts` — "treats a stale reading as absent rather than as still true". One
factory sensor, `maxAgeSeconds: 600`, a reading 4,000 s old, asserted absent. It passed.

It also passed with the entire staleness check **deleted from `evaluate`**. The single factory was
configured at exactly the installation-wide floor, so the SQL `WHERE s.time > now() - interval`
excluded the row before the rule ever saw it. The test proved the query, and was named for the
rule.

**Exposed by:** mutation. Deleting the age comparison left it green.

**What it needed:** a *second* factory sensor. The defect was that one sensor's cut-off became
everyone's, and that is unobservable with one.

### 2. A limit of zero (`P-60`)

`state-stream.test.ts` — "cuts off a subscriber that cannot keep up". Constructed the broadcaster
with `queueLimit: 0`, so `0 >= 0` fired on the first event whatever the counter held. The counter
it was meant to exercise was `attached.pending`, which was incremented and decremented around a
synchronous `send` and was therefore *always* zero. The cut-off had never fired in production and
could not.

**Exposed by:** reading, prompted by an audit. No mutation was needed — the guard was unreachable
by construction.

**What it needed:** a subscriber that reports a backlog. Every recorder in the suite consumed
instantly, which is why a guard that could never fire never showed up as a failure.

### 3. `0 === 0` (`P-60`, found by the review of `P-60`)

The replacement test asserted `registered[0]?.backlog?.() === socket.bufferedAmount` over a real
WebSocket. `socket` was the **client** end; `backlog()` read the **server's**. Both are 0 on an
idle connection. It would have passed against an implementation returning a constant.

Worse than the test was the claim: the commit message said it pinned "the socket's figure". It
pinned that the method existed.

**Exposed by:** an adversarial reviewer reading both ends of the assertion.

**What it needed:** the arithmetic extracted into a pure function and tested against a socket a
test can move by hand — `stream-backlog.test.ts`.

### 4. A 17% race, called deterministic (`P-63`)

The regression guard for `P-63` opened a connection, waited, and asserted `stop()` completed. Its
ticket and its commit message both said the 0 ms row "fails against the old tracking".

Measured against a behaviourally reverted build: **17 times in 100 idle runs, 27 in 100 loaded**.
Whether the connection had been *dispatched* when `stop()` ran is the race the defect lives in, so
the guard was sampling it.

**Exposed by:** a reviewer running it a hundred times.

**What it needed:** a socket that connects and never sends a request — permanently in the state the
timed rows can only reach by luck. It fails every time.

The corollary is the sharpest thing in this document. **A full 3,602-test run certified a build
that still contained this defect**: an incremental build had not picked up a mutation restore, and
the only test that could have caught it rolled its 17% and lost.

### 5. An idle timer wearing the test's name (`P-65`)

`probe-endpoint.test.ts` — "replaces a stale session when the same probe reconnects". It had been
passing about five runs in six for weeks.

Timing it: the second probe connects in 6 ms and is welcomed in 1 ms, then the first socket takes
**exactly 3,000 ms** to close — against a `waitForClose` timeout of exactly 3,000 ms. That number
is `heartbeatIntervalMs * 3`, the connection's idle timeout. A log spy settled it: the endpoint
logged `connection idle, closing`, never `replacing an existing session for this probe`.

The test had never observed a replacement. It watched an unrelated timer expire at the instant it
gave up, and won that race most of the time.

**Exposed by:** instrumenting the durations, then a capturing logger.

**What it needed:** a 30 s heartbeat, putting the idle timeout at 90 s, so nothing but a
replacement can close that socket inside the second it now allows. 3,010 ms and one failure in six
became 13–29 ms and six for six.

---

## The four the review panel found

These came from `P-80`'s adversarial panel and were fixed under `P-80` and `P-83`. All four are in
code written on 2026-09-04, most of it after the five above had been written up.

### 6. A conjunct made vacuous by the test's own constant (`P-80`)

`check-flow.test.ts` — "is untroubled by a check that is merely slow". `overdue` is a conjunction:
past the stall window **and** past twice the check's own timeout. The test dispatched with
`timeoutMs: 30_000` and advanced exactly `60_000`, so `waited === timeoutMs * 2` and the second
conjunct was already false under the strict `>`.

The consequence: **delete `waited > stallAfterMs &&` and the whole file stays green.** Every other
case in it is absorbed either by that boundary or by the separate recency clause. What the mutant
permits is a probe carrying only long-interval sensors — legitimately quiet, so the recency clause
is already satisfied — flipping to stalled 21 seconds into one hung 10 s check, 279 seconds before
the design says it may.

**Exposed by:** the panel, reading the conjunction against each test in the file rather than each
test on its own.

**What it needed:** 90,000 instead of 60,000, so the second conjunct is true and only the clause
under test holds the assertion up — plus a discriminating case that fails against the mutant.

### 7. A test whose subject cannot express the property (`P-83`)

`check-flow.test.ts` — "counts an error as a completion, because the runner came back".
`CheckFlowWatchdog.completed(sensorId)` takes **no outcome**. The test could only call it five
times and observe a counter, and would pass identically against a `completed` that ignored
outcomes — which is what it has. The property lived at one line in `main()`, which had no test
file at all.

Measured rather than argued: wrapping that line in `if (result.outcome === 'ok')` left the entire
probe suite green, this test included.

**Exposed by:** the panel, comparing the assertion's reach against its subject's *signature*.

**What it needed:** the sink extracted out of `main()` — `result-sink.ts`, the way `P-43`
extracted the config handlers — and the property asserted against the unconditional call that
actually carries it. The same mutation now fails two tests. The old test kept its scenario and
lost its name.

### 8. Forty copies of one assertion (`P-83`)

`probe-delivery.test.ts` — "does not fire on a probe replaying an hour of spool", billed in
`P-74`'s commit message as "the trap the whole design turns on". Its forty iterations each
advanced `now` and `lastResultsAt` by the same 30,000 ms, so `silentForMs` was 30,000 and
`windowMs` 240,000 in every one.

Worse than the repetition: `DeliveryFacts` carried no field for the probe's own clock, so **no
implementation of the rule could have failed it** without also failing its neighbour. The forty
iterations were forty copies of an assertion the rule could not get wrong.

**Exposed by:** the panel, asking what change to the subject would turn the test red.

**What it needed:** the assertion at the *endpoint*, which is the one line that stamps arrival and
the only place where arrival and `result.at` differ. The replacement sends a batch stamped an hour
ago and asserts the link's age is seconds; it fails against ageing from `result.at`, which is the
design `P-74` rejected.

### 9. A guard satisfied by a substring (`P-80`)

`build-hygiene.test.ts` — `P-79`'s new structural check that every field in `PROBE_HEALTH_SCHEMA`
is read by the core. It matched with `code.includes(field)`, so a field whose name is a *prefix*
of another — `sessionsOpen` against `sessionsOpened` — was satisfied by its longer sibling.

The guard carried a floor on its own extracted field count, precisely because a regex that
silently matched nothing would make it pass for ever. That floor catches an extraction that finds
too little. It cannot catch a match that is accidentally satisfied, and nothing else did either.

**Exposed by:** the panel, reading the guard as adversarially as the code it guards.

**What it needed:** a word boundary. One line.

**The reason it is in this list rather than a footnote:** this is the ticket written the day
before, whose entire purpose was to stop a field being added and silently never read. It was
built as the durable fix for this family and shipped with an instance of it inside.

---

## What actually found them

Ranked by what each cost and what it caught:

| Technique | Caught | Cost |
| --- | --- | --- |
| Mutation — revert the fix, expect red | 1 | Minutes, and the only general one |
| Reading, prompted by an audit | 2 | Free, but needs somebody to ask |
| Adversarial review of a *fix* | 3 | Expensive; caught what its author could not see |
| Running it N times and counting | 4 | Cheap and nobody does it |
| Instrumenting durations, then a log spy | 5 | Minutes, once the duration looked wrong |
| **A review panel with a refutation bar** | **6, 7, 8, 9** | **Very expensive; the only thing that caught the author's blind spot four times** |

The one that generalises: **a passing test is a hypothesis, and the mutation is the experiment.**
Four of the first five had never had the mutation run against them; 7 was settled by one in
minutes once somebody thought to ask.

The one that does not, and it is the sharper half: **an author cannot review their own tests for
this defect, and knowing about the defect in detail does not help.** Entries 6, 7 and 9 were
written *after* entries 1–5 were catalogued, by the person who catalogued them, on the same day.
Entry 9 was written *inside the guard built to prevent this family*. The panel was independent,
worked from the code rather than from the intent, and had to defeat three skeptics to report
anything — and that structure, not more care, is what found them.

## Five rules this produced

1. **Assert on `dist`, not on `src`.** Verify the compiled output after a mutation sweep, and
   before trusting a suite that certifies a fix. Twice in one day an incremental build did not pick
   up a restore, once through a `git stash` cycle that left the source older than the build.
   `tsc -b --force` costs a minute.
2. **A number chosen so the assertion holds is a smell.** `queueLimit: 0`, one factory at exactly
   the floor, a 3,000 ms timeout against a 3,000 ms timer. When a test's constants are load-bearing
   for the *pass*, ask what it proves at any other value.
3. **Run a race a hundred times before calling it deterministic.** Cheap, and it is the only thing
   that separates a guard from a coin flip.
4. **Ask what change to the subject would turn this test red — and if the answer is "none",
   the test is scenery.** Entry 8's rule had no field that could distinguish the case the test was
   named for; entry 7's subject had no parameter that could carry the property. Neither needed a
   mutation to see, only the question. When the honest answer is "the subject cannot express it",
   the fix is to move the assertion to where the property lives, which usually means extracting
   something out of `main()`.
5. **Review the guards as adversarially as the code.** Entry 9 was in the structural check written
   the day before to catch exactly this. A guard is code, it is written by somebody who has just
   convinced themselves of something, and it is the *last* thing anybody re-reads.

## What is still not covered, and is said so on purpose

`P-66` wires an allowance to the snapshot in one line, and nothing fails if that line is removed.
Catching it needs a socket whose buffer stays non-empty, and on loopback it drains before it can be
observed — which is the same reason `P-60`'s original assertion was empty. The arithmetic is pinned
and the wiring is not. Pretending otherwise is what `P-60` did.

`P-82` gives the check-flow watchdog a per-runner completion clock, and the probe-side wiring that
tells it *which* runner accepted a check runs through `due-dispatch` into `main()`. This paragraph
first said the wiring was one line of trust — which was true when written and is the reason it was
written down. It is now pinned: `due-dispatch.test.ts` asserts the label for both branches, and
hard-coding it to `'pool'` fails there while **every check-flow test stays green**, because they
pass the label themselves. That is the same structure as entry 7 — a subject that cannot express
the property, and an assertion that had to move to where it lives.

What remains unpinned is `main()`'s own composition: that `assignments.onAdd`, `onDrop` and the
dispatcher's `onDispatch` are wired to the watchdog at all. `main()` has no test file, and three
of the day's fixes now depend on lines in it.

## The honest bottom line

Nine instances in one day is not nine unlucky tests. It is the base rate for tests written by
somebody who already knows what the answer should be, which is every test anybody writes about
their own fix. The mutation is cheap and catches most of it. The rest needs somebody — or
something — that did not write the code and is rewarded for refuting rather than agreeing.
