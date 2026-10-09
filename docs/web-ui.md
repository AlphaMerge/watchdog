# The web UI

What each view is for, and where to go for the thing you are trying to do.

This is the operator's guide. Developing the UI — the stack, the dev server, the design tokens —
is [`packages/web/README.md`](../packages/web/README.md).

`ms-core` serves the UI itself as static assets from `api.webRoot`; there is no second web server
to install ([`ADR-001` Decision 8](ADR-001-architecture.md)). An empty `webRoot` serves no UI at
all, which is what a headless install wants. Point a browser at the core's own address and port —
the same one the API answers on.

## The views

Nine sections, in the order the header lists them.

| View             | Path             | The question it answers                                          |
| ---------------- | ---------------- | ---------------------------------------------------------------- |
| **Overview**     | `/`              | Is the core up, how much is configured, and how much is healthy?  |
| **Alarms**       | `/alarms`        | What is broken right now, worst first?                            |
| **Tree**         | `/tree`          | Where is this object, and what is underneath it?                  |
| **Logs**         | `/logs`          | What changed — to a sensor, by a person, or in a notification?    |
| **Discovery**    | `/discovery`     | What is on this network, and what would scanning it cost?         |
| **Templates**    | `/templates`     | What does a notification say, and to whom?                        |
| **Sensor types** | `/sensor-types`  | What can this installation measure?                               |
| **Maps**         | `/maps`          | What did somebody arrange to be looked at, and where?             |
| **Reports**      | `/reports`       | What is being sent to whom, and did last night's run work?        |

Alarms sits second, ahead of the tree, deliberately: [`WORKFLOW.MD §7`](WORKFLOW.MD) calls it the
operator's home screen, and the thing somebody opens this product to look at belongs near the
front.

**Maps and Reports appear only where the core built them** (`H-12`). The v1 build — the release
candidate — constructs neither, so its header has seven sections, and a bookmark to `/maps/3`
goes to the Overview. The UI asks the core rather than knowing what v1 means: `GET /build` says
which optional subsystems this server registered routes for, and a link is shown once that answer
names it. A core that cannot answer is treated as having everything, which is what this UI showed
before it asked.

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
- **Search** matches names and device hosts, as a case-insensitive substring — `10.1.` or
  `berlin.example` finds the device — and there is a tag filter beside it. Results come back
  flat, with the path written out — `Local probe › Berlin DC › switch-01` under each match, so
  two sensors both called `Ping` say which device each is on. That is what somebody searching
  actually wants, and it is still one request: `GET /objects?include=path` walks every row's
  ancestors in one statement rather than a breadcrumb request per row.
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

**Rediscovery rules** sit under the scan form. A rule runs a discovery every hour, day or week,
and can be limited to the times a schedule allows ("weekly, but not during the change freeze").
The list shows the rules for the groups you can see: where each one scans into, when it runs
next, whether it creates what it finds, and when it last ran.

- **A new rule is off**, and **creating devices is a separate switch that is also off**. So a
  rule you switch on first sweeps and leaves a plan for somebody to review. Switching a rule on
  or off is a button on its row, not a field in its form.
- **A rule refused when it fired says so first.** If a rule's group has moved under another
  probe, the rule is refused every time it is due, and its row says why. Editing the rule's probe
  to the group's new one puts it right.
- **A run whose group moves under another probe creates nothing.** What it found was read from
  the old probe's network. It fails with "its group moved to another probe" at its next step:
  when that probe next asks for work, when its sweep hands over to identification, between
  identification batches, or when you create what it found. Start the scan again from the
  group's new probe.
- **An edit changes a rule, not its group.** For another group, write another rule. The edit
  sends only what you changed, with the version you opened. If somebody else saved first, the
  form says so and offers the rule as it now is, rather than saving over their change.
- **The SNMP community is never shown**, not even to an administrator. When you edit a rule you
  choose to keep the stored community, replace it or remove it. Keeping is the default, but only
  while the rule scans where the community was set for: changing its range or its probe clears
  the community unless you enter it again in the same save, and the rule's history says so.

### Templates

Notification templates — what a message says, who receives it, and when it is allowed to send.

- **The preview renders the text in the box**, not the last saved version, so you are looking at
  the edit you are making.
- **A test send really sends** — and the result says what a green tick does *not* prove: a
  template that is switched off, outside its activation schedule, or folded into a digest can
  deliver a test and still never deliver an alarm.
- **A recipient is an address, a user or a group.** Users and groups are picked by typing a name,
  and the template keeps the one picked even if it is renamed later. The list warns about an
  account that is disabled or has no address, and about a group with no members, because a
  message to either reaches nobody. Only an administrator can pick them, since only an
  administrator may list who is in the installation. Anyone else who edits a template sees the
  users and groups already on it by number, keeps them as they are, and can still remove them.
  The server holds the same rule, so a request that adds one is refused however it was sent.
- **Who a message missed is named only to an administrator.** A test send's result and the
  notification log name the people a message did not reach, and why, for an administrator.
  Anyone else sees how many and why — "not sent to 2 recipients (1 disabled, 1 no email
  address)" — because the names are the list of accounts and groups.
- **A secret stays with where it is sent.** Secret headers and secret arguments are never shown,
  and saving a form that leaves them blank keeps them. Changing an HTTP action's URL, or a
  program's name or any of its arguments, clears the secrets that went there, unless you enter
  them again in the same save. After such a save the form shows them as not set, and the template's history says which
  were cleared. This is so that editing a template cannot send a token somebody else set to an
  address of your choosing.
- **An HTTP action sends its subject as the `x-ms-subject` header**, so an endpoint can route on
  it without parsing the body. A subject in printable ASCII is sent as it is. Anything else is
  sent as percent-encoded UTF-8, with `x-ms-subject-encoding: utf-8-percent` beside it, and
  `decodeURIComponent` gives the text back. That covers a name in any script, an emoji, and the
  `—` a placeholder shows when it has no value. A header cannot carry those raw, and until
  `N-18` they failed the delivery on every retry.

### Sensor types

The registered catalogue and each type's parameter schema — the same document the add-sensor form
is generated from. Useful for checking that a new type's schema says what its author meant.

The full reference, including channels and defaults, is
[sensor-reference.md](sensor-reference.md).

### Maps

A map is a canvas somebody arranged: status icons, live graphs, data tables, sensor lists,
connector lines, custom HTML and a background image, on a grid or on a map of the world. It is not
a tree object — it has its own storage, its own API and its own access by group — so a map you may
not read is absent from the list rather than refused.

- **The designer and the view are separate pages.** `/maps/:id` is what a map looks like; the
  designer is behind write access, and it drags, undoes and redoes on the keyboard as well as the
  pointer.
- **A widget whose object is gone leaves a tile saying so**, not a hole. Whether it says *why* —
  deleted, or merely invisible to you — depends on your rights on the map.
- **A public share link** is a per-map bearer token with an expiry, revocable, handed over once
  and stored only as a hash. A shared map draws the current readings rather than history, and
  **only what the account that made the link can see** — as it stands now, so a link shrinks when
  its maker loses a grant, and stops opening at all, as a revoked link does, when the maker's
  account is disabled or deleted.
- **Five-star maps surface in the Home menu.** Priority is set on the map itself.
- **A name is unique among the maps you can read, not across the installation.** Two groups can
  each have a "Core Network" without either learning the other's exists, and a list that holds two
  of one name — an administrator's, which holds everything — gives each one's id beside it. The
  same holds for reports and libraries.
- **A save somebody else beat you to is refused, and your edit stays on screen.** Open the map
  again in another tab to see what changed before saving over it.
- **Geographical maps need a tile source, and this installation may not have one.** With none
  configured the widgets are drawn over the background image instead — the designer says so where
  somebody is arranging one, because the fix is an administrator's
  ([administration.md](administration.md)). Panning is local to your browser: where a map opens is
  its author's decision, so a wall display comes back to the same place after a reboot.

### Reports

A report is a saved question about a period — which sensors, over what span, rendered through whose
eyes, on what schedule, delivered where. Like a map it is not a tree object and has its own access
by group, so a report you may not read is absent from the list rather than refused.

- **The report and its settings are one page**, unlike a map and its designer. A map's editing
  surface is a canvas that wants the whole viewport; a report's is eight fields, and somebody
  checking why last night failed should not have to navigate away to fix it.
- **A report that will not run says so in the list**, not only on its own page — a lost security
  context, or a template that does not render yet. The failure that prevents is scanning twenty
  reports and seeing nothing wrong with the one that has been refusing since August.
- **A save somebody else beat you to is refused and says so**, with your edit still in the form.
- **The schedule form offers only the fields its frequency uses.** A weekday appears for a weekly
  report and not for a monthly one, because the core refuses the second outright.
- **What the period works out to is shown while you are still editing it**, along with the bucket
  width, the rollup tier that will answer, and anything the rules changed — an author who pinned
  five-minute averaging over a quarter learns it will be hourly here rather than from a document a
  month later.
- **What the report's account cannot see is counted, not hidden.** The ids are listed; whether each
  is deleted or merely out of scope is deliberately not said, because a `write` holder on a report
  needs no access to the object tree.
- **Every run is listed with the period it covered**, how long it took, whether it was delivered,
  and a link to what it produced. `store` keeps the document, `email only` does not — see
  [administration.md](administration.md).
- **The formats are checkboxes, not a choice.** HTML, CSV, XML and PDF are four renderings of one
  document rather than four reports, so a run can produce all of them and they cannot disagree
  about a number. HTML is for reading, CSV for a spreadsheet, XML for a script, PDF for filing and
  printing.

## The object detail page

`/objects/:id` — and for a sensor, this is *the* page. Six tabs, and **the tab lives in the URL**,
so a link to a sensor's triggers is a link somebody can send.

| Tab             | Shows                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| **Overview**    | State with its cause and since when, the channel table with current readings      |
| **History**     | Charts over 2 days / 30 days / 365 days (sensors only)                            |
| **Log**         | This object's state changes                                                       |
| **Settings**    | Every inheritable setting in effect, what it resolves to, and where it came from   |
| **Credentials** | The credential sets stored here and inherited (everything but a sensor)           |
| **Triggers**    | The notification triggers on this object                                          |
| **Changes**     | The audit trail for this object                                                   |

A channel an edit took out of a sensor's parameters — a `snmp.table` column removed — keeps its
row and its history and is no longer read. The channel table marks it **retired** beside its name
and says **not read** where the reading goes, rather than *no recent reading*, which would read
as an outage; a note under the table says what that means, and is each retired row's accessible
description, so it does not depend on hovering. Its limits judge nothing, so it plays no part in
the sensor's state. **Hide retired channels**, above the table where any channel is retired,
takes them out of it and says how many it hid; it starts unticked, so a channel an edit has just
retired stays in sight (`U-38`). Ticked, it is `?retired=hide` in the page's address, so it
survives a failed poll of the readings, a change of tab and a reload. On the **History** tab its line stops at the edit, as a gap, and
its legend entry (or, charted alone, its heading) and its column in the table view say
**(retired)** in words, not by colour (`U-37`). `GET /sensors/:id/values` carries the same
`retired` as the channel list. Put the column back and it is read again, with its history. Only a type that promises its readings name no channel it does not declare is
marked this way (`P-310`): every shipped type but three (`P-320`). An advanced script's extra
channels, and Windows CPU's per-processor and Windows Volume's per-drive channels, come from what
was read, so no channel of those three types is ever called retired. Nor is a channel
with a reading newer than the sensor's last change: a probe running a newer build than the core
may still read a key the core's build no longer declares (`P-322`).

Add a sensor beneath a device at `/objects/:id/add-sensor`. Everything after "which type" is
generated from the type's `paramsSchema`, which is what keeps adding a sensor type a one-file job.
A secret parameter shows as set, never as its value, and a save that leaves it alone keeps it —
unless the save changes where the type sends it, such as a script's program, arguments,
environment or working directory, or an SNMP sensor's port. Then it is cleared unless entered again, and the sensor's
**Changes** tab says which (`A-40`). Giving its device a new host, or moving it to another probe or
another device, clears it the same way (`A-41`).

A type that reads from a probe listener — a flow, syslog or SNMP trap sensor — is checked against
the probe it would run on as soon as it is chosen (`B-08`). If that probe has reported and its
listener is not running, a sentence under **Sensor type** says so, naming the probe and the
setting in its configuration file that turns the listener on; the sensor can still be created,
and fails its scans until the probe is fixed. The sentence is text tied to the field and
announced when it appears, not a colour. A probe that has not reported cannot be said to have
its listener off, and the sentence says why instead, from the reason Probe Health gives
(`U-29`): the probe is not connected, it has connected and not sent its first heartbeat yet, it
is too old to report (naming its protocol and the one needed), or its heartbeats carry no
numbers. The first two say the sentence updates when that changes; the last two name the
setting to check by hand. A probe that has reported, but speaks a protocol older than the one its
listener's counter arrived in (23 for flows, 13 for syslog and SNMP traps), is too old in the same
words, with its protocol and the one needed, rather than called off (`U-30`): it leaves the
counter out whether the listener runs or not. Both numbers come from the protocol's own table
(`P-294`). A probe that is not connected, and spoke a protocol older than its listener's when it
last connected, gets that said beside "not connected", as a fact about that connection: unless it
has been upgraded since, it will not say when it reconnects either (`U-31`). When the core does not answer the question, because it is starting,
it failed, or it cannot be reached, the sentence says the form could not ask. Nothing is shown
to an account the core refuses the probe to (403 or 404). Otherwise, no sentence means the
listener is running.

A save that would send a group's inherited credentials somewhere new — a device's host, an SNMP
sensor's port, a device moved under the group — needs `write` on the group, and is otherwise
refused with a message naming the kind and the group (`A-41`). A sensor whose credentials nobody
still vouches for reads **Unknown** on its **Overview**, with a sentence saying what to do.

A set with **allowed targets**, or an SSH set with **host keys**, is not vouched for by anybody
(`A-41b`). A device inside its bounds gets it whoever saved the device, and those saves are not
refused. A device outside them does not get it, whoever saved it. Its sensors read **Unknown** on
their **Overview** with the reason: outside the targets, or a probe too old to check more than
one host key. A device named by host name, where the targets name only addresses, is checked by
its probe at each scan (`A-41c`): SNMP, SSH, HTTP, mail and database sensors are scanned at the
address that was checked, and read **Unknown** only while the name resolves outside the targets,
or to nothing, or while the probe is older than protocol 24 (27 for a database sensor, `A-62`).
Windows sensors on such a device read **Unknown** until it is given its address or its name is
added to the targets.

### Credentials

The **Credentials** tab is on a probe, a group and a device, and on the root. A sensor has none:
it uses the set in force on its device.

- **What is in force, and where it is stored.** Each set shows its kind, its public fields and
  whether it is stored here or inherited. An inherited set links to its owner's tab, which is
  where it is changed. If the owner is outside what you may see, the tab says so and does not
  name it.
- **A secret is never shown, to anyone.** The tab names which secrets a set holds. The form
  shows each as set, with **Replace** and **Clear**. Leaving one alone keeps it.
- **The form comes from the kind's own schema**, so allowed targets and SSH host keys are
  fields in it like any other. A private key goes in a box that keeps its line breaks.
- **A set with no bounds is flagged**, with the reason it matters: `write` on the object it is
  stored on is trust with the set ([administration.md](administration.md)). The flag links to
  `/credentials/unbounded`, the list of every such set on the objects you can see. Core Health's
  **Credential sets without targets** links there too. That channel counts the whole
  installation, so it can read higher than the list is long.
- **A save is checked before it is made.** If it leaves sensors outside the set's bounds, the
  form stops and says how many: they are not sent the set and read **Unknown**. The number does
  not include a sensor on a device named by host name that its probe will check against address
  targets: whether that name resolves inside is found out at the scan (`A-41c`). If it widens the
  bounds, it says which secrets that clears. Nothing is stored until you confirm. After the
  save the tab says what the core answered.
- **Removing a set asks first**, and says how many sensors use it and what they will use
  instead: the set on an ancestor, or nothing. A removal the core would refuse (`A-41`) is
  refused before the confirmation.
- **The numbers are of the sensors you can see.** With part of the tree beneath the object
  hidden from your account, the sensors inside it are affected like the rest and are not in the
  count.
- **One thing is asked about at a time.** While a removal is waiting for its answer, no form
  opens and no other removal starts, so confirming it cannot take an unsaved form with it.
- **After a save or a removal the list is read again, and nothing opens until it has been.** If
  that read fails, the tab keeps saying what was done, says the list may be the old one, and
  offers **Try again**.
- **Focus goes back to where it came from.** Cancelling a form returns to the button that opened
  it; dismissing a confirmation, or having it refused, returns to the button it replaced.
- **Without `write` on the object the tab is read-only.**

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

## Signed out while a page is open

The live updates travel over a WebSocket that is signed in once, when the page opens, and the
core closes it when the session behind it ends. That can be a logout in another tab, a password
change, an administrator disabling the account, or the idle timeout. The page then goes to the
login form and says why ("You were signed out: this session has expired; sign in again"). That
happens within about five seconds, on a timer of the core's own; in those seconds the page is sent
nothing, so what it shows stops moving before the login form appears. While the core's database is
not answering it cannot ask, and the page waits, still sent nothing, until it can.

A page that is still signed in can be paused the same way by a database that stops answering
for more than a few seconds: the core sends changes only to pages it has found signed in within
the last five seconds. When the core can ask again, such a page is told to start over, and it
reloads what it shows by itself; nothing it missed is lost.

**It does not try to reconnect.** A reconnect would be refused, and a browser cannot tell a
refused connection from a dropped network, so it would retry for ever while the header still said
somebody was signed in. Signing in again puts you back where you were, because the address bar
never changed.

The stream itself does not keep a session alive, so a page that asks the core for nothing else is
signed out at the idle timeout. [administration.md](administration.md#sessions-and-screens-left-open)
says which pages ask and what to use for a screen that must stay up.

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

**Libraries** are `[V2]` and are not built. Reports and the map and dashboard designer were also
`[V2]` and are now built — see their sections above. See [`CAPABILITIES.MD §6`](CAPABILITIES.MD) for the full
list and its markers; the remaining v2 candidates are in [TASKS.md](TASKS.md).

For an installation that has no maps arranged yet, the Overview and the Alarms view are what a
wall display would show.

## Related

- [administration.md](administration.md) — the rights that decide what a given account can see and do here
- [state-machine.md](state-machine.md) — what the states on every one of these screens actually mean
- [troubleshooting.md](troubleshooting.md) — including "writes from the browser are refused", which is usually `api.allowedOrigins`
- [api-reference.md](api-reference.md) — every route these views call
