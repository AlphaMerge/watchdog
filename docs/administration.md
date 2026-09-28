# Administering MonitoringSystem

Running the thing once it is installed: who may do what, where the secrets live, what to watch,
and what to have rehearsed before you need it.

- Installing is [`docs/installation.md`](installation.md).
- When something is broken, [`docs/troubleshooting.md`](troubleshooting.md).
- Backups have their own runbook, [`docs/runbook-backup-restore.md`](runbook-backup-restore.md).

---

## Accounts, roles and rights

Two independent controls, and the distinction matters when a permission does not behave the way
somebody expected.

**A role is what an account may do at all**, on the whole installation:

| Role | |
| --- | --- |
| `admin` | Everything, including accounts, groups, probes and system settings |
| `readwrite` | May change objects it has been granted write access to |
| `readonly` | May look, never change — regardless of any grant below |

**A right is what a group may do to a branch of the tree**: `none`, `read`, `write`, `full`.
Rights are granted to *groups*, never directly to accounts, and they resolve by three rules:

1. They **inherit down** the tree.
2. An **explicit grant beats an inherited one**, at the same object.
3. Across the groups an account is in, the **highest right wins**.

`none` is a grant, not an absence — it overrides inheritance to carve a hole in a branch. Deleting
a grant is the different thing: it restores whatever the object inherits.

The two controls are a floor and a ceiling, in that order: the role caps the right. A `readonly`
account in a group with `full` on a device may still only read it. `GET /objects/:id/access/
effective` answers "what may this account actually do here, and *where did that come from*",
which is what makes a refusal debuggable rather than mysterious.

### API tokens

A token carries **the rights of the account that owns it, never more**, and can be given less. It
is shown once, at creation, and no route can read it back afterwards. Revoke by deleting it;
there is no expiry to wait for.

Tokens authenticate with `Authorization: Bearer …` and are not subject to the CSRF header
requirement — that applies to cookie-authenticated writes, because a cookie is what a browser
attaches on its own.

### Two-factor authentication

TOTP, per account, self-enrolled under the account's own settings. Recovery codes are generated
at enrolment and shown once. An administrator can disable MFA on an account that has locked
itself out; they cannot read anybody's secret.

### A report renders through an account, and says so when that account is gone

A report is granted to groups the same way a branch of the tree is — `none`, `read`, `write`,
`full`, highest right across your groups wins, role still the ceiling. Three of its rules are its
own, and they exist because a report is read later, by somebody who was not in the room:

- **A report names the account whose visibility it renders through**, which defaults to whoever
  created it. That is what decides which sensors appear in the output, so **changing it needs
  `full`, not `write`** — a colleague who may edit what a report measures cannot quietly make it
  measure as you. **Naming anybody other than yourself needs an administrator**, on a new report
  as on an existing one: the creator of a report holds `full` on it, so a rule about editing alone
  would let anybody create a report that reads through an administrator's eyes.
- **Granting somebody a report grants them everything that account can see.** This is the point of
  the feature and it is worth saying out loud: a colleague with `read` on a report gets the data
  its `runAs` account could reach, whatever their own rights are. **Grant a report the way you
  would grant the account it runs as.** `GET /reports/:id/subjects` answers exactly what a given
  report would contain, which is the way to check before granting it.
- **Deleting or disabling that account does not widen the report; it stops it.** The report keeps
  the login it was pointed at, reports the account as unavailable, and refuses to run rather than
  run with no scope at all. Point it at a live account to start it again.

That last one is the thing to know when somebody leaves. **Disabling an account stops its reports**
— which is what you want, and which is why they go quiet rather than quietly continuing to publish
what that person could see. An account that is merely *locked out* after too many bad passwords is
a different case and its reports keep running: a lockout clears on its own, and anybody could
trigger one from the login form.

A report never contains a monitored device's credentials. What it names an object by is its id,
kind and name; sensor parameters marked `writeOnly` are stripped at one place for every route in
the system, and the report projection has no field for one in the first place.

---

## Credentials for monitored devices

**Credentials are write-only and that is enforced in one place.** A parameter a sensor type marks
`writeOnly` is stripped from every API response by `ObjectService.#redact` — not per route, so a
new endpoint cannot forget to do it — and the read carries `redactedParams` instead, saying which
fields exist without saying what they are. No API route returns a stored credential to anyone,
including administrators. This is deliberate and there is no flag to turn it off.

They are encrypted at rest with the **vault key**, at `/var/lib/ms-core/vault.key` by default:

- Mode 0600, owned by `ms-core`.
- **Without it every stored credential is unrecoverable.** Not "hard to recover" — the ciphertext
  is all that is in the database.
- It is in every backup for exactly that reason, which is also why a backup archive is as
  sensitive as the credentials themselves.

Credentials are inherited like every other setting: set the SNMP community once on a group, and
every device beneath it uses it. That is the point — rotating one is one edit, not four hundred.

---

## Inheritance

Intervals, credentials, dependency behaviour, notification settings and access rights all inherit
down the tree, and all of them resolve through **one** resolver in `packages/core`. An object
either inherits a setting or overrides it; there is no third state, and there is no place in the
code where parent-walking is reimplemented locally.

`GET /objects/:id/settings` shows both the effective value and where it came from. When something
scans every 60 seconds and you are sure you set 300, that is the endpoint that says which ancestor
disagrees.

---

## Pausing

Four independent pause sources, and this is the thing most worth understanding before an
on-call night:

| Source | Set by |
| --- | --- |
| Manual | A person, with or without a duration |
| Schedule | A maintenance window |
| Dependency | A master sensor going down |
| Parent | Any ancestor being paused |

**They are a set, not a precedence chain.** Clearing the one the UI happens to report does not
necessarily resume the object — `pausedBy` lists every source currently holding it, which is why
it exists. A paused sensor records no readings and raises no alarms, and its downtime is not
counted against its SLA.

Acknowledging is not pausing. An acknowledged sensor keeps scanning and keeps recording; it
simply stops re-notifying. Use it for "I know, I am on it", and a pause for "do not tell me and
do not count this".

---

## What to watch

The system monitors itself with real sensors, and every subsystem with a queue, a pool or a
connection reports into one of them. The full channel list is in
[`docs/sensor-reference.md`](sensor-reference.md) under **System**; these are the ones worth an
alarm.

### Core Health — `ms.core.health`

| Channel | Watch it because |
| --- | --- |
| `ingestQueue` | Readings arriving faster than they are written. Warns at 40,000, errors at 100,000 |
| `rollupLag` | Rollups falling behind. An hour is a warning; a day means graphs at wide ranges are wrong |
| `diskFree` | Errors below 10%. See below — a full disk costs retention |
| `memoryAvailable` | What the core's *machine* has left — `MemAvailable` on Linux, the lowest of the last 30 s. Warns below 20%, errors below 10%: `P-206` watched a machine go from 8.5% to a kernel kill in six seconds. On the default installation the local probe's copy reads the same machine; this is the one that matters when every probe is remote and nothing else is watching the database host |
| `memoryLimitUsage` | The core's working set against its own ceiling — `MemoryMax=8G` in `ms-core.service`. Warns above 80%, and the warning is the one to act on: at 100% the kernel kills the core. See [a service at its memory ceiling](#a-service-at-its-memory-ceiling). A gap where there is no limit, on cgroup v1 and on Windows |
| `evictedChunks` | **Any value above zero is an error.** Data was dropped early to stay on disk |
| `notifyOldest` | Notifications queued and undelivered. 15 minutes warns; an hour means nobody is being told anything |
| `alarmOverdue` | The alarm sweep is not running. Everything downstream of it is silently stale |
| `probesDown` | Probes not connected. Their sensors are not being checked |

### Probe Health — `ms.probe.health`

| Channel | Watch it because |
| --- | --- |
| `connected` | The link to the core |
| `schedulerLag` | Checks starting later than scheduled. Warns at 1 s, errors at 5 s — this is the first sign of an overloaded probe |
| `poolUsage` | Worker pool saturation, sampled at the heartbeat rather than averaged — on a bursty workload it under-reads badly (4.7% measured while every worker was saturated once a second, `findings/2026-09-04-live-probe-check.md`), so do not size down from a low reading. Warns at 80%. Since `P-34` the probe raises its own ceiling from the checks it was assigned, so sustained saturation means either `workerPoolSize` is pinned or the workload outgrew what a probe derives for itself — see the troubleshooting runbook, and note that a pool below its floor accumulates rather than refusing |
| `deferred` | Checks the pool could not start. **Backpressure is counted, never silent** |
| `sessionOverflows` | **Any value above zero is an error.** SNMP or SSH sessions were opened past the pool's bound because every existing one was in use — the pools do that rather than fail a check, and sustained overflow is a probe heading for `EMFILE`. Lengthen `idleMs`, move devices to another probe, or raise the bound |
| `sessionsOpen` | Device sessions held right now. No threshold — how many is a property of your catalogue, not of health |
| `sessionsEvicted` | Sessions closed for being idle. Climbing in step with the sessions opened means `idleMs` is shorter than your scan interval, so every check pays a handshake it need not — expensive on SSH |
| `spoolStalled` | **Any value above zero is an error.** The link is up and the spool is not moving — results are accumulating for a reason nothing else reports |
| `spoolDropped` | **Any value above zero is an error.** Results were lost because the spool filled |
| `memoryAvailable` | What the probe's *machine* has left, which `memory` — the probe's own share — cannot tell you. The probe `P-206` lost was the largest process on its VM, and was killed because a lint run and PostgreSQL had taken the rest. Warns below 20%, errors below 10%; the lowest of the last 30 s, because the fall from 8.5% to a kill took six. A gap for a probe older than protocol 17 and on any platform but Linux and Windows. The machine's figure, not the probe's own ceiling — that is the next row |
| `memoryLimitUsage` | The probe's working set against the ceiling its own unit sets — `MemoryMax=6G` in `ms-probe.service`, whatever the machine has left. Warns above 80%. **Act on the warning**: at 100% the kernel kills the probe, and what follows is a link that drops, not a reading — see [a service at its memory ceiling](#a-service-at-its-memory-ceiling). Measured against the working set, not `memory.current`, because page cache fills a cgroup to its ceiling harmlessly. A gap where there is no limit, on cgroup v1 (RHEL 8 by default) and on Windows. `memoryLimit` beside it is the ceiling in MB |
| `clockJumps` | The host's clock moved. Scheduling is monotonic, but data is wall-clock |

These thresholds ship as **defaults, not policy**. They are written once when the channel is
created and never again — change or clear one and it is yours from then on, because a default
that reappeared after somebody deliberately removed it would be worse than no default at all.

### A service at its memory ceiling

Each service has one memory ceiling, `MemoryMax` in its unit — 6 GiB for `ms-probe`, 8 GiB for
`ms-core` — and the kernel enforces it whatever the machine has left. `memoryLimitUsage` on Probe
Health and Core Health says how close each one is. **The warning at 80% is the one to act on**,
because on the stock units it is the last thing that channel will say. It catches a service that
has settled high or is growing slowly — a leak, a workload added over weeks. It cannot catch a
surge already under way: the probe's start-up grew 856 MiB in five seconds (`P-206`), which
crosses the last 20% of 6 GiB in about seven, and a warning reaches the sensor up to half a minute
after the crossing. At 80% there is still room for one such surge; past about 86% there is not.

- **Past the ceiling, the kernel kills the service** — measured with swap configured as well as
  without — and systemd records why. The journal says *A process of this unit has been killed by
  the OOM killer* and *Failed with result 'oom-kill'*, and `systemctl status ms-probe` shows the
  result.
- **It restarts five seconds later**, and if the same work needs the same memory it is killed
  again, for as long as nothing changes — systemd never gives up at this pace (`P-215`).
  `systemctl show -p NRestarts ms-probe` counts the rounds. The core shows the probe Down with
  "Link to the core is 0", and `memoryLimitUsage` as a gap, not as 100%.
- **Raising the ceiling ends it.** The next restart comes up under the new one without anybody
  starting it.

To raise a ceiling, set it with `systemctl`, which applies it at once, keeps it across reboots and
leaves the shipped unit file alone for the next upgrade to replace:

```
systemctl set-property ms-probe MemoryMax=8G
```

**Do not add a `MemoryHigh` below it.** Past `MemoryHigh` the kernel does not stop a service or
kill it — it throttles it, and with no swap a probe was measured at a standstill within 17 seconds,
killed by its own 30-second watchdog within 25, and restarted into the same standstill for as long
as nobody intervened (`P-213`, `docs/findings/2026-09-28-memory-ceiling.md`). Where a unit does
set one, `memoryLimitUsage` measures against it, and can read past 100% — which is what its error
limit is for.

### Prometheus

`/metrics`, outside `/api/v1` because that is the path every scraper config, service-discovery
rule and Helm chart already assumes. **It is guarded explicitly**, because authentication only
covers `/api/` — the app shell has to be public — so a route outside that prefix would otherwise
be public too, and the scrape body is a map of the installation: every queue depth, the sensor
counts per probe, the probe names.

A scraper authenticates with an API token, which is what `authorization` in a `scrape_config` is
for. While the core is still starting it answers **503** rather than an empty body, because an
empty body is recorded as every series vanishing at once.

---

## Housekeeping, retention and a full disk

Rollups, retention and the job that drives them are written in `packages/core`, not delegated to
the database — so the storage engine could change and this behaviour would not. Native
compression is the one TimescaleDB feature relied on, and it is worth 12.5× on disk
([measured](findings/2026-08-25-rollup-storage-spike.md)).

**A full disk costs retention, and it says so.** When free space falls under the reserve, the
housekeeper evicts the oldest raw chunks early — up to a bounded number of steps per pass — and
raises `evictedChunks`. That channel exists so the trade is visible: the alternative is a
database that stops accepting writes, and a monitoring system that stops recording is worse than
one that has forgotten last month. Treat any eviction as "add disk", not as normal operation.

If the configured data path is on a remote database host, the core cannot measure it and reports
nothing rather than guessing — a wrong number here would be worse than no number.

### Stored reports have their own two horizons

`housekeeping.retention.reportDays` (90 by default) bounds the **documents** and
`reportRunDays` (730) bounds the **record that a report ran**. Two settings because the two are
not the same size: a rendered report is kilobytes and is what grows a backup, while a run row is a
few hundred bytes and is what answers "has this report been failing since August". The same
reasoning gives `auditDays` twice the life of the raw data.

Deleting a run takes any document still attached to it, so setting `reportRunDays` below
`reportDays` simply makes the shorter one win. That is a coherent way to configure it, not a
mistake.

**Two things are never pruned, whatever their age.** A report still rendering keeps its run row —
deleting it would let a second render start beside the first. And a report whose delivery is still
queued keeps its bytes: a queued delivery with nothing to send is recorded as a *permanent*
failure, and retention causing that would be this system manufacturing the one outcome it cannot
recover from. Both wait for the next pass, which costs five minutes.

If reports are what is filling the disk, `reportDays` is the setting to shorten; the run history
is almost free and worth keeping.

---

## Backups

Have this rehearsed before you need it. The whole procedure is
[`docs/runbook-backup-restore.md`](runbook-backup-restore.md); the short version:

```bash
sudo /opt/ms/bin/ms-backup --out /var/backups/ms
```

One timestamped `tar.gz` holding the database, both configuration files, the vault key and the
probe-channel certificates. **Rehearse the restore onto a host that is not the one it came
from** — restoring over the original proves almost nothing, because the data, the key and the
certificates are all already there and a restore that quietly did nothing would pass.

The archive decrypts every monitored-device credential in the installation. Store it where the
database's own storage is stored, and no more widely.

---

## Upgrades

Covered in [`docs/installation.md`](installation.md#upgrading). The two things worth repeating:

- **`config check` runs before anything restarts.** A renamed or newly-required setting stops the
  upgrade with the old services still running on the old version.
- **A build refuses to start against a schema migrated by a newer build.** That refusal is
  correct. Install the matching release rather than migrating backwards.

---

## Reverse proxies

The API listens on loopback by default. Behind a proxy, set `api.allowedOrigins` to the origin
browsers will actually use:

```json
{ "api": { "allowedOrigins": ["https://ms.example.com"] } }
```

The CSRF guard compares the browser's `Origin` against the request's `Host`, and a proxy that
rewrites `Host` makes those differ for a request that is not cross-site at all — so without this
key every write from such a deployment is refused. Full origins, with a scheme; not a bare
hostname, and not a wildcard. A bad value is refused at startup, not at the first write.

Set `notifications.publicUrl` to the same origin, or alarm emails will link to an address nobody
receiving them can open.

## Map tiles

A map can place its widgets on a map of the world, and this installation draws no street map until
you give it one. That is deliberate (`ADR-004`): bundling a world is tens of megabytes for a view
that cannot show a street, and shipping a default provider would accept somebody else's terms on
behalf of every operator who installs this. A map with no tile source configured still works — it
draws its widgets over the background image the map's author uploaded, which is what an air-gapped
NOC gets.

To use one, choose a provider, accept its terms, and configure the template and the credit it asks
for:

```json
{
  "maps": {
    "tileUrl": "https://tiles.example.org/{z}/{x}/{y}.png",
    "tileAttribution": "© OpenStreetMap contributors"
  }
}
```

All three placeholders are required; a template missing one asks the provider for the same tile at
every position, which draws a broken map and is a request pattern that gets an installation
blocked. The attribution is drawn on every map that uses the tiles, and it is not optional in
spirit: every tile service asks for it, and removing it is you breaking somebody's terms using our
software.

The tiles are fetched by each **viewer's browser**, not by the core, so every browser that opens a
geographical map talks to the provider directly. Two consequences:

- The content security policy is widened to exactly the one origin your template names. Change the
  provider and restart; nothing else is allowed to load images.
- **A public share link draws no tiles unless the map's author opts in**, per map, in the designer.
  A stranger opening a link would otherwise tell your provider that this installation exists and
  which places it watches — and with a keyed provider, hand over the key — none of which is visible
  to the person who made the link.

Where a map opens is saved with the map by its author. Panning and zooming are local to a browser
and are not saved, so a wall display comes back to the same place after a reboot rather than to
wherever somebody left it.

---

## What period a report covers

A report names a calendar period rather than a number of days: `day`, `week`, `month`, `quarter`,
`year`, or a custom start and end. Three things about that are worth knowing before somebody files
a bug about them.

**"Month" means last month, not this one.** The `offset` on a span counts periods backwards and
defaults to 1, the last complete one. A monthly report fires on the 1st at 02:00, and one covering
"this month" would cover two hours — every month, without complaint. Set `offset: 0` for
month-to-date; that is the only span whose end is clamped to now rather than to a calendar
boundary.

**The period is read in a zone, and the zone is part of the span.** Absent one, it resolves in the
zone the core process runs in. Weeks start on Monday, as ISO 8601 defines them, and are numbered
the same way — which is why the week of 28 December 2026 is `2026-W53` and not `2027-W01`.

**Two rules can change the report out from under the request, and both are visible before it
runs.** A span of 40 days or more is averaged over at least an hour, and one longer than 500 days
is shortened to 365 counted back from the end. These are the same rules the sensor graphs obey, and
they are the same code — a report and the graph an operator checks it against cannot disagree. The
API answers `resolved` alongside every report: the interval it works out to right now, the bucket
width, the rollup tier that will answer, and anything a rule changed. An author who pinned
five-minute averaging over a quarter is told it will be hourly while they are still looking at the
form, rather than a month later in a PDF.

### What a rendered report says, and what an empty cell means

`GET /reports/:id/render` produces the document now, as HTML (`?format=html`, the default), CSV
(`?format=csv`), XML (`?format=xml`) or PDF (`?format=pdf`). All four carry the same numbers — they
are one document formatted four times — and all four begin with the period, the account the report
rendered through, and the averaging interval, because a file that has been forwarded twice has lost
whatever the email said.

**An empty cell means no reading was recorded in that interval. It does not mean zero.** In CSV it
is an empty field; in HTML and in PDF it is `—`; in XML it is `<value channel="…" xsi:nil="true"/>`,
which is XML Schema's own way of saying an element has no value — an empty element was deliberately
not used, because a script reading its text as a number would get `0`. A sensor that was Down, paused, or unreachable produced no
readings, and a report that wrote `0` there would be a measurement somebody acts on. A measured
zero — 0% packet loss, 0 errors — is written as `0`, and the two are always distinguishable. An
interval where every channel is empty still gets a row: dropping it would make the table claim the
period was shorter than it was.

Objects the report names but could not render are counted in the document rather than left out, as
a list of ids. They are either gone or outside what the report's account can read, and the document
deliberately does not say which — see the note about granting reports above. The core log has the
breakdown.

A report that would produce more than 200,000 values is refused rather than truncated, with the
count and what to narrow: fewer sensors, a shorter span, or a coarser averaging interval. A report
silently missing its last four hundred sensors would be worse than no report. **It is refused before
any history is read**: the count is channels times buckets, and both are known up front — a
500-sensor report used to read for ten seconds before being told no (`P-203`). **A PDF has a second
bound**, because values become pages: over 400 pages it is refused the same way, with the page
count and the suggestion to render it as CSV instead, which has no pages. Most of those are refused
before a page is laid out as well: a report with more table rows than 400 pages could hold cannot
fit, and says it is "at least" that many pages (`P-204`).

CSV is written so that a name beginning `=`, `+`, `-` or `@` cannot run as a formula when the file
is opened in a spreadsheet. Numbers are left exactly as measured, negative ones included.

### Graphs

**The template decides what a reader sees.** `graph_and_table` draws a graph for each sensor and
then its table; `graph_only` draws the graphs alone; `table_only` draws no graph. This applies to
the HTML and the PDF. **CSV and XML always carry the data table**, whatever the template: they are
the data, for a spreadsheet and a script, and a `graph_only` report exported as CSV would otherwise
be an empty file.

A sensor gets **one graph per unit**, never one graph with two y-axes. A Ping sensor's response
time and packet loss are two graphs, because on one set of axes the point where two lines cross is
an artefact of where the axes were put and reads as a relationship. Channels that share a unit —
traffic in, out and total — share a graph, with a legend, because that is where comparing them is
real. A channel keeps its colour whichever graph it lands on.

What a graph shows, and what it deliberately does not:

- **A break in a line is an interval with no reading**, exactly as `—` is in a table. The line is
  never drawn down to zero and never joined across an outage. A single reading with no reading on
  either side is drawn as a dot, so it is not lost.
- **The shaded band is each interval's lowest and highest reading**, around the average line — the
  same band the sensor page draws. An hour's average hides a spike; the band does not.
- **The value axis starts at zero for anything that never goes below it.** Latency, traffic and loss
  are magnitudes, and an axis fitted to the data turns a response time wandering between 243 and
  245 ms into a picture of an outage. The cost is that a steady temperature sits near the top of its
  graph. Data that goes below zero is drawn as it is. Ticks are always 1, 2 or 5 × 10ⁿ.
- **The time axis is in the report's own zone**: ticks at local round hours, midnight labelled with
  its date, months at the local first of the month, and no tick for the hour the clocks skipped.
- **A channel that recorded nothing in the period is said in words** — "No readings were recorded
  for Response time (ms) in this period" — rather than drawn as an empty frame.

**Graphs cost size.** Measured at the value limit, a report's HTML is 7.3 MiB as a table, 13.9 MiB
with graphs and table, and 6.5 MiB as graphs alone. A month of hourly data over fifty sensors is
2.6, 5.1 and 2.5 MiB. If a mail relay refuses a large report, `graph_only` or a shorter span is the
first thing to try.

**A PDF of a large table meets the page limit sooner than the value limit.** A month of hourly
tables for fifty sensors is about 700 pages, and PDFs stop at 400 — while the same report as
`graph_only` is under a megabyte. For a PDF over many sensors, `graph_only` is usually the report
that was wanted; the table is still in the CSV.

**A PDF is laid out by this service, not by a browser** (`ADR-006`). There is no Chromium to
install, patch or supervise; the layout — column widths from the content, headings repeated on
every page, a row never split across a break, a column too wide carried to a following page rather
than clipped — is this service's own, and every page says what a dash means and where it sits in
the document. **The font travels inside the file**, so the reader needs nothing installed and a
Cyrillic or Greek sensor name is drawn correctly on a server with no fonts of its own.

**Two fonts ship, and every character is drawn by the first that has it** (`E-12`). DejaVu Sans
draws Latin, Greek, Cyrillic and much besides; **WenQuanYi Micro Hei** draws Japanese, Chinese and
Korean — every character of JIS X 0208, GB 2312, Big5 and KS X 1001 — so `東京 本社` and `서울 코어`
are drawn as themselves with nothing configured. A character neither has is written as its Unicode
notation — `U+20B9F` — and the document says once, under its heading, that this happened: an empty
box that nothing reports is the failure embedding a font was meant to remove, and it would be no
better for being ours. The one such character a Japanese name commonly uses is **〜** (the wave
dash); the rest are rare.

**WenQuanYi's kanji are drawn the Chinese way.** Many Han characters are shaped differently in Japan,
China, Taiwan and Korea, one font can only choose one shape, and this one chose China's. Reports read
in Japan, or anywhere the shapes matter, should name a regional font to draw with first:

```json
{
  "reports": {
    "pdfFonts": [
      { "path": "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "face": "NotoSansCJKjp-Regular" }
    ]
  }
}
```

That path is where Debian and Ubuntu's `fonts-noto-cjk` package puts Noto Sans CJK; the faces in
it are `NotoSansCJKjp-`, `kr-`, `sc-`, `tc-` and `hk-Regular`, for Japan, Korea, mainland China,
Taiwan and Hong Kong. The fonts listed are tried in order, before WenQuanYi and after DejaVu, and
WenQuanYi still draws anything they lack. `face` is empty for a font file with only one face in it.
**A font that cannot be used does not stop the core**: it is logged at startup with the reason — a
collection opened without a face is answered with the faces it has — and PDFs draw with the next
font in the list. Opening one costs a formatting worker memory, once, and only when a report first
needs a character DejaVu lacks: 22 MiB for WenQuanYi, 80 MiB for Noto Sans CJK.

**XML is the format for a reader that is a program.** Every fact the other two print as a label is
an attribute — the period, the timezone, the account, the averaging, the channel keys and units,
and a count on every list — so a script does not have to reconstruct them from a table. There is no
namespace on the report's own elements, so `//sensor/rows/row` works as written; the `xsi` namespace
is declared because that is where `nil` lives, and the root carries `version="1"` for the day the
shape changes. A character XML cannot carry — a control byte in a device name discovered over SNMP,
say — is dropped rather than escaped, because XML 1.0 has no escape for one and a document
containing it is a document no parser will read at all.

---

## When a report runs

A report runs when somebody asks (`POST /reports/:id/runs`) or on a schedule: hourly, daily,
weekly, monthly, quarterly or annual. **A new report is manual** — creating one does not schedule
one, because choosing a frequency for somebody is this system deciding on its own to send email.
`GET /reports/:id` answers `scheduleSummary` in words and `nextRunAt`; **a null `nextRunAt` is not
an error**, it means the report does not run on its own.

A few rules are worth knowing before somebody files a bug about them.

**A monthly report set to the 31st runs on the 28th of February**, not never. The day is clamped to
the end of a shorter month. A report that silently had no February would be missing the month
somebody eventually asks about.

**A schedule from the schedule library is a permission window, not the cadence.** Attaching one to
a report means "monthly on the 1st at 02:00, but only while this window is open", which is `§4`'s
rule that inactive periods pause reports as well as monitoring. A booking that lands while the
window is shut is moved forward to the next open minute — up to a week, which is as long as a
weekly calendar can be shut — rather than skipped. A window that is never open means the report
never runs on its own, which is a configuration you can make and is reported as a null next run.

**One run at a time.** Asking for a run while one is in flight answers 409 rather than queueing:
a render is minutes of work, and a button pressed six times must not become six of them. Starting a
run needs `write` on the report; reading its history needs only `read`.

**A run that was in flight when the core stopped is marked failed at the next startup**, with
`REPORT_INTERRUPTED`. A report more than six hours behind its booking is skipped rather than run,
so a core that was down for two days does not produce a burst of reports each covering a period the
next one also covers — the log says when this happens, and the next run is on time.

**Every run is a row.** `GET /reports/:id/runs` answers the last fifty: when, who asked, what period
it covered, how many sensors it rendered, how long it took, and — if it failed — the same error code
the API would have answered with. That is what tells you at 09:00 whether last night worked.

**A report that ran writes an audit entry**, naming both who asked and the account whose visibility
it rendered through. Those are routinely different, and the second is the one that decides what the
document contained.

Core Health carries two channels for this. **Scheduled reports deferred** rises when more reports
are due than the core will render at once — schedule fewer, or spread them out. **Report runs
failed** rises when one report is broken: a security context that was deleted or disabled, a span
that resolves to nothing, or a document over the size limit. The two name different fixes, which is
why they are two lines.

**Formatting runs beside the core, not on it** (`P-204`). Turning a document into HTML, CSV, XML or
PDF is CPU work, and on the core's own thread a large report froze every request, probe result and
browser update for a second or more. It runs in two worker threads instead, started the first time
a report is formatted and given back after a minute idle. Eight more jobs may wait for them; beyond
that a render is refused with **`409 REPORT_BUSY`** rather than queued without limit — try again
when one has finished. Two more Core Health channels watch this: **Report formats waiting** is how
many are queued now, and **Report formats refused** counts the ones turned away. A steady non-zero
refusal count means more people are rendering large reports at once than two workers serve.

---

## What happens to a report once it has run

A report renders any of HTML, CSV, XML and PDF, and is delivered one of three ways: stored, stored
and emailed, or emailed only. **A new report stores HTML and sends nothing** — creating one must not
arrange for this system to send mail.

**A stored report lives in the database** (`ADR-005`), not in a directory. Backing up the database
backs up the reports; there is no second procedure, and a restore does not produce a list of
reports whose files are all missing. The cost is that backups grow with what you retain, which is
what `E-10`'s retention setting is for.

**"Email only" still stores the report briefly.** A delivery that fails is retried, a retry needs
the bytes, and re-rendering later is a *different document* — the same span gives different numbers
once a rollup or retention has moved underneath it. The stored copy is deleted as soon as it has
gone. A delivery that has permanently failed keeps its copy, because that is the one somebody
investigating needs.

**The ZIP option replaces the attachments rather than joining them.** A report set to render HTML
and CSV with ZIP on produces one archive containing both, not three files.

### When a report cannot be delivered

Four rules, and they are the same ones the alarm pipeline follows.

- **Bounded retries with a growing delay** — five attempts over roughly ninety minutes, per
  report. A hundred reports queued behind one dead relay retry on their own schedules.
- **A permanent rejection is not retried at all.** An address the relay refused will be refused
  again; only a relay that timed out is worth waiting for. The distinction comes from the relay's
  own response code.
- **One report, one failure.** A relay that has been down for an hour is one report in `failed`
  with one log line, not sixty.
- **Failed means failed.** Nothing re-arms a delivery on a timer. `GET /reports/:id/runs` shows the
  state, the attempt count and the relay's own error, and Core Health's **Reports waiting to be
  delivered** rises while a backlog exists and falls when it clears.

`GET /reports/:id/runs/:runId/:format` downloads what a run produced — `html`, `csv` or `zip`. The
bytes carry their own SHA-256 as an ETag, so a second download of an unchanged report is a 304.
Reading a report is enough to download its output; the run has to belong to the report, so an id
from somewhere else answers 404 rather than serving somebody else's data.

