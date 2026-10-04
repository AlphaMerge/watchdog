# The field-test dress rehearsal — 2026-10-04 (H-15)

- **What this is**: `docs/runbook-field-test.md` followed end to end, as an operator would, on
  one Ubuntu 24.04 box against the development simulators. It is written in the shape of the
  runbook's step 6.
- **What it proves**: the procedure, and nothing about the product. Simulators are not "100 real
  devices", and three hours is not a week. **`H-09` is not ticked from this.** Endurance on this
  VM is `H-01`'s 24-hour soak at 5,047 sensors (`2026-08-30-soak-24h.md`).
- **The build**: **`v1.0.0-rc.2`**, installed from `ms_1.0.0~rc.2_arm64.deb`, SHA-256
  `e1f8123a4e81aa472842cee27050c27e14bb38afbad4012c8cf8d4a4ea60ac74`. That matches the cut
  record (`2026-10-04-v1-release-candidate-cut.md`), and it was checked again before the
  install. The installed core answered `GET /api/v1/build` with:

  ```json
  {"version":"1.0.0-rc.2","commit":"0a43b7bfbb705253e883050223790c9e271cf67a","dirty":false,
   "profile":"v1","lock":"sha256:571a99105d98701c689ea33d7626beadf01ce1500bca17938290a0ac2ef4bf45",
   "subsystems":{"maps":false,"reports":false,"libraries":false}}
  ```

  Every condition step 4 sets holds: a commit, clean, `v1`, nothing `true`, and a `lock`.

## On what

- **The host**: `ms-smoke:ubuntu` (`scripts/smoke/Dockerfile.ubuntu`), an arm64 image with
  systemd 255, PostgreSQL 17 from PGDG and TimescaleDB 2.30.1. It ran as one privileged systemd
  container, `ms-h15-box`, on the dev stack's network. It is the smoke-install box with two
  differences: it was installed from the `.deb` rather than the tarball, and it was labelled so
  that `ms_smoke_reap_orphans` would not remove it after an hour. PostgreSQL was provisioned with
  `scripts/smoke/provision-postgres.sh`, the operator's prerequisite.
- **The machine**: this project's Apple Silicon Mac, 8 CPUs, through Docker Desktop's VM
  (8 CPUs). No other heavy run of this project's was booked, but the machine was not quiet:
  - **The Mac**: at the start its 5- and 15-minute load was 7–8, from other projects'
    containers; its one-minute load was 5.4. Its five-minute samples then ran 1.3–10.4, at
    about 2.8 for half of them, with the peak at 14:03.
  - **The VM**: its one-minute load ran 0.18–11.95 over the sampler's 372 samples. It was
    above 8 CPUs from 14:28 to 14:30, with the peak at 14:29:10, from other work. See *Load*
    below.
- **The devices**: 31 sensors on 9 devices, all of them development simulators:
  - `target`: ICMP, HTTP, HTTP content, REST, TCP 22 with banner, SSH load, memory and disk,
    SNMP uptime, CPU, memory, traffic and disk, and SNMP traps.
  - `snmpsim`: SNMP uptime and `sysDescr`.
  - GreenMail: SMTP, IMAP, POP3 and a round trip.
  - MailHog as a relay: SMTP.
  - MariaDB and SQL Server (Azure SQL Edge): `SELECT 1`.
  - The syslog sender, by address.
  - `10.255.255.1`, an address that drops everything: ping and TCP 80.
  - The box itself: Core Health, Probe Health, its own PostgreSQL, and a syslog and a trap
    sensor that take any sender.

  Credentials were the dev stack's (`docker-compose.dev.yml`, `dev/target`). The SSH set was
  bound to the target's three host keys with strict checking.
- **The relay**: MailHog, `notifications.smtp.primary` = `mailhog:1025`, no TLS, no auth.
- **The compression**: **24 h → 1 h, the week → 3 h.** The "24 h" reading was taken one hour
  after the start reading, and the "end" reading three hours after it. The rest is the
  runbook's order, minus the wait.

## The steps, as run

Times are UTC. "Load" is the Mac's 1/5/15-minute load on 8 CPUs, then the VM's. Every row
also records both units' restarts and how many *Watchdog timeout* lines the journal held.
A sampler inside the box recorded the same every 30 s for the whole run.

| Time | Step | Load (Mac; VM) | Restarts | Watchdog kills |
| --- | --- | --- | --- | --- |
| 13:39:36 | Box up, PostgreSQL provisioned | 5.42 7.43 7.98; 2.16 3.00 4.17 | — | none |
| 13:39:41 | 1: `reset-failed` (*Unit not loaded*), then `dpkg -i` | (as above) | — | none |
| 13:39:51 | The package starts the core, which refuses: no database password, exit 78 | | 0 | none |
| 13:40:19 | installation.md §3: password, `config check` (both pass), `reset-failed`, restart | 4.72 7.00 7.79; 2.32 2.96 4.10 | 0 | none |
| 13:40:29 | `reset-failed`, `dpkg --configure -a`: `iF` → `ii`, both started | | 0 | none |
| 13:40–13:41 | First administrator (`mustChangePassword: true`); tokens `h15-setup` (full), `field-test` (read) | | | |
| 13:41 | installation.md §5: probe object created (id 2), probe approved, `local: true` | | | |
| 13:41:11 | Devices, credentials, sensors (31) | 5.31 6.78 7.66; 3.20 3.09 4.08 | 0 | none |
| 13:43–13:44 | `iputils-ping` installed: the box had no `ping` | | | |
| 13:44:02 | **2**: `reset-failed`, `restart ms-core ms-probe` (5 s) | 7.61 6.40 7.29; 0.97 2.06 3.51 | 0 | none |
| 13:44:19 | 2: Probe Health *connected, 29 sensors scheduled* | | | |
| 13:44:24 | **3**: template, 4 state triggers, the `probesDown` threshold, a test send | 7.77 6.55 7.33; 1.15 2.04 3.47 | 0 | none |
| 13:44:34 | **4**: T0. Build recorded; the start reading | 6.43 6.31 7.23; 0.97 1.95 3.42 | 0 | none |
| 13:45 | The appendix, against the installed core | | | |
| 14:44:59 | 4: the "24 h" reading (T0 + 1 h) | 3.58 2.75 2.91; 1.02 1.16 1.59 | 0 | none |
| 15:14:13 | The target paused for three minutes | 2.87 2.83 2.80; 0.75 0.81 0.91 | 0 | none |
| 15:17:13 | The target unpaused | 4.39 3.21 2.93; 1.44 1.04 0.97 | 0 | none |
| 16:45:09 | 4: the "end" reading (T0 + 3 h) | 6.37 3.89 3.31; 3.87 3.78 2.85 | 0 | none |
| 16:45:42 | Teardown: journal and sampler kept, box removed, simulators stopped | 6.37 4.16 3.43; 3.87 3.82 2.89 | 0 | none |

**Watchdog kills: none.** None in the journal, and none in the sampler's 372 samples from
13:39:35 to 16:45:22. Both main PIDs were the same from step 2 to the end (core 1877, probe
1900), with `NRestarts` 0.

**Load.** The VM's one-minute load peaked at 11.95 on 8 CPUs, at 14:29:10. The Mac's five-minute
samples peaked at 10.37, at 14:03:38. Both came from other work on the machine, and both are
well short of `P-220`'s 24 on 8 CPUs. So this run says nothing for or against `P-220`.

**Starts**: each unit is allowed five starts in ten minutes, and the sixth is refused.
`reset-failed` clears the count (`administration.md`, *Your own starts count too*, measured
it). The core started four times in under five minutes before the start reading: the package,
the restart after the password, `dpkg --configure -a`, and step 2. Each start after the
package's followed a `reset-failed`: `installation.md` §3's and step 2's by hand, and
`dpkg --configure -a`'s inside `ms-setup` (`deploy/setup.sh`, before its own restart). So at
step 2 each unit had used about one start of its five. The journal shows that each restart of
the core also restarted the probe (13:40:20, 13:40:34, 13:44:03), so both counts moved
together.

## The readings

Each reading is step 4's: `/values` of both health sensors with the `read` token. They were
taken at 13:44:38 (start), 14:45:00 ("24 h") and 16:45:10 ("end"). Rates are per second.

| Channel | Start | "24 h" | "End" |
| --- | --- | --- | --- |
| Core Health `memory` (MB) | 305.7 | 152.7 | 157.9 |
| Core Health `heap` (MB) | 52.8 | 53.8 | 56.4 |
| Core Health `ingestQueue` | 0 | 65 | 69 |
| Core Health `rollupLag` (s) | 0 | 0 | 6 |
| Core Health `evictedChunks` | 0 | 0 | 0 |
| Core Health `alarmOverdue` | 0 | 0 | 0 |
| Core Health `notifyOldest` | 0 | 0 | 0 |
| Core Health `probesDown` | 0 | 0 | 0 |
| Core Health `memoryAvailable` (%) | 22.1 | 25 | 24.9 |
| Probe Health `connected` | 1 | 1 | 1 |
| Probe Health `scheduled` | 29 | 29 | 29 |
| Probe Health `memory` (MB) | 309.6 | 243.7 | 269.1 |
| Probe Health `schedulerLag` (ms, p95) | 5.7 | 7.5 | 6.3 |
| Probe Health `checkWait` (ms, p95) | 1.8 | 2.2 | 2.3 |
| Probe Health `spoolDropped`, `spoolStalled` | 0, 0 | 0, 0 | 0, 0 |
| Probe Health `workerCrashes` | 0 | 0 | 0 |
| Probe Health `sessionsOpen` / `sessionsEvicted` | 3 / 0 | 5 / 0 | 8 / 0 |
| Probe Health `sessionOverflows` | 0 | 0 | 0 |
| Probe Health `trapOverwritten`, `syslogOverwritten` | 0, 0 | 0, 0 | 0, 0 |

**What the criterion's numbers say, as a rehearsal's:**

- **Memory, from the history** (five-minute averages, as step 4 now says to read it).
  - The restarted core read about 306 MB in the minutes after step 2's restart: 305.7 at the
    start reading, and 306.3 as the 13:45 bucket's highest sample. It settled to about 150 MB
    within ten minutes. The 13:40 bucket's 324.8 is not the restarted core: that bucket also
    holds the previous process's samples, as its `uptime` shows. From the "24 h" reading to
    the end it went 152.6 → 157.9 MB, about +2.6 MB/h.
  - The probe went 243.7 → 282.9 MB over the same two hours, about +20 MB/h. The 24-hour soak
    measured +0.68.
  - Two hours with an outage in them is not a slope. A week will say whether that is settling
    or growth. **It is the number to watch first in the field test.**
- **`schedulerLag`**: 9.7 ms at worst, against a 1,000 ms budget.
- **`spoolDropped`, `evictedChunks`**: zero throughout.
- **`workerCrashes`**: zero.
- **Sessions**: `sessionsOpen`, summed over workers and devices, read 5 before the outage, 10
  at its peak, and **8 from then to the end**, with none opened or evicted after it. That is
  `P-256`.

**Sensor states.** At every reading, 28 Up and 3 Down, and every Down is explained:

- the target's `snmp.diskfree` on `/`: the containerised agent has no such storage;
- the drop-everything address's ping and TCP 80, as intended.

The state log since T0 holds 40 changes, and every one is explained:

- one ping sensor going Up at 13:44:36, once `ping` was installed;
- the outage below;
- Probe Health's Warnings during it.

**The outage.** At 15:14:13 the target was paused for three minutes, standing in for "a device
that is intermittently unreachable on purpose".

- **11 of its 14 sensors went Up → Warning → Down**, one scan apart, and all were Up again by
  15:18:00. Of the other three, its `snmp.diskfree` was Down already.
- **Its ping stayed Up**, and so did the trap sensor, which only listens. A paused container's
  network stack still answers ICMP and accepts TCP. It behaved as a *hung* device, not an
  unreachable one, so ping could not have been the dependency that holds the rest.
- **Probe Health went to Warning three times**, at 15:15:06, 15:16:06 and 15:17:06, on
  `poolUsage` 83.3 %. Five of its six workers were waiting out the target's timeouts. It was
  Up between them and after.

**Notifications.**

- The test send at 13:44:25 was delivered: MailHog had it, `delivered: true`.
- The outage raised **two** notification requests: **one alarm despite three Warnings**, and
  its recovery.
  - Request 1 was Probe Health's first Warning, held for the template's default 15-minute
    summary (`first-down-and-up`). The second and third Warnings raised nothing.
  - Request 2 was the **recovery, sent at 15:22:36**, after Probe Health's five-minute
    recovery hold (`M-18`).
- The **Warning itself was delivered at 15:30:36**, in the digest. The recipient was told the
  probe was back eight minutes before being told anything was wrong. That is `N-20`.
- One outage was one alarm, which is the rule. The order was wrong.
- Nothing else notified: the target's sensors had no trigger, as step 3 does not ask for one.

**The candidate's surface, against an installed system** (the RC proposal §7: the one thing
only the rehearsal can do). Every route and method in the runbook's appendix was requested
without a credential, 129 method rows. Every one answered as the table says: `401`, or not `401`
for the three public routes. With the `read` token, the catalogue served 39 types, and the table
carries 39 and withholds 5: none missing, none extra. `/maps`, `/reports` and `/libraries`
answered `404`.

## Where the runbook was wrong or unclear

Twelve suspected problems, each confirmed or refuted by the run:

- **Eleven were real, and are fixed**: nine confirmed, one unclear (10), and one found only by
  running (4).
- **One was refuted (9)**, and the order it questioned is kept.

Each fix is in `runbook-field-test.md`, or in `installation.md` where the runbook sends the
reader.

1. **Step 1 was one command, and on a fresh install that command fails.** *Confirmed, and
   worse than read.* `dpkg -i` starts the services, the core refuses the example's empty
   password (exit 78, as `P-222` designed), and `postinst` exits 1. `dpkg` reports *returned
   error exit status 1* and leaves the package `iF`, half-configured. Nothing in the runbook or
   `installation.md` says to finish it with `dpkg --configure -a`; `installation.md` mentions it
   only for upgrades. **Fix**: step 1 now says to expect this, and gives the sequence: §3–§5,
   `reset-failed`, `dpkg --configure -a`, `ii`. `installation.md` §2 says to expect the error
   and `iF`, and §3 finishes the package with `reset-failed`, `dpkg --configure -a` and a
   `dpkg -l ms` that reads `ii`. The package behaviour is `H-30`.
2. **Nothing created Core Health or Probe Health.** *Confirmed.* A fresh install has the root
   object only. Step 4's `<core-health-id>` had nothing to name until both sensors were created
   by hand. **Fix**: step 1's list of what must exist before step 2.
3. **Devices, the probe approval and the listeners came from nowhere.** *Confirmed.* Step 2
   restarts "after the devices are added", and no step adds them, approves the probe or turns
   on the syslog and trap listeners. **Fix**: the same list.
4. **`ping` was missing.** *Found by the run, not by reading.* Ubuntu 24.04's container image
   has no `ping`. Every ping sensor read Down: *the "ping" binary is not available on this
   probe*. The package neither depends on nor recommends `iputils-ping`, and `installation.md`'s
   requirements do not list it. **Fix**: step 1 says to check and install it. The packaging is
   `H-31`.
5. **Step 3 needed a write credential, and the only token is step 4's `read` one.** *Confirmed.*
   **Fix**: step 1 makes a `full` setup token, to be revoked before the week, and says why.
6. **"One state trigger … Down and Warning."** *Confirmed.* A state trigger's settings take
   exactly one `state`, so the six channels need four triggers, two on each sensor. **Fix**: step
   3 says so, with the JSON.
7. **No relay, and no proof of delivery.** *Confirmed.* The example `core.json` has no
   `notifications` section, no operator document describes `notifications.smtp`, and step 3 adds
   "delivery" without saying where it goes. **Fix**: step 3 gives the section and says to prove
   it with `POST /templates/<id>/test` before the week. That send worked against MailHog. The
   operator documentation gap is `H-33`.
8. **"Flat memory" from `/values`.** *Confirmed.* `/values` is one reading, and a slope needs
   `/history`, which a `read` token can read. **Fix**: step 4 gives the history `curl`, and says
   to leave the first hour after a restart out of the slope. The restarted core read about
   306 MB in the minutes after step 2's restart and about 150 MB within ten minutes: a slope
   fitted from the start reading would have read that as memory falling by half. The `curl`
   URL-encodes `from`. A time with a `+00:00` offset pasted raw into the URL decodes to a
   space and the range is refused, which is why the rehearsal's own reader encoded it.
9. **Step 2 restarts before step 3's triggers exist, so a restart's alarm cannot be seen.**
   *Refuted in effect.* The restart took 5 s, and Probe Health never left Up. It read "up since
   13:41:34" afterwards, so there was no alarm to see, with or without triggers. The order
   stands.
10. **"`scheduled` matches what the core assigned."** *Unclear, and now said.* An operator has
    no number to compare with. What matched was 29: every sensor under the probe except Core
    Health and Probe Health, which the core evaluates. The four syslog and trap sensors (two
    of each) are included. `GET /probes/<id>/health` says *connected, 29 sensors scheduled* within 17 s of
    the restart. **Fix**: step 2 says how to count, and where to read it.
11. **`reset-failed` was not in step 2.** *Confirmed as a gap, not as a failure.* Every other
    start in the procedure follows one, and step 2's did not. The run came nowhere near the
    limit, because each earlier start had followed a reset (see *Starts*). **Fix**: step 2's
    command block now starts with it. The text says each unit gets five starts in ten minutes,
    that `reset-failed` clears the count, and that a core restart moves the probe's count too.
12. **`installation.md` §5's approval `curl`.** *Confirmed.* As written it answers `401`
    (`AUTH_REQUIRED`). With a token and no content type it answers `415`. Its `objectId: 2` is
    right only because a probe object created first on a fresh install gets id 2, and nothing
    says to create one. **Fix**: §5 creates the probe object, lists the pending probe and
    approves it, with the token and the content type.

**What held as written:**

- The step 4 `curl`s, with a `read` token, on `localhost:8080`.
- The build checks.
- The mechanism step 3 rests on: a declared limit moves its sensor's state, and a state
  trigger picks that up with no threshold of its own. No channel in the table moved, but Probe
  Health went to Warning on `poolUsage`'s declared limit during the outage, and the Warning
  trigger raised a notification for it.
- The `probesDown` threshold trigger as given.
- The note that `read` is enough for step 4.

## Product defects, filed as tickets

- **`H-30`** — a fresh `.deb` install exits 1 and leaves the package half-configured, whenever
  the database password has not been set. That is every fresh install.
- **`H-31`** — the packages do not declare the `ping` the default ICMP path needs.
- **`H-32`** — every start and every `config check` reports `MS_BUILD_VERSION` as an ignored
  `MS_*` variable, and it is the launcher's own (`/opt/ms/bin/ms-core` exports it).
- **`H-33`** — no operator document describes `notifications.smtp`, so no installation can send
  email from the documentation alone.
- **`P-254`** — a trap or syslog message that arrives after a probe restart and before a
  sensor's first scan is counted by nobody.
  - Seen: three traps sent at 13:44:48, after the probe restarted at 13:44:07. Probe Health's
    `trapReceived` counted them.
  - Both trap sensors' first scans (13:44:53, 13:45:02) registered their cursors at "now" and
    reported *no traps since* then. The history shows `count` 0 and `dropped` 0 for those
    minutes.
  - Three more traps sent once the cursors existed were counted, 3 and 3.
  - `ring.ts` says a first scan "has genuinely received nothing". The listener had.
- **`N-20`** — a held Warning's recovery is delivered before the Warning itself (the outage,
  above).
- **`P-256`** — after the target hung and recovered, `sessionsOpen` read 8 where it had read
  5, for the 85 minutes to the end, with none opened or evicted. It peaked at 10 during the
  hang. That channel is a sum over every worker's own SNMP and SSH pools and every device. So
  this may be sessions spread across more workers rather than a leak, and the ticket's first
  step is to tell those two apart.
- **`P-255`** — between a probe's connection and its first heartbeat, Probe Health's message
  reads *its own numbers are unavailable — it speaks protocol 28, the same as this build*. It
  gives the protocol as the reason when there is no skew at all.

## What was not covered

- **A week, and real devices.** This is three hours against simulators that answer as they
  were written to. Every memory and lag number above is a rehearsal's, not a criterion's.
- **x86_64.** The arm64 package was used. The amd64 one is `H-14`'s, and Ubuntu on x86_64 is
  `H-29`.
- **A remote probe, a spool and a replay.** The probe was local, and the link never dropped.
- **An alarm from Core Health or Probe Health going Down.** Neither did. Delivery was proved
  by the test send. A Warning on Probe Health was raised during the outage; see above.
- **TLS on any simulator.** None of them serves a certificate worth checking.
- **`snmp.diskfree` on the target.** It is Down for the whole run. The containerised `snmpd`
  reports no storage called `/`. That is a simulator's limit, and it is explained.
- **The first administrator's password** was never changed. The API does not require it; see
  step 1.
