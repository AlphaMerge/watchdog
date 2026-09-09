# ADR-003: Where an operator's uploaded file lives

- **Status**: Accepted
- **Date**: 2026-09-09
- **Deciders**: Roman
- **Supersedes**: —
- **Relates to**: `ADR-001` Decision 1 (standalone service), `ADR-002` (map exposure), `G-05`

## Context

`G-05` gives a map a background image, and that is the first time this system stores a file on an
operator's behalf. Everything it has held until now is either configuration it generated or
measurements it took; a background is bytes somebody handed it, which it must keep, serve back, and
eventually delete.

The decision is worth writing down once rather than deciding it again per feature, because more of
these are coming: `G-07`'s custom HTML is operator-supplied content, report templates would be, and
a device photograph or a site plan is the obvious next request. What is settled here is *where such
a file lives*, *what bounds it*, and *what is refused outright*.

The constraint that shapes all of it is `CLAUDE.md`'s first: production is a standalone native
service under systemd or WinSW, with PostgreSQL as the only thing an operator installs and
supervises.

## Decision 1 — Uploaded files live in PostgreSQL, not on the filesystem

**Decision.** A background image is stored as `bytea` in a table, not as a file under the service's
data directory.

**Why.** The deciding argument is backup and restore. An operator who backs up the database has
backed up their configuration, their history and their maps; the moment a map's background is a
file on disk, a restored database renders every map with a hole in it, and nobody discovers that
until the day they restore. One thing to install has a matching rule — one thing to back up — and
the alternative is a second procedure that exists only for this feature and is therefore the one
people skip.

Three supporting reasons, none of them decisive alone:

- **Access control is already in the database.** Serving a file means asking whether this caller may
  read this map, which is a query. A file path would need the row anyway, and then a second thing
  can go wrong: the row says yes and the file is missing, or the file is there and the row is gone.
- **Deletion is a foreign key.** `ON DELETE CASCADE` from `map` removes the image with the map. On
  disk it is a reaper, a class of orphan, and a bug where the reaper deletes something still in use.
- **`V2-06` is failover clustering.** Rows replicate; files on one node's disk do not. Choosing the
  filesystem now would mean choosing to migrate later, or shipping a cluster where half the maps
  render.

**What this costs, said plainly.** Large objects in a relational database are a well-known way to
make backups slow and buffer cache useless. That cost is bounded here by Decision 2 and by what
this is for: a monitoring installation has tens of maps, not thousands, and a background is a floor
plan. If a later feature wants files measured in hundreds of megabytes — packet captures, report
archives — that is a different question and it gets its own ADR rather than being smuggled in under
this one.

**Not `pg_largeobject`.** It is a second API with its own lifecycle, it is not covered by
`pg_dump` in the plain-text format without extra flags, and TOAST handles a two-megabyte `bytea`
without any of that.

## Decision 2 — Hard, small, unnegotiable bounds, enforced at the boundary

**Decision.** One background per map. At most **2 MiB** per image and at most **4096 × 4096**
pixels. The declared `Content-Type` is not trusted: the format is decided by reading the file's
own header bytes, and a file whose bytes do not match a permitted format is refused.

**Why bounds at all.** An upload endpoint is the one place where a caller who is merely
*authenticated* decides how much of the server's disk to use. A `write` holder on one map is not an
administrator, and "the map author filled the database" must not be reachable. The limit is small
because the feature is small: a floor plan or a rack diagram at 2 MiB is a large one.

**Why sniff rather than trust the header.** `Content-Type` is a claim by the client. Accepting a
file because it *says* it is a PNG is the oldest upload hole there is, and the fix costs eight
bytes of comparison.

## Decision 3 — Raster only. SVG is refused

**Decision.** PNG, JPEG and WebP are accepted. **SVG is refused**, and so is anything else.

**Why.** An SVG is not an image, it is a document: it can carry `<script>`, `<foreignObject>`, and
external references. `ADR-002` Decision 2 has already settled that operator-supplied *documents*
run in a sandboxed iframe and never in the application's own document — and a background image is
drawn in the application's document by definition, because that is what a background is. Accepting
SVG would either contradict that decision or require sanitising a format whose sanitisers are a
running list of bypasses. The capability lost is a scalable floor plan; the capability kept is
being able to say what a background can and cannot do in one sentence.

**Served defensively regardless.** The response carries `Content-Type` from the sniffed format,
`X-Content-Type-Options: nosniff` so a browser cannot decide it is something else, and
`Content-Security-Policy: default-src 'none'` so that a file that somehow reached an executing
context has nothing to reach. `Content-Disposition: inline` with no filename: the stored name is an
operator's string and does not belong in a header.

## Decision 4 — Addressed by content, cached hard

**Decision.** A stored image carries the SHA-256 of its bytes. The serving route answers with that
hash as a strong `ETag` and honours `If-None-Match`.

**Why.** A background is the largest thing on a map and the least likely to change. Without a
validator, every open of a wall display re-downloads it; with one, the second open is a 304. The
hash rather than a version counter, because it is also what makes "this is the same image" a fact
rather than a bookkeeping exercise — and `G-06`'s public share links will serve the same bytes to
unauthenticated callers, where a monotonic version would leak how often the map is edited.

**Not immutable caching.** `Cache-Control` is `private, max-age=0, must-revalidate`: the URL is
stable across a replacement, so a long max-age would leave an operator staring at the old plan
after they uploaded the new one. A revalidation that answers 304 costs one small request and is
correct on the day it matters.

## Consequences

- The upload route is the first in this system that accepts something other than JSON, and the
  first that must bound a request body by size rather than by schema.
- `S-17`'s disk watcher continues to be about the database's disk, which is now also where
  backgrounds are. Nothing new to supervise.
- A future feature wanting large files must revisit Decision 1 explicitly. It is not a precedent
  for "files go in Postgres" at any size — it is a decision that two megabytes does.
