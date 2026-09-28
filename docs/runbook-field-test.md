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
| Clean install on Ubuntu | **2026-09-28, locally** | `MS_SMOKE_DISTRO=ubuntu scripts/smoke-install.sh` |
| Clean install on Debian | 2026-09-03, locally | `scripts/smoke-install.sh` |
| `.deb` and `.rpm` install, upgrade, remove | 2026-09-03, locally | `scripts/smoke-packages.sh` |
| Backup and restore onto a different host | 2026-09-03, locally | `scripts/smoke-restore.sh` |
| 5,000 sensors for 24 h | 2026-08-30 | `docs/findings/2026-08-30-soak-24h.md` |

> **"Last verified" is a date, not a guarantee, and that is deliberate.** These four used to read
> "in CI", which stopped being true the moment the workflow was disabled — a table telling you
> not to re-prove something, on the strength of a job that is not running, is worse than no table.
> They are one command each and they take minutes. **Re-run all four against the build you are
> about to field-test**, rather than trusting this row, and update the date. If CI is running
> again by then, say so here and the rule can go back to trusting it.

**What this runbook adds is what those cannot reach**: real devices that answer in ways a
simulator does not, and a week of unattended running.

> **Say which build you are testing, and mean it.** This runbook was written when `main` was v1
> plus `H-06`. It is not any more: flow monitoring (Phase 11) and maps (Phase 12) have landed on
> the same branch, there is no v1 tag, and a build cut from `main` today carries a UDP listener
> and a public share-link surface that the Phase 10 exit criterion never contemplated. Either cut
> the release candidate from a commit you can name and field-test *that*, or accept the v2
> subsystems into the test and read the extra section in step 3. Field-testing "whatever `main`
> was that morning" is how a week produces a result nobody can attribute.

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
sudo dpkg -i ms_<version>_amd64.deb
```

## 2. Restart everything, once, before you start counting

**This step exists because of `P-28`.** A probe at the v1 target could never reconnect: the core
sent a configuration too large for one message, the probe rejected it, and it looped — 426 times
in three minutes — with the core logging only "link to core closed". A 24-hour soak with the same
5,047 sensors never saw it, because the probe never restarted during the run.

So restart both services deliberately, after the devices are added, and confirm the probe comes
back:

```bash
sudo systemctl restart ms-core ms-probe
```

Then check `connected` on Probe Health, and that `scheduled` matches what the core assigned. A
probe that is connected but scheduling nothing is the shape that defect took.

**Anything that only breaks on restart is invisible to every other test we have**, which is
exactly why it is step 2 and not an afterthought.

## 3. Set the alarms that make "without intervention" observable

The point of a week unattended is that nothing needs doing — which you can only claim if
something was watching.

**There are two kinds of trigger and the difference decides how many you create.** A *state*
trigger is attached to a sensor and fires when that sensor enters a state; a *threshold* trigger
is attached to a channel and carries its own value, without changing the sensor's state (`M-04`).
A channel with a declared limit already moves its sensor's state, so a state trigger picks it up;
a channel without one never will, whatever it reads.

| Channel | Sensor | Declared limit? | Why it matters |
| --- | --- | --- | --- |
| `evictedChunks` | Core Health | yes | above zero means data was dropped early to stay on disk |
| `spoolStalled` | Probe Health | yes | the link is up and results are not moving (`P-27`) |
| `spoolDropped` | Probe Health | yes | results lost because the spool filled |
| `alarmOverdue` | Core Health | yes | the alarm sweep stopped; everything downstream is stale |
| `notifyOldest` | Core Health | yes | notifications queued and undelivered |
| `sessionOverflows` | Probe Health | yes | SNMP or SSH sessions opened past the pool bound (`P-36`) — sustained, this is a probe heading for `EMFILE`, and a week is long enough to get there |
| `probesDown` | Core Health | **no** | a probe is not connected |

**So six of the seven need no threshold at all.** Their limits ship declared (`S-18`), which means
Core Health and Probe Health already go Down or Warning on their own; one *state* trigger on each
of those two sensors — Down and Warning, with a template that names the channel — delivers all six.
What you are adding is delivery, not thresholds.

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

### If the build carries flow monitoring (Phase 11)

Adding a `flow.netflow` sensor starts the probe's collector, and five counters on Probe Health
come with it: `flowReceived`, `flowRejected`, `flowMalformed`, `flowMissed` and `flowUndecodable`.
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

**`sessionOverflows` matters more here than anywhere else**, and it is why it was worth adding
before the field test rather than after. A hundred real devices with SNMP and SSH credentials is
the first workload this project has ever run that opens sessions in earnest, and the pools open
past their bound rather than fail a check — the right trade, and one nothing could see until
`P-36`. A simulator does not hold a session open for a week.

## 4. Run for a week, and record

Take a reading at the start, at 24 h, and at the end. **The API needs a token** — every route
but the public map prefix does — so make one first, from a signed-in session, and keep it for the
week:

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
libraries are not part of what this test is about.

The numbers that decide the criterion:

- **`memory` on both health sensors.** Flat is the pass. The 24-hour soak measured +1.10 MB/h on
  the core and +0.68 on the probe; a week should not look different in kind.
- **`schedulerLag`** — p95 against the 1,000 ms budget.
- **`spoolDropped`, `evictedChunks`** — both must still be zero.
- **Sensor states.** Every Down should correspond to a device that was actually down. A Down that
  nobody can explain is the finding.
- **`workerCrashes`** — above zero names a check type that fell over on a real device, which is
  precisely what a simulator would not have shown you.
- **`sessionsOpen` against `sessionsEvicted`** — the pair, not either alone. A steady `open` with
  `evicted` climbing is a probe reopening sessions it just closed, because `idleMs` is shorter
  than your scan interval; on SSH that is a full handshake per check and it will show in
  `checkWait` before it shows anywhere else.

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
