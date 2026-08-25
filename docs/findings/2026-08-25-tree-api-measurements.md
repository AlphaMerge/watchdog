# Measurements: tree CRUD API (S-03)

- **Date**: 2026-08-25
- **Measured on**: PostgreSQL 17.11 + TimescaleDB 2.29.2, Node 24.19.0, in the dev container
- **Reproduce**: `scripts/dev.sh "cd packages/core && node --test 'dist/test/clone-performance.test.js'"`

CLAUDE.md: *performance claims need a measurement committed to the repo, not an assertion.*
These are the two claims S-03 makes.

## 1. Pagination must be keyset, not offset

Measured over 50,000 siblings under one parent, names deliberately non-unique.

| Approach | Time | Buffers |
| --- | --- | --- |
| Keyset on `(parent_id, name)` — the index migration 001 already had | 0.20 ms | 154 |
| Keyset on `(parent_id, name, id)` — the composite added in migration 002 | 0.23 ms | 104 |
| `OFFSET 40000` | 12.29 ms | 40,344 |

A deep offset page is ~60× slower and touches ~260× the buffers, because it reads and discards
every row it skips. That cost is why `CAPABILITIES.MD:465` calls for cursor pagination, and it
is why there is no `?offset=` parameter to reach for.

The composite index buys little on time; it earns its place by making the scan index-only, and
by making the `id` tiebreaker explicit — sibling names are not unique, so a cursor on `name`
alone would skip rows.

## 2. Cloning is set-based

Cloning a 221-object subtree (1 group → 20 devices → 200 sensors, depth 3):

```
cloned 221 objects in 23.9 ms using 14 statements
```

14 statements, not 221. The count is a function of tree *depth*, not of object count: one
`INSERT … SELECT` per depth level, then one bulk statement each for `sensor_config`,
`device_config`, `channel` and `object_setting`.

The per-depth-level split is not an optimisation, it is a correctness requirement.
`object_check_hierarchy()` is a `BEFORE ROW` trigger that reads `SELECT kind FROM object WHERE
id = NEW.parent_id`, and PostgreSQL does not guarantee that a row inserted earlier in the same
multi-row statement is visible to a later row's trigger. Inserting depth by depth makes every
parent visible to its children.

`clone-performance.test.ts` asserts the statement count stays below 20, so a future change that
loses the set-based path fails the test rather than quietly costing a second per hundred objects.

## 3. A cycle does not corrupt data — it hangs

Found while checking that `objects-concurrency.test.ts` fails when the advisory lock is removed.

Without the tree lock the two concurrent-move tests do not fail with a wrong answer; they never
finish. A cycle in the adjacency tree makes every `WITH RECURSIVE` walk loop forever, so the
next read of that subtree hangs instead of erroring. For a monitoring system that is the worst
available failure mode.

Cycles are prevented three ways over — the trigger in migration 001, the pre-check in
`ObjectRepository.wouldCycle`, and the exclusive tree lock. On top of that, every recursive walk
in `repository.ts` and `inheritance.ts` now carries `WHERE depth < 1000`, matching the limit
migration 001's own cycle check uses. A bounded walk that returns a wrong answer can be
debugged; an unbounded one takes the process with it.

## 4. What an adversarial review of S-03 found

Six reviewers, one per dimension, then one independent skeptic per finding whose instruction was
to *refute* it. 37 candidates, 35 survived — a high rate, which says more about the review's
scope than about the code: most were test-quality findings, and several reviewers independently
reported the same defect.

The one that mattered:

**A PATCH touching only a side table always failed 412 against its own fresh ETag.** For a body
like `{"kind":"device","host":"10.0.0.2"}`, no column on `object` changes, so the
version-predicated `UPDATE object … AND version = $n` was skipped. The `UPDATE device_config`
then fired `device_config_touch_owner`, which bumps `object.version` — and only *afterwards* did
the code assert the caller's version, now comparing against a number its own statement had just
incremented. A device's address and a sensor's parameters were unchangeable through the API, and
the operator was told somebody else had edited the object when nobody had.

Five of the six reviewers found it independently. No test covered it: every PATCH test also
changed `name`, which took the guarded path.

The fix is one guard-and-bump statement before any write —
`UPDATE object SET … WHERE id = $1 AND version = $expected RETURNING id` — with zero rows
discriminating 404 from 412. A plain `SELECT` beforehand would not do: under READ COMMITTED it
takes no lock, so a concurrent writer's bump stays invisible and the lost update the precondition
exists to prevent slips through anyway.

Also fixed from the same review:

| Finding | Fix |
| --- | --- |
| Settings writes ran outside a transaction, breaking the audit sink's own contract | `setSetting`/`clearSetting` run in `db.tx` with a transaction-bound resolver, and honour `If-Match` when it is sent |
| 500 bodies carried the statement text and `host:port/database` | A 500 now says only that it failed; the detail goes to the log, correlated by request id |
| A malformed JSON body was reported as 500 | Fastify's own 4xx status is passed through |
| `304` was served for `?include=settings`, hiding a changed inherited value | Conditional GET applies only when the response is entirely the object's own state |
| Tag filtering matched own tags only | `CAPABILITIES.MD` §1 requires inherited tags: the filter now selects the subtree of every tagged object |
| An unknown `?kind=`, an out-of-range id and a hostile cursor each reached the driver as a 500 | Bounded at the boundary schema, so they are 400s |
| `copySubtree` could not run twice in one transaction | The temp table is dropped first — bulk clone (D-09) will do exactly that |
| `create` returned a version taken before its own channel inserts | Re-read after them, so the returned ETag is not stale on arrival |

And the review found the credential canary test could not have caught the leak it was written
for: `credential_set.secret` is `bytea`, `pg` returns a `Buffer`, and `JSON.stringify` renders
that as `{"type":"Buffer","data":[83,69,...]}` — so the ASCII canary would never have appeared in
a leaking body. The sweep now checks the byte-array, base64 and hex renderings too.
