# Seventeen tests that passed for the wrong reason, and what exposed each

`P-58`–`P-95`, 2026-09-04 and 2026-09-05. **Extended twice**, which is the finding.

A morning spent on `P-58`'s backlog turned up five tests that were green, had been green for
weeks, and did not test what their names said. None was a careless test. Each was written by
somebody who understood the defect, and each passed for a reason that had nothing to do with it.

That was the first five. Then an adversarial review panel — 109 agents over the day's own
commits, three independent skeptics per finding — was pointed at the code written to *fix* them,
and found four more. **Three of the four were in tests written that afternoon, by the author of
this document, after writing it.** One of them was in the guard built the previous ticket to catch
exactly this family of defect.

That was the first nine, all of them in code written that week. A second panel was then pointed
at the state machine, dependencies, schedules, notifications and ingestion — code a fortnight
old, written unhurriedly and green ever since. It confirmed 29 defects, five of which belong
here, and they are the ones that settle the argument: haste was never the explanation.

That is why the catalogue is worth keeping. The individual bugs are in their tickets; what is
here is that **seventeen independent instances of one failure have now been found**, that a
different technique was needed to expose each, and that knowing about the failure mode in
detail — having just catalogued it — did not stop somebody producing four more instances of it
before dinner.

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

## The five the state-machine panel found, in code two weeks old

The first nine were all in code written the same week. A second panel was run over
`packages/core`'s state machine, dependencies, schedules, notifications and ingestion — older
code, none of it written that day — and confirmed 29 defects. Five of them are this family, and
they are the more interesting half: nobody was in a hurry when these were written.

### 10. A test that supplied the missing trigger itself (`P-87`)

`pause-precedence.test.ts` had a case called *releases a dependency when the master itself is
paused, not when it is Down*. It passed for a fortnight. Three lines after pausing the master it
called `dependencies.recompute` by hand — the exact step whose absence was the defect.
`DependencySync.invalidates` had no `object.paused` case, so production ran nothing, and forty
dependents stayed held for ever with the pause API insisting nothing held them.

Deleting those three lines turned it red immediately. **A test that provides the missing step
tests the step after it**, and the giveaway is on the page: a test that has to reach past the API
into a collaborator to make the scenario happen is describing a scenario production cannot reach.

### 11. The one mode where the wrong lookup happens to be right (`P-89`)

The dependency recovery delay was resolved on the *master* and configured on the *dependent*. In
`device` mode the master sensor sits inside the device the setting lands on, so resolving it on
the master finds it anyway. The test used `device` mode. In `object` mode — the other half of
what `WORKFLOW.MD §5` offers — every recovery silently fell back to a delay of zero.

**A fixture that picks the configuration where two different things coincide cannot tell them
apart.** The mutation is instructive: reverting the fix kills the new `object`-mode case and
leaves the original `device`-mode one green, which is exactly the shape of a test that was never
testing what its name said.

### 12. A guard tested in one direction (`P-92`)

`conditional-get.test.ts` asserted *does not serve 304 after a credential appears on an
ancestor* — the INSERT direction. The trigger fired on `INSERT OR UPDATE` and not `DELETE`, so
**revoking** a credential moved no version, the ETag was unchanged, and a client holding it got a
304 and kept acting on a credential that had been taken away. The route's own comment says the
digest exists so that "a 304 there would hide a revoked credential".

**A cache-invalidation test that only adds things is half a test**, and it is the wrong half: the
appearing case is the benign one.

### 13. Asserting the two fields that could not move (`P-94`)

`pause-precedence.test.ts` walks the transition where a schedule window opens on a sensor an
operator has also paused by hand. It asserts `state` and `cause`. It never asserts `message` —
which is the only field the defect touched. The sensor read "outside the Office hours schedule"
at 08:00, with office hours open, and the operator's "replacing the PSU" was gone from both the
row and the newest history entry.

This is entry 8's rule reached from the other side. There the assertion could not distinguish the
case; here it simply looked away from the field that could.

### 14. A test that passed alone and failed in its file (`P-95`, found by writing it)

Not a pre-existing test — one written for a fix, an hour before this paragraph. It passed run in
isolation and failed twice in the full suite: it assumed it was the only in-force pause in the
database, and it left its own pause behind, which broke a sibling three tests later.

Worth recording because the failure mode is invisible to the loop everybody actually uses.
`node --test --test-name-pattern` is how a fix gets iterated on, and it is precisely the mode in
which order-dependence cannot appear. **A new test has to be run inside its own file before it is
believed**, and it has to leave the database as it found it.

The same fix produced the sharper lesson twice more, both caught only because the test existed:

- The finding's own suggested check — "advance the watermark only when `report.started.length <
  batchSize`" — is wrong. `started` holds the windows that moved a flag, not the page that was
  read. A plausible fix from a careful reader, and it would have shipped.
- The first *correct-looking* fix silently re-read the same row for ever. `timestamptz` holds
  microseconds and a JS `Date` holds milliseconds, so a cursor round-tripped through JS lands
  just *before* the row it came from. The watermark advanced, the query returned the same row,
  and nothing ever progressed past page one. **A truncating conversion in a pagination cursor
  fails silently and looks like a working loop.**

### 15. An assertion on the implementation, which made the fix look like a regression (`P-97`)

Six tests asserted `last_result_at === null` after a resume. That was never the invariant — §3's
invariant 8 is *"a resume yields Unknown and never reports a state measured before the pause"* —
it was the mechanism that happened to implement it. And the mechanism was the defect: nulling
that column also erased the staleness floor the at-least-once probe protocol depends on.

So the fix turned six green tests red, every one of them for the right reason. That is the
failure mode worth naming, because it points the wrong way: **a test pinned to the mechanism
makes a correct fix look like a regression, and the cheapest response is to revert.** The tell is
that the assertion restates the code rather than the requirement — `null` is not a property
anybody wants, "nothing measured since the resume" is. They now assert the scan facts and, in
the pure model, the stronger claim the old form could not make: that a reading from before the
resume is stale.

### 16. Two queries, one row type, and only one of them updated — twice (`P-98`)

Not a test that passed for the wrong reason; a defect the tests could not see at all, found while
fixing entry 15. `RuntimeRow` is asserted from raw SQL, so the compiler cannot check that a query
selects every field. Two queries feed `toRuntime`: the one the machine decides on, and the one
`GET /sensors/:id/state` answers from.

`P-85` added two columns and updated one query. The read side returned `undefined`, which the
helper read as "nothing judged" — wrong, silent, shipped. `P-97` added another the same way, and
its helper called `.getTime()` on it: 500 for every sensor, caught by an *acknowledgement* test
asserting over HTTP, which is to say by luck.

**The difference between the two is only that the second one threw.** That is not a property of
the code, it is a property of what the helper happened to do with `undefined` — so the guard is
now structural: `runtime-row.test.ts` parses the interface and requires every non-optional field
in both queries, every optional one in at least one. Written as "both queries carry everything",
it failed immediately on the two fields the type already marked optional, which is the guard
finding the distinction rather than the author remembering it.

### 17. A helper more generous than production, over a feature that did nothing (`P-104`)

The sharpest instance on this page, because of the ratio. `threshold-engine.test.ts` has
seventeen tests over threshold triggers. Its `scan` helper wrote the reading and then called
`engine.react` unconditionally — while the ingestion path called `react` **only when the batch
produced a state transition**. A threshold trigger fires on a *reading*, and a reading changes
without the state changing, so in production the feature never armed on a stable sensor and
never stood an alarm down. It was inert.

Seventeen green tests, and the entire feature was dead. The helper was not wrong about anything
it asserted; it was wrong about the world the assertions ran in.

**A test helper that sets up state is fine; one that performs the step under test is a
substitute for production, not a model of it.** The fix was to make the helper apply the same
rule the ingestor does — mirroring it rather than restating it — after which reverting the
production change turns four of the seventeen red, including the two the panel had predicted by
name. This is entry 10's defect at the scale of a subsystem: there the missing call was three
lines above the assertion, here it was in a shared helper every case in the file depended on.

## The four the notifications panel found, in the guards themselves

A second panel, over notifications, schedules and triggers, and then over five areas a critic
said nobody had looked at. It confirmed 45 defects. Four of them were not defects in the code
under review at all — they were the tests that were supposed to be watching it.

### 18. A matrix that asserted the resolver against itself (`A-11`)

`access-matrix.test.ts` is named for Phase 9's exit criterion: "an access-control test matrix
passes for every combination of role, group and tree position", and its own comment says this is
"where a route that forgot to ask would show up". Twelve rows, all green, for a year.

Every one of them called `GET /objects/:id/access/effective` — the endpoint whose entire job is
to *report* what the resolver says. So the matrix asserted `AccessService` against
`AccessService`, and would have passed identically on a build where no route enforced anything.
Which is what the build was: `requireFor` was called by nothing, `resolveFor` by that one
reporting route, and every mutating route in the installation was open to any authenticated
principal.

The file's other half, the credential sweep, filtered to `GET` — and it says why, in a comment
about hand-maintained lists going stale. **A sweep of reads cannot notice that no write is
guarded.** Both halves were carefully built; neither could see the hole between them.

### 19. Two harnesses missing the thing the defect was in (`P-133`, `A-11`)

`pause-precedence.test.ts` builds its `ScheduleService` with a `DatabaseAuditSink` and a
`ScheduleSync`. Production composes those *and* `DependencySync` — that is what
`scheduleAuditSinks` is for, and there is a test asserting the membership of that list. So the
file that exists to prove the four pause sources interact correctly could not observe the sink
where the interaction was broken.

`access-matrix.test.ts` had the same shape: it registered no triggers, templates or schedules
service, so the routes the authorization finding was about were **not registered in the app it
swept**. A sweep over routes that do not exist passes.

Both were fixed by making the harness compose what `main()` composes. Neither is a hard rule
about mocks — it is narrower than that: **a harness that omits a collaborator cannot fail on a
defect in the collaboration**, and the omission is invisible because everything about the file
still reads correctly.

### 20. A sweep that could not distinguish a guard from a schema (`A-11`)

The mutating-route sweep, newly written for `A-11`, posted `{}` at every non-GET route and
asserted the answer was not 2xx. It passed. Then a mutation that let a read-only account write
everything **also** passed — because Fastify validates the body before `preHandler`, so every
route answered 400 for the empty payload and never reached the guard.

The test was measuring the schema. Two changes fixed it: authorisation moved to `preValidation`,
so a refusal is the *first* answer, and the assertion narrowed from "not 2xx" to "401 or 403".
**A negative assertion has to name the reason it expects, or it will accept the wrong one.**

### 21. A fix by symmetry with no test that can fail (`P-140`)

Recorded because the honest thing to do with it was to say so. `P-94` gave `reevaluate` a
`sources` parameter and taught one caller to use it; the pause API was never given one, and an
absent `sources` means "every cause". The asymmetry is real and the fix costs nothing.

Every sequence tried to make it *matter* reaches the higher-precedence pause through a
re-evaluation that has already set the state, so the later manual pause decides the same state
and cause and writes nothing at all. So the fix ships with no test that fails without it, and
`TASKS.md` says that in as many words. **A test that passes either way is worse than no test: it
is a claim of coverage that a later reader will believe.**

## What actually found them



Ranked by what each cost and what it caught:

| Technique | Caught | Cost |
| --- | --- | --- |
| Mutation — revert the fix, expect red | 1 | Minutes, and the only general one |
| Reading, prompted by an audit | 2 | Free, but needs somebody to ask |
| Adversarial review of a *fix* | 3 | Expensive; caught what its author could not see |
| Running it N times and counting | 4 | Cheap and nobody does it |
| Instrumenting durations, then a log spy | 5 | Minutes, once the duration looked wrong |
| **A review panel with a refutation bar** | **6, 7, 8, 9, 10, 11, 12, 13** | **Very expensive; the only thing that caught the author's blind spot, now eight times** |
| Writing the test for the fix, then running its *file* | 14 | Free, and skipped by the `--test-name-pattern` loop everybody uses |
| Running the whole suite after a fix that changes a mechanism | 15, 16 | Minutes, and the six red tests were the *fix* working |
| Asking what production calls, then making the helper call exactly that | 17 | Free, and it emptied seventeen tests of their meaning at once |
| A second panel, with a critic asked what nobody had looked at | 18, 19 | Very expensive; the gap round found the authorisation hole nothing else had |
| Mutating the *new* test's subject before trusting the new test | 20 | Minutes, and it caught a test written the same hour |
| Trying to write the failing test, and failing | 21 | Free, and the only outcome that has to be written down rather than fixed |

The one that generalises: **a passing test is a hypothesis, and the mutation is the experiment.**
Four of the first five had never had the mutation run against them; 7 was settled by one in
minutes once somebody thought to ask.

The one that does not, and it is the sharper half: **an author cannot review their own tests for
this defect, and knowing about the defect in detail does not help.** Entries 6, 7 and 9 were
written *after* entries 1–5 were catalogued, by the person who catalogued them, on the same day.
Entry 9 was written *inside the guard built to prevent this family*. The panel was independent,
worked from the code rather than from the intent, and had to defeat three skeptics to report
anything — and that structure, not more care, is what found them.

## Twelve rules this produced

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
6. **A test that reaches past the API to make its scenario happen is describing a scenario
   production cannot reach.** Entry 10 called a collaborator by hand three lines after the action
   under test. If the scenario needs a step the system does not take, that missing step *is* the
   finding — delete the line and see.
7. **Run a new test inside its own file before believing it, and leave the database as you found
   it.** Entry 14 passed under `--test-name-pattern` and failed twice in the suite. The iteration
   loop that makes a fix fast is the one mode in which order-dependence is invisible.
8. **Assert the requirement, not the mechanism that currently implements it.** `last_result_at
   === null` is not a property anybody wants; "nothing measured since the resume" is. Six tests
   pinned to the mechanism turned red on a correct fix, and the cheap response to that is to
   revert the fix. If the assertion restates the code, it will punish the next person who
   improves the code.
9. **A row type asserted from raw SQL is unchecked, so check it structurally.** Entry 16 happened
   twice, and the only difference between the silent instance and the loud one was what a helper
   did with `undefined`. Where the compiler cannot see the boundary, a guard that parses the type
   and the query is not paranoia, it is the type system by other means.
10. **A test that asks the subject what it thinks proves nothing about anybody else.** Entry 18's
    matrix asked the resolver to report its own answer twelve times. The question a matrix over
    *enforcement* has to ask is of the routes: call them and see what they do. If the endpoint
    under test and the thing under test are the same object, the test is a mirror.
11. **A harness that omits a collaborator cannot fail on a defect in the collaboration.** Entry 19,
    twice in one panel. When a file exists to prove how N things interact, build it the way
    `main()` builds them — and if that is inconvenient, the inconvenience is the finding.
12. **A negative assertion has to name the reason it expects.** Entry 20 accepted any 4xx, and a
    schema rejection is a 4xx. "Not allowed" is not a property; "401 or 403" is. The same rule as
    2, in the other direction: when a test passes for a reason it did not name, it will keep
    passing when that reason changes.

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

`main()`'s own composition was unpinned, and this section used to end by saying so and leaving it
there. `P-111` measured it instead: **deleting `pauses` and `reachabilitySync` from the core's
`main()` left all 2,118 core tests green, and deleting `onAdd` and `onDispatch` from the probe's
left all 283 green** — four shipped fixes silently reverted by a suite that noticed nothing.
`buildHarness` builds its own state service and audit sink, and the watchdog's tests call
`assigned` and `forget` directly under a comment noting that `main.ts` does it "in the same
breath". Every one of them proves the mechanism; none proves the wiring.

The fix was already working ten lines away. Two additions from the same day could *not* be
deleted, for one reason: `reconcilesReadings` and `ingestionDiscards` are required interface
members, so the compiler is the guard. Three of the four became required too; the fourth, a sink
in an `AuditSink[]`, has no shape to require, so the three lists are named functions now with a
test that asserts their membership.

**What is still unpinned is one line each**: that `main()` passes those lists to those services,
and constructs the store and the dispatcher at all. `main()` still has no test file. The gap is
smaller and it is not closed — which is the same sentence this section carried before, about a
larger gap, and it is worth noticing that writing it down did not fix it. Measuring it did.

## The honest bottom line

Nine instances in one day is not nine unlucky tests. It is the base rate for tests written by
somebody who already knows what the answer should be, which is every test anybody writes about
their own fix. The mutation is cheap and catches most of it. The rest needs somebody — or
something — that did not write the code and is rewarded for refuting rather than agreeing.

**Sixteen now, and the seven added later are the ones that settle the argument.** The first nine
were all written in the rush of a single day, which is the comfortable explanation. Entries 10 to
13 are in code that was written unhurriedly a fortnight earlier, reviewed at the time, and green
ever since — and each one had a name that described a property the test did not check. The base
rate is not a function of haste.

Entry 14 is the counterweight, and the cheapest thing on this page: it was caught by running a
new test in its own file, which takes seconds. Two more defects in that same fix were caught only
because the test existed at all — one of them a plausible fix suggested by a careful reader that
would have shipped, and one a silent truncating conversion that looked exactly like a working
loop. Most of this is not subtle. It is only invisible to the person who just decided what the
answer is.
