# Release candidate field test (H-09)

`PLAN.md` Phase 10's exit criterion:

> A clean install on Ubuntu and on Windows Server, monitoring 100 real devices for a week without
> intervention.

This is the procedure for running it. It exists because the test needs hardware and a week of
wall-clock that no CI job has, and a test that has to be designed before it can be run is a test
that gets run badly or not at all.

**What is already proved, so you do not re-prove it:**

| | Last verified | How |
| --- | --- | --- |
| Clean install on Ubuntu | **2026-09-03, locally** | `MS_SMOKE_DISTRO=ubuntu scripts/smoke-install.sh` |
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

**What this runbook adds is what those cannot reach**: Windows Server, real devices that answer
in ways a simulator does not, and a week of unattended running.

---

## Before you start

- **A Windows Server host.** `H-06` builds an MSI that has never been installed; this is the
  first time it runs. Expect to find things, and file them rather than patching around them.
- **An Ubuntu host** for the core, unless you are testing the Windows core.
- **100 devices you did not choose for being easy.** A field test against a hundred identical
  Linux VMs proves the scheduler and nothing about the sensor catalogue. Aim for a spread: some
  switches, some Windows servers, some appliances with slow SNMP agents, at least one device
  behind a firewall that drops rather than refuses, and at least one that is intermittently
  unreachable on purpose.
- **A week you are not going to touch it.** "Without intervention" is the criterion. Restarting a
  service to see whether that helps ends the run.

## 1. Install

Ubuntu core, from the package rather than the tarball — that is what an operator uses:

```bash
sudo dpkg -i ms_<version>_amd64.deb
```

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

Repeat on Windows. **Anything that only breaks on restart is invisible to every other test we
have**, which is exactly why it is step 2 and not an afterthought.

## 3. Set the alarms that make "without intervention" observable

The point of a week unattended is that nothing needs doing — which you can only claim if
something was watching. Set notification triggers on:

| Channel | Sensor | Why |
| --- | --- | --- |
| `evictedChunks` | Core Health | above zero means data was dropped early to stay on disk |
| `spoolStalled` | Probe Health | the link is up and results are not moving (`P-27`) |
| `spoolDropped` | Probe Health | results lost because the spool filled |
| `alarmOverdue` | Core Health | the alarm sweep stopped; everything downstream is stale |
| `notifyOldest` | Core Health | notifications queued and undelivered |
| `probesDown` | Core Health | a probe is not connected |

These all ship with declared limits (`S-18`), so the thresholds are already right; what you are
adding is delivery.

## 4. Run for a week, and record

Take a reading at the start, at 24 h, and at the end:

```bash
curl -s localhost:8080/api/v1/sensors/<core-health-id>/values
curl -s localhost:8080/api/v1/sensors/<probe-health-id>/values
```

The numbers that decide the criterion:

- **`memory` on both health sensors.** Flat is the pass. The 24-hour soak measured +1.10 MB/h on
  the core and +0.68 on the probe; a week should not look different in kind.
- **`schedulerLag`** — p95 against the 1,000 ms budget.
- **`spoolDropped`, `evictedChunks`** — both must still be zero.
- **Sensor states.** Every Down should correspond to a device that was actually down. A Down that
  nobody can explain is the finding.
- **`workerCrashes`** — above zero names a check type that fell over on a real device, which is
  precisely what a simulator would not have shown you.

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
carry both.
