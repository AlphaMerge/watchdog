# Release candidate field test (H-09)

`PLAN.md` Phase 10's exit criterion for 1.0:

> A clean install on Ubuntu, monitoring 100 real devices for a week without intervention.

**1.0 is Linux-only** (decided 2026-09-28, `H-10`). The criterion used to name Windows Server as
well; that half is release 1.1's field test, `H-17`, and its steps are the last section of this
runbook — moved there whole, not deleted.

This is the procedure for running it. It exists because the test needs hardware and a week of
wall-clock that no CI job has, and a test that has to be designed before it can be run is a test
that gets run badly or not at all.

**What is already proved, so you do not re-prove it:**

| | Last verified | How |
| --- | --- | --- |
| Clean install on Ubuntu | **2026-10-04, `v1.0.0-rc.2`, locally (arm64)** | `MS_SMOKE_DISTRO=ubuntu scripts/smoke-install.sh` |
| Clean install on Debian | **2026-10-04, `v1.0.0-rc.2`, locally (arm64)** | `scripts/smoke-install.sh` |
| `.deb` and `.rpm` install, upgrade, remove | **2026-10-04, `v1.0.0-rc.2`, locally (arm64)** | `scripts/smoke-packages.sh` |
| Backup and restore onto a different host | **2026-10-04, `v1.0.0-rc.2`, locally (arm64)** | `scripts/smoke-restore.sh` |
| 5,000 sensors for 24 h | 2026-08-30 | `docs/findings/2026-08-30-soak-24h.md` |

> **"Last verified" is a date, not a guarantee, and that is deliberate.** These four used to read
> "in CI", which stopped being true the moment the workflow was disabled — a table telling you
> not to re-prove something, on the strength of a job that is not running, is worse than no table.
> They are one command each and they take minutes. **Re-run all four against the build you are
> about to field-test**, rather than trusting this row, and update the date. If CI is running
> again by then, say so here and the rule can go back to trusting it.

**The procedure itself was rehearsed** on 2026-10-04, on `v1.0.0-rc.2` (arm64) against the
development simulators, compressed to three hours (`H-15`,
[the write-up](findings/2026-10-04-field-test-dress-rehearsal.md)). It checked twelve suspected
problems in this runbook, or in `installation.md` where it sends you. Eleven were wrong or
unclear, and are fixed in both; one was refuted, and the order it questioned is kept. That
proves the steps can be
followed, and nothing about the product. It is not a row in the table above: it is not a check
to re-run, and a rehearsal is not part of `H-09`.

**What this runbook adds is what those cannot reach**: real devices that answer in ways a
simulator does not, and a week of unattended running.

> **Say which build you are testing, and mean it.** `main` carries v2 work beside the candidate:
> flow monitoring, maps, reports and libraries. The candidate is `main` packaged with the v1
> profile, which constructs none of them (`H-12`). `scripts/package.sh` builds that profile unless
> told otherwise, and stamps each build with its profile and commit (`H-11`); step 4 records both.
> The appendix lists everything the candidate answers and every sensor type it carries.
> Field-testing "whatever `main` was that morning" is how a week produces a result nobody can
> attribute.

---

## Before you start

- **An Ubuntu host** for the core.
- **A host for a remote probe: optional, and recommended.** Debian or RHEL, x86_64, whose
  `resolv.conf` names the site's DNS servers, which resolves the core host's name (its
  `hostname -f`, by DNS or the probe host's hosts file) to the core, and which can reach the core
  on TCP 23560 by it (step 1, *Every probe resolves names with the gate*). Without one, nothing
  in the week shows what the gate's questions cost the site's resolver, and the write-up says so.
- **100 devices you did not choose for being easy.** A field test against a hundred identical
  Linux VMs proves the scheduler and nothing about the sensor catalogue. Aim for a spread: some
  switches, some Windows servers, some appliances with slow SNMP agents, at least one device
  behind a firewall that drops rather than refuses, and at least one that is intermittently
  unreachable on purpose. Monitor the Windows servers by ping, port, HTTP, TLS and SNMP: the four
  WMI types need a probe on Windows, and are 1.1's.
- **A week you are not going to touch it.** "Without intervention" is the criterion. Restarting a
  service to see whether that helps ends the run.

## 1. Install

Ubuntu core, from the package rather than the tarball — that is what an operator uses:

```bash
sudo apt install ./ms_<version>_amd64.deb
```

`apt` and not `dpkg -i`: the package depends on `iputils-ping` (`H-31`), and only `apt` fetches
a dependency.

A candidate's package spells its version with `~` where the tag has `-`: `v1.0.0-rc.1` is
`ms_1.0.0~rc.1_amd64.deb` and `ms-1.0.0~rc.1-1.x86_64.rpm`, so that `1.0.0` sorts after it and
upgrades it. The tarball and `/opt/ms/VERSION` keep the tag's spelling. Check the package's
SHA-256 against the candidate's record (`docs/findings/2026-10-04-v1-release-candidate-cut.md`)
before installing it.

**A fresh install starts nothing, and says so** (`H-30`). `dpkg -l ms` reads `ii`, both services
are stopped, and the install's last lines say *`/etc/ms/core.json` is new, so nothing was
started* and what to set. Finish it with [`installation.md`](installation.md) §3–§5:

```bash
sudo nano /etc/ms/core.json                     # database.password, and the relay (step 3)
sudo /opt/ms/bin/ms-core config check
sudo systemctl reset-failed ms-core ms-probe
sudo systemctl start ms-core ms-probe
```

**Then, before step 2, everything the week will read has to exist.** A fresh installation has
the root object and nothing else, so none of this is optional:

- **The local probe**, approved onto a probe object you create first (`installation.md` §5).
- **`ping`, and the probe's right to use it.** The package brings `iputils-ping` (`H-31`). The
  probe's unit gives `ping` no raw socket, so it uses an unprivileged ICMP socket, which only
  the groups in `net.ipv4.ping_group_range` may open. Check the live value: the two numbers
  `sysctl net.ipv4.ping_group_range` prints must include the id `getent group ms-probe` gives.
  Where the range was still the kernel's empty default, the install set it, and put the same in
  `/etc/sysctl.d/60-ms-probe-ping.conf`; where it already included the group, that file does not
  exist, and need not. If the range leaves `ms-probe` out, widen it first (`installation.md`,
  *Before you start*); otherwise every ping sensor reads Down.
- **The listeners**, in `/etc/ms/probe.json`, if your devices send syslog or traps:
  `syslogListener.enabled` (UDP and TCP 10514 by default) and `trapListener.enabled` (UDP 162).
  Restart the probe afterwards, after `reset-failed`.
- **A Core Health sensor, and a Probe Health sensor for every probe** (`ms.core.health`,
  `ms.probe.health`), each on a device under its probe. Nothing creates them for you, and steps 2
  to 4 read them all.
- **The devices**, and their credentials.
- **A token for the setting up.** Everything after the install is the UI or the API. For the
  API, sign in and make a `full`-scope token for steps 1 to 3 (`POST /api/v1/auth/tokens`
  `{"name":"field-test-setup","scope":"full"}`), and revoke it before the week starts. Step 4's
  `read` token is for the readings, and a `read` token cannot create a trigger.
- **A new password for the first administrator.** Signing in with the generated one works,
  and the API does not insist on the change (`mustChangePassword` is the client's to enforce),
  so a week can run on the password in `first-admin-password` unless you change it.

### Every probe resolves names with the gate (`P-432`)

**Set `"nameResolver": "gate"` on every probe in the test**: the local probe on the core's host,
and every remote probe. The default is `"system"`, and the field test is where the gate is
tried on real devices and a real resolver before 1.0's default is decided
([release notes → Name resolution](release-notes-1.0.md#known-limits-and-what-comes-next)).
A probe left on `"system"` tests nothing of it, and step 4 records that it did not.

- **Both ends run this build.** A remote probe is the same candidate's probe-only tarball,
  `ms-probe-<version>-linux-x86_64.tar.gz`, checked against the record the same way, and installed
  as [installation.md → Remote probes](installation.md#remote-probes) says: `ms-enrol` on the
  core's host issues the probe its bundle, with `--host "$(hostname -f)"`, since a default core
  binds every address and `ms-enrol` cannot read one to dial. The probe dials that name and checks
  the core's certificate against it, which lists `localhost`, `127.0.0.1` and the core host's
  `hostname -f` at install, so an IP address fails (`connection to core failed`, and the probe
  never appears as pending), and the probe's host must resolve the name to the core.
  `sudo ./install-probe.sh --enrolment <bundle>` from inside the unpacked tarball installs and
  enrols it, and it is approved onto a probe object of its own on the core. That is the path
  `scripts/smoke-enrol.sh` runs. The `ms-probe` package is not used for a remote probe here: it
  has no way to take an enrolment bundle, and its setup issues a probe-channel certificate
  authority of its own, which the core does not trust. Give the new probe its Probe Health sensor
  (above). An older probe refuses the key and stays stopped (exit 78), and under an older core
  the gate's health never reaches Probe Health.
- **A second probe pointed straight at the site's resolver, if you can.** Ubuntu's own probe asks
  `systemd-resolved`'s stub at `127.0.0.53`, which stands between the gate and the site's DNS
  servers, so it cannot show what the gate's questions cost them. A probe on Debian or RHEL whose
  `resolv.conf` names the site's servers can. If there is none, the write-up says that the load
  on the site's resolver was not observed.

On each probe's host, add the key to the `probe` section of `/etc/ms/probe.json`, beside what is
there:

```json
"probe": {
  "nameResolver": "gate",
  …
}
```

```bash
sudo nano /etc/ms/probe.json                    # "nameResolver": "gate" in the probe section
sudo /opt/ms/bin/ms-probe config check          # refuses a misspelt key or value
```

`config check` refuses a misspelt key or value (exit 1), and passes `"gate"` (exit 0) with a line
on its standard output, `note: probe.nameResolver: is gate: …`, that says where names are asked.

Nothing applies it but a restart. On the core's host step 2's restart does it; on a remote
probe's host restart that probe now, and do it again in step 2:

```bash
sudo systemctl reset-failed ms-probe
sudo systemctl restart ms-probe
sudo journalctl -u ms-probe -b --no-pager | grep -F 'probe.nameResolver is gate'
pgrep -af 'ms-probe: lookups'                   # the lookup helper, the probe's child
```

A probe in gate mode logs one line at start, *probe.nameResolver is gate: the name policy the
probe routes its lookups by*, with what it read of the host's name settings: its DNS servers,
search list, `resolv.conf` options, `hosts:` line and glibc. **`"check":"on"` in that line is the
pass**: the name check takes this host's settings. `"check":"off"` names in its `off` field the
first rule the host failed (`code`, and `why` in words), and every name is asked in the lookup
helper, the hosts file's included, so step 4's share of lookups in the helper counts them too:
still the gate, and the write-up says which rule, since nothing the week records then tests the
check. No such line means the probe runs `"system"`, which logs nothing of the mode, or has not
restarted. Probe Health's `nameResolverMode` says the same from the core (step 4). With the
check on, the probe logs *the DNS check is proven: a DNS server answered it* once a server has
answered it, within a minute of the start, and every hour's summary then reads `"state":1` in its
`check` (step 4):

```bash
sudo journalctl -u ms-probe -b --no-pager -o cat | grep -F 'the DNS check is proven'
```

Run this block once against a packaged probe before the week, as the dress rehearsal did for the
rest of step 1.

## 2. Restart everything, once, before you start counting

**This step exists because of `P-28`.** A probe at the v1 target could never reconnect: the core
sent a configuration too large for one message, the probe rejected it, and it looped — 426 times
in three minutes — with the core logging only "link to core closed". A 24-hour soak with the same
5,047 sensors never saw it, because the probe never restarted during the run.

So restart both services deliberately, after the devices are added, and confirm the probe comes
back:

```bash
sudo systemctl reset-failed ms-core ms-probe
sudo systemctl restart ms-core ms-probe
```

**`reset-failed` first.** Each unit is allowed five starts in ten minutes, an operator's
included, and the sixth is refused and leaves the unit `failed`. `reset-failed` clears that
count and changes nothing else (`administration.md`, *Your own starts count too*, measured it).
That is why every start in this runbook follows one: `installation.md` §3's start, and the
restart here. A restart of the core also restarts the probe, so both counts move together.

**Restart every remote probe too**, on its own host, the same way (`sudo systemctl reset-failed
ms-probe`, then `sudo systemctl restart ms-probe`), and run step 1's `journalctl` check again on
each: the mode in effect after this restart is the one the week runs.

Then check `connected` on Probe Health, and that `scheduled` matches what the core assigned:
every sensor under that probe **except Core Health and Probe Health**, which the core evaluates
itself. Syslog and trap sensors count — the probe schedules a scan of its buffer for each.
`GET /api/v1/probes/<probe-object-id>/health` answers both in its message — *connected, 29
sensors scheduled, …* — within a heartbeat of the restart; the Probe Health sensor's own values
follow at the next sweep. A probe that is connected but scheduling nothing is the shape that
defect took.

**Anything that only breaks on restart is invisible to every other test we have**, which is
exactly why it is step 2 and not an afterthought.

## 3. Set the alarms that make "without intervention" observable

The point of a week unattended is that nothing needs doing — which you can only claim if
something was watching.

**There are two kinds of trigger and the difference decides how many you create.** A *state*
trigger is attached to a sensor and fires when that sensor enters a state; a *threshold* trigger
is attached to a channel and carries its own value, without changing the sensor's state (`M-04`).
A channel with a declared limit already moves its sensor's state, so a state trigger picks it up,
and so does one whose lookup says Warning or Down for a value, marked `yes (lookup)`; a channel
with neither never will, whatever it reads.

| Channel | Sensor | Declared limit? | Why it matters |
| --- | --- | --- | --- |
| `evictedChunks` | Core Health | yes | above zero means data was dropped early to stay on disk |
| `spoolStalled` | Probe Health | yes | the link is up and results are not moving (`P-27`) |
| `spoolDropped` | Probe Health | yes | results lost because the spool filled |
| `alarmOverdue` | Core Health | yes | the alarm sweep stopped; everything downstream is stale |
| `notifyOldest` | Core Health | yes | notifications queued and undelivered |
| `sessionOverflows` | Probe Health | yes | SNMP or SSH sessions opened past the pool bound (`P-36`) — sustained, this is a probe heading for `EMFILE`, and a week is long enough to get there |
| `lookupsGivenUpRecently` | Probe Health | yes | the probe's resolver gave up 100 checks in five minutes for want of an answer (`P-441`): DNS is not answering the probe, and the message names the domains |
| `lookupHelperTrouble` | Probe Health | yes (lookup) | only on a probe set to `probe.nameResolver: gate` (`P-432`): its lookup helper is failing, and the probe's log says why ([the gate](administration.md#the-gate-a-lookup-helper-for-the-names-dns-answers-probenameresolver)) |
| `probesDown` | Core Health | **no** | a probe is not connected |

**So eight of the nine need no threshold at all.** Their limits ship declared (`S-18`), or for
`lookupHelperTrouble` its lookup, which means Core Health and Probe Health already go Down or
Warning on their own. *State* triggers deliver all eight: **on Core Health and on every probe's
Probe Health sensor, the local probe's and each remote one's, two on each, one for Down and one
for Warning**, because a state trigger watches exactly one state. A remote probe's sensor left
without them delivers nothing: not its spool or session channels, not its resolver giving checks
up, not its lookup helper's Warning (step 4), and not its link, which goes Down through
`ms.probe.link`. A sensor inherits the triggers of every object above it, so one pair on a common
ancestor does the same; above sensors on different probes that is only the root, whose triggers
fire for every sensor in the installation. Give each a template whose body carries
`%lastmessage`, which names the channel. What you are adding is delivery, not thresholds.

```json
{ "kind": "state", "settings": { "state": "down", "initialTemplateId": 1, "recoveryTemplateId": 1 } }
```

**Delivery needs a relay, and the example leaves it empty.** The `notifications` section of the
installed `core.json` has no relay and no sender, so email goes nowhere until you set them and
restart the core (after `reset-failed`). Every setting, the fallback, and the password from a
file rather than `core.json` are in [`administration.md` → Email](administration.md#email). Set
`siteName` too, so the week's mail says which installation sent it.

**Then prove it before the week, not during it.** The
[test send](administration.md#the-test-send), `POST /api/v1/templates/<id>/test` with
`{"sensorId": <probe-health-id>}`, sends one real message through the template, the relay and the
recipients, and answers `"delivered": true` or the relay's error. Send one for Core Health and one
for each probe's Probe Health sensor, and check that each of those sensors has both of its
triggers: `GET /api/v1/objects/<id>/triggers` lists every trigger in effect on it, inherited
ones included, with a state trigger for `down` and one for `warning` among them. A week with no
alarm and a broken relay looks exactly like a week with nothing to report.

**`probesDown` is the exception, and it is deliberate.** It carries no limit because a probe that
is gone already alarms on its own Probe Health sensor, through the `ms.probe.link` lookup: that
sensor goes Down, and a second alarm here for the same outage is what `CLAUDE.md` forbids. So the
row above is the installation-wide *number* an operator reads, not a second alarm — and a state
trigger on each probe's own health sensor is what tells you. If you want the aggregate anyway, it
takes a threshold trigger with an explicit value, because nothing else will make it fire:

```json
{ "kind": "threshold", "settings": { "channelKey": "probesDown", "condition": "above", "value": 0 } }
```

`POST /api/v1/objects/<core-health-id>/triggers`. Take the same care with any channel you add to
this list yourself: check `docs/sensor-reference.md` for whether it has a limit before assuming a
state trigger will ever see it.

`trapOverwritten` and `syslogOverwritten` on Probe Health are two of those: neither has a limit,
and both need the probe and the core at protocol 26. Each counts what that listener received and
its buffer overwrote before a trap or syslog sensor read it, so a number above zero is
`trapListener.bufferSize` or `syslogListener.bufferSize` too small for what real devices send,
not the network. A trigger on either is optional — a syslog sensor that was behind fails that
scan and says how many it lost, and so does a trap sensor unless that was switched off on it —
but a week of real devices is the first time either buffer meets a real flood, so read both at
each of the three readings below.

### If the build carries flow monitoring (Phase 11)

The v1 candidate does not, so skip this section when testing it.

A `flow.netflow` sensor does not start the probe's collector: set `flowListener.enabled` in the
probe's configuration and restart it first (`docs/administration.md`, "The flow collector"), or
every scan fails saying so. Five counters on Probe Health come with a running collector, on a
probe and a core both at protocol 23: `flowReceived`, `flowRejected`, `flowMalformed`,
`flowMissed` and `flowUndecodable`.
**None of them has a declared limit**, so none of them will ever move a sensor's state — they need
threshold triggers or they are numbers nobody reads.

`flowMissed` is the one to set, and it is the reason this section exists rather than a sentence.
It counts what did *not* arrive, read out of the exporter's own running sequence, because UDP
drops silently and there is no other evidence — without it, a collector losing a third of its
flows to a saturated link looks exactly like a quiet network. A week of real traffic against a
real exporter is the first thing this project has ever run that could show that, and a simulator
never will.

`flowUndecodable` is worth one too: NetFlow v9 and IPFIX records are undecodable until their
template arrives, so a steady non-zero count is an exporter whose templates are not reaching us —
which looks like silence and is not.

A sixth, `flowOverwritten`, needs both ends at protocol 25. It counts records that did arrive and
that the collector's buffer overwrote before a flow sensor read them, so it is the probe's own
`flowListener.bufferSize` being too small and not the network. It has no limit either. A trigger
on it is optional: every flow sensor that was behind fails that scan and says how many it lost,
which is already an alarm. Read it on the probe to see how often, and by how much, before
choosing a larger buffer.

**`sessionOverflows` matters more here than anywhere else**, and it is why it was worth adding
before the field test rather than after. A hundred real devices with SNMP and SSH credentials is
the first workload this project has ever run that opens sessions in earnest, and the pools open
past their bound rather than fail a check — the right trade, and one nothing could see until
`P-36`. A simulator does not hold a session open for a week.

## 4. Run for a week, and record

Take a reading at the start, at 24 h, and at the end. **The API needs a token** — every route
but the three that log you in does — so make one first, from a signed-in session, and keep it
for the week:

```bash
# POST /api/v1/auth/tokens {"name":"field-test","scope":"read"} → { token, secret }
export MS_TOKEN=<secret>          # shown once, at creation, and never readable again
curl -s -H "Authorization: Bearer $MS_TOKEN" localhost:8080/api/v1/sensors/<core-health-id>/values
curl -s -H "Authorization: Bearer $MS_TOKEN" localhost:8080/api/v1/sensors/<probe-health-id>/values
```

A `read` scope is enough for everything in this section, and is what a token that lives on a
laptop for a week should have.

**Once, at the start, record which build this is** — it is the first line of the write-up, and
the answer to "say which build you are testing" (`H-11`):

```bash
curl -s -H "Authorization: Bearer $MS_TOKEN" localhost:8080/api/v1/build
```

A `commit` of `null`, or `"dirty": true`, means the build cannot say exactly what code it is.
Re-cut the candidate rather than field-testing it. So does a `profile` other than `v1`, or a
`subsystems` with anything `true`: the candidate is the v1 build (`H-12`), and maps, reports and
libraries are not part of what this test is about. `lock` names the dependency versions the build
was installed with (`H-20`). A candidate cut before `H-20` has no `lock`, and it shipped
dependency versions no suite ran against, so re-cut that one too.

**And, at each of the three readings, which name resolver each probe ran** (`P-432`), from that
probe's Probe Health sensor. `nameResolverMode` is `1` for `"system"`, `2` for `"gate"`, and `3`
for `"gate"` resting, which resolves as `"system"` does. Its lookup reads every value as Up, so
no state changes when it moves: read the number. In the hourly history since the start reading,
every hour's `min` and `max` of it must both be `2`, on every probe, and an hour with none is a
gap the write-up explains:

```bash
for id in <probe-health-id> <another-probe-health-id>; do
  curl -s -G -H "Authorization: Bearer $MS_TOKEN" \
    --data-urlencode "from=<start-reading-time>" --data-urlencode "resolutionSeconds=3600" \
    "localhost:8080/api/v1/sensors/$id/history"
done
```

The write-up's second line, after the build, names each probe, its host's OS, which resolver its
host asks (`systemd-resolved`'s stub or the site's servers), and the mode it ran. A probe that
ran anything but `2` for the week did not test the gate, whatever else it shows.

The numbers that decide the criterion:

- **`memory` on both health sensors.** Flat is the pass. The 24-hour soak measured +1.10 MB/h on
  the core and +0.68 on the probe; a week should not look different in kind. `/values` is one
  reading, which cannot show a slope: read the history since the start reading, and judge the
  trend from the hourly averages, not from two points.

  ```bash
  curl -s -G -H "Authorization: Bearer $MS_TOKEN" \
    --data-urlencode "from=<start-reading-time>" --data-urlencode "resolutionSeconds=3600" \
    "localhost:8080/api/v1/sensors/<core-health-id>/history"
  ```

  `-G --data-urlencode` matters: a time written with an offset, `2026-10-04T13:44:34+00:00`,
  pasted straight into the URL has its `+` decoded as a space, and the range is refused. The
  alternative is a UTC time ending in `Z`, which needs no encoding: `date -u
  +%Y-%m-%dT%H:%M:%SZ` at the start reading prints one.

  **Leave the first hour after a restart out of it.** A restarted service is not at its settled
  size, and step 2 restarts both just before the start reading. In the dress rehearsal the
  restarted core read about 306 MB in the minutes after it (305.7 at the start reading, 306.3
  the highest five-minute sample), and about 150 MB within ten minutes
  (`findings/2026-10-04-field-test-dress-rehearsal.md`). A slope fitted from the start reading
  measures the settling, not the week.
- **`schedulerLag`** — p95 against the 1,000 ms budget.
- **`spoolDropped`, `evictedChunks`** — both must still be zero.
- **Sensor states.** Every Down should correspond to a device that was actually down. A Down that
  nobody can explain is the finding.
- **`workerCrashes`** — above zero names a check type that fell over on a real device, which is
  precisely what a simulator would not have shown you.
- **`sessionsOpen` against `sessionsEvicted`** — the pair, not either alone. A steady `open` with
  `evicted` climbing is a probe reopening sessions it just closed, because `idleMs` is shorter
  than your scan interval; on SSH that is a full handshake per check and it will show in
  `checkWait` before it shows anywhere else. A device that hangs sends its checks to more workers,
  each with its own sessions, so `open` rises during an outage and falls back within `idleMs` of
  the workers it no longer reaches going quiet (`P-256`). Still high an `idleMs` after the checks
  stopped is a finding.
- **The gate's channels, on every probe** (`P-432`), written down here before the week so that
  nobody judges them after it: six, at protocol 38; on a probe running `"system"` the five beside
  `nameResolverMode` gap, and `nameResolverMode` reads `1`. Only the trouble latch moves Probe
  Health's state (its lookup reads `1` as Warning, so step 3's Warning trigger on that probe's
  sensor delivers it); read the others. **The core stores a counter as a rate**, the difference
  between two readings over the time between them, per second, so `/values` and the history give
  no running total to subtract: each criterion on a channel below is on the hourly history since
  the start reading (the `curl` loop above, `resolutionSeconds=3600`), in the form the core
  stores, and an hour with no value is a gap the write-up explains. The counters are
  `nameCheckOnSeconds`, `namePassedStuck` and `nameHelperStuck`; `nameQuestionsOpen` is a
  reading; the other two are states, read as their numbers.

  **The rest is in the probe's log, not on Probe Health** (the user's decision of 2026-10-18,
  `P-467`): the helper's changes of state, its losses and its resident memory, the check's state
  and why, and the lookups heard, asked in the helper, missed and deferred. The probe logs each
  as it happens, and once an hour one summary line, `the probe’s resolver in gate mode, this
  hour`, whose fields the
  [administration guide](administration.md#the-gate-a-lookup-helper-for-the-names-dns-answers-probenameresolver)
  lists. Read both on each probe's host, from the start reading's time written as `journalctl`
  takes it (`2026-10-04 13:44:34 UTC`), and keep the files with the write-up:

  ```bash
  SINCE='<start-reading-time, as 2026-10-04 13:44:34 UTC>'
  # One line an hour: the criteria below read its hour, check and helper fields.
  sudo journalctl -u ms-probe --since "$SINCE" --no-pager -o cat \
    | grep -F 'in gate mode, this hour' > gate-hours.jsonl
  wc -l gate-hours.jsonl                     # one an hour since the probe started, no gap
  # Every warning and error of the resolver, the helper, the check and the name settings.
  sudo journalctl -u ms-probe --since "$SINCE" --no-pager -o cat \
    | grep -E '"component":"(lookup-helper|dns-check|system-names|name-resolver)"' \
    | grep -E '"level":"(warn|error)"' > gate-events.jsonl
  ```

  Each line is JSON, and some keys are on it more than once. The hour's counts are in `hour`;
  the `lookupsHeard`, `lookupsToHelper`, `misses`, `walksDeferred`, `passedStuck` and
  `helperStuck` beside it are running totals since the probe started, `check` has its own
  `misses`, and `walksDeferred` has a `total` before the helper's `losses` do. So read a field by
  the object that holds it. Each `grep -o` below prints one match a line of the file, so one an
  hour in order (`off` only in the hours the check is off), and the last prints, whole, the hours
  that list a loss:

  ```bash
  grep -o '"hour":{[^}]*}' gate-hours.jsonl           # this hour's counts
  grep -o '"check":{"state":[0-9]*' gate-hours.jsonl  # the check's state as the hour ended
  grep -o '"off":{[^}]*}' gate-hours.jsonl            # why the check is off: code and why
  grep -o '"rss":[0-9a-z]*' gate-hours.jsonl          # the helper's memory in bytes, or null
  grep -o '"losses":{[^}]*}' gate-hours.jsonl         # its losses since the start, and total
  grep -o '"changes":\[[^]]*]' gate-hours.jsonl       # this hour's changes of its state
  grep -vF '"lost":[]' gate-hours.jsonl               # the hours that list a loss, whole
  ```

  - `lookupHelperTrouble` is `0` throughout: every hour's `max` is `0`. Each Warning, and any
    time the probe's log says the lookup helper ran out of memory, is a finding, explained by the
    probe log's `lookup helper` lines.
  - **No loss and no rest.** Every hour's summary lists no loss, `"lost":[]` in its `helper`,
    and its `losses` `total` is the same as the first hour's, or each loss it lists matches a
    loss the probe's log explains, with its reason. Each loss is one `the lookup helper was lost`
    line, with its `reason` and its `signal` or `exitCode`, which the summary lists with it. Only
    a crash signal (SIGSEGV, SIGBUS, SIGABRT, SIGILL, SIGFPE, SIGTRAP or SIGSYS) is held against
    a name (`P-453`); when it is, the probe also logs `asking getaddrinfo for <name> made the
    lookup helper fail` once, and that name, with the crash line, is a finding to bring back. A
    `SIGKILL` names who sent it in `killedBy` on its line (`P-469`): `probe` is the probe's own
    kill, for the `why` on the line; `itself` the child ending itself after the line's `fatal`;
    `outside` the kernel's OOM killer or a cgroup kill, which `journalctl -k` names, or a person,
    and only for `outside` is `journalctl -k` the place to look. And `reason` `memory` is the
    helper's own 256 MiB bound, which the summaries' `rss` shows climbing to: none is held
    against a name, and each is still a finding with its reason. **The summaries' `changes`
    pass when they list these and nothing else.** The first summary after a start lists the
    helper's own start, `idle` → `starting` → `up`, with no loss. Each loss listed is a move to
    `backoff` with its `loss`, then back: `up` → `backoff` → `starting` → `up` for an `exit` or
    `memory` loss, `up` → `unresponsive` → `backoff` → `starting` → `up` for a child that
    stopped answering first, as a `hung` one always has, and `starting` → `backoff` →
    `starting` → `up` for a `start` loss, a child that never came up. A loss late in an hour has
    its moves back in the next hour's summary. Anything else in `changes` is a finding: `up` →
    `unresponsive` → `up` with no loss, a helper that stopped answering and answered again,
    which `gate-events.jsonl` has as `the lookup helper is not answering`; a `starting` with no
    loss or start before it; and a `resting`, which, like a `the lookup helper is resting` line
    or a `3` in `nameResolverMode`, is a rest.
  - **A quiet helper** (`P-463`). Each `the lookup helper is not answering` line is a finding,
    explained by the host's load at its time, and recorded with its `keptOffNow`: every name
    kept off the probe's own lanes then, those in flight at that quiet (`keptOff`) and those of
    every earlier quiet or loss whose ten minutes after the helper was next up have not run.
    While the helper does not answer, the check of each one fails at once unless an answer is
    kept for it. A quiet the child comes back from is not a loss, so it never rests the helper,
    and `keptOffNow` grows with how often the child goes quiet. The line is said at most once a
    minute. The quiets between are counted on the next line, or as the probe stops on `the
    lookup helper is stopping: the times it was not answering since it last said so`
    (`alsoNotAnswering`, with what they detached and kept off, `alsoDetached` and
    `alsoKeptOff`).
  - **What a quiet helper cost is in the gate's summary**, `the probe’s resolver in gate mode,
    this hour`, said every hour whatever the lines said, and once more as the probe stops, for
    the part of the hour since the last, with `stopping: true`. `checksFaulted` is the checks the
    gate failed at once since the summary before, each for a name kept off the probe's lanes
    while the helper was not answering or rested, or for a poison name, which its crash line
    names; a "Check now" served its kept answer is not one. `routed.faulted` counts lookups, not
    checks: one for each lookup the gate refused, however many checks waited for it, so a
    refresh nobody waited for is one, and it can be above `0` in an hour no check failed. What
    the stop itself fails, after the check pool has drained, comes after the stop's summary and
    is in none. Under `helper`, `quiets` and `msInState.unresponsive` count the quiets and the
    time not answering since that probe started, and `keptOffPeak` is the most names kept off at
    once since then: each start of `ms-probe` begins them at `0` again.
    - Record the week's sum of `checksFaulted` over every summary up to the end reading, the
      stops' included; its quiets, as the sum over each start of the last summary that start
      said before the end reading, a start that said none adding none; and the highest
      `keptOffPeak` of any of them. They are the measure of what keeping names off costs
      (`P-463`'s decision). A start is its `probe.nameResolver is gate` line (step 1), and each
      summary is the start's above it. On each probe's host, every start and summary in the order
      they were said, across reboots:

      ```bash
      sudo journalctl -u ms-probe --since "<the day of step 2's restart, as 2026-10-04>" \
        -o short-iso --no-pager \
        | grep -F -e 'probe.nameResolver is gate' -e 'resolver in gate mode, this hour'
      ```

      The week's starts are step 2's restart and every one after it. The list holds an earlier
      boot only where the journal is kept on disk (`/var/log/journal`): `journalctl --list-boots`
      lists the boots it holds, and a boot of the week missing from it is a time the write-up
      leaves uncounted.
    - A start whose summaries do not end with a `stopping` one, none at all included, ended
      without stopping (killed, crashed, or the host lost power): what it counted since its last
      summary, or since its start line if it said none, was never said, up to an hour. The
      write-up names each such end by its start line's time, with the time it leaves uncounted,
      the `the lookup helper is not answering` lines in that time (each a quiet no summary holds,
      and its `alsoNotAnswering` more), and the sensors whose checks failed at once in it, found
      by their messages as below. The start running at the end reading is not an end: its counts
      are its summaries before the end reading, and the `stopping` one the drill's stop says is
      not the week's.
    - Each summary with `checksFaulted` above `0` is a finding, with the sensors whose checks
      failed at once, whose messages say the probe `does not ask its own getaddrinfo` for the
      name.
    - Neither `routed.faulted` nor a sum of the lines' `keptOff` is the measure: a refresh
      refused is not a check failed, and a lookup in flight across two quiets is counted at each.
  - `namePassedStuck` (lookups a second) is `0` throughout: every hour's `max` is `0`. Each one
    is a lookup the gate sent to the probe's own lanes that then ran past 1 s, and is explained
    from the log line naming its host, or it is a finding.
  - **No misses, and the check on.** Every hour's summary reads `"misses":0` in its `hour`, or
    each hour above it is explained from the probe log's line naming the name and zone the check
    skipped (`the DNS check missed a name`). Its `check` reads `"state":1` (on) in every hour
    after the first. A `4` is a stand-down after misses, and so is any `the DNS check missed
    names in three zones` line, at `error`, though the hour's summary says `1` again: a finding
    with the zones it names. A `2` is the check off for the host's settings, with the rule that
    turned it off in the summary's `off` (`code` and `why`), from the start line or the line
    that moved it.
  - `nameCheckOnSeconds` (a counter of seconds, so seconds a second: `1` while the check is on
    and the helper up) averages at least `0.95` over the week: the mean of every hour's `avg`
    since the start reading. Less, and the write-up says the check was not tested for that share
    of the week, and why, from the start line and the log.
  - **A log line during the week saying the check is off until `ms-probe` restarts is a
    finding: record it, and do not restart to clear it**, which is an intervention. It means a
    file the probe reads only at start changed under it (`resolv.conf`, `nsswitch.conf`,
    `gai.conf`, `/etc/ld.so.preload`, the hostname's domain or an NSS module; on Ubuntu, most
    likely `systemd-resolved` rewriting its stub after a DHCP lease or netplan changed the search
    domains), and every name goes to the helper from then on. The line names the file and when,
    the summaries' `check` reads `"state":2` and `nameCheckOnSeconds` falls short from that hour.
  - `nameHelperStuck` (lookups a second) is recorded, not judged: the hours whose `max` is above
    `0`, each a lookup that `"system"` would have held one of the probe's own lanes for. So are
    each hour's summary's `lookupsHeard` and `lookupsToHelper` in its `hour`, as the hour's share
    of the two, and its `walksDeferred`, whose hours above `0` the probe's log says the reason
    for (`the DNS check is deferring walks to the lookup helper`, with its `why`).
  - `nameQuestionsOpen` (the highest since the last heartbeat the core acknowledged) is recorded
    as the highest hourly `max` at each reading, beside the release notes' bound (about 24 in an
    outage, 40 at most).
  - **The helper's memory**, each hour's summary's `rss` in its `helper`, in bytes at the
    child's last beat. Flat is the pass, judged as `memory` is, from the hourly values, with the
    first hour after a restart or a loss left out. A `null` is an hour that ended with no child,
    which that hour's `lost` must explain.
- **`lookupsGivenUp` and `lookupsGivenUpRecently`, on every probe** (`P-426`, `P-441`).
  `lookupsGivenUp` is a counter, so lookups a second: at each reading, the hours since the start
  reading whose `max` is above `0`, from the same hourly history, each explained from the
  probe's log (the name and its zone). `lookupsGivenUpRecently` counts the same checks over the
  last five minutes and puts Probe Health in Warning from 100, with up to three of the domains
  not answering in its message, which step 3's Warning trigger delivers: each such Warning is a
  DNS outage the write-up explains, in either mode, and not a fault of the probe. Record
  `answersLoaded` once, after step 2's restart, and the highest hourly `max` of
  `lookupsInFlight` beside it.

### After the end reading: the gate drill (`P-432`)

**Not part of the week, and not a condition of `H-09`**: an intervention, so it starts only after
the end reading is taken. A clean week shows that the gate did no harm; it cannot show that the
gate helps, because a week with no DNS outage never routes a name to the helper for the reason
the gate exists. **The drill is the case `"system"` does not cover.** With one zone silent,
`"system"` already keeps the zones that answer answered, cold or restarted from its answer file
(`P-438`: none of the answering zone's 31,500 checks given up either way,
[the third finding](findings/2026-10-19-name-lookups-answer-file-and-lanes.md)), so a drill of
one zone would pass in both modes and tell them apart in nothing. What only the gate covers is
two zones silent at once after a restart with nothing kept, where the two can take all four of
`"system"`'s first lanes between them. So the drill needs devices in at least three DNS zones,
and runs on the same installation once with `"gate"` and once with `"system"`:

1. Pick two DNS zones that some of the devices are in, and make the site's resolver drop both
   zones' questions without answering (a blackhole, not a refusal). Note the time.
2. Restart the probe that serves those devices with nothing kept: stop it, which writes its
   answer file, move the file out of its spool directory (`probe.spoolDir`,
   `/var/lib/ms-probe/spool` unless set; the file would answer the zones that answer from the
   first scan, which is `P-438`'s case and not this one), then start it, and add one new device
   in a zone that still answers:

   ```bash
   sudo systemctl stop ms-probe
   sudo mv /var/lib/ms-probe/spool/name-answers.json /root/name-answers.json.drill
   sudo systemctl reset-failed ms-probe
   sudo systemctl start ms-probe
   ```

   Probe Health's `answersLoaded` then reads `0`; anything else, and the restart kept something.
3. Wait two scan intervals, then record every sensor state change since the zones went silent,
   from `GET /api/v1/state-log`, the gate's Probe Health channels above, and the probe's log
   since the time you noted:

   ```bash
   sudo journalctl -u ms-probe --since '<the time noted at 1, as 2026-10-04 13:44:34 UTC>' \
     --no-pager -o cat | grep -E '"component":"(lookup-helper|dns-check|name-resolver)"'
   ```

   The hourly summary is not part of the pass. Under `"system"` there is none. Under `"gate"`
   the first, `the probe’s resolver in gate mode, this hour`, is logged an hour after step 2's
   restart, and the restart at step 4 would stop the probe before it is: to keep it, restore
   both zones, wait until an hour has passed since step 2, and run the same command again
   before step 4's restart. That summary covers the restore too.
4. Restore both zones, set the other mode in that probe's `probe.json`, and repeat from 1: step
   2's restart applies it.

The pass: under `"gate"`, no sensor on a device in a zone that answers changes state, the new
device's sensors come Up at their first scan, and `lookupHelperTrouble` stays `0`. Under
`"system"`, expect the answering zones' first checks to be given up while the two silent zones'
first lookups hold all four lanes: that is what `P-438`'s outage scenario asserts for the same
restart with no file (`name-lookup-outage-scenario.test.ts`). If they are not given up under
`"system"`, the drill did not reach the case, and the write-up says so rather than reading the
two runs as alike. Put both records in the write-up. If the gate has to come off during the week
instead, that is an intervention and the week has failed: set `"system"`, restart the probe
after `reset-failed`, and record why.

## 5. What counts as a failure

- Any intervention. If you had to restart, reconfigure or clear something, the run failed and the
  reason is the finding.
- Memory growth that would not fit the hardware over a quarter.
- A sensor that stopped reporting without its state saying so.
- An alarm storm from one outage — `M-17`'s scenario tests cover the cases we thought of, and a
  hundred real devices is where the ones we did not think of live.

## 6. Write it up

`docs/findings/<date>-field-test.md`, in the shape the other findings use: what was measured, on
what, the numbers, and what was *not* covered. File every defect as its own ticket rather than
folding them into the writeup — `P-25` through `P-28` all came out of Phase 10 that way, and each
was worth more as a ticket than as a paragraph.

Tick `H-09` only if the week ran clean. A field test that found things and got them fixed is a
successful field test and an unmet exit criterion; those are different facts and the plan should
carry both. `H-09` is the Linux week; the Windows week is `H-17`, below, and neither ticks the
other.

---

## Release 1.1 — the Windows half (`H-17`)

**Not part of 1.0.** These are the Windows steps of the procedure above, moved here on 2026-09-28
(`H-16`) when 1.0 became Linux-only, and kept as they were. Run them on a 1.1 candidate, once
`H-06` (the MSI), `S-11` (TimescaleDB on Windows) and `T-25` (the `windows.*` queries against
Windows) have landed. Steps 2 to 6 above apply as written, with what follows added to them.

| | Last verified | How |
| --- | --- | --- |
| MSI installs on Windows | **never** | CI's `windows-install` job, which has not run (`H-06`) |

### Before you start

- **A Windows Server host.** Note what this is and is not: `windows-latest` on GitHub Actions is
  Windows Server 2022, and `H-06`'s `windows-install` job installs the MSI there — so the
  *installer* has a machine that can prove it, whenever CI is running. What it cannot reach is
  this runbook: a hundred real devices for a week is hardware and wall-clock, not a job. If that
  job has still never run when you start, then this is the first time the MSI is installed
  anywhere, and you should expect to find things — file them rather than patching around them.
- Among the devices, **Windows servers monitored over WMI**, from a probe on Windows — the four
  `windows.*` types, which the Linux test cannot reach.

### Install

Windows Server, elevated:

```powershell
msiexec /i ms-<version>-x64.msi /l*v install.log
```

**Keep `install.log`.** The MSI has not been installed before, and if it fails, that log is the
finding. Check afterwards that the services registered and the firewall rules exist:

```powershell
Get-Service ms-core, ms-probe
Get-NetFirewallRule -DisplayName 'MonitoringSystem *'
```

### Restart

Repeat step 2 on Windows: restart both services once the devices are added, and check Probe
Health the same way. Anything that only breaks on restart is invisible to every other test.

---

## Appendix: the candidate’s surface

**What the v1 candidate is, and what this runbook is a test of** (`H-13`). The two tables are
compared with a v1 core in both directions by `packages/core/test/candidate-surface.test.ts`.
A build that answers a route not listed here fails that test, and so does one that no longer
answers a route that is listed. The same goes for sensor types. Change the build and this table
together, or the suite goes red.

**The routes**, found by asking a v1 core, not by reading the OpenAPI document (which does not
list `/api/v1/stream`). *Without a credential* is what that core answers to a request with no
session and no token: `401`, or **public** for the three routes that let a user log in. Nothing
under `/api/` or at `/metrics` answers anything else. The web UI's own files are also served
without a credential; they are public by design, carry no data, and are not listed. A
`{parameter}` is part of the path.

There are no maps, reports, libraries or `/api/v1/public/` routes. Those are v2, and the v1
build does not construct them (`H-12`).

| Route | Methods | Without a credential |
| --- | --- | --- |
| `/api/v1/accounts` | GET | 401 |
| `/api/v1/accounts/{id}/groups` | GET | 401 |
| `/api/v1/accounts/{id}/primary-group/{groupId}` | PUT | 401 |
| `/api/v1/alarms` | GET | 401 |
| `/api/v1/audit` | GET | 401 |
| `/api/v1/auth/login` | POST | **public** |
| `/api/v1/auth/logout` | POST | **public** |
| `/api/v1/auth/me` | GET | 401 |
| `/api/v1/auth/mfa` | GET | 401 |
| `/api/v1/auth/mfa/confirm` | POST | 401 |
| `/api/v1/auth/mfa/disable` | POST | 401 |
| `/api/v1/auth/mfa/enrol` | POST | 401 |
| `/api/v1/auth/mfa/recovery-codes` | POST | 401 |
| `/api/v1/auth/password` | POST | 401 |
| `/api/v1/auth/session` | GET | **public** |
| `/api/v1/auth/tokens` | GET · POST | 401 |
| `/api/v1/auth/tokens/{id}` | DELETE | 401 |
| `/api/v1/build` | GET | 401 |
| `/api/v1/channels/without-lookup` | GET | 401 |
| `/api/v1/core-health` | GET | 401 |
| `/api/v1/credential-kinds` | GET | 401 |
| `/api/v1/credentials/unbounded` | GET | 401 |
| `/api/v1/device-templates` | GET | 401 |
| `/api/v1/device-templates/plan` | POST | 401 |
| `/api/v1/device-templates/{templateId}` | GET | 401 |
| `/api/v1/discovery` | POST | 401 |
| `/api/v1/discovery/preview` | POST | 401 |
| `/api/v1/discovery/schedules` | GET · POST | 401 |
| `/api/v1/discovery/schedules/{id}` | PATCH · DELETE | 401 |
| `/api/v1/discovery/schedules/{id}/enabled` | POST | 401 |
| `/api/v1/discovery/{id}` | GET | 401 |
| `/api/v1/discovery/{id}/cancel` | POST | 401 |
| `/api/v1/discovery/{id}/hosts` | GET | 401 |
| `/api/v1/discovery/{id}/plan` | GET | 401 |
| `/api/v1/discovery/{id}/problems` | GET | 401 |
| `/api/v1/discovery/{id}/provision` | POST | 401 |
| `/api/v1/discovery/{id}/summary` | GET | 401 |
| `/api/v1/groups` | GET · POST | 401 |
| `/api/v1/groups/{id}` | PUT · DELETE | 401 |
| `/api/v1/groups/{id}/members` | GET | 401 |
| `/api/v1/groups/{id}/members/{userId}` | PUT · DELETE | 401 |
| `/api/v1/lookups` | GET | 401 |
| `/api/v1/lookups/{id}` | GET | 401 |
| `/api/v1/notification-health` | GET | 401 |
| `/api/v1/notification-methods` | GET | 401 |
| `/api/v1/notification-placeholders` | GET | 401 |
| `/api/v1/notification-requests` | GET | 401 |
| `/api/v1/objects` | GET · POST | 401 |
| `/api/v1/objects/bulk` | POST | 401 |
| `/api/v1/objects/counts` | GET | 401 |
| `/api/v1/objects/root` | GET | 401 |
| `/api/v1/objects/tops` | GET | 401 |
| `/api/v1/objects/tree` | POST | 401 |
| `/api/v1/objects/{id}` | GET · PATCH · DELETE | 401 |
| `/api/v1/objects/{id}/access` | GET | 401 |
| `/api/v1/objects/{id}/access/effective` | GET | 401 |
| `/api/v1/objects/{id}/access/{groupId}` | PUT · DELETE | 401 |
| `/api/v1/objects/{id}/acknowledge` | POST · DELETE | 401 |
| `/api/v1/objects/{id}/ancestors` | GET | 401 |
| `/api/v1/objects/{id}/as-template` | POST | 401 |
| `/api/v1/objects/{id}/audit` | GET | 401 |
| `/api/v1/objects/{id}/channels` | GET | 401 |
| `/api/v1/objects/{id}/channels/{key}` | PATCH | 401 |
| `/api/v1/objects/{id}/clone` | POST | 401 |
| `/api/v1/objects/{id}/counts` | GET | 401 |
| `/api/v1/objects/{id}/credentials` | GET | 401 |
| `/api/v1/objects/{id}/credentials/{kind}` | PUT · DELETE | 401 |
| `/api/v1/objects/{id}/dependency` | PUT | 401 |
| `/api/v1/objects/{id}/discovery` | GET | 401 |
| `/api/v1/objects/{id}/move` | POST | 401 |
| `/api/v1/objects/{id}/order` | POST | 401 |
| `/api/v1/objects/{id}/pause` | GET · POST · DELETE | 401 |
| `/api/v1/objects/{id}/settings` | GET | 401 |
| `/api/v1/objects/{id}/settings/{key}` | PUT · DELETE | 401 |
| `/api/v1/objects/{id}/simulate-error` | POST · DELETE | 401 |
| `/api/v1/objects/{id}/target-policy-exception` | PUT | 401 |
| `/api/v1/objects/{id}/tree` | GET | 401 |
| `/api/v1/objects/{id}/triggers` | GET · POST | 401 |
| `/api/v1/openapi.json` | GET | 401 |
| `/api/v1/probes` | GET | 401 |
| `/api/v1/probes/{gid}` | DELETE | 401 |
| `/api/v1/probes/{gid}/allow-from` | PUT | 401 |
| `/api/v1/probes/{gid}/approve` | POST | 401 |
| `/api/v1/probes/{gid}/certificate` | PUT | 401 |
| `/api/v1/probes/{gid}/revoke` | POST | 401 |
| `/api/v1/probes/{id}/health` | GET | 401 |
| `/api/v1/schedules` | GET · POST | 401 |
| `/api/v1/schedules/{id}` | GET · PUT · DELETE | 401 |
| `/api/v1/sensor-types` | GET | 401 |
| `/api/v1/sensor-types/{id}/channels` | POST | 401 |
| `/api/v1/sensor-types/{id}/preview` | POST | 401 |
| `/api/v1/sensors/{id}/check` | POST | 401 |
| `/api/v1/sensors/{id}/history` | GET | 401 |
| `/api/v1/sensors/{id}/state` | GET | 401 |
| `/api/v1/sensors/{id}/values` | GET | 401 |
| `/api/v1/setting-definitions` | GET | 401 |
| `/api/v1/state-log` | GET | 401 |
| `/api/v1/stream` | GET | 401 |
| `/api/v1/summarisation-modes` | GET | 401 |
| `/api/v1/templates` | GET · POST | 401 |
| `/api/v1/templates/preview` | POST | 401 |
| `/api/v1/templates/{id}` | GET · PUT · DELETE | 401 |
| `/api/v1/templates/{id}/preview` | GET | 401 |
| `/api/v1/templates/{id}/test` | POST | 401 |
| `/api/v1/templates/{id}/used-by` | GET | 401 |
| `/api/v1/trigger-kinds` | GET | 401 |
| `/api/v1/triggers/{id}` | PUT · DELETE | 401 |
| `/metrics` | GET | 401 |

**The sensor types.** Every built-in type is listed, with whether the candidate carries it.
`flow.netflow` is not carried because flow monitoring is v2 (`V2-01`). The four `windows.*` types
are not carried because they run PowerShell on a Windows probe, and 1.0 is Linux-only: Windows is
release 1.1. A core offers only what it carries, and a v1 probe assigned a type it does not carry
refuses it by name.

| Sensor type | In the candidate |
| --- | --- |
| `core.factory` | yes |
| `db.mssql` | yes |
| `db.mysql` | yes |
| `db.postgresql` | yes |
| `dns.blocklist` | yes |
| `dns.record` | yes |
| `exe.script` | yes |
| `exe.script.advanced` | yes |
| `flow.netflow` | **no** |
| `http.advanced` | yes |
| `http.content` | yes |
| `http.request` | yes |
| `http.transaction` | yes |
| `icmp.jitter` | yes |
| `icmp.ping` | yes |
| `mail.imap` | yes |
| `mail.pop3` | yes |
| `mail.roundtrip` | yes |
| `mail.smtp` | yes |
| `ms.core.health` | yes |
| `ms.probe.health` | yes |
| `port.range` | yes |
| `port.tcp` | yes |
| `rest.custom` | yes |
| `snmp.cpu` | yes |
| `snmp.custom` | yes |
| `snmp.custom.string` | yes |
| `snmp.diskfree` | yes |
| `snmp.memory` | yes |
| `snmp.table` | yes |
| `snmp.traffic` | yes |
| `snmp.trap` | yes |
| `snmp.uptime` | yes |
| `ssh.diskfree` | yes |
| `ssh.load` | yes |
| `ssh.meminfo` | yes |
| `ssh.script` | yes |
| `syslog.receiver` | yes |
| `tls.certificate` | yes |
| `tls.security` | yes |
| `windows.cpu` | **no** |
| `windows.memory` | **no** |
| `windows.service` | **no** |
| `windows.volume` | **no** |
