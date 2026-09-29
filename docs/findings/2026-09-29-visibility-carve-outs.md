# Holes in a readable root: every nested shape, and four hundred of them under `EXPLAIN`

**Date:** 2026-09-29
**Task:** `A-33` — visibility for a root-readable account is never tested with nested holes, or
measured with many
**Tests:** `packages/core/test/access-rights.test.ts` (the shapes),
`packages/core/test/perf/visibility-performance.test.ts` (the measurement and the plans)
**Follows:** `docs/findings/2026-09-28-object-visibility.md`

## The question

An account that reads the root sees the tree minus what it cannot see, and `Visibility.where`
says so as `id NOT IN (<walk>)`. The walk starts from every grant whose answer differs from the
root's and stops at every grant, so it collects the holes and nothing re-opened inside them.
`A-12`'s review found two things missing (T10 and M3):

- **The shapes were never made.** The agreement test scatters grants from forty seeds. Across
  all forty it put a hole inside a hole zero times and re-opened a hole zero times. Those are
  exactly the cases where the walk has to stop at the right boundary and no other.
- **The only `NOT IN` measurement had ten holes.** PostgreSQL never plans `NOT IN` as an
  anti-join, because of what it has to do with a null. Either it hashes the subquery once, or,
  when it expects the rows not to fit in `work_mem`, it reads them again for every row it
  filters. That second plan is quadratic in the size of the tree. Ten holes could not show which
  plan several hundred get.

## The shapes

Nine fixed grant sets, on a tree of `outer-0 ⊃ inner-0 ⊃ device ⊃ sensor`, plus a device beside
`inner-0` and a second outer group that no shape touches. The account is in two groups, and
Alpha reads the root:

| Shape | Grants | Seen, of the six named |
| --- | --- | --- |
| a hole | outer: Alpha `none` | untouched |
| a hole inside a hole | outer, inner: Alpha `none` | untouched |
| a hole re-opened | outer `none`, inner `read` | inner, device, sensor, untouched |
| a hole inside a re-opened hole | + device `none` | inner, untouched |
| re-opened, carved and re-opened again | + sensor `read` | inner, sensor, untouched |
| a hole inside a hole, re-opened at its deepest | outer, inner: Alpha `none`; sensor: Beta `read` | sensor, untouched |
| a hole re-opened by the other group | outer: Alpha `none`; inner: Beta `read` | inner, device, sensor, untouched |
| a `none` the other group reads through | outer: Beta `none` | all six |
| a `none` for a group the account is not in | outer: Gamma `none` | all six |

The test checks each shape for every principal that can read, in two ways:

- The four answers the code gives — the SQL condition, `sees`, `whereChildOfVisible` and `trim`
  — agree with `resolveManyFor` on every object in the tree. This is the randomised test's
  check, now in one function that both tests call.
- The condition's rows match the hand-written `seen`, so a shape that agreed with a wrong
  resolver would still fail. The condition carries `NOT IN` exactly when something is hidden.

**The randomised test could not see two of the four mutants of the walk and the trim; the shapes
see all four:**

| Mutant | Randomised | Shapes |
| --- | --- | --- |
| N1 the walk crosses a re-opening grant | caught | caught |
| N2 the walk stops only at holes | **passes** | caught |
| N3 any hole on the path wins | caught | caught |
| N4 a hole is never re-opened in a trimmed path | **passes** | caught |

So the gap was real, and nothing in the code was wrong: every shape agreed on the first run.

## Four hundred carve-outs, measured

The `test:perf` case adds a seventh principal to `A-12`'s six. It reads the root and has **400
devices carved out** (every fifth device, so 4,000 sensors hidden). **40 of those holes are
re-opened** by a `read` grant on the first sensor of every tenth carved device. So the walk
starts from 440 boundaries, stops at 440, and leaves 16,040 of the 20,000 sensors visible. The
tree is `A-12`'s: four probes, a hundred customer groups, twenty devices each, ten sensors per
device, one sensor in twenty Down.

Taken 2026-09-29 at 04:45, in a window WatchDog held quiet, on the code this ticket pushed. Only
the test's plan check changed after this run, as described below:

```
load average   0.67 / 7.54 / 20.19  over 8 CPUs  (0.08 per CPU)
delivered CPU  270 ms for a fixed loop  (1.01x the reference machine's 267 ms)
database       nothing else is connected
```

- `ms-server` was **stopped**. It had been stopped before the window; this run did not stop it.
- Also on the VM, all idle: the kept `H-23` install box (`ms-smoke-install-debian-62666`,
  0.00 % CPU, 122 MiB), and three other projects' CI runners (`ddc-runner`, `ddc-runner-2`,
  `whatsbot-runner-fixed`, at most 0.85 %). Another project's eight-container stack
  (`dutydesk-cloud-*`) and its database (`ddc-pg`) were at most 1 % CPU each. None of them is a
  client of the monitoring database. The database line above says nothing else was connected.

Median of fifteen calls after three untimed ones:

| Principal | Sees | Resolve | A page of the list | A page of alarms | Overview counts | Snapshot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| administrator | 20,000 | 1.0 ms | 2.5 ms | 14.0 ms | 34.7 ms | 249 ms |
| the root, ten customers carved out | 18,000 | 1.0 ms | 4.2 ms (1.7×) | 20.9 ms (1.5×) | 37.2 ms (1.1×) | 190 ms (0.8×) |
| **the root, 400 devices carved out, 40 re-opened** | 16,040 | 4.2 ms | 10.2 ms (4.2×) | 40.1 ms (2.9×) | 63.6 ms (1.8×) | 185 ms (0.7×) |

The run prints `A-12`'s other four principals too. They are within the spread of
`2026-09-28-object-visibility.md`, and they are not what this ticket asked about.

The budgets are an operator's: a page, the totals and a resolution each inside a quarter of a
second, a full snapshot inside two. The four-hundred-hole principal is inside every one by at
least 3.9 times, the counts being the closest. Its largest 90th percentile is 99 ms, also for the
counts. Two earlier runs in the same window, under 0.44 and 0.05 load per CPU, put that
principal's medians within these ranges: resolve 3.0–4.2 ms, list 9.6–11.1, alarms 32.1–40.1,
counts 40.3–63.6 (this run's 63.6 is the outlier; the other two were 40.3 and 40.9, level with
the administrator), snapshot 139–185.

What the row says:

- **Resolving is no longer flat, and does not need to be.** Resolving reads the boundaries, and
  this principal has 440 of them rather than a handful. So resolving costs 3–4 ms, against about
  1 ms for every other shape. It is paid once per request.
- **The list pays for the walk before its `LIMIT`**, as every principal with exceptions does. The
  walk is 4,360 ids long here. That is about 10 ms, a quarter of what the principal granted every
  probe pays for its `IN` form.
- **Seeing less is still cheaper for the snapshot.** 16,040 rows cost less to read than 20,000,
  and the rows cost more than the walk.

## The plans

Measuring the time cannot tell you which plan ran; it would show a re-read plan only as a time
that grew with the tree. So the test records the statements that each of the four read paths
sends for the four-hundred-hole principal, runs `EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON)` on
each, and finds every walk in the plan: a subplan that scans the `exception` CTE. For each walk
it reads how the plan uses it, `(hashed SubPlan n)` or `(SubPlan n)`.

```
list        walks 1  hashed 1  re-read 0  unseen 0     19.5 ms
alarms      walks 3  hashed 3  re-read 0  unseen 0     80.3 ms
counts      walks 1  hashed 1  re-read 0  unseen 0     51.1 ms
snapshot    walks 1  hashed 1  re-read 0  unseen 0     92.4 ms
```

The times are `EXPLAIN ANALYZE`'s, with its instrumentation, so they are not the measurement
above. Every walk is hashed: the tree is read once per statement, not once per row.

The test in its final form, the check changed as described below, was run once more at 05:05
to confirm it passes, both cases green and the plans the same. Other sessions were doing light
work, and the run measured 0.42 load per CPU and 1.15× the reference CPU time. Its numbers are
not used above.

**Three things the test checks, so that a green result says what it claims:**

- **Each path by name.** Each path's statements are recorded separately, and a path that sent no
  walk fails by name. A total such as "at least four statements" could pass with one path
  counted twice and another missing. The first version of the test used a total, and failed
  with three: the alarm list reads inside `db.tx`, and the recorder only covered `db.query`.
- **Every walk the text holds is found in the plan.** The alarm list's statement holds two walks.
  One filters the alarming sensors. The other marks each step of each sensor's path visible or
  not, and it is an expression in a select list. A plan without `VERBOSE` prints no reference to
  it, so if that walk were re-read per row the check would not see it. The second version of the
  test had that gap: its alarms row said `hashed 1`. Now the plan is `VERBOSE`, output lists are
  read along with filters and conditions, and every walk found must be referenced and hashed. A
  walk the reader finds but cannot see used is counted `unseen` and fails. And the plan must hold
  at least as many walks as the statement's text has `NOT IN (WITH RECURSIVE exception`.
  *At least*, not exactly: the third version required exactly, and the alarm list's plan held
  three walks for its text's two (below).
- **Not vacuous.** Each statement is planned again with `work_mem` at 64 kB, which is too little
  to hash the carve-outs. Every walk found in every statement must then be seen re-read,
  including the ones from the alarm list's select list.

**The alarm list walks the carve-outs three times, and could walk them twice.** Its `sighted` CTE
marks each step `${visibleStep} AS visible`, and one query reads it, so PostgreSQL inlines it.
Inlining replaces each reference to `visible` with the expression, and `placed` has two:
`array_agg(id) FILTER (WHERE visible)` and `array_agg(name) FILTER (WHERE visible)`. So the plan
holds two copies of the step walk, each hashed and each building its own hash table. A
`VERBOSE` plan on a scratch database shows them as `hashed SubPlan 8` in the first aggregate and
`hashed SubPlan 10` in the second. It costs one walk more, a few milliseconds of the alarm list's
40, so no ticket was filed. **The fix, for whoever next edits `state/alarms.ts`, is
`sighted AS MATERIALIZED (…)`.** That evaluates the mark once per step and leaves one copy. The
test's check (found ≥ text) passes either way.

## `NOT IN` stays

The ticket said to switch to `NOT EXISTS` only if the plan degraded, and it did not. For the
record, the switch would be safe where it matters. `NOT EXISTS` plans as an anti-join and would
read a null column as visible where `NOT IN` reads it as hidden. The one nullable column the
condition is applied to, `tops`' `parent_id`, tests for null itself.

What would change the answer is a walk too large to hash in `work_mem` (4 MB by default). Here
the walk returns 4,360 ids (400 devices and their 4,000 sensors, less the 40 re-opened). This
measurement does not find where between 64 kB and 4 MB the planner stops hashing. The test
names the plan, so a larger installation that crosses that line will fail by name, not slowly.
