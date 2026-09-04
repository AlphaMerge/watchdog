# Five tests that passed for the wrong reason, and what exposed each

`P-58`–`P-76`, 2026-09-04.

A day spent on `P-58`'s backlog turned up five tests that were green, had been green for weeks,
and did not test what their names said. None was a careless test. Each was written by somebody
who understood the defect, and each passed for a reason that had nothing to do with it.

This is the catalogue, because the interesting part is not the individual bugs — those are in
their tickets — but that **five independent instances of one failure appeared in one day**, and
that a different technique was needed to expose each. A green suite is evidence about the suite.

---

## The five

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

## What actually found them

Ranked by what each cost and what it caught:

| Technique | Caught | Cost |
| --- | --- | --- |
| Mutation — revert the fix, expect red | 1 | Minutes, and the only general one |
| Reading, prompted by an audit | 2 | Free, but needs somebody to ask |
| Adversarial review of a *fix* | 3 | Expensive; caught what its author could not see |
| Running it N times and counting | 4 | Cheap and nobody does it |
| Instrumenting durations, then a log spy | 5 | Minutes, once the duration looked wrong |

The one that generalises: **a passing test is a hypothesis, and the mutation is the experiment.**
Four of the five had never had the mutation run against them.

The one that does not: an adversarial reviewer found the two defects their own author had looked
straight at. `P-60`'s snapshot storm and `P-66`'s allowance were both written by somebody who had
just spent an hour thinking about that exact code.

## Three rules this produced

1. **Assert on `dist`, not on `src`.** Verify the compiled output after a mutation sweep, and
   before trusting a suite that certifies a fix. Twice in one day an incremental build did not pick
   up a restore, once through a `git stash` cycle that left the source older than the build.
   `tsc -b --force` costs a minute.
2. **A number chosen so the assertion holds is a smell.** `queueLimit: 0`, one factory at exactly
   the floor, a 3,000 ms timeout against a 3,000 ms timer. When a test's constants are load-bearing
   for the *pass*, ask what it proves at any other value.
3. **Run a race a hundred times before calling it deterministic.** Cheap, and it is the only thing
   that separates a guard from a coin flip.

## What is still not covered, and is said so on purpose

`P-66` wires an allowance to the snapshot in one line, and nothing fails if that line is removed.
Catching it needs a socket whose buffer stays non-empty, and on loopback it drains before it can be
observed — which is the same reason `P-60`'s original assertion was empty. The arithmetic is pinned
and the wiring is not. Pretending otherwise is what `P-60` did.
