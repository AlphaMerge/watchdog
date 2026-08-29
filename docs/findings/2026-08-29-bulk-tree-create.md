# Building a 5,000-object tree in one request

`P-19`, measured 2026-08-29. Reproduce with:

```bash
scripts/dev.sh "node --test packages/core/dist/test/perf/tree-build-performance.test.js"
```

Same harness, same HTTP, same wiring, same 5,000 objects as the serial measurement it sits beside
— a probe, 100 groups, 1,300 devices and the rest sensors. Stop `ms-server` first (`P-21`).

## The numbers

| How | Wall | Rate | Against the 30 s budget |
| --- | --- | --- | --- |
| serial, one request per object | 28.8 s | 174 objects/s | 4% spare |
| 8 requests in flight | 8.8 s | 570 objects/s | 71% spare |
| **one request** | **2.8 s** | **1,798 objects/s** | **91% spare** |

**10.3x the serial path**, and 3.1x a client clever enough to pipeline eight at a time.

## Why the serial path costs what it does

Not the inserts. `S-16` already measured that and corrected the premise it was filed under: the
per-object work that remains is genuinely needed — `M-02`'s `sensor_runtime` row, `M-08`'s guard
against a paused ancestor, the hierarchy trigger, the audit entry.

What a serial build pays *per object* is the set of costs that are really *per request*:

- an HTTP request and its response
- a transaction — begin, commit, and the fsync at the end of it
- `lockTreeShared`, taken and released five thousand times
- the `anyActive` probe that guards the pause cascade
- a `SELECT` of the parent, to learn a kind the caller already knew

None of those get cheaper with a faster machine, and all of them disappear when the unit of work
is a subtree rather than an object.

## What the bulk path does instead

One transaction. One tree lock. One parent read. One pause check. Then **one statement per
level** — the tree is written breadth-first, and a level is exactly the set of nodes whose parents
are already written — plus one statement per kind for the side tables and one for every sensor's
channels.

For the shape above that is: 3 object inserts (groups, devices, sensors), 2 side-table inserts
(devices, sensors), 1 channel insert, 1 read-back for the audit log, and 1 audit write. **Eight
statements for 4,999 objects**, against roughly 15,000.

## Two things that are the same, deliberately

**The tree.** Every object goes through the same validation, the same hierarchy trigger, the same
parameter normalisation, the same channel declaration and the same audit sink. A test creates one
sensor each way and compares the stored rows rather than comparing against a value typed into the
test — a hard-coded expectation would go on passing if normalisation moved and only one path
followed it.

**The audit log.** One entry per object, each carrying what was *stored* rather than what was
requested: the entries are built from a read-back, so they hold the defaults the schema filled in,
the version the triggers landed on, and the redaction every read goes through. An entry saying
"5,000 objects were created" answers no question anybody has.

## Two things that are different, deliberately

**It is all or nothing.** One transaction means the whole subtree appears or none of it does,
which is what a discovery run needs: a half-provisioned device is worse than a failed one, because
nothing says which half. It is also why the node count is bounded at 5,000 — the tree lock is
shared, but a transaction that runs for a minute is still a minute in which nothing can
restructure the tree.

**The answer is ids, not objects.** Five thousand full objects is megabytes of response describing
what the caller already wrote; the one thing they could not know is what the ids came out as. They
arrive in the order the nodes were sent, which is neither the order the rows were written nor the
order the levels produced them.

## One implementation note worth keeping

The batched object insert uses `jsonb_to_recordset` rather than parallel `unnest` arrays, and
`tags` is the reason: `unnest` flattens a multidimensional array completely, so a column of
*lists* cannot go through it — five nodes with two tags each arrive as ten rows of one string.
JSON carries the nesting, and ragged lists as well, which a Postgres array literal does not.

Ids come back in input order because the insert is a single statement with an explicit
`ORDER BY ord`: the sequence is advanced once per row as the rows are produced, so sorting the
returned ids ascending recovers the input order. Relying on the order of the `RETURNING` rows
themselves would not be sound; relying on the order the sequence hands numbers out within one
statement is. The `ORDER BY` is what makes that true, so it is not decoration.
