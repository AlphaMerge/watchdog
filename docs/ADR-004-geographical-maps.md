# ADR-004: Where a geographical map's tiles come from

- **Status**: Accepted (2026-09-09, on the instruction to start `G-08`)
- **Date**: 2026-09-09
- **Deciders**: Roman
- **Supersedes**: —
- **Relates to**: `ADR-001` Decision 1 (standalone service), `ADR-002` Decision 1 (public share
  links) and Decision 3 (which deferred exactly this), `ADR-003` (uploaded files), `G-08`

## Context

`CAPABILITIES.MD §6` lists geographical maps, and `ADR-002` Decision 3 deliberately declined to
design them: it recorded only what the eventual answer must satisfy — **degrade to a plain
background when no provider is configured**, so an air-gapped installation gets a map without tiles
rather than a map that does not load.

The reason it was deferred is that a slippy map needs raster tiles, and every way of getting them
argues with something this product has already decided:

- **`CLAUDE.md` hard constraint 1**: production is a standalone native service. Nothing may assume
  a container runtime, an orchestrator, or a cloud-managed service.
- **`CLAUDE.md` hard constraint 3**: no new always-on service dependencies without an ADR.
  PostgreSQL is the only one. A tile server is exactly such a dependency.
- **The deployment reality**: a monitoring system runs in a NOC. Plenty of them have no route to
  the internet, and the ones that do often route it through a proxy that an operator has to be
  told about rather than discovering when a map is blank.
- **`ADR-002` Decision 1**: a map can be published to unauthenticated strangers. Whatever the
  browser fetches to draw a map, it fetches for *them* too.

Two things have also changed since Decision 3 was written, and both narrow the problem:

- **`G-05` ships background images.** An operator can already upload a picture and place widgets on
  it. A screenshot of a region, with sites on it, is a geographical map by any practical measure —
  it is only missing pan, zoom and coordinates.
- **`G-06` ships public links.** The privacy question below is now concrete rather than
  hypothetical.

## Decision 1 — We ship no tiles, no default provider, and no key

**Decision.** The product contains no map tiles and no built-in tile source. A geographical map
draws tiles only from a **URL template an operator configures**, of the usual form
`https://tiles.example.org/{z}/{x}/{y}.png`. The setting is empty by default.

**Why not bundle them.** The tile count for zoom levels 0…N is `(4^(N+1) − 1) / 3`, exactly: 1,365
tiles to zoom 5, 87,381 to zoom 8, 1,398,101 to zoom 10. At the tens of kilobytes a raster tile
typically weighs, zoom 5 is a world view in tens of megabytes and anything approaching street level
is gigabytes. Zoom 5 does not tell you which building; gigabytes do not fit in an installer for a
service whose whole posture is "one thing to install".

**Why not ship a default provider.** Every public tile service has terms — attribution, rate
limits, usually a prohibition on heavy automated use. Shipping a default URL accepts somebody
else's terms on behalf of every operator who installs this, most of whom will never read them, and
points an unknown number of NOCs at a volunteer-funded service. If an operator wants a provider,
they choose it, they accept its terms, and they paste its URL.

**Why not a self-hosted tile server.** It is precisely the thing hard constraint 3 exists to
prevent: a second always-on service to install, supervise, back up and upgrade, for one screen.
An operator who already runs one can point the URL template at it, which is the whole of the
support they need from us.

**What this costs, plainly.** Out of the box, a geographical map has no tiles. An operator who
wants a street map has to find a provider and configure it — which is a step, and a step is worse
than it working. The alternative is one of the three above, and each of them is worse than a step.

## Decision 2 — With no tiles configured, a geo map is still a map

**Decision.** The tile layer is optional. A geographical map with no tile template renders its
coordinate grid and its widgets over the map's `G-05` background image, or over the plain canvas
when there is none. It never renders an error, a grey checkerboard, or a broken-image grid.

**Why.** This is `ADR-002` Decision 3's one requirement, and it is also what makes Decision 1
tolerable: an air-gapped NOC uploads a screenshot of its region as the background and places sites
on it by coordinate. That is the feature working, not the feature failing — and it is roughly what
half the operators who ask for this actually want.

**Consequence.** The coordinate system has to work without tiles, so the projection is ours rather
than a library's, and a map's *extent* — which patch of the world the canvas shows — is a property
of the map rather than of the tile source.

## Decision 3 — Coordinates live on the widget, not on the object

**Decision.** A geo widget carries `lat` and `lon` in the map's layout document, beside `box`.
Objects gain no location field and no inheritable location setting.

**Why.** A location is a property of *this map's picture of the world*, and the same device
legitimately appears on a national map and a campus map at two different levels of precision. The
alternative — latitude and longitude as inheritable settings on `object` — is a schema change, an
inheritance question ("does a sensor inherit its device's location?"), and a migration, in exchange
for not retyping a coordinate.

**What it costs.** Placing the same device on a second map means entering its coordinate again, and
moving a data centre means editing every map that shows it. Recorded because it is the obvious
complaint, and because the cure — a location on the object — is a decision that can be taken later
without unpicking this one.

## Decision 4 — A shared map draws no tiles unless the operator says so

**Decision.** A map published through `G-06` renders its widgets and its background image but
**not** its tile layer, unless an operator explicitly enables tiles for public viewing of that map.

**Why.** A tile layer is fetched by *the viewer's* browser from a third party. On a public link
that means: everyone who opens the link tells the tile provider that this installation exists,
which coordinates it cares about, and — with a keyed provider — hands them a request carrying the
operator's API key from an arbitrary network. None of that is visible to the person who made the
link, and `ADR-002` was explicit that what a share link gives away must be said at the point of
sharing rather than discovered.

**Consequence.** The sharing panel gains one more sentence when the map is geographical, and the
default is the quiet one.

## Decision 5 — The tile layer is ours, not a mapping library's

**Decision.** The raster tile grid, the Web Mercator projection and the pan/zoom interaction are
implemented in `packages/web`, in the same shape as the rest of the canvas. No Leaflet, no MapLibre.

**Why.** The mathematics is small and exactly testable — `lon → x` and `lat → y` in EPSG:3857 are
two formulae, and "which tiles cover this rectangle at this zoom" is a loop — which is the kind of
thing this codebase already prefers to own (the timing wheel, the NetFlow decoders, the image
header reader). A mapping library is several hundred kilobytes of bundle, its own event model and
its own theming, brought in for one screen, and it would have to be taught the same "no tiles
configured" path as Decision 2 anyway.

**Why this is the riskiest decision here, said plainly.** Pan and zoom that feel right are fiddly,
and a hand-written tile layer that stutters is worse than a dependency that does not. This is the
one decision worth revisiting if the implementation turns out to fight back: it can be reversed
without touching Decisions 1 to 4, which is exactly why it is listed last.

## Consequences across the system

- **The application's CSP changes when a provider is configured.** `img-src` is `'self' data:`
  today; tiles need the provider's host added, and only when there is one. That makes the CSP
  configuration-dependent for the first time, which is a security-posture change worth writing
  down here rather than discovering in `hardening.ts`.
- **Attribution is not optional.** Every provider requires it, and the renderer must draw the
  attribution the operator configures alongside the URL — non-removable, because removing it is
  the operator breaking someone else's terms using our software.
- **A proxy is an operator's problem, and must look like one.** When tiles fail to load, the map
  says the tile source did not answer and keeps drawing everything else. A blank canvas with no
  explanation is the failure this whole ADR is trying to avoid.
- **No new service dependency.** Hard constraint 3 is untouched: PostgreSQL remains the only
  always-on dependency, and the tile source is a URL an operator may or may not supply.

## Rejected

- **Bundling an offline tile set.** Tens of megabytes for a world view that cannot show a street,
  or gigabytes for one that can. Both are the wrong shape for an installer.
- **A hosted provider with our key.** It makes the vendor's rate limit our support burden and our
  account everybody's dependency, and it stops working the day the key is rotated.
- **Requiring a self-hosted tile server.** Hard constraint 3, for the reasons that constraint
  exists.
- **Dropping geographical maps entirely.** Defensible — `CAPABILITIES.MD` marks them `[V2]` and
  nothing else depends on them — and rejected because Decisions 1 and 2 make the feature cost a
  projection and a tile grid rather than a dependency. If the implementation of Decision 5 turns
  out to be as fiddly as it might, this option comes back onto the table honestly.

## The two questions this left open, answered by `G-08`

Recorded here because the answers are part of the model rather than of one ticket's code.

1. **The extent is per map.** A map is a saved picture and where it opens is part of what the
   author arranged, exactly as widget positions are: `layout.geo` carries the home view — a
   latitude, a longitude and a zoom. A viewer may pan and zoom, and nothing persists it. Per-viewer
   state has nowhere to live in this system, and a wall display has to come back to the same place
   after a reboot rather than to wherever somebody left it on Tuesday.

2. **One kind of map, and widgets may carry a coordinate.** The tile layer is a property of the
   map — the same shape `G-05`'s background already has — rather than a widget kind, and a widget
   with `lat`/`lon` is placed by them while a widget without keeps its `box`. The deciding argument
   is that a geographical map needs *both* anyway: a legend, a status list and a note belong pinned
   to the canvas, not to a point on the ground. Separating the two would have meant a second
   designer that immediately grew the first one's features back.
