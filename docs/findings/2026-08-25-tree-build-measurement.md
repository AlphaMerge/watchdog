# Phase 1 exit criterion — building a 5,000-object tree

Date: 2026-08-25 · PostgreSQL 17, Node 24.19.0, Debian 12 container on Apple Silicon ·
reproduce with `./scripts/dev.sh npm run test:perf -w @ms/core`

`PLAN.md`: *"Create a 5,000-object tree via the API in under 30 seconds."* This was the last
Phase 1 exit criterion without a number against it.

Measured over **real HTTP against a listening server**, not `inject`: "via the API" includes the
socket, the connection pooling and the JSON on the wire, and skipping those would be answering an
easier question than the one the criterion asks. The wiring is production's, audit sinks included
— an install that writes no audit entries is not the install anyone runs, and that write is
inside every create's transaction.

The tree is exactly 5,000 objects in the shape an installation actually has: one probe, 100
groups, 1,300 devices, and the remaining 3,599 as sensors, three to a device.

| Client | Before `S-16` | After `S-16` | Rate | Spare |
| --- | --- | --- | --- | --- |
| Serial, one request at a time | 24.0 s | **21.0 s** | 239 objects/s | 30% |
| Eight requests in flight | 6.6 s | **5.9 s** | 847 objects/s | 80% |

The criterion is met either way. `create` takes a *shared* tree lock, so concurrent creates
genuinely run in parallel and a client that pipelines has four fifths of the budget spare.

## Where the time goes, measured rather than guessed

The first version of this document asserted that a create was "nine round trips to PostgreSQL"
and that serial builds were round-trip bound. Both halves were wrong, and the way they were wrong
is worth keeping.

Timing every statement across 400 creates gives **1.55 ms of database work per object**, against
roughly 4.2 ms per object end to end. **The request layer costs more than all the SQL together** —
Fastify routing, JSON-schema validation, `fast-json-stringify` serialisation, and the client and
server sharing one event loop in this harness. Shaving statements was never going to be the big
lever, and the measurement said so as soon as it was taken.

Per create, after `S-16`:

| Statement | Per create | Share of the SQL |
| --- | --- | --- |
| read the created object's detail | 0.307 ms | 20% |
| `INSERT INTO audit_log` | 0.259 ms | 17% |
| `INSERT INTO object` | 0.237 ms | 15% |
| `INSERT INTO sensor_config` | 0.183 ms | 12% |
| read the parent's kind | 0.146 ms | 9% |
| advisory lock | 0.083 ms | 5% |
| BEGIN, COMMIT and client overhead | 0.339 ms | 22% |

## What S-16 changed, and what it could not

**The parent read was the expensive one, and not for the reason it looked.** Folding the separate
`object_parent_kind_is_valid` call into it removed a round trip and changed the end-to-end number
by less than the run-to-run noise — that round trip was a trivial function call. The real cost was
that `create` read the parent's *whole detail*, side-table joins and a `count(*)` of its children,
to use one column. That count grows with the parent: every new sensor under a device with four
hundred of them counted four hundred rows to answer a question about kinds. Reading two values
instead took the statement from 0.371 ms to 0.146 ms and the whole create from 1.92 ms to 1.55 ms.

Note what that means for this benchmark: the 5,000-object tree fans out only 13 devices per group
and 3 sensors per device, so it barely exercises the count that was removed. The 12% it gained
here understates what a wide tree gains.

**The detail re-read cannot be removed, and it is worth writing down why.** The obvious idea is to
build the response from `RETURNING` on the inserts that just wrote it. It does not work: every
side-table write bumps the object's version by trigger (migration 002), so the object insert
returns version 1 while the committed object is at 2 — or at 5, once channels exist. The response
carries that version as its ETag, and a stale one means the client's first `If-Match` PATCH is
answered 412. Measured directly:

```
device, after its own INSERT:        version 1
device, after device_config INSERT:  version 2
device, after one channel INSERT:    version 3
```

Channel writes were also batched into one statement while in the area. That is worth nothing
today — `permissiveSensorTypeGate` declares no channels until `P-05` ships the registry — and
worth five round trips per sensor the moment a real sensor type declares five channels.

## The lever that is left

Fewer *requests*, not fewer statements. A batch create endpoint would collapse both the HTTP cost
and the per-object BEGIN/COMMIT, and it is what a provisioning script actually wants; the service
already has the `batch()` seam that clone uses. Nothing needs it yet — a pipelining client
finishes in 5.9 seconds — so it is not filed as work, only as the direction if the number ever
matters again.

## What this does not measure

A remote database. Every number here is loopback inside one container, which matches the
standalone deployment `CLAUDE.md` mandates — the operator installs PostgreSQL on the same box. An
installation that puts the database on another host adds its latency to each of the eight round
trips a create makes, and the serial path would feel it.
