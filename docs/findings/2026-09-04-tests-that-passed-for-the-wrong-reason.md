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

## The five the third panel found, in the fixes for the second

A third panel, over the diff that fixed the second panel's 45. It confirmed 36 more, and four of
them were again the guards rather than the code. A fifth was found the way three others in this
document were: by starting the server.

### 22. A sweep whose principal could not tell a coarse bar from a correct one (`A-11`)

Entry 20 fixed the mutating sweep so a refusal beats a schema rejection, and it then ran twice:
once as a read-only account, once as a read-scoped token. Both are stopped at the **role** gate,
which every mutating route clears by declaring `write` — so a route that asks only for the role,
and never resolves a right on the object it is about, answers 403 to both and looks exactly like
a correctly guarded one.

Five holes were invisible for that reason: `POST /objects/tree` created a subtree under any
parent, `move` and `clone` relocated into any destination, `PUT` and `DELETE /triggers/:id`
edited every trigger in the installation, and `POST /discovery` provisioned devices into any
group. The principal that separates them is `readwrite` **with no grant anywhere**: it clears
every role gate and holds `none` on every object, so anything it gets through was never guarded
on an object at all. Added, it found all five the day it was written.

**A negative sweep is only as sharp as the principal it uses.** Entry 20 was about the *answer*
being unambiguous; this is about the *question*.

### 23. A floor so far below the truth that nine missing modules fitted under it (`A-11`)

The same file asserted `mutating().length > 25` under a comment about a silent zero not being a
pass. The real number was 48, and nine of `ApiServer`'s optional services were still not
registered by the harness — including the one carrying `POST /templates/:id/test`, **the route
the ticket singles out by name** as the one that "really sent for anybody with a session". A
sweep that cannot call the route it is cited for is not evidence, and twenty-nine routes cleared
a floor of twenty-five without a murmur.

This is entry 19 recurring in the same file, one commit after entry 19 was fixed there. The floor
is close to the real count now, and beside it is a list naming the routes an absent module takes
with it: a count cannot catch one missing service, and the absence is in the harness rather than
in any route's source, so nothing in the source can declare it. **A guard with slack in it is
sized by the slack, not by the guard.**

### 24. A test that could not distinguish the fix from the bug (`P-147`)

Written for this panel's own finding and it passed immediately — because the racing write and the
row it was supposed not to overwrite decided the *same state*. The guard keeps `r.state` when it
holds and applies `w.state` when it does not; with both equal to `down_acknowledged` the two
branches are indistinguishable, and the test asserted a value that was already there.

It took a deliberate mutation to notice: reverting the fix left it green. The repair was to make
the racing write decide something different — an acknowledgement that *lapses*, which the machine
answers `down` — so the branches produce different rows. **Mutation is not a formality after the
test passes; it is the only thing that told this one apart from a tautology**, and it is entry 3
in a new costume.

### 25. Deferring by process rather than by state (`P-146`, found by writing the test)

`P-146` skipped the alarm reaction for a replayed batch and reasoned that "the drain ends with a
live batch, and that one decides the present correctly". It does not: the reaction is keyed on
*this batch's* transitions, so an outage that began inside a skipped batch and is still happening
transitions in no later one and is armed by nothing. One outage, zero alarms.

The existing test could not see it, and its own comment says why: it puts the first failure in
the stale batch and the second in the live one, so the two-step rule makes the Down transition
land in the live batch, which then supplies the transition. **The test was constructed so the
thing it was skipping never needed to be remembered.**

Writing the version that puts both failures in the stale batch also caught a second thing: the
first attempt built a fresh ingestor per batch, as the tests around it do, which meant the
deferred set was empty by construction. It failed for the right reason and for the wrong one at
once, and only reading the failure told them apart.

### 26. A fake peer more permissive than the real one (`R18`, found by starting the server)

Adding a field to a wire message means widening two declarations: the TypeScript union and the
runtime JSON schema the peer validates against. Only the first was widened. The probe's
`parseCoreToProbe` has `additionalProperties: false`, so it refused every configuration message,
closed the connection on a protocol violation, reconnected and refused it again — the `P-148`
wedge, reached by a different road.

Both new tests passed, and so did the other 3,499. `TestProbe`, the fake probe in
`probe-endpoint.test.ts`, **cast** what it decoded — `value as CoreToProbeMessage` — instead of
parsing it. A stand-in strictly more permissive than the thing it stands in for, in the one file
whose entire subject is what the core puts on the wire. It parses now, and removing the field
from the schema turns six tests red.

This is the third defect in this document caught by *starting the dev server* after a green
suite, and the second in three days caught on the probe link specifically. The cost is under a
minute.

## The three the fourth panel found, in the fixes for the third

A fourth panel, over the diff that fixed the third panel's 36. It confirmed 12 more. Three were
the guards; the fourth entry here is not a test at all, and is the most useful thing on this page.

### 27. A sweep exemption that swallowed the route the ticket was written for (`P-155`)

Entry 22 added a grantless-`readwrite` pass — the only principal that clears the role gate — and
exempted the library routes with a prefix: `^/api/v1/(templates|schedules)(/|$)`. That prefix also
matches `POST /templates/:id/test`, **the route the ticket cites twice** as the one the old
harness could not see and the reason nine services were wired in. It was wired in, given a
per-object bar on the sensor it renders against, and then skipped by the one sweep that could
exercise it.

This is entry 23 — a guard sized by its slack — in the same file, one commit later, written by
somebody who had just fixed entry 23. The exemptions are a list of exact `METHOD /url` strings
now, because a prefix is a rule nobody has to justify extending.

### 28. A test whose discriminating premise was false (`P-157`)

The R16 test exists to prove staleness is folded over results rather than transitions, and its
whole premise is a comment: "same failing sensor, already at its final state, so no transition".
`warnFor` is 1, so failure one is unknown→warning and failure two is warning→down — two
transitions, not none. Both batches carried one, so the test passed identically under the rule it
was testing and the rule it was replacing.

It was never mutated. The ticket said "Mutation 3/3" and meant two; the third change was the one
this test covered. **A mutation count is a claim like any other, and this one was wrong in the
direction that flatters.** Corrected in `TASKS.md`, and the test now needs three failures before a
fourth that changes nothing.

### 29. A test that passed against the bug, caught only by mutating it (`P-158`)

Written for the panel's own finding and green on the first run — because the racing write and the
row it must not overwrite both decided `down_acknowledged`. The guard keeps the existing state
when it holds and applies the write's when it does not; with both equal, the branches are
indistinguishable and the assertion was on a value already there. Reverting the fix left it green.

Repaired by making the racing write decide something *different* — an acknowledgement that lapses,
which the machine answers `down`. Same lesson as entry 3, and the same tool caught it. Recorded
separately because entry 3 was a `0 === 0` anybody could see; this one needed the state machine's
two-step rule held in mind to notice at all.

### 30. A premise nobody checked, in the field the whole fix rested on (`P-157`, found by the panel's critic)

Not a test — the thing under the tests. `P-157` decided "is this batch a replay?" from the probe's
`backlog`, reasoning that only the probe knows. It does; this is not that number. `SpoolDrain`
computes `backlog = pending - batch.length`: rows on disk *right now*. Every result goes through
the spool, so a live probe whose scan tick outruns one batch reports thousands of them. At the dev
stack's own 5,047 sensors and a 500-row batch, that is every tick — **the fix for "alarms are
deferred and lost" was itself deferring every live alarm on a healthy installation.**

Eight lenses reviewed that change, one of them dedicated to the ingestion path, and all eight
audited the deferral machinery carefully. None opened `packages/probe/src/spool/drain.ts` to ask
what the flag driving it meant. The panel's completeness critic did, and named it as the blind
spot: every lens stayed inside `packages/core` and inside one ticket at a time.

**The lesson is about scope, not diligence.** A reviewer given a diff reviews the diff. A field
the diff *reads* is not in the diff, so its meaning is assumed — and an assumption about somebody
else's field is exactly the kind that survives eight careful readings. The critic round exists for
this and this is the first time it has paid for itself outright.

## The two the fifth panel found, and the one it found in itself

A fifth panel, over the diff that fixed the fourth panel's 12. It confirmed 4 — the yield across
five rounds is 45, 36, 12, 4. Two belong here.

### 31. A guard added to answer entry 30, defeated by statement order (`P-169`)

The per-source deferral registered a submission's source as one this write carried, *then*
checked whether the submission had decided anything, and recorded a staleness verdict only if it
had. A batch that decided nothing was therefore a member with no verdict — and the filter read
"no verdict" as live, flushing that probe's deferred set and reacting over rows the drain had
written hours before.

What makes it worth recording is the trigger: a batch re-delivered after a lost `results-ack` is
entirely duplicate, so the state machine skips every result and returns nothing. **A lost ack is
what the link flap that creates a spool does.** The most likely batch in a drain was the one shape
the guard could not judge, and it defaulted to the unsafe answer.

Three of eight reviewers found it independently, which is the strongest signal this document has
recorded for a single finding.

### 32. The test written for entry 31, which could not fail (`P-179`, found by mutating it)

The first version delivered a batch of *failed* checks twice. A failed check records no channel
values, so the duplicate carried neither samples nor states and never reached the write at all —
the code path under test was not entered, and the test passed against the bug, against the fix,
and against both halves of the fix reverted.

Four mutations were needed to establish that: revert half one (green), revert half two (green),
revert both (green — the test is inert), then rewrite it with *measured* results so the duplicate
carries samples but no state decisions, and revert both again (red). **The mutation that matters
is the one against the original code, and running only the single-half mutations would have
reported a passing guard.**

This is entry 24 and entry 29 for the third time, and by now the pattern is specific enough to
name: when a fix has two independent halves, mutating each half in turn can never distinguish a
working test from an inert one. Only reverting the whole fix can.

### 33. The panel's own blind spot, named by its own critic (`P-178`)

This panel had a lens dedicated to reading *outside* the diff — added because that is where the
fourth panel's best finding came from. It did its job: it verified eight premises sound, including
that `sentAt` really is stamped at send. And the panel still missed the largest defect in the
change, which its completeness critic then found:

> Every lens reviewed this change from the inside of a running, already-negotiated system. Eight
> lenses examined what the new fields and gates do once both peers agree on version 16, and
> nobody asked what the version bump itself does to a peer that is already deployed.

The protocol lens got closest and stated the opposite leg correctly — "new probe + old core cannot
occur" — then treated "old probe + new core" as a wire-shape question without checking whether
that probe survives the handshake. It does not: `isProtocolCompatible` refused any peer above this
build, so the bump would have taken every deployed probe offline until the fleet caught up.

**The lesson is not "look outside the diff" — the panel did that.** It is that a premise can be
audited for *what it enables* and never for *whether it is reachable*. The outside-the-diff lens
checked that `session.protocolVersion` is set before the gate reads it, which is a question about
correctness given a connection. Nobody asked whether the connection happens.

### 34. Two guards over one path, and the test that could only see the outer one (`U-17`, found by mutating before it shipped)

The API client reports a lost session on `AUTH_REQUIRED` and deliberately not on every 401,
because a login itself answers 401 three ways and each of those is the form working. The session
provider *separately* ignores the report unless it was already signed in.

Both rules are right and they overlap on every path the application can reach. A login form is
only ever shown to a browser that is already anonymous — so a listener firing on all three of the
login's own 401s is swallowed by the provider's guard and renders identically. **Widening the
client's filter to `status === 401` left every screen-level test green**, including the four that
drive the login form through a refused code and assert what stays on screen.

Caught by mutating rather than by reading, and the fix is where the assertion lives: the rule
belongs to the client, so it is asserted at the client — `onSessionLost` with a stub `fetch`, no
component in sight. That mutation then fails, and only that test sees it.

Two things are worth separating. The mutation was run because running one is the standing habit,
not because this looked suspicious; nothing about the code said "the outer guard is hiding me".
And the structural tell is visible in advance once named: **when two independent guards protect
the same path, a test that exercises the path can only ever measure their conjunction.** That is
entry 7 again — a subject that cannot express the property — arriving as redundancy rather than
as a missing seam.

### 35. A fixture in the shape the client expected, not the shape the server sends (`U-17`, found by a panel lens reading outside the diff)

The login form decided between "now type a code" and "this account is locked out" by reading
`error.details['enrolled']`. The core puts an `AuthError`'s values in `error.context` —
`toHttpError` has two namespaces, and fills `details` only for `ObjectError`, `MethodError` and
`TriggerError`. The lookup was always `undefined`, so **every account with a second factor was
shown the lockout message and a disabled button**, and the throttle delay always rendered as
"shortly".

Eight tests covered exactly this, in two files, and all eight passed. Each built its own refusal:

    body: { error: { code, message, details } }

— the shape the client reads, and a shape no server produces. The fixture was not wrong by
accident. It was written by the same person, in the same hour, from the same belief about the
wire, and it therefore agreed with the code about the one thing neither of them had checked.

**Three separate defences were in place and none of them could work.** TypeScript could not help:
`ErrorDetails` has an index signature, so `details['enrolled']` type-checks against a key that is
never present. Mutation testing could not help either — reverting the client to `details` leaves
the tests green, because the fixture moves with it; the mutation and the assertion are the same
belief. And the previous panel had a lens dedicated to reading outside the diff, which is what
eventually caught this one, but only because the lens was pointed at *the other end of the wire*
rather than at the calling code.

The general rule is the one this whole document keeps arriving at from new directions: **a test
that constructs its own fixture for a boundary cannot verify the boundary.** It verifies that the
code agrees with the author. The only thing that pins a wire is an assertion at each end that
neither end can satisfy alone — here, four cases in `auth-api.test.ts` asserting `context` carries
the values and `details` stays `{}`, and the web fixtures rebuilt to match. Moving the values to
`details` on the core now reddens three core tests; reading `details` on the client reddens six
web ones. Before, both changes were invisible.

Worth noting what it cost to find: nine review lenses, and the one that found it was the lens
whose entire instruction was to verify premises the commit rests on against code the commit did
not touch. That instruction exists because of entry 30 and entry 33. It has now paid three times.

## The inverse: a test that failed for a reason unrelated to its subject

**`ssh2`'s key generator, not the SSH sensors (2026-09-06).**

Everything above is a test that stayed green while its subject was broken. This is the mirror
image, and it earns a section because it costs the same thing in the end: a suite that goes red at
random teaches people to re-run rather than read, and then the next real failure is re-run too.

`packages/simulators/src/ssh-server.ts` generated a fresh ed25519 host key on every
`TestSshServer.start()`. Roughly one key in 256 comes out of `ssh2.utils.generateKeyPairSync` with
a 31-byte public key inside the OpenSSH blob — a leading zero byte trimmed where the format keeps
it — and `new ssh2.Server({ hostKeys: [key] })` throws `Cannot parse privateKey: Malformed OpenSSH
private key` on it. The `before` hook throws, and every test in `ssh-sensors.test.ts` fails at
once, each one named for an SSH sensor that was never reached.

**Measured**, on an idle machine: 26 unparseable keys in 6,000 (0.43%, against 1/256 = 0.39% for
"the first byte of the public key is zero"). Reconstructing the old `start()` exactly — generate,
then construct the server — threw 16 times in 3,000.

**The report was right about the cause and wrong about the trigger, and the wrong half is the
interesting one.** It arrived as load-dependent: red under `npm test --workspaces`, green 26/26
running that file alone. It is not load-dependent. It is a coin, flipped once per key, and the
sweep that measured it had the machine to itself. A whole-workspace run makes three draws — one
host key per SSH test file, plus one client key pair in `ssh-session.test.ts` — so it goes red
about 1.3% of the time. `ssh-sensors.test.ts` alone makes one draw: about 1 run in 230. Twenty-six
green single-file runs is what a 1-in-230 event looks like every time anybody has the patience to
try it, and it was read as a control.

That also disqualifies the evidence anyone reaches for first. Five consecutive green whole-workspace
runs after the change prove close to nothing: five runs *before* it would have been green 94% of
the time. What the fix rests on instead is that `start()` no longer calls the generator at all —
the host key is a committed constant, flagged in place as a fixture with no security value — so the
throw is gone by construction rather than by luck. The one caller that still wants a fresh key,
`keyPair()` for the key-authentication test, now generates until `ssh2.utils.parseKey` accepts one.

**Exposed by:** generating 3,000 keys and parsing each. Nothing in the suite could have found it.
At three draws a run its own signal is one red in seventy-odd, which is indistinguishable from the
flakiness it was being blamed on.

**What it needed:** measuring the rate instead of re-running until green. The re-run is what let it
survive — it works, every time, and it is precisely what a 1-in-70 failure trains everybody to do.

### 36. Six tests that could only fail for ten hours a week (`P-184`, found by the clock)

The pause-precedence table drives its schedule through `recompute(q, OUTSIDE)` at a pinned Monday
03:00, and then asserts that the operator's view agrees with the row the probe is filtered by.
Three service paths reach the schedule at the *real* clock instead and cannot be told otherwise —
`pauseState` computes holding live, `resume` does the same before refusing, and `ScheduleSync`
recomputes at the mutation's own timestamp. The window was `mo:08:00-mo:18:00`: closed at the
pinned instant, and open for ten hours of every real week.

So six cases asserted that two clocks agreed, while comparing 03:00 against whatever time it
happened to be. **They passed 94% of the time and failed 6%**, and the 6% is a contiguous block —
Monday office hours — so a project that runs its suite on weekday mornings would have seen this
constantly and one that runs it at night would never see it at all. This one ran at 02:00 and was
green, ran at 10:00 on a Monday and was red, with nothing in the repository changed between.

Three things worth taking from it.

**The failing assertion was the one carrying the comment that named the invariant** — "the view an
operator reads has to agree with the row a probe is filtered by, or one of them is lying about the
same sensor". Somebody understood the property exactly and wrote a fixture that could not test it.
That is entry 7 and entry 34 again: knowing the property is not the same as having a subject that
can express it.

**A time-dependent pass rate is invisible to every technique on this page.** Mutation testing says
what it always says — revert the fix, watch it go red — but the mutation only reddens during the
window. Run it at the wrong hour and a working guard reports as inert, or an inert one reports as
working. The only reason the mutations here mean anything is that they were run on a Monday
morning, on purpose, and the write-up says so.

**The first fix was a third of a fix.** An injectable `now` on `pauseState` made the view take the
pinned instant and the six cases pass — and left `resume` and `ScheduleSync` on the real clock, so
the file still had two clocks and the next case to touch either path would have found them.
Reverted in favour of a fixture whose window is closed on both clocks: a weekday that is not
today. The tell was that the seam existed only for the test, which is usually a sign the fixture
is what is wrong.

### 37. Three tests that held a negative hostage to a positive (`P-195`, found by reading CI's only failure)

`http-ssrf.test.ts` asserts, in three places, that the target guard did **not** refuse. It did that
by requiring the request to reject for some other reason — nothing is listening on
`10.255.255.1`, `no-such-host.invalid` will not resolve, `169.254.169.254` is unreachable — and
then checking the rejection was not a refusal.

Every one of those is a fact about the environment rather than about the code. On the one class of
machine where the last is false, the shape inverts: **GitHub's runners are Azure VMs, where
169.254.169.254 is the live instance-metadata service and answers immediately.** The request
succeeded, nothing rejected, and `assert.rejects` reported `Missing expected rejection` — a failure
message describing the guard as broken at the moment the guard was most correct, because standing
aside under policy `none` is exactly what it is for.

It was the **sole** failing test in every CI run before the workflow was disabled, and it took the
whole pipeline with it: the install-smoke and Windows jobs both `need` the build.

Three things worth taking from it.

**A test that asserts a negative needs a subject that can produce a positive.** `assert.rejects`
can only express "this failed, and here is what the failure was", so a case whose actual claim is
"the guard was silent" has to borrow someone else's failure to say anything at all. The replacement
is a helper returning the refusal or `undefined` — which says nothing about whether the request
succeeded, because these cases were never about that.

**The same guard was tested correctly ten metres away.** `webhook-delivery.test.ts` covers the
identical policy through the pure predicate with injected resolution — `refuses('none',
'169.254.169.254') === null`, no socket, no environment — and has never been red. Two tests of one
rule, and only the one that reached the network could be wrong about the network.

**And the test was performing the attack it documents.** Under `none` the guard steps aside by
design, so naming the metadata address there meant every cloud machine running the file genuinely
queried its own IMDS — deliberately, in a file whose entire subject is not doing that. Nobody read
the response, so nothing leaked; it is still the one request this code exists to prevent, issued on
purpose and unremarked for as long as the file existed.

**An audit for the same shape elsewhere found none.** Every `assert.rejects`/`assert.throws`
predicate in the workspace — 966 of them — was scanned for one that asserts only a negative about
the error; after this fix there are zero. The other tests holding hardcoded addresses hold them as
data, not as connection targets.

### 38. Two exporters that were the same exporter (`B-02`, found by the mutation surviving)

The flow listener reads UDP loss out of each exporter's own `flowSequence`, and the bug worth
guarding against is one shared counter instead of one per exporter — two devices sending to one
collector have unrelated sequences, and a single "expected next" reports a loss on every alternate
datagram, a number that looks like a failing network and is arithmetic.

There was a test for exactly that, named for it: *keeps a sequence per exporter, because they are
unrelated*. It delivered

    A: sequence 0, five flows
    B: sequence 0, five flows
    A: sequence 5, five flows
    B: sequence 5, five flows

and asserted nothing was counted missing. It passes. **It also passes with the bug**, and the
mutation is what said so: with a shared counter the expected-next runs 5, 5, 10, 10, every arriving
sequence is less than or equal to it, no forward gap is ever seen, and the count is zero for the
wrong reason. Both exporters were at the same point in their sequences, so the fixture could not
tell one counter from two.

Fixed by putting B nine hundred ahead of A. Then the shared counter sees B's 900 against an
expected 5 and invents 895 missing flows, which is the failure the test was always meant to
describe.

Two things worth taking from it.

**The test was written before the mutation, and knowing the bug in detail did not help.** The name
of the case states the property correctly; the author had the shared-counter failure in mind
clearly enough to write a paragraph about it in the source. What went wrong was one step further
down — choosing fixture values that make two mechanisms indistinguishable — and no amount of
understanding the property protects against that. This is entry 7 and entry 34 again.

**A fixture where every actor is identical cannot test per-actor anything.** The general form:
if the code under test keys something by X, the fixture needs at least two X's that *differ in the
keyed dimension*, not merely two X's. Two exporters at the same sequence are one exporter twice.

### 39. Forty widgets that were one widget (`G-02`, found by the mutation surviving — again)

`MapResolver` must resolve a whole canvas in one pass: a map with forty tiles is not forty round
trips, which is the constraint the ticket carried and the reason the resolver collects every object
id before it queries anything.

The test for it built forty widgets and counted the object lookups. It pointed all forty at the
same sensor. The resolver de-duplicates ids before querying, so the batched implementation and a
per-widget loop both issue exactly one query, and the case passed against the bug it exists to
catch. Fixed by giving the forty widgets forty distinct object ids; the mutation then dies.

**This is entry 38 with different nouns, four hours later.** There, two exporters were given the
same sequence numbers, so one shared counter and two separate ones behaved identically. Here,
forty widgets were given the same object id, so one query and forty behaved identically. Both times
the property was understood well enough to write a paragraph about it in the source, and both times
the fixture was built out of one thing repeated.

The rule, stated so it is checkable rather than merely true: **if the code under test collapses,
groups or keys by X, the fixture needs at least two X's that differ in X.** N copies of one input
cannot distinguish "handled once" from "handled N times", and no amount of understanding the
mechanism substitutes for counting the distinct values in the fixture.

It is also the second entry in a row found by a mutation surviving rather than by a test failing,
which is the case for running them on new tests and not only on new code.

### 40. One undo step, asserted by an end state that both worlds share (`G-03`, found by the mutation surviving — a third time)

The designer's drag has to record **one** undo entry for a whole gesture: a pointer move produces
a `draft` that changes the canvas without touching the history, and `record` at the end pushes a
single entry for the whole drag. Fifty entries for one drag is not undo, it is a replay.

The component test dragged a tile across four cells, pressed Ctrl+Z once, and asserted the tile was
back where it started. It passes when every pointer move commits its own entry — because the entry
pushed when the drag *ends* is the origin either way. The correct code has a stack of one whose
single entry is home; the mutant has a stack of five whose *last* entry is also home. One undo
returns the tile in both, and the difference only appears on the second one.

The fix is one line: after the undo, assert there is nothing left to undo (the Undo button is
disabled). That statement is false in the mutant and true in the original, which is what the case
was always trying to say.

**The shape, and it is not the same as entries 38 and 39.** Those were fixtures made of one thing
repeated. This is an assertion about an *end state* that is reachable by both the right and the
wrong path — the wrong path takes four extra steps to get there and the test only looks at where it
arrived. Stated so it is checkable: **when the property under test is "how many", asserting the
value after one step is not asserting it. Assert the count, or assert that the next step does
nothing.**

The undo stack was tested properly one level down — `canvas-model.test.ts` asserts `line.past` has
exactly one entry after a simulated drag — and that test kills a mutation of `record`. What it
cannot see is the component wiring `draft` where it should, which is the one thing the component
test existed to cover.

### 41. A claim about the wire, asserted one layer below it (`G-10`, found by writing the first HTTP test)

`G-01` is careful that **a map the caller may not read answers 404 rather than 403**, because
answering 403 for one that exists and 404 for one that does not turns the error into an oracle for
enumerating ids. `maps/errors.ts` says so, the row in `TASKS.md` says so, and `maps-service.test.ts`
asserts it: `MapService` throws `mapNotFound` in both cases.

All of that is true, and none of it was reaching the client. `MapError` extends `AppError`, and
`api/errors.ts` — which translates an exception into a status — had a branch for `ObjectError`,
`QueryError`, `AuthError` and nine others, and none for `MapError`. Every map error fell through to
the catch-all: **500, with the message replaced by "the request could not be completed"**. The 404
that avoids the oracle, the 409 a second designer gets from `If-Match`, the 400 for an invalid
name — all 500s.

Nothing could have caught it at the layer it was tested. The service was right; the translation was
missing; and the maps routes had no HTTP test at all, because the routes had never been mounted in
`main.ts` either (`G-03` found that half). The first `app.inject` against `/maps/:id/view` failed on
its first run.

**The rule: assert a claim at the layer the claim is about.** "The API answers 404" is a statement
about a response, and a test that the service *throws a 404-shaped error* is a statement about a
service. Between them sits a translation table that a new error class does not automatically join.

Two things worth noticing. The security property survived by accident — both the visible and the
invisible map answered 500, so the oracle never opened; what broke was every client's ability to
tell a missing map from a broken server. And the code field survived the catch-all, so a client
switching on `error.code` (the map designer does, for `MAP_CHANGED`) would have behaved correctly
while the status said something else entirely — the kind of half-working that survives a demo.

### 42. A guard that pinned where the SQL lives, not what it asks for (`S-11`, found by re-deriving the list to re-run a check)

`storage-engine.test.ts` — "names an engine-specific function in no file but the engine and its
migrations". It walks every file under `src`, looks for `time_bucket`, `create_hypertable`,
`drop_chunks`, `compress_chunk` and four more, and fails if one appears outside
`timeseries/engine.ts` and migrations 003/004. It has been green since `S-12` and it is a good
test of the thing it tests.

It was quietly believed to be more than that. `docs/findings/2026-09-03-timescaledb-on-windows.md`
decided this project needs no plain-PostgreSQL fallback engine, and it decided it by listing five
functions and checking each against the Windows package — "that is the whole of this project's
dependency surface". `CLAUDE.md` accepts the Timescale Licence for **native compression and
nothing else**, which is a claim about the same list. Two documents rested on it.

Re-deriving the list from the code six days later, to re-run the Windows check, it was eleven
symbols and not five. `show_chunks`, `decompress_chunk`, `timescaledb_information.chunks` and the
three `timescaledb.compress*` table options had joined it; `add_compression_policy`, which the
finding named as a dependency, is a function this project never calls — the housekeeping loop
compacts chunks precisely because the policies are TSL beyond what `CLAUDE.md` accepts. Nothing
had gone wrong at runtime, and no test could have gone red: **"no engine token outside these
files" and "these files use exactly these tokens" are different statements**, and only the first
one was written.

**The shape.** A containment guard is one-directional by construction. It pins *where* something
may appear and says nothing about *what*, so the set inside the boundary drifts freely while the
guard stays green — and the longer it stays green the more load the documents put on it. Stated so
it is checkable: **when a document depends on a list, assert the list, not just its location.** A
scan that would still pass if the list doubled is not pinning the list.

The fix asserts both directions and one more: the surface must equal a declared table, a symbol in
the table that stops being used fails too (or the Windows check is verifying something this
project no longer asks for), and seven named TSL features must appear nowhere. The comment
stripping is load-bearing — the migrations explain at length why they *don't* use
`add_compression_policy` — so it was mutation-tested from both sides: the name in a comment is not
reported, the same name in SQL is.

### 43. The guard for entry 42's failure mode, with entry 42's failure mode (`H-09`, found by mutating the side I had not thought to mutate)

`docs/runbook-field-test.md` tells whoever runs the week-long field test which channels to alarm
on, and says of each whether it carries a declared limit — which decides whether a *state* trigger
will ever see it, or whether the operator has to write a threshold themselves. The table said all
seven ship with declared limits. `probesDown` does not and never did, so anybody following the
runbook would have set up delivery for an alarm that cannot fire, on the one week nobody is
watching. Same shape as entry 42, one day later, in a second document: a claim about code, in
prose, that nothing checked.

So it got a test — the rule entry 42 produced, applied. The test parses the table and, for each
row, asserts the channel exists on the sensor named and that the limit column matches the code.
Three mutations from the document's side killed it: a wrong limit column, a channel that does not
exist, a table reformatted past the regex. It was written, mutated, and believed.

**Then the fourth mutation, from the code's side, did not kill it.** Removing the bound from
`evictedChunks` left `limits: {}` behind, and the test asked `channel.limits !== undefined` — an
object, not a bound. A channel that reads as configured and does nothing is precisely what the
runbook's column is *for*, and the guard for it accepted one. The run went red anyway, on the
generated-reference tests, which is how it nearly passed for the wrong reason twice: the suite
said "2 failed" and neither was this.

**The shape, and it is the one thing entry 42's rule does not say.** Asserting the list is not
enough if the predicate is weaker than the claim. "Has a `limits` key" and "has a bound that will
move a state" are different statements, and mutating the document only ever exercised the first
half of the comparison — the half I wrote the test around. **Mutate from both sides of an
equality: a test comparing A to B is two tests, and passing one of them is not passing the other.**

The fix is four `!== undefined` checks and a comment saying why an object is not a bound.

### 44. The container was too fast for the bug to happen in (`P-197`, found by the mutation surviving)

`P-196` is a latency defect. Revoking a probe wrote its rows and told the live connection nothing,
so the refusal only bit at the next handshake — hours away on a real network, with the machine
somebody had just revoked still probing their devices in the meantime. The fix was `withdraw`
beside `disconnect`: close the link *with a reason the probe acts on*, rather than with a bare
close it is built to treat as a blip.

`smoke-enrol.sh` grew the two assertions that seemed to say so, against a packaged build on two
boxes: after revoking, `stopped scanning` reaches the probe's journal, and the operator's own
sentence reaches it too. Both green. Then `withdraw` was replaced by `disconnect` — the defect
itself, exactly — and **both assertions stayed green and the smoke test passed.**

They are true on the broken path as well. The bare close makes the probe reconnect; the handshake
it comes back on is refused, with the same code and the same sentence; it stops. Same journal
lines, same order of magnitude apart — **because in a container the reconnect is one second, and
the entire defect is that on a real network it is not.** A test environment fast enough to make a
latency bug invisible is not a neutral convenience; it is a test environment that agrees with
whatever you assert.

**The shape.** This is entry 40's shape — an end state reachable by both the right and the wrong
path — in a distributed system rather than an undo stack, and it is worth the second entry because
the disguise is different. There the wrong path took four extra steps and arrived at the same
place. Here the wrong path arrives at the same place *later*, and "later" is the whole bug, so the
assertion has to be about the route and not the destination. Stated so it is checkable: **when the
defect is that something happens too late, no assertion that it happened can catch it.** Assert
what the fast path did *not* have to do.

The fix reads a journal cursor before the revocation and asserts, inside the slice after it, that
`stopped scanning` appears before `link to core closed` — the probe stopped without having to
reconnect. That is false on the broken path and true on the fixed one, and re-running the same
mutation now fails on that assertion and on nothing else.

Two smaller things from the same ticket. A second mutation — `approve` no longer closing the
session, which is `P-189`'s defect — fails step 1 and nothing else, so the two steps are
independent rather than one riding on the other. And step 3's first assertion was wrong in the
other direction: it read `hasOwnKey`, which is `hash AND confirmed`, for a claim about issuance
alone. It failed on the first run, which is the cheap kind of wrong.

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

## Twenty-one rules this produced

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
13. **A negative sweep is only as sharp as the principal it uses.** Entry 22: both passes were
    refused at the role gate, so a bar that asked only for the role was indistinguishable from a
    correct one. Choose the principal that *clears* every check but the one under test.
14. **A guard with slack in it is sized by the slack.** Entry 23's floor of 25 was cleared by 29
    routes while nine modules were missing. Put the bound near the truth, and where a count cannot
    express the property, name the thing that would disappear.
15. **Mutate a test that passed first time before believing it.** Entries 24 and 29 both passed
    against the bug because both branches of the guard produced the same row. A test written for a
    fix and green on the first run has told you nothing until the fix is reverted.
16. **An exemption list must name its members.** Entry 27's prefix swallowed the one route the
    ticket existed for. A pattern extends itself silently; a list of exact names is a line
    somebody has to add and justify.
17. **A mutation count is a claim, and belongs in the ticket only if it happened.** Entry 28 said
    3/3 and meant 2. The unmutated one was the change whose test could not fail.
18. **Check the meaning of a field you did not write.** Entry 30: the whole fix rested on
    `backlog`, eight reviewers audited what it drove, and none asked what it counted. A value the
    diff reads is not in the diff, and its meaning is the easiest thing in a review to assume.
19. **A guard must have no third answer.** Entry 31 had "stale", "live", and "never asked" — and
    the filter folded the third into the second. When a verdict can be absent, say what absent
    means, in the code rather than in your head.
20. **Mutate the whole fix, not each half.** Entry 32: a fix with two independent halves passes
    every single-half mutation whether or not the test works. Revert all of it at least once.
21. **Ask whether the thing you are auditing is reachable, not only whether it is correct.**
    Entry 33: a lens verified that the version gate reads a value set before it. Nobody asked
    whether a peer that needs the gate ever gets that far. Correct-given-a-connection is not the
    same as connected.

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

**Forty-four now, and the thirty-five added later are the ones that settle the argument.** The first
nine were all written in the rush of a single day, which is the comfortable explanation. Entries
10 to 13 are in code that was written unhurriedly a fortnight earlier, reviewed at the time, and
green ever since — and each one had a name that described a property the test did not check. The
base rate is not a function of haste.

Entries 22 to 25 close the argument from the other end. They are the guards written *for the
previous panel's findings*, by somebody who had just spent a day looking at exactly this failure
mode, reviewed and green — and two of them are the same defect as entry 19 and entry 3, in the
same file, one commit later. **Knowing the shape of the mistake does not stop you making it.**
The only things that have caught it are a mutation and a reader who did not write the code.

Entry 14 is the counterweight, and the cheapest thing on this page: it was caught by running a
new test in its own file, which takes seconds. Two more defects in that same fix were caught only
because the test existed at all — one of them a plausible fix suggested by a careful reader that
would have shipped, and one a silent truncating conversion that looked exactly like a working
loop. Most of this is not subtle. It is only invisible to the person who just decided what the
answer is.
