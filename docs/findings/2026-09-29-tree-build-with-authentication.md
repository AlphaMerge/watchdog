# Building a 5,000-object tree as a real caller

`P-225`, measured 2026-09-29 23:14–23:22 UTC in a window booked for it. Reproduce with:

```bash
scripts/dev.sh "node scripts/perf-conditions.mjs && cd packages/core && node --test dist/test/perf/tree-build-performance.test.js"
```

Until this run, every committed tree-build number came from a server built with **no
authentication at all**. `tree-build-performance.test.ts` said its writes went through the stack
"exactly as production assembles them", and set `requireAuthentication: true` on a config field
that does nothing without `auth` wired. So no request resolved a token, none asked whether its
caller could write the parent, and none met the per-account rate limit. Production does all three
on every request.

The harness now builds the same 5,000 objects three ways, interleaved within each sample so a
drift in the machine lands on all three alike:

- **no auth**, which is what every earlier number measured, kept so that the difference is the cost
  of authentication and nothing else;
- **an administrator's API token**;
- **a non-administrator's token** whose group holds `write` at the root. Every create then walks
  from its parent to the root to find the grant, which is the longest walk this tree has.

The rate limit is raised for the two authenticated callers, in this fixture only. At the default,
one account's serial build is refused at request 1,201. This file measures what a request costs,
and the limiter measures how many one account may make; `A-39` is the policy.

## Conditions

| | |
| --- | --- |
| load average | 0.89 / 20.51 / 28.37 over 8 CPUs — 0.11 per CPU at the start. The 5- and 15-minute figures are the booked run before this one (`P-216`) finishing |
| delivered CPU | 265 ms for the fixed loop, 0.99x the reference machine |
| database | nothing else connected |
| `ms-server` | **down**, restart-looping on exit 78 against an edited migration. Not stopped for this run, and not a competitor on the database while it is down |
| every other session | held by the orchestrator for the window |
| code | `main` at `d66c106` plus this ticket's harness, built before the run. Nothing else in the working tree was in the build. Of what landed on `main` after the build, `A-31` changes the acknowledge and simulate routes and `S-20` adds a string check on a device's host; neither adds a query to a create |

## The numbers

Median of three samples, each into its own empty database (`P-193`), with the samples in brackets.

**One request (`P-19`'s `POST /objects/tree`)** — the criterion's answer:

| Caller | Wall | Rate | Against 30 s | Samples |
| --- | --- | --- | --- | --- |
| no auth | 2.8 s | 1,803 objects/s | 91% spare | 2.6, 3.4, 2.8 |
| admin token | 2.6 s | 1,925 objects/s | 91% spare | 2.4, 2.7, 2.6 |
| non-admin token | 3.5 s | 1,427 objects/s | 88% spare | 3.5, 3.6, 2.6 |

**One object per request, rate limit raised** — the cost of the request path, which no account can
reach at these speeds in production:

| Caller | Serial | Samples | 8 in flight | Samples |
| --- | --- | --- | --- | --- |
| no auth | 27.1 s | 23.7, 29.7, 27.1 | 8.9 s | 7.7, 10.4, 8.9 |
| admin token | 35.7 s | 35.7, 34.5, 37.2 | 11.5 s | 13.9, 11.5, 10.3 |
| non-admin token | 44.7 s | 44.7, 50.7, 40.4 | 12.1 s | 12.1, 12.4, 10.0 |

## What it means

**The criterion holds, for every caller, on the path it is met by.** A 5,000-object tree in one
request takes 2.6 to 3.5 s whoever sends it. Authentication is paid once per request, and there is
one request.

**The serial path never met it as a real caller.** An administrator's serial build takes 35.7 s
and a non-administrator's 44.7 s, against the 27.1 s the same run gives with authentication
switched off. That is **1.7 ms per create for an administrator and 3.5 ms for anyone else**. The
separation is clean rather than a reading of medians inside noise: every administrator sample is
above every unauthenticated one, and every non-administrator sample is above every administrator
one. `PLAN.md`'s 20.9 to 25.7 s serial range measured a path production does not run.

**And the rate limit makes the serial speed moot.** One account may make 1,200 requests a minute,
so 5,000 creates need five windows and at least four minutes, whatever a request costs. A script
that does not honour `Retry-After` stops with the tree half-built at request 1,201 (`A-39`). Bulk
is the provisioning path, and the documentation should say so.

**The unauthenticated serial median, 27.1 s, is at the top of the range four quiet runs gave on
2026-09-08 (20.9 to 25.7 s).** Its own samples span 6.0 s, which is the noise `P-194` measured for
this path, so it is not read here as a change in the code.

## Where the per-request cost goes

The per-create difference is paid on every write any account makes, not only in provisioning,
so it was profiled. The pg driver's `query` was wrapped and every statement timed across 1,000
serial creates per caller, with the same wiring as the benchmark. It was run twice, **under load**
(0.55 and then 1.06 per CPU, and another client on the database the second time), so the counts
are exact and the times are only indicative. This table is from the second run, per sensor
create:

| Statement | no auth | admin | non-admin |
| --- | --- | --- | --- |
| the token lookup (`api_token` joined to its account) | — | 1 / 1.3 ms | 1 / 1.3 ms |
| the permission check's administrator `EXISTS` (`AccessService.resolve`) | — | 1 / 0.9 ms | 1 / 0.9 ms |
| the permission check's rights walk (`WITH RECURSIVE chain …`) | — | — | 1 / 1.9 ms |
| **the writer's sight** (`visibilityFor`: administrator, epoch and every grant, one query) | — | **1 / 3.2 ms** | **1 / 3.3 ms** |
| everything else — tree lock, parent, pause probe, inserts, channels, audit, commit | 10 | 10 | 10 |

**The spread is four round trips, and the walk is not the expensive one.** However deep the parent,
the rights walk costs about one round trip. **The most expensive of the four is one that nearly
every write never uses.** `writerFor` resolves the writer's sight for every write, so that `A-29`
can check what a sensor's parameters name. Its only consumer, `assertMayName`, runs for sensor types
in `readingTypes()` and nothing else, so a group, device or Ping create pays for it and never reads
it. That is `P-235`.

Also noted, and not in `P-235`'s scope: the administrator fact is asked twice per request, once by
the permission check and once inside the sight.

## Changed alongside

- `ApiServerOptions.rateLimit`, used by this fixture only. `A-39` replaces it with a setting.
- The file's claim to measure what production assembles is true now, and says what it leaves out.
