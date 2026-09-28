# Proposal: what the v1 release candidate is (H-09)

- **Date**: 2026-09-28
- **Status**: **a proposal, for decision.** No branch has been cut and no tag moved. Everything
  below marked *recommend* is a choice for roman; everything marked *measured* or cited to a file
  is a fact about `main` at `ac2056a`.
- **Question**: `H-09`'s field test cannot start, because nothing says what it is a test *of*.
  `main` is v1 plus three v2 phases, there is no tag, and a build carries no record of the commit
  it came from.
- **Constraint**: there is no Windows machine and no Ubuntu machine either (roman, 2026-09-28, in
  WatchDog's session). So the goal is not "released" but **ready to start the day hardware
  exists**: the candidate can be cut in an afternoon, the procedure has been rehearsed, and what
  is missing is a list somebody can buy or borrow in one go.
- **Answer, in one paragraph**: the candidate is **`v1.0.0-rc.N`, Linux only**, cut as a **tag on
  `main`** — not a branch at the last pre-v2 commit — and packaged with a **v1 build profile** in
  which the v2 subsystems are *not constructed*, rather than switched off by an operator setting.
  Three pieces of work make that possible, and none needs hardware: a build that says which
  commit it is, the profile, and a hygiene test that proves the candidate's surface from the
  running server rather than from a flag. A **dress rehearsal** of the runbook against the
  simulators proves the procedure, and is not `H-09`. Windows moves to **1.1**.

**Decisions for roman**, each argued below:

1. Tag on `main` with a v1 build profile, or a release branch at `8182e1e` plus 32 backports (§2).
2. **1.0 is Linux-only and says so**, or 1.0 waits for Windows too (§5).
3. Whether the four Windows sensor types are *in* the Linux 1.0 catalogue (§5.2).
4. Whether a remote-probe host is on the hardware list (§6).

---

## Two things found on the way that change the question

### The flow collector has never run in a shipped probe

`H-09` and the runbook both worry that a build of `main` "carries a UDP listener the Phase 10
criterion never contemplated". **It does not, and it never has** — which is a defect, not a
reassurance:

- `packages/probe/src/main.ts` constructs two listeners, `TrapListener` and `SyslogListener`.
  `FlowListener` (`probe/src/listeners/flow-listener.ts`) is referenced by its own test and by a
  type import in `probe/src/health/report.ts`, and by nothing that runs. `git log -S FlowListener
  -- packages/probe/src/main.ts` is empty: it was never wired, rather than wired and removed.
- The probe's configuration has no `flowListener` key (`shared/src/config/schema.ts`; the root is
  `additionalProperties: false`, so an operator cannot add one).
- `flow.netflow` is registered in the catalogue regardless, so a flow sensor can be created — and
  its `execute` rejects every scan with "enable `flowListener` in the probe's configuration"
  (`sensors/src/types/flow.ts:317-327`), naming a key that does not exist. Every flow sensor is
  Down for ever, with advice that cannot be followed.
- Probe Health declares five `flow*` channels that nothing sends, so they gap. The runbook's
  "If the build carries flow monitoring" section tells the field-tester to put threshold triggers
  on them.

`B-01`…`B-06` are all ticked; each is correct as far as it goes, and none of them had to start
the probe. **Drafted as `B-07`** at the end. One trap for whoever fixes it: `B-02` and `B-06`
added the five `flow*` fields to `ProbeHealthReport` and its JSON Schema at protocol 16, with no
capability and no version bump, and that schema is `additionalProperties: false` — so the day a
probe starts sending them, a core older than the probe rejects its heartbeat. `P-208`'s comment
calls its own field "the first health field since `P-178`", which is how this went unnoticed.

**What it does to this proposal**: the security question — a UDP socket nobody asked for — has the
same answer under every option. No build of `main` opens a flow socket, and v1's own two
listeners (SNMP traps on UDP 162, syslog on UDP/TCP 10514) are `enabled: false` by default. The
Linux installer opens no firewall ports at all, and the Windows script opens TCP only (the API
and probe ports). **An installed candidate binds no UDP socket unless the operator turns on traps
or syslog**, whichever way it is cut.

### No build says which commit it is

`scripts/package.sh` writes `package.json`'s version into `VERSION` and into the launcher's
`MS_BUILD_VERSION`, and every `package.json` in the repository says `0.1.0`. So every build ever
made is `0.1.0`, and two builds from commits a month apart are indistinguishable to an operator,
to a bug report, and to the runbook's own opening instruction — "say which build you are
testing, and mean it" — which today cannot be followed.

It also defeats a cache. `ObjectRepository.chainValidator` salts the validator for responses
carrying inherited settings with the build version, *because the last input to a resolved setting
is the registry default, which lives in code* (`objects/repository.ts`, `S-13`). With every build
at `0.1.0`, an upgrade from one candidate to the next that changes a default leaves every
validator unchanged, and a client revalidating gets a `304` for a value the new build would
render differently.

---

## 1. What is in the candidate

Derived from the scope markers in `CAPABILITIES.MD`, not from phase titles: **127 `[V1]`, 66
`[V2]`, 6 `[OUT]`** (each count excludes the legend row).

### v2 work that is on `main`

| Subsystem | `CAPABILITIES.MD` rows | On `main` | Footprint in a build |
| --- | --- | --- | --- |
| **Flow** (`B-01`…`B-06`) | §3.9: NetFlow v5, v9/IPFIX, jFlow/sFlow, custom variants | decoders, the listener class, the `flow.netflow` type — **never started** (above) | 1 sensor type, 5 Probe Health channels. No migration, route or dependency |
| **Maps** (`G-01`…`G-10`) | §6 Maps/dashboards, Geographical maps; §12 Map/dashboard designer | complete | migrations 044–046; 15 routes under `/api/v1/maps`; **2 routes that answer without a token** under `/api/v1/public/maps/`; web `/maps`, and `/shared/:token` mounted *before* the login gate (`web/src/App.tsx:44-50`) |
| **Reports** (`E-01`…`E-12`, plus `P-203`, `P-204`, `P-211`, `A-13`, `A-14`) | §6 Reports, scheduling, time spans, output, security context; §9 report storage | complete | migrations 047–051; 13 routes; a 60 s sweep and a `recover()` at every start; a worker pool; `pdfkit` and `fontkit` (MIT) with ~15 transitive packages, **loaded at start-up by static imports**; 5.7 MB of fonts; 5 Core Health channels; a housekeeper step; two required retention keys |
| **Libraries** (`L-01`…`L-05`) | §6 Libraries | **not built** — all five open | none |

**Everything else marked `[V2]` is absent**, and two parts of that are checked: the catalogue has
44 types and `flow.netflow` is the only `[V2]` one (the other 43 are what `H-07` counted before
Phase 11), and triggers implement `state` and `threshold` only — no speed, volume or change
trigger. The rest of the 66 rows were not audited one by one; §3's test makes the catalogue half
of this mechanical, and nothing else in the list is a surface an operator reaches.

### `[V1]` rows a Linux-only release cannot claim

**§3.5's four Windows rows** — Windows CPU Load, WMI Memory, WMI Volume, WMI Service
(`windows.cpu`, `windows.memory`, `windows.volume`, `windows.service`). They run PowerShell's
CIM cmdlets from a probe **on Windows**; on a Linux probe `pwsh` starts and then fails on the
first cmdlet, because `CimCmdlets` is Windows-only
(`sensors/src/support/windows/powershell.ts:191-206`). And `T-09` records that **no
`Get-CimInstance` has ever run against a Windows machine** — the queries are written against
recorded output. So these four are unproven on every platform, and unreachable on the only one
1.0 would support.

Not a Windows problem, noted because it is nearby: §7's identify stage says "via SNMP/WMI/other".
Discovery identifies by SNMP and reverse DNS only (`probe/src/discovery/sources.ts`), on every
platform. That is a v1 gap regardless of this proposal.

---

## 2. How to keep v2 out: a branch, or a tag

### The facts that decide it (*measured*, `8182e1e..ac2056a`)

- **The boundary is clean.** `8182e1e` (2026-09-09) is the last commit before v2; `fd117d1`,
  `B-01`, is the first. 72 commits follow: 30 carry v2 prefixes, 35 v1 prefixes, 7 are
  unticketed.
- **A branch at `8182e1e` needs 32 backports** — 10 of product code (`P-196`, `A-09`, `P-205`
  to `P-208`, `P-210`, `P-212`, `P-214`, and the tree-search wording), 13 of CI, dev and smoke
  infrastructure, 2 of tests with documentation, 7 of documentation only. None needs splitting
  by hand. Six v1-prefixed commits are v2 in substance and would be skipped (`P-203`, `P-204`,
  `P-211`, `A-13`, `A-14`, `A-15`).
- **The two that matter most would conflict.** `P-208` and `P-210` — the machine-memory and
  cgroup-ceiling channels, which exist because a probe was OOM-killed at 3.5 GiB (`P-206`) —
  change `core/src/main.ts` and `core/src/health/core-health.ts` against lines `E-08` added for
  reports. They would be rewritten by hand on the branch, which means the branch ships a
  hand-made variant of the fix the measurements were taken against.
- **Open v1 work would need backporting as it lands.** `A-12` — list routes, alarms, the state
  log and the stream ignore per-object rights, so an account granted one branch reads them all —
  is v1, open, and nearly finished. `P-213` (what the stock units do past their memory ceiling)
  is v1 deployment. Both belong in any candidate.
- **Migrations are separable either way.** v1 ends at 043; 044–051 are all v2 and all at the
  tail, and no v1 migration was numbered after them. The migrator applies whatever is pending by
  id (`db/migrator.ts`), so a patch migration on a branch only needs its id reserved on `main`
  first.
- **The protocol is separable.** Every version bump since `8182e1e` (16 → 17 → 18) is v1.

### The options, by what they cost the operator

| | **A. Branch at `8182e1e`** | **B. Tag on `main`, v2 off by configuration** | **C. Tag on `main`, v1 build profile** — *recommend* |
| --- | --- | --- | --- |
| Fixes since 09-09 | only what is backported (32 now, more as `A-12` and `P-213` land) | all | all |
| v2 code on disk | none | all | all |
| Can the operator turn v2 on? | no | **yes** — and the `MS_*` overlay (`shared/src/config/load.ts`) makes every key settable from the environment | no |
| Routes that answer without a token | the three login/logout/session paths | the same, *while* maps are off | the same |
| UDP sockets bound by default | none | none | none |
| `pdfkit`, `fontkit` and 5.7 MB of fonts | absent | present, loaded at start | present on disk; loaded only if the profile makes the report import lazy |
| Database | migrations 001–043 | 001–051: eight v2 tables and enums, empty | the same as B |
| Upgrade to 2.0 | ordinary — v2's migrations are the tail | ordinary | ordinary |
| What the field test exercises | a code line nobody else develops on | `main`, with a switch it never flipped | `main`, as it will be released |

**Why not A.** It is the cleanest artefact and the most expensive candidate. The field test would
qualify a code line that no one else works on, carrying a hand-merged version of the two memory
fixes whose measurements justified them, and every v1 fix from now until release — `A-12` first —
would have to be applied twice. And with no hardware in sight, "until release" is open-ended: the
backlog of backports grows for as long as the wait lasts. Its one real advantage, that no v2 code
or dependency ships, C can mostly recover (below).

**Why not B.** A switch an operator can reach is a support claim. No such key exists today; if B
added `maps.enabled`, the overlay would make it `MS_MAPS__ENABLED=true` in a unit's environment,
which would put an unauthenticated route on an installation labelled v1, running code the field
test never exercised. "Off by configuration" is one environment variable from
"on".

**Why C.** One code line; the candidate is `main` at a named commit, so the field test tests what
ships, and a candidate can be re-cut from whatever `main` is on the day hardware arrives. The v2
subsystems are not constructed at all — the same outcome as B's "off", decided by the build
rather than by whoever edits the unit file. Most of the mechanism exists already:

- **Routes.** `ApiServer` registers the map, public-map and report routes only when their
  services are passed, and exempts the public prefix only then (`core/src/api/server.ts:480-485`,
  `606-654`). `core/src/main.ts:1051-1057` always passes them; under the profile it would not.
- **Reports beyond the routes.** The sweep, `recover()`, the housekeeper step and the Core Health
  source are wired separately and each needs the same condition. `CoreHealthSources.reports` is
  required today and would become optional; its five channels gap on a v1 build, which is the
  right reading of "no data" and what Probe Health's `flow*` channels do already.
- **The catalogue.** `standardCatalogue(types)` takes its list as an argument
  (`sensors/src/index.ts:185-191`), and both core and probe call it with the default. The profile
  passes a v1 list without `flow.netflow` (and, per decision 3, without the four Windows types).
- **The web UI.** Its nav and routes are static (`web/src/components/Layout.tsx:15-16`,
  `App.tsx:93-97`). It needs to ask the core what exists — `GET /api/v1/build`, from the
  provenance work — and hide what does not.
- **Where the profile comes from.** `package.sh` stamps it, beside the version and commit; it is
  not a key in `core.json`. A development build is the full profile.

**What C still ships that A would not**, stated rather than implied: the v2 code, `pdfkit` and
`fontkit` with their dependencies (which a dependency scanner will list even though nothing loads
them once the import is lazy), the fonts, and eight empty tables. Leaving `pdfkit`, `fontkit` and
the fonts out of the v1 *package* is possible once the import is lazy, and is worth a line in the
profile's ticket rather than a blocker. **Migrations 044–051 should stay in the v1 build**:
dropping them would give the two profiles different migration lists, and a database a full build
has touched would then refuse the v1 build ("migrations this build does not know",
`db/schema-gate.ts`) — including every development database.

**Patch releases under C.** When 1.0.1 is needed, `release/1.0` is branched *from the tag* and
the fix is cherry-picked onto it. That is a branch cut late, from the commit that was actually
qualified, rather than early from one that predates two weeks of fixes.

---

## 3. What the build-hygiene test should assert

In the shape `H-09`'s runbook test already has: **a table in a document, parsed, and compared in
both directions against the running code** — the falsifiable half, not a checklist. The table is
the candidate's surface, and it goes in the runbook next to step 3's, since it is what the field
test is a test of.

**What it asserts, all under the v1 profile, building `ApiServer` the way
`scripts/docs/api-reference.mjs` does — without a database:**

1. **Routes, by asking the router.** Every route that answers equals the table's v1 route list,
   with nothing extra (no `/maps`, `/reports` or `/public/`) and nothing missing (the profile did
   not take a v1 route with it). **Asked of Fastify with `inject`, not read from the OpenAPI
   document**: `@fastify/websocket` already hides a real route from that document (`H-07` found
   `/api/v1/stream` missing), so "absent from the document" and "does not answer" are different
   statements, and only the second is the claim.
2. **The unauthenticated surface, by behaviour.** For every route under `/api/` and `/metrics`, a
   request with no credential answers `401` unless the route is in the table's public list —
   which for v1 is `/api/v1/auth/{login,logout,session}` and nothing else. (The web shell and its
   assets are public by design, carry no data, and are outside this claim.) Specifically, `GET
   /api/v1/public/maps/anything` must not be exempted. A test that read the `PUBLIC` flag or the
   `publicPrefixes` option would pass against a build that exempted the prefix and forgot to
   remove the route, or the reverse.
3. **The catalogue, both ways.** The v1 profile's sensor types equal the table's list — 43 today,
   39 if decision 3 removes the Windows four.
4. **A v2 listener cannot start, by trying.** A v1 probe handed a `flow.netflow` assignment
   refuses it by name, and binds nothing. **"No UDP socket at start-up" is the wrong assertion,
   and it is catalogue entry 43 again**: it is true of `main` today *with v2 fully on*, because
   the collector is never constructed (above). A mutation that turns the whole v2 profile on
   would not kill it. And the day `B-07` wires the collector, the check has to go red on a v1
   build, or it was never checking anything.
5. **Provenance.** The version and commit a build reports equal what it was built from. This half
   runs in `smoke-packages.sh` against an installed `.deb`, because only the packaged launcher
   says what the package says.

**The mutations, from both sides, because entry 43 is what happens otherwise.** A comparison of A
with B is two tests, and passing one of them is not passing the other:

- *From the document*: add a v2 route to the table; drop a v1 route from it; mark a v2 sensor type
  v1. Each must fail.
- *From the code*: register one map route under the v1 profile; hide it from OpenAPI while it
  still answers; exempt the public prefix without registering the routes; let the profile remove
  a v1 route as well; wire `FlowListener` under the v1 profile; make the build fall back to the
  full profile when its stamp is missing. Each must fail.

---

## 4. Cutting a candidate in an afternoon

**Once, before the first cut** — none of it needs hardware:

- the provenance, profile and surface-test work above has landed;
- `A-12` and `P-213` have landed — the v1 security fix and the stock units' memory ceiling;
- **an x86_64 build has been made once.** Every package so far was built on this project's
  Apple Silicon machine, so every `.deb` has been `arm64`, and `package.sh` says native addons
  must be built on the target's architecture. The field host will almost certainly be x86_64 and
  the runbook installs `ms_<version>_amd64.deb`. It looks feasible — `argon2` ships a
  `linux-x64` prebuild, and `ssh2`'s native helper (`cpu-features`) is optional — but it is
  unproven, and the afternoon of the cut is the wrong time to find out. Build under emulation
  (`--platform linux/amd64`) and install it in the smoke container the same way, or name an
  x86_64 build machine on the hardware list;
- the dress rehearsal (§7) has run, and whatever it found in the runbook is fixed.

**The cut** — in this order, each step a command that already exists or one line of the work
above:

1. **Choose the commit**: the head of `main`, with CI green on it.
2. **One commit on `main`** that sets every `package.json` and the lockfile to `1.0.0-rc.N`, and
   changes nothing else — so the tagged commit differs from a tested one by a version string.
3. **An annotated tag, `v1.0.0-rc.N`**, on that commit — by roman, or with his yes. N starts at 1
   and goes up by one for every re-cut, including a re-cut of an unchanged `main` onto new
   hardware.
4. **Build with the v1 profile**, for the field host's architecture: the tarball, the `.deb`, the
   `.rpm`.
5. **Re-run the runbook's four smoke tests against those packages** — the Ubuntu install, the
   Debian install, the packages and the restore — and update their dates in the runbook, as its
   own rule says.
6. **Record the cut**: the tag, the commit, the package checksums and the four results, in the
   field test's findings file before the week starts, so the write-up begins with what was
   installed.

A pass after the week is tagged **`v1.0.0` on the same commit** as the candidate that passed.

---

## 5. Linux first: what the release is called and what it claims

Roman has answered the Windows question in WatchDog's session: there is no Windows machine, and
`S-11`'s benchmark, `H-06` and the Windows half of `H-09` are not to be written blind — the
rejection `S-11` recorded on 2026-09-04 stands.

### 5.1 The name

| | **1.0 is Linux; Windows is 1.1** — *recommend* | **1.0 waits for Windows too** |
| --- | --- | --- |
| What unblocks 1.0 | a Linux host, 100 devices and a week (§6) | that, **and** a Windows Server host, `S-11` and `H-06` |
| What the docs must say | that 1.0 does not run on Windows, in the places that say it does | nothing new, until the release |
| Cost | a documentation change; 1.1 carries the Windows work | two hardware dependencies instead of one, and every candidate cut in the wait re-qualified on both |

**What a Linux-only 1.0 has to say plainly**, rather than leave implied:

- `docs/installation.md:18` — requirements say "Linux with systemd, or Windows with WinSW".
- `README.md:6-7` — "systemd on Linux, WinSW on Windows" as a description of production.
- `docs/PLAN.md` Phase 10 — the exit criterion names Ubuntu *and* Windows Server; split it into
  1.0 (Ubuntu) and 1.1 (Windows Server), with the MSI deliverable moving to 1.1.
- `docs/CAPABILITIES.MD` §3.5 — the four Windows rows stay in scope, and say "not in 1.0: needs a
  Windows probe, 1.1". The alternative, a new `[V1.1]` marker, is honest too, but it adds a fourth
  marker to a legend `CLAUDE.md` refers to, which is roman's call.
- `docs/runbook-field-test.md` — the Windows steps move to a 1.1 section, not deleted.

`CLAUDE.md`'s first hard constraint ("systemd on Linux, WinSW on Windows") does **not** need to
change. It constrains what gets built — no container runtime, no orchestrator — and Windows is
still being built for. `ADR-001`'s decisions stand for the same reason.

### 5.2 The Windows sensor types in a Linux 1.0

*Recommend* leaving `windows.*` out of the v1 profile's catalogue. A type that can only fail, with
an error from PowerShell, is the shape `flow.netflow` has today. The four stay in the full build
and come back in 1.1's profile. The field test still covers Windows *servers* — by ping, port,
HTTP, TLS and SNMP — only not by WMI.

### 5.3 Where the Windows tickets go

Into a new **"Release 1.1 — Windows"** heading in `TASKS.md`, moved rather than rewritten, each
with its dependency — a Windows Server host, or a runner registered under `CI_RUNNER_WINDOWS`,
which brings back `H-06`'s and `S-11`'s CI jobs with no code change:

- `S-11`'s remaining half — the provisioning job, and the benchmark, which needs a host rather
  than a hosted runner.
- `H-06` — the MSI, built and never installed.
- **The Windows half of `H-09`**, split out as its own ticket so that `H-09` can be ticked for
  Linux on its own evidence.
- The first run of the four Windows queries against Windows — `T-09`'s stated open item, which
  has no ticket of its own.
- `R-07`'s `install-probe.ps1`, which has never executed.

---

## 6. What `H-09` still needs — the list to buy or borrow

Everything on this list is missing today; nothing else is.

1. **A core host.** Ubuntu 24.04 LTS, **x86_64**, 4 cores, 8 GB of RAM, a 100 GB SSD. It runs
   `ms-core`, the local `ms-probe` and PostgreSQL 17 with TimescaleDB. `docs/sizing.md` puts
   ≤ 1,000 sensors at 2 cores and 4 GB for the core, "plus whatever PostgreSQL wants, which is the
   larger half of the core's box" — and a hundred devices is 500 to 1,000 sensors. x86_64 matters
   on its own account: `H-08` lists x86 among what it did not measure.
2. **A remote-probe host** — *recommend*, decision 4. Any small Linux machine, 2 cores and 2 GB,
   on a different network segment from the core, dialling out to it. Remote probes are `[V1]`
   (§8 of `CAPABILITIES.MD`), and without one the field test leaves enrolment, approval, the mTLS
   link and the disk spool across a real network to the smoke tests alone.
3. **The devices: 100 of them, real.** One hundred device objects, each a distinct host — not a
   simulator, not a clone of one image, not two device objects for one address. A spread the v1
   catalogue can reach from Linux, as the runbook already asks:
   - network gear over SNMP, some on v3 with authentication and privacy, at least one with a slow
     agent;
   - Linux servers over SSH;
   - Windows servers by ping, port, HTTP, TLS and SNMP — **not WMI** (§5.2);
   - web endpoints over HTTP and TLS;
   - a few mail and database servers;
   - one device behind a firewall that drops rather than refuses, and one taken down and up again
     on a schedule written before the week starts.
4. **Network access to all of them** from the probe that monitors each: ICMP, the TCP ports the
   sensors use, SNMP (UDP 161) — and credentials, entered once, for SNMP v3, SSH, the mail
   servers and the databases.
5. **Mail delivery for the alarms**: an SMTP relay the core may send through, and one mailbox a
   person reads. The runbook's step 3 is delivery, not thresholds.
6. **A week**: 168 consecutive hours from the end of the runbook's step 2, and nobody touching
   either host. Anything scheduled before the start is not an intervention — the device that goes
   up and down, and, with a remote probe, a firewall rule that cuts its link for half an hour
   twice in the week, the only way the spool and replay meet a real outage. Unattended OS updates
   run as they would on an operator's machine, and are recorded.

**Later, for 1.1:** a Windows Server host, and `S-11` and `H-06` (§5.3).

**What the Linux field test proves:** a clean install from the `.deb` on x86_64 Ubuntu, the v1
catalogue against real devices that answer in ways simulators do not, and a week unattended —
memory, scheduler lag, rollups, notifications delivered, restart behaviour (`P-28`'s class), and,
with a remote probe, the link and the spool across a real network.

**What it leaves unproved, and its write-up says so:** the MSI (`H-06`); TimescaleDB provisioning
and performance on Windows (`S-11`); a Windows probe and every WMI query (`T-09`); WinSW under a
week of running; and anything v2, which is not in the candidate.

---

## 7. The dress rehearsal — not `H-09`

The runbook has been wrong in three places once already (`H-09`'s audit, 2026-09-09: a channel
with no declared limit, a `curl` that answers `401`, and a build it no longer described). The next
such mistake should be found in an afternoon on a VM, not on day three of a week somebody arranged
hardware for.

**What it is.** `docs/runbook-field-test.md`, end to end, on the smoke-install Ubuntu 24.04 box
(`MS_SMOKE_DISTRO=ubuntu scripts/smoke-install.sh`'s container, with a real systemd), against the
protocol simulators in `docker-compose.dev.yml` — `snmpsim`, the syslog sender, GreenMail, MariaDB
and MSSQL, the in-house HTTP, SSH and mail servers — with MailHog as the relay. Every step as
written: install from the `.deb`, make the token, set step 3's triggers, take the start reading,
restart everything once (step 2), take the "24 h" and "end" readings — compressed to hours — and
write the result up in the runbook's own step-6 shape. **Every place the runbook's text did not
match what happened is the finding.**

**What it proves: the procedure, and nothing about the product.** Simulators are not "100 real
devices" — they answer exactly as they were written to — and a few hours on a shared VM is not a
week. What this VM can show about endurance, `H-01`'s 24-hour soak at 5,047 sensors already
showed. The ticket must say this, so that nobody reads a green rehearsal as a partial `H-09`.

**Two things only it can do**: prove the procedure works against a candidate built the way §4
builds one — v1 profile, provenance, the packages — and exercise the candidate-surface table from
§3 against an installed system rather than an in-process server.

**Cost.** It is a heavy run: a systemd container, PostgreSQL, the simulators and a candidate
build, on the machine every session shares with the development database and `ms-server`. It is
announced before it starts, and run when the machine is quiet.

---

## Draft `TASKS.md` entries, for WatchDog to place

WatchDog numbers and places these; nothing starts before the decision. `H-10` is the next free
`H-` number and `B-07` the next free `B-` number at `ac2056a`.

- **`H-10` — What the v1 release candidate is** · S · H-09 · This document. Tick when roman has
  decided §2 and §5 and the entries below exist.
- **Build provenance** · S · — · Version and commit in every build, `GET /api/v1/build`, and the
  validator salt ("No build says which commit it is"). Needed whatever the decision.
- **The v1 build profile** · M · provenance · Option C (§2): v2 not constructed; the v1
  catalogue; the web UI asks what exists.
- **The candidate's surface, tested** · M · the profile · §3's table and test, with the
  mutations from both sides.
- **An x86_64 build, proven once** · S · — · §4.
- **The field-test dress rehearsal** · M · all of the above · §7. **Proves the procedure, not the
  product; never tick `H-09` from it.**
- **The Linux-only 1.0 documentation** · S · decision 2 · §5.1.
- **Release 1.1 — Windows** · — · a Windows host · the moves and splits in §5.3.
- **`B-07` — the flow collector has never run in a shipped probe** · M · B-02 · Wire
  `FlowListener` behind a `flowListener` configuration key, as trap and syslog are; fix the five
  `flow*` health fields' protocol gating first. Not a 1.0 blocker under A or C, since flow is not
  in the candidate; needed for v2 regardless.

**`H-09` itself** keeps its text, gains the §6 list as "what it still needs", and is blocked on
hardware, not on work.
