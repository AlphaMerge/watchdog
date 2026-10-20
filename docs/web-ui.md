# The web UI

What each view is for, and where to go for the thing you are trying to do.

This is the operator's guide. Developing the UI — the stack, the dev server, the design tokens —
is `packages/web/README.md` in the source repository.

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

Alarms sits second, ahead of the tree, deliberately: it is the operator's home screen, and the
thing somebody opens this product to look at belongs near the front.

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
  appears here. Partial and Unusual are `[V2]` ([the state machine](state-machine.md), §1): the chips are
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
- **Every filter is in the address** (`U-70`): the search is `?q=`, the tag `?tag=` and the box
  below `?invalidParams=true`, the names `GET /objects` gives them, so a filtered tree is a link
  you can send, and reload or *Back* after opening a result brings the same search back. Typing
  rewrites the address in place (`replace`, as the alarm filters do) rather than adding a history
  entry per key, so *Back* from the tree still leaves it. The search and tag are written a moment
  (300 ms) after the last key, and at once when you leave the box, so a held key cannot run into
  the browser's limit on history writes (`U-75`); the checkbox is written as it is pressed. The
  search is asked for after the same moment, not on every key (`U-79`), the two boxes waiting as
  one; leaving a box writes the address but does not ask, so the result you are leaving it for
  stays on the page under your click. Opening the tree on an address, and *Back* or a link to one,
  asks at once. A reload or a closed tab within the moment writes the last keys first
  (`pagehide`). Only *Back* pressed from the keyboard within it leaves them out of the tree's
  address, so *Forward* comes back to the search without them. A blank box is left out, so the
  plain tree is `/tree`. When something else moves the address while the tree is open — the
  navigation bar's **Tree** link, or *Back* and *Forward* between two tree addresses — the
  boxes follow it.
- **Invalid parameters only** lists the sensors whose stored parameters their type now refuses
  (`U-63`): a type's `paramsSchema` was tightened after they were saved, so they still run as
  stored and an edit of one is refused until it is mended. It is `?invalidParams=true` in the
  address, as on `GET /objects`, so it is a link you can send. It combines with the search and
  the tag, and Core Health's **Sensors with invalid parameters** links to it (**Which sensors**).
  The rows are the search's rows and nothing more: no parameter values, parameter paths or
  problem messages (the core log and an edit's refusal name those). A status line under the
  search says, in words, how many the list holds or that none fail. The core has no list until
  its start-up check has read every sensor, and the line says so instead: still being checked,
  so try again shortly (with a **Try again** button, which keeps focus while it asks again), or
  not checked since the last start and checked again at the next. That is not shown as an error.
  The line is a polite live region, on the page and empty from the start, so the answer is
  announced when it arrives. The list is of the sensors you can edit (`P-380`): which parameter
  a type refuses can be a secret one, so a read-only account is listed none, and the line says
  that no sensor you can edit fails. Core Health counts every sensor in the installation, so its
  number can be higher than the list is long. Below the `sm` breakpoint the box has a line of
  its own under the search and tag.
- **Full keyboard navigation**, to the ARIA tree pattern: arrows move and expand, `Home`/`End`
  jump to the ends, `Enter` or `Space` opens the row. Collapsing a branch you were inside keeps
  focus somewhere real rather than dropping it.

Type-ahead, `*`-to-expand and multi-select are deliberately not implemented — they are optional
in the pattern, and this tree is a navigation aid rather than a picker.

### Logs

Three tabs, because they are three different questions rather than one stream with a type
column:

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
- **A save, a create or a delete closes the editor and says so** under the title ("Template
  Alert hook saved."), with focus on **New template** (`U-64`, `U-69`). While it is being sent,
  **Save template** or **Create template** reads *Saving…*, keeps focus and does nothing if pressed
  again; refused, focus is still on it (`U-73`). The fields stay as they are while it is out, the
  method's settings with them, so Enter in a settings box saves without taking focus from that
  box; **Cancel** does nothing until the answer is in (`U-78`). The list is then read
  again; if that read fails, the list in hand stays and a line above it says it may be out of
  date, with **Try again** (`U-67`). The same failure after the next save is not said again; one
  in other words is, and so is the same one after **Try again**, since you asked (`U-72`).
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

Above the catalogue, **Channels without the lookup their type declares** opens
`/channels/without-lookup` (`P-308`): status channels judged by nothing, because they do not hold
the lookup their sensor's type declares, on the sensors you can see. Most lost it in a clone made
before `P-302`; some may have been cleared on purpose, so the page lists them and fills nothing
in. Each row names the sensor, the channel and the declared lookup, and goes to the sensor, whose
channel table sets the lookup and offers the declared one first (`U-82`). A status
line says how many there are, and says the list is the first thousand of more when the core cut
it; a line under it counts the sensors whose type could not say what it declares.

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
  account is disabled or deleted. It reads the map again each minute with the last one still on
  screen; a read that fails is said under the map's name and the map stays, until the link itself
  stops working. A link whose first read fails says so, and the same failure a minute later is
  not said again; one in other words is (`U-72`). Once the core has answered that a link does not
  work, the page stops asking for it, and stops redrawing itself each minute (`U-80`). Beside the
  map's name, *Last read 14:05* says when the core read the map on screen, by the core's clock
  rather than the display's, which nobody may have set (with the day, once that is not today); it
  moves only when a read succeeds, so a display that has been failing for an hour shows an
  hour-old time, and it is plain text that a screen reader does not announce each minute. After
  three reads in a row have failed, a line under the failure says *Not updated for 3 minutes: the
  last read failed*, counting on each minute; it is announced once, politely, when it appears, and
  its count steps without being said. A good read takes it away (`U-80`).
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

Where a failed check failed is said in words beside its cause, on the Overview's state line and
at the start of each **Log** row's message (`P-285`): "Failed while connecting to 192.0.2.7:22",
or "Did not finish within its timeout" when the probe settled it. It is there when the probe
named a phase (protocol 35) and the state is the check's to explain; a limit's breach, a pause
or an acknowledgement shows its own words alone. A phase the page does not know is shown as
itself, and the host is in the face the device's Host field uses. It is text, not a tooltip.

A channel an edit took out of a sensor's parameters — a `snmp.table` column removed — keeps its
row and its history and is no longer read. The channel table marks it **retired** beside its name
and says **not read** where the reading goes, rather than *no recent reading*, which would read
as an outage; a note under the table says what that means, and is each retired row's accessible
description, so it does not depend on hovering. Its limits judge nothing, so it plays no part in
the sensor's state. **Hide retired channels**, above the table where any channel is retired,
takes them out of it and says how many it hid; it starts unticked, so a channel an edit has just
retired stays in sight (`U-38`). Ticked, it is `?retired=hide` in the page's address, so it
survives a failed poll of the readings, a change of tab and a reload. On the **History** tab its line stops at the edit, as a gap, and
its legend entry (or, charted alone, its heading), the chart's hover tooltip and its column in
the table view say **(retired)** in words, in text ink and not by colour (`U-37`, `U-55`). The
History tab has the same **Hide retired channels** box in its filter row, and it is the same
`?retired=hide`: one choice for the page, so the box says the same thing on either tab and a link
opens both the same way. Hiding one keeps every other channel's colour, since a colour follows the
channel and not its place on screen. `GET /sensors/:id/values` carries the same `retired` as the
channel list, and when a poll answers otherwise than the list the page holds, about any channel,
the list is read again (at most once a minute), so a channel a new reading makes live stops
saying retired without a reload; so is a channel the poll names that the list does not hold,
one an edit added since the page opened (`U-61`). The page polls on the Overview and the History
tab alike, and each re-read of the list reads the History tab's series again, up to now, so the
chart shows the new line too. An ordinary poll does not ask for the list. If a re-read fails, the
list in hand stays and a line beside it says it could not be read again, with **Try again**
(`U-67`). While the page keeps reading it again by itself, the same failure is said once, not
once a minute; one in other words is said, and so is the same one after **Try again** (`U-72`).
Put the column back
and it is read again, with its history. Its kind of reading cannot change on the way back — a
counter stores rates and a gauge values, and one line cannot mean both — so the **Parameters**
form asks the core which channel the column lands on and holds it to what that channel stores: its
**Reading type** is read-only when it matches, and otherwise says which channel it is, what it
stores and that the other value is refused (`U-40`). Only a type that promises its readings name no channel it does not declare is
marked this way (`P-310`): every shipped type but three (`P-320`). An advanced script's extra
channels, and Windows CPU's per-processor and Windows Volume's per-drive channels, come from what
was read, so no channel of those three types is ever called retired. Nor is a channel
with a reading newer than the last change to the sensor's parameters (`P-340`): a probe running a newer build than the core
may still read a key the core's build no longer declares (`P-322`).

**Setting a channel's lookup** (`U-82`). For an account that may write the sensor, each row's
**Judged by** has a list of lookups and **Set lookup** under what judges it now. The list offers
the lookup the sensor's type declares for that channel first, marked as declared by its type, then
**None**, which judges the channel by its limits, then every loaded lookup by name. A lookup the
channel names that is not loaded is offered as it is, marked, so the list shows what the channel
has. Choosing in the list sets nothing until **Set lookup** is pressed: a lookup can turn the
sensor Down, and arrow keys move a closed list's choice in some browsers. The new lookup judges
the channel from its next reading, and the line under the row says so. A refusal is said there
too, with its correlation id; one refused because the sensor changed since the page was read says
to reload first. Setting a lookup moves the sensor's version, and the page reads the sensor again;
anything typed in **Parameters** and not yet saved stays, since its parameters did not move. An
account that may only read the sensor is shown the lookup and no list. Retired channels are
offered the list too, for the day their key is put back.

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
every sensor would be a stream nobody could keep up with — so the page re-reads them every
15 seconds instead, while the Overview or the History tab is open. The readings in hand stay on
screen while the next are read, and when a read fails a line above the table says so, with
**Try again**, while they stay (`U-71`). A poll that keeps failing in the same words keeps the
line it first showed rather than saying it again every 15 seconds; other words replace it, and
**Try again** says it afresh. A reading kept that way is never passed off as current:
once it has been held past the core's own window (three scan intervals) it says *no recent
reading*, as a fresh answer would. If the first read of a sensor's readings fails, an error panel
takes the table's place, and the 15-second poll does not ask again while its **Try again** is
out. That wait is bounded: a read the core does not answer within 30 seconds is given up and said
(`U-77`), so a hung **Try again** cannot stop the poll.

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

The UI targets WCAG 2.1 AA, and this is one of the project's requirements rather than an
aspiration.

- **Colour is never the only signal.** Every state has a distinct glyph and its name beside it,
  which is what makes the badge readable to a screen reader and to a colour-blind operator.
- Every foreground token meets AA against its own surface, in both themes.
- A **skip-to-content** link is the first thing `Tab` reaches.
- The layout reflows to 320px.
- **Dark theme** is a toggle in the header. It keeps one name and reports its state, rather than
  renaming itself underneath the state it is reporting.
- **A failed read is announced.** A page's *Loading…* line is in a polite live region that is on
  the page from the moment the read starts, and if the read fails, the failure, its correlation
  id and **Try again** come into that same region, so a screen reader says them. Polite rather
  than an alert, since nothing you asked for was refused. A region that has to come onto the page
  already holding a failure comes on empty and is filled a moment after (`U-58`).
- **Try again keeps focus.** A failed read's **Try again** stays where it is while it asks again,
  saying *Trying again…*; a second failure is said again in the same region, and a read that
  succeeds puts focus on the page's heading rather than dropping it to the page. On an object's
  page focus goes to the tab it was in instead, the panel under the tab strip, rather than back
  above the header and every card (`U-76`), and on the Logs page to the tab's panel rather than
  above the tab strip and its filters (`U-78`). A list kept on screen whose re-read failed has its
  own **Try again** beside it, which keeps the list in place. Its line is said when it is filled,
  and also when it comes onto the page already failed, as the readings do on going back to
  Overview from the History tab, where a failed poll is not shown: it comes on empty and is
  filled a moment after (`U-78`).
- **No read waits for ever.** A read the core has not answered within 30 seconds, headers or
  body, is given up and said as *The core did not answer*, naming what was asked — not as *not
  reachable*, since the core may be up and only slow — and **Try again** is free again (`U-77`).
  Writes are not bounded this way: a save that is given up may still have been made.

## What is not here

**Libraries** are `[V2]` and are not built. Reports and the map and dashboard designer were also
`[V2]` and are now built, in the full build only — see their sections above. What 1.0 has and
does not have is in [the release notes](release-notes-1.0.md).

For an installation that has no maps arranged yet, the Overview and the Alarms view are what a
wall display would show.

## Related

- [administration.md](administration.md) — the rights that decide what a given account can see and do here
- [state-machine.md](state-machine.md) — what the states on every one of these screens actually mean
- [troubleshooting.md](troubleshooting.md) — including "writes from the browser are refused", which is usually `api.allowedOrigins`
- [api-reference.md](api-reference.md) — every route these views call
