# The web UI

What each view is for, and where to go for the thing you are trying to do.

This is the operator's guide. Developing the UI — the stack, the dev server, the design tokens —
is [`packages/web/README.md`](../packages/web/README.md).

`ms-core` serves the UI itself as static assets from `api.webRoot`; there is no second web server
to install ([`ADR-001` Decision 8](ADR-001-architecture.md)). An empty `webRoot` serves no UI at
all, which is what a headless install wants. Point a browser at the core's own address and port —
the same one the API answers on.

## The views

Seven sections, in the order the header lists them.

| View             | Path             | The question it answers                                          |
| ---------------- | ---------------- | ---------------------------------------------------------------- |
| **Overview**     | `/`              | Is the core up, how much is configured, and how much is healthy?  |
| **Alarms**       | `/alarms`        | What is broken right now, worst first?                            |
| **Tree**         | `/tree`          | Where is this object, and what is underneath it?                  |
| **Logs**         | `/logs`          | What changed — to a sensor, by a person, or in a notification?    |
| **Discovery**    | `/discovery`     | What is on this network, and what would scanning it cost?         |
| **Templates**    | `/templates`     | What does a notification say, and to whom?                        |
| **Sensor types** | `/sensor-types`  | What can this installation measure?                               |

Alarms sits second, ahead of the tree, deliberately: [`WORKFLOW.MD §7`](WORKFLOW.MD) calls it the
operator's home screen, and the thing somebody opens this product to look at belongs near the
front.

### Overview

Counts and reachability. Objects by kind (probes, groups, devices, sensors), sensors by state
**worst first**, the registered catalogue, and the core's own version.

The state counts come from `sensor_state`, not from the last sample — so they stay right across
rollups and gaps ([state-machine.md](state-machine.md)). A sensor reads **Unknown** until its
first result, and again after a resume; that is a real state, not a placeholder for one.

### Alarms

The operator's home screen, and the closest thing v1 has to a dashboard.

- **Severity chips** — Down, Partial, Acknowledged, Warning, Unusual, worst first. A paused
  sensor is deliberately silent and an unscanned one is Unknown; neither is a fault, so neither
  appears here. Partial and Unusual are `[V2]` ([`WORKFLOW.MD §4`](WORKFLOW.MD)): the chips are
  there because the severity scale is, but nothing reaches those states in v1.
- **Scope to a branch**, hide acknowledged, and sort by **priority** or **duration**.
- **Acknowledge, pause and resume from the row.** A switch failing puts forty sensors on this
  screen, and making somebody open each one to silence it is how a list stops being used.
  Acknowledging offers presets — 15 minutes, 1 hour, 3 hours, 1 day — because the point of the
  list is speed. An operator who needs 45 minutes has the detail page.
- **Filters live in the URL**, so "look at the Berlin alarms" is a link you can send.

Acknowledging silences notifications until the sensor recovers, and it stays on the list. Pausing
stops scanning it entirely, and it leaves the list because nothing is watching it any more — the
button says so on hover.

The list is the server's answer; the live stream only decides *when* to ask again.

### Tree

The object tree in the operator's own arrangement — root, probes, groups, devices, sensors.

- **Virtualised**, so the 5,000-sensor target scrolls.
- **Rollup colour**: a collapsed group shows the colour of the worst thing inside it, without its
  children ever having been loaded.
- **Search** matches names and hosts, and there is a tag filter beside it. Results come back
  flat, with the path written out — which is what somebody searching actually wants.
- **Full keyboard navigation**, to the ARIA tree pattern: arrows move and expand, `Home`/`End`
  jump to the ends, `Enter` or `Space` opens the row. Collapsing a branch you were inside keeps
  focus somewhere real rather than dropping it.

Type-ahead, `*`-to-expand and multi-select are deliberately not implemented — they are optional
in the pattern, and this tree is a navigation aid rather than a picker.

### Logs

Three tabs, because they are three different questions rather than one stream with a type column
([`CAPABILITIES.MD §6`](CAPABILITIES.MD)):

| Tab                | Answers                                    |
| ------------------ | ------------------------------------------ |
| **Status changes** | When did this sensor break, and for how long? |
| **Object history** | Who changed this, and to what?             |
| **System events**  | Did anybody actually get told?              |

Object history filters by category — object, setting, channel, trigger, template, schedule,
sensor.

### Discovery

Scan a range, and create what it finds.

The **estimate is shown before the choice, not after it**: the view tells you what each discovery
level costs on *this* range, so you can pick a detailed scan on a /24 knowing it is about a
minute, and decline it on a /16 knowing it is hours. Progress is polled while a run is alive and
stops the moment it finishes.

### Templates

Notification templates — what a message says, who receives it, and when it is allowed to send.

- **The preview renders the text in the box**, not the last saved version, so you are looking at
  the edit you are making.
- **A test send really sends** — and the result says what a green tick does *not* prove: a
  template that is switched off, outside its activation schedule, or folded into a digest can
  deliver a test and still never deliver an alarm.

### Sensor types

The registered catalogue and each type's parameter schema — the same document the add-sensor form
is generated from. Useful for checking that a new type's schema says what its author meant.

The full reference, including channels and defaults, is
[sensor-reference.md](sensor-reference.md).

## The object detail page

`/objects/:id` — and for a sensor, this is *the* page. Six tabs, and **the tab lives in the URL**,
so a link to a sensor's triggers is a link somebody can send.

| Tab          | Shows                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| **Overview** | State with its cause and since when, the channel table with current readings    |
| **History**  | Charts over 2 days / 30 days / 365 days (sensors only)                          |
| **Log**      | This object's state changes                                                     |
| **Settings** | Every inheritable setting in effect, what it resolves to, and where it came from |
| **Triggers** | The notification triggers on this object                                        |
| **Changes**  | The audit trail for this object                                                 |

Add a sensor beneath a device at `/objects/:id/add-sensor`. Everything after "which type" is
generated from the type's `paramsSchema`, which is what keeps adding a sensor type a one-file job.

On the **Settings** tab, each row is a toggle rather than a plain input, because the source is the
half that matters: "60 seconds" is not the same fact as "60 seconds, because the group two levels
up says so". Overriding to the same value the parent already has is a real state and is kept
distinct — it means this object stays at 60 when the parent later moves to 30. Inheritance is
resolved in one place ([administration.md](administration.md)).

**The badge is live and the numbers refresh on a timer**, and the split is deliberate. State
changes arrive over the WebSocket stream, because those have to be immediate. Channel *values*
change on every scan whether the state does or not, and a frame on the wire for every reading of
every sensor would be a stream nobody could keep up with — so the channel table re-reads every
15 seconds instead.

### Graphs

Three ranges, and they are not arbitrary: **2 days** is "what happened on my shift", **30 days**
is "is this getting worse", **365 days** is "what do I tell the auditor". One filter row scopes
every panel, so two panels can never disagree about what period they are showing. There is a
table view for reading exact numbers off the same slice.

Resolution is the server's decision, and it reports what it changed.

**A gap is a gap.** A Down sensor records no channel values, and a discarded reading — one the
spike filter rejected — records nothing either. The line breaks; it never draws to zero. If you
are looking at a gap and want to know which kind it is, [troubleshooting.md](troubleshooting.md)
has "Graphs have gaps" and "Graphs are wrong only at wide time ranges".

## Accessibility

The UI targets WCAG 2.1 AA, and this is a requirement rather than an aspiration
([`CLAUDE.md`](../CLAUDE.md)).

- **Colour is never the only signal.** Every state has a distinct glyph and its name beside it,
  which is what makes the badge readable to a screen reader and to a colour-blind operator.
- Every foreground token meets AA against its own surface, in both themes.
- A **skip-to-content** link is the first thing `Tab` reaches.
- The layout reflows to 320px.
- **Dark theme** is a toggle in the header. It keeps one name and reports its state, rather than
  renaming itself underneath the state it is reporting.

## What is not here

The drag-and-drop **map and dashboard designer** — status icons and live graphs arranged on a
canvas, publishable by URL — is `[V2]` and is not built. So are **reports** and geographical
maps. See [`CAPABILITIES.MD §6`](CAPABILITIES.MD) for the full list and its markers; the v2
candidates are in [TASKS.md](TASKS.md).

For v1, the Overview and the Alarms view are what a wall display would show.

## Related

- [administration.md](administration.md) — the rights that decide what a given account can see and do here
- [state-machine.md](state-machine.md) — what the states on every one of these screens actually mean
- [troubleshooting.md](troubleshooting.md) — including "writes from the browser are refused", which is usually `api.allowedOrigins`
- [api-reference.md](api-reference.md) — every route these views call
