# Object visibility on the read paths: the approach, and what it costs

**Date:** 2026-09-28
**Task:** `A-12` — lists, search, alarms, the state log and the stream ignore object rights
**Measurement:** `packages/core/test/perf/visibility-performance.test.ts`

## The question

`A-03` gave the tree per-object rights and `A-11` made every route declare who may call it. Every
route that answers with *many* objects declared `READS` — a role check with no object in it — and
none of them handed the principal any further. A `readonly` account granted one customer's branch
read every other customer's device and sensor names, states and failure messages, live.

The rule was never in question: `administration.md` already says what a right is and that `none`
carves a hole. The design is where the rule goes, so that a page of 100 is still a page of 100, a
keyset cursor does not skip, a total does not count what it hides, and a WebSocket that stays open
for a week notices when a grant is revoked. This is written before the code because it changes
the hottest read paths in the system.

## The rule, stated once

**An object is visible to a principal exactly when `AccessService.resolveManyFor` would answer at
least `read` for it** — the groups' grants, inherited per group, highest across groups, capped by
the role and the token's scope. Nothing else decides it.

**An object that is not visible is absent**: from every listing, subtree walk, count, total,
alarm row, log row, notification row, map widget list and stream frame. Its name, state and
message appear nowhere. *Absent, not counted* — a total that included it would say how many
sensors match a filter in a branch the caller cannot see.

**The containers above a granted branch are outside it.** A path or breadcrumb is trimmed to the
steps the principal can see, so a customer granted `Customer A` sees `Customer A › web01 › Ping`
and never learns what the probe above it is called. The alternative — show the path as bare
names so the tree can be navigated down to the branch — is what a filesystem's traverse right
does, and it is exactly "learning something outside the branch". Navigation is solved the other
way: `GET /objects/tops` names the visible objects whose parent is hidden, which is where a branch
account's tree starts.

**An id can still appear as a reference.** A visible device's `parentId` names its parent whether
or not that parent is visible, as `GET /objects/:id` always has. An id names nothing; the rows it
would name are the ones that are absent.

**A scope that names a hidden object is refused, not emptied.** `?objectId=` on the alarms and the
state log, `?parentId=` on the object list and a stream subscription to one object all ask for
`read` on the object they name, and answer 403 the way `GET /objects/:id` does. Serving the
visible part of a hidden scope would be an oracle: "which of my sensors are beneath object 4711"
is a question about the structure of a branch the caller cannot see.

## One implementation of the rights, and why the walks are not a second one

`resolveMany` answers for ids already in hand. Filtering a page after the query hands back 37
rows for `limit=100` and a cursor that skips, so visibility has to be a condition *inside* each
list query. The ticket's constraint is that it is resolved by the same SQL `resolveMany` runs, and
not by a second walk that could disagree.

The observation that makes that cheap: **a principal's right can only change at an object that
carries a grant for one of its groups.** Between two such objects, every group's nearest grant is
the same one, so the right is the same. Call those objects the principal's *boundaries*. There are
as many as there are grants to its groups — a handful, not a tree.

So visibility is computed in two steps, and only the first knows anything about rights:

1. **Label the boundaries.** One query collects the boundaries and resolves each one with
   `resolveMany`'s own SQL — the same text, built by the same function — then applies the role
   and scope ceilings exactly as `resolveManyFor` does. The answer is a map from boundary id to
   visible-or-not, plus whether the root is visible. Administrators short-circuit, as they do in
   `resolve`.
2. **Carry the labels down, structurally.** An object's visibility is its nearest boundary's
   label, or hidden if there is none above it. That fact is used in two places:
   - **In SQL**, as a predicate: walk down from the boundaries whose label differs from the
     root's, stopping at any boundary. What that walk reaches is the set of *exceptions* — so a
     row is visible when it is `NOT IN` the exceptions if the root is visible, and `IN` them if it
     is not. The walk is as large as the part of the tree that disagrees with the root: nothing
     for an account that sees everything, the holes for one that sees most of it, the branch for
     one that sees a branch.
   - **In TypeScript, for the stream only**: an event already carries its sensor's root-first
     path, so its visibility is the label of the last boundary on that path. No query per event.

Neither step can disagree with the resolver about a *right*, because neither contains one. What
they could get wrong is the structural claim, and `A-03`'s agreement test is extended to check it:
on a randomised tree with grants of every kind for several groups, for every role and scope, the
set `resolveManyFor` calls readable equals what the SQL predicate returns and what the path check
says, object by object.

## Inside every query

The predicate is a subquery in the `WHERE` clause of each listing's own query, so `LIMIT`, the
keyset cursor, `total` and the per-state counts are all computed over visible rows. Every place
the ticket found goes through it: the object list and search, the subtree and its counts, the
children behind `hasChildren` and `childCount`, the alarms with their totals and per-state
counts, the state log, the notification log, the map's sensor-list widget, the stream's snapshot,
and the handful of smaller listings the sweep turned up.

Services take the visibility as a **required** argument. The callers that genuinely want the
whole tree — a public map, whose widget list is its authorisation (`ADR-002`), and the template
delete that refuses while any trigger still uses the template — pass `Visibility.EVERYTHING`,
spelled out, for the reason the map resolver's audience is a discriminated union: a default that
means "no checks" is how the next caller gets an unauthenticated read of everything by forgetting
an argument.

**A sensor whose object has been deleted is visible to administrators only.** Its history and its
notification rows outlive it, but nothing records which branch it was in, so there is no grant to
resolve and the resolver answers `none`, as it does for any id that does not exist.

## The stream

Each socket resolves its own visibility when it subscribes, and every event is checked against it
with the path check above; paths are trimmed the same way before they are sent. The snapshot is a
filtered query like any other.

**Grants change while sockets stay open.** A new migration keeps a single-row `access_epoch`,
bumped by triggers on `object_access`, `user_group_member`, `user_group` and `object.parent_id` —
the only things a boundary's label or position depends on. It is a row in a table rather than a
sequence because it has to be transactional: a sequence advances before the grant commits, and a
stream that re-resolved in that window would read the old grants and then never look again.

The epoch is read in the same query that already fetches each published batch's ancestry, so it
costs no round trip. When it has moved, every restricted socket re-resolves before the batch is
delivered, and a socket whose view changed is sent the existing `overflow` frame with a reason
instead of the batch. The client already treats `overflow` as "everything you hold is suspect,
subscribe again", which is exactly what a revoked grant means for a tree that has already painted
the sensors it can no longer see.

## What the sweep found that the ticket did not list

The ticket named the listings. The sweep — every registered `GET`, called as a branch account with
every id it can see and every query parameter the route's schema declares, visible ids and hidden
ones — found the other way a hidden object reaches a visible one: **a visible object's own fact
with another object's name in it.** Each is fixed the same way — the reference stays, as an id,
and the name goes — through `Visibility.visibleAmong`, the same predicate asked of a handful of
ids.

| Where | What it named | Now |
| --- | --- | --- |
| `GET /objects/:id/triggers` | the object an inherited trigger is defined on — the probe above the branch | listed, `definedOn.name` null |
| `GET /objects/:id/pause` (and the three writes that answer a pause view) | the container a pause is inherited from; a dependency's master, and its state | `inheritedFrom.name`, `masterName` and `masterState` null |
| the dependent's **state history** | `master #14 (core-switch) is Down`, written once and read by everyone who can read the dependent | `master #14 is Down`; the pause view names the master to a reader who may see it |
| `GET /templates/:id/preview` and the draft preview | `%probe`, `%group`, `%device` over a sensor re-granted inside a hole | `(outside your view)` in the preview; a real notification still says it all |
| `GET /objects/:id/settings?asChildOf=` | the settings a hidden parent would hand down | `read` on `asChildOf` too |
| `PUT /objects/:id/dependency` | a hidden master's outages, by pausing the dependent | `read` on `masterId` too |
| `GET /objects/tops` (this ticket's own) | — it dropped a grant re-opened inside a hole, which then had no way to be found | a top is a visible object whose *parent* is hidden |

And one the sweep found about itself: **`server.routes` never listed a route exempt from the
response-schema rule** — the `onRoute` hook returned before recording it — so `/metrics` and a
map's background had been outside `A-10`'s credential sweep since each was added. Both are listed
now; `A-10` sweeps them.

**Deliberately left as they are**, because each is the visible object's own:

- **A pause's message.** It is copied into the state of every sensor the pause holds and becomes
  that sensor's history; it was written for the people whose sensors it paused. The *object* it
  was set on is what the pause view leaves unnamed.
- **Inherited settings and tags.** The effective value is the visible object's; the source is an
  id (`SettingSource`), and no route names it.
- **A probe's own numbers.** `GET /probes/:id/health` asks `read` on the probe, which an account
  granted a branch below it does not have. One that has it and a `none` carved further down still
  sees `scheduled` and `checksBehind` count the carved sensors — they are the probe's measurements,
  the same channels its Probe Health sensor records, not a list of anything.

**Found and not fixed here**, because they are answers to *writes* — a caller with `write` on the
object, asking it to change — and each is a refusal or an echo rather than a listing: the resume
refusal names the container a pause is inherited from and a holding master; the template and
schedule delete refusals count uses on objects the caller cannot see; `POST /templates/:id/test`
echoes the rendered message, `%probe` and all. `A-16` is those.

## What this does not change

- **Credentials.** `A-10`'s sweep holds; `#redact` is a boundary and stays the only one.
- **A report's `runAs`.** A report renders through its account's visibility by design
  (`administration.md`), and since `A-13` only an administrator may point it at anybody else.
- **A public map — which this said, and was wrong about.** It read: "`ADR-002` makes the widget
  list its own authorisation, so a public view is not resolved against anybody." That was the
  largest leak left, found in review and fixed as `A-22`; see the last section. A signed-in
  viewer's sensor-list widgets are filtered like any other list; a tile on an object the viewer
  cannot see is `unavailable`, and since `A-15` it does not say why.

## What it costs

Measured by `test/perf/visibility-performance.test.ts` at the v1 target: **20,000 sensors** —
four probes, a hundred customer groups, twenty devices in each and ten sensors on each device —
with one sensor in twenty Down, so the alarm list has a thousand rows to page and count. Each
path is the median of fifteen calls after three untimed ones, for six principals chosen for the
shapes the predicate has to handle. Taken 2026-09-28 18:24, with `ms-server` stopped and every
other session held off the machine:

```
load average   0.59 / 2.44 / 11.73  over 8 CPUs  (0.07 per CPU)
delivered CPU  271 ms for a fixed loop  (1.02x the reference machine's 267 ms)
database       nothing else is connected
```

| Principal | Sees | Resolve | A page of the list | A page of alarms | Overview counts | Snapshot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| administrator | 20,000 | 1.0 ms | 1.8 ms | 15.7 ms | 39.7 ms | 142 ms |
| the root, ten customers carved out | 18,000 | 0.9 ms | 3.4 ms (1.9×) | 17.1 ms (1.1×) | 32.6 ms (0.8×) | 148 ms (1.0×) |
| one customer | 200 | 1.4 ms | 3.0 ms (1.7×) | 3.4 ms (0.2×) | 18.6 ms (0.5×) | 24 ms (0.2×) |
| one probe | 5,000 | 1.5 ms | 12.8 ms (7.1×) | 26.7 ms (1.7×) | 32.4 ms (0.8×) | 58 ms (0.4×) |
| fifty customers, granted one by one | 10,000 | 1.2 ms | 24.6 ms (14×) | 47.9 ms (3.1×) | 39.0 ms (1.0×) | 92 ms (0.7×) |
| every probe | 20,000 | 1.0 ms | 43.8 ms (24×) | 75.7 ms (4.8×) | 54.5 ms (1.4×) | 182 ms (1.3×) |

The budgets are an operator's — a page, the totals and a resolution each inside a quarter of a
second, a full snapshot inside two — and every row is inside them by at least three times; the
largest 90th percentiles are 90 ms for a page of alarms and 236 ms for a snapshot, both for the
principal granted every probe.

**The same run twelve minutes earlier, under load**, is kept beside it because together they say
the budgets hold on a busy machine too. `perf-conditions` flagged it — 0.55 per CPU against its
0.5, the one-minute average still carrying another session's build, and 1.22× the reference's CPU
time — and every path was still inside budget: the principal granted every probe paid 51 ms for a
page of the list, 70 for alarms, 64 for the counts and 253 for the snapshot, against the
administrator's 2.6, 19, 46 and 166.

What the table says:

- **Resolving is flat.** 1–1.5 ms for every shape, because it reads the boundaries — a handful of
  rows — and not the tree.
- **The list's ratio is large because the administrator's time is tiny.** 1.8 ms is an index scan
  that stops at the hundredth row. A principal who cannot read the root has an `IN` set, and the
  walk that builds it has to finish before the `LIMIT` can apply — so the cost grows with what the
  principal can see, not with the installation: 3 ms for 200 sensors, 13 for 5,000, 44 for all of
  them reached by walking. That is the price of the condition being *inside* the query, which is
  what makes a page of 100 a hundred rows and the cursor not skip; it is paid once per page.
- **Seeing less is cheaper everywhere else.** The snapshot and the counts cost less than the
  administrator's for any principal who sees less, because the rows cost more than the predicate.
- **The worst case is the one nobody configures on purpose.** A principal granted every probe and
  not the root sees what an administrator sees, the long way round. Granting the root instead puts
  it on the `NOT IN` form, which the carved-root row shows costs 0.8–1.9× the administrator.

**Measuring first changed the code.** The first run, before the list chose its page of ids and
joined the details to those alone, had the every-probe list at 187 ms — 48 times the
administrator's — because it paid for the walk twice and joined every visible sensor to its detail
tables before the `LIMIT`; `hasChildren` and `childCount` walked as well, and now use the walk-free
child rule. That run was under 0.78 load per CPU, so the before-and-after is indicative, not a
measurement of the change.

Nothing here contradicts `ADR-001`: no new service, no cache to invalidate, and the rule stays in
PostgreSQL, in the query that returns the rows.

## What review found after it landed

`A-12` landed as `91c4ead`; review found four more ways out, each filed on its own number with
a test shown to fail before its fix.

- **`A-22` — a public share link published whatever its map named.** The sweep had called
  `/public/maps/none`, a 404, and so proved nothing about the route. A `readwrite` account granted
  one branch could put the root on a canvas, share it, and hand the whole installation to anybody
  with the URL. A public view is now resolved through the account that made the link, as it stands
  when the link is opened; a save may not add a tile on an object its saver cannot read. The
  reasoning is an amendment to `ADR-002`. **Migration 054 records each link's maker as an
  account.** Links made before it carry only a login, which it matches; **a link whose login
  matches nobody — renamed or deleted since — has no maker after the upgrade and publishes
  nothing**, every tile unavailable. That is deliberate, and it is what an operator who sees a
  shared wall go blank after upgrading should read: make a new link.
- **`A-21` — `seq` counted every change in the installation.** One process-wide counter numbered
  every published state change before any filtering, and every socket was sent it; a branch
  account seeing its sequence jump by 3,000 between two of its own events had learned the size and
  timing of an outage in somebody else's branch. Each socket now numbers the `state` frames it has
  been sent, so a gap still means a lost frame and nothing else.
- **`A-23` — `POST /objects/:id/as-template` read the sensors under a device without asking which
  the caller could see.** A `COMPUTES` route, so the sweep of `GET`s could not reach it; the
  device check was right and the walk under it had no condition.
- **`A-24` — acknowledging or forcing a device reached the sensors in its holes.** A write, not
  only a read: the route checked `write` on the device, and the walk beneath it acknowledged, or
  forced Down and paged the owner of, a sensor carved `none` — and the answer named it, or said
  whether the hole held anything Down. Both walks now carry the condition every listing does.

**Reported, and not this ticket's:** a change that commits while a subscriber's snapshot is being
read is sent *before* the snapshot frame, and the client replaces its state wholesale on a
snapshot — so that sensor shows its older state until it next changes. It predates `A-12` (`U-02`
ordered attach-then-snapshot for exactly this, and the order on the wire undoes it).

