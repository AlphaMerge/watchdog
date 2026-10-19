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

- **Both ends run this build.** A remote probe is the `ms-probe` package of the same candidate,
  `ms-probe_<version>_amd64.deb` (or `.rpm`), checked against the record the same way. An older
  probe refuses the key and stays stopped (exit 78), and under an older core the gate's health
  never reaches Probe Health.
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

Nothing applies it but a restart. On the core's host step 2's restart does it; on a remote
probe's host restart that probe now, and do it again in step 2:

```bash
sudo systemctl reset-failed ms-probe
sudo systemctl restart ms-probe
sudo journalctl -u ms-probe -b --no-pager | grep -i 'name resolver'
```

The start line names the mode asked for and the mode in effect, and why. **`gate` asked and
`gate` in effect is the pass.** A check that is off names the first setting of the host it could
not vouch for, and asks every name in the lookup helper: still the gate, and the write-up says
which setting, since nothing the week records then tests the walk.
<!-- TODO(rc3-cut): P-432 S3 writes the start line (design p432-r2-final.md §5, "Logs"). Check
the grep and the words against the landed code, and run this block once against a packaged
probe before the week, as the dress rehearsal did for the rest of step 1. -->

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
Warning on their own. *State* triggers on those
two sensors deliver all eight: **two on each, one for Down and one for Warning**, because a state
trigger watches exactly one state. Give each a template whose body carries `%lastmessage`, which
names the channel. What you are adding is delivery, not thresholds.

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
recipients, and answers `"delivered": true` or the relay's error. A week with no alarm and a
broken relay looks exactly like a week with nothing to report.

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
<!-- TODO(rc3-cut): nameResolverMode and the five channels below are P-432 S3's (protocol 38,
the user's six-field set of 2026-10-18), named as the design names them. Check each name, value
and lookup against packages/sensors/src/types/probe-health.ts once S3 has landed. -->

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
- **The gate's five channels, on every probe** (`P-432`), written down here before the week so
  that nobody judges them after it. Only the trouble latch moves Probe Health's state (its
  lookup reads `1` as Warning, so step 3's Warning trigger delivers it); read the others. A
  counter is judged by its difference between two readings, not by its value:
  - `lookupHelperTrouble` is `0` throughout. Each Warning, and any time the probe's log says the
    lookup helper ran out of memory, is a finding, explained by the probe log's `lookup helper`
    lines.
  - `namePassedStuck` does not move: a lookup the gate sent to the probe's own lanes that then
    ran past 1 s. Each one is explained from the log line naming its host, or it is a finding.
  - `nameCheckOnSeconds` grows by at least 95% of what `uptime` grows by. Less, and the
    write-up says the walk was not tested for that share of the week, and why, from the start
    line and the log.
  - `nameHelperStuck` is recorded, not judged: each is a lookup that `"system"` would have held
    one of the probe's own lanes for.
  - `nameQuestionsOpen`'s highest value at each reading is recorded beside the release notes'
    bound (about 24 in an outage, 42 at most).
  - **The helper's memory**, at each reading, on each probe's host. Flat is the pass, judged as
    `memory` is; an elapsed time shorter than the probe's own means the helper was replaced, and
    that must match a loss in the probe's log:

    ```bash
    ps -o pid=,rss=,etimes= -p "$(pgrep -f 'ms-probe: lookups')"
    ```
  <!-- TODO(rc3-cut): the process title, the log's wording and the 95% rule are P-432 S3 and
  S6's (design §5, "The field test's record"). Check them against the landed code. -->

### After the end reading: the gate drill (`P-432`)

**Not part of the week, and not a condition of `H-09`**: an intervention, so it starts only after
the end reading is taken. A clean week shows that the gate did no harm; it cannot show that the
gate helps, because a week with no DNS outage never routes a name to the helper for the reason
the gate exists. So, on the same installation, once with `"gate"` and once with `"system"`:

1. Pick one DNS zone that some of the devices are in, and make the site's resolver drop its
   questions without answering (a blackhole, not a refusal). Note the time.
2. Restart the probe that serves those devices (`reset-failed`, then `restart`), and add one new
   device in the zone that still answers.
3. Wait two scan intervals, then record every sensor state change since the zone went silent,
   from `GET /api/v1/state-log`, and the six Probe Health channels above.
4. Restore the zone; set the other mode on that probe and restart it; repeat from 1.

The pass: under `"gate"`, no sensor on a device in the zone that answers changes state, the new
device's sensors come Up at their first scan, and `lookupHelperTrouble` stays `0`. Under
`"system"` some of them may not, which is the comparison the drill exists to make. Put both
records in the write-up. If the gate has to come off during the week instead, that is an
intervention and the week has failed: set `"system"`, restart the probe after `reset-failed`,
and record why.

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
