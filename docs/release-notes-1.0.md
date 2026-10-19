# MonitoringSystem 1.0 — release notes

For an operator installing 1.0, or upgrading to it from an earlier build. This file ships in
`/opt/ms/docs` with `v1.0.0-rc.3`, and then with `v1.0.0`. One item is marked **Before `v1.0.0`**
and is rewritten before that tag; the *Verified* line at the end is filled in when rc.3 is cut.

Each item names the section that says it in full, or the ticket (`H-37`) in [TASKS.md](TASKS.md)
that recorded it. This page says what to do and where to read, and does not repeat those sections.

---

## What 1.0 is

A PRTG-class infrastructure monitoring system for Linux. Two services and one database
([installation.md](installation.md)):

- **`ms-core`** holds the configuration, the API, the web UI, and the alarms and notifications.
- **`ms-probe`** runs the checks. One runs beside the core (the local probe); remote probes run on
  other hosts and are the same code. A probe dials out to the core, on port 23560 by default, so
  nothing has to reach into a probe host ([installation.md → Remote probes](installation.md#remote-probes)).
- **PostgreSQL with TimescaleDB** holds configuration and readings in one database. It is the only
  always-on dependency.

Both services are native systemd units. Neither needs a container runtime, an orchestrator or a
cloud service.

**1.0 is `main` built with the v1 profile** (`H-10`, `H-12`). `main` also carries v2 work — maps,
reports, libraries and flow monitoring — and the v1 build constructs none of it. A build says its
version, commit and profile in `/opt/ms/app/core/build.json` and `/opt/ms/app/probe/build.json`,
and the core answers the same at `GET /api/v1/build`
([troubleshooting.md → When none of this fits](troubleshooting.md#when-none-of-this-fits)).

## Requirements and platforms

From [installation.md → Before you start](installation.md#before-you-start), where each line is
argued:

| | |
| --- | --- |
| OS | Linux with systemd. **Not Windows**, which is release 1.1 (*Known limits*, below) |
| Packages | `.deb` for Debian and Ubuntu; `.rpm` for RHEL, Rocky, AlmaLinux and Fedora; a tarball with `install.sh` for anything else |
| Architectures | x86_64 and aarch64 |
| Node.js | 22 or newer, on `PATH`. Not a package dependency, so install it yourself ([why](installation.md#why-node-is-not-a-package-dependency)) |
| PostgreSQL | 17, which everything here is measured and tested on |
| TimescaleDB | 2.14.0 or newer, the Community build, preloaded, under its Community licence (below). The core refuses an older one at start and stops (exit 78). Tested on 2.29 |
| `openssl` | On `PATH`, for the probe-channel certificates |
| `ping` | iputils', on every host that runs a probe. The packages depend on it, so install them with `apt` or `dnf`, which fetch it |
| Privileges | `root`, to install |
| Ports | The API and UI on `127.0.0.1:8080` by default ([§4](installation.md#4-the-first-administrator)); probes reach the core on 23560 |

**What a candidate has been installed on.** rc.2 passed the four smoke tests on 2026-10-04: a clean
install on Debian 12 and on Ubuntu 24.04, the `.deb` on Debian and the `.rpm` on Rocky 9 installed,
upgraded and removed, and a backup restored onto another host. That was arm64 natively, and x86_64
under emulation except Ubuntu 24.04, which the emulator cannot boot
([the rc.2 record](findings/2026-10-04-v1-release-candidate-cut.md); `H-29`). rc.3's runs are the
*Verified* line at the end. **Sizing** is [sizing.md](sizing.md), from measurements; the short
version is in [installation.md → Sizing](installation.md#sizing).

### TimescaleDB's licence

`ms-core` relies on TimescaleDB's native compression, which is under the Timescale License, not
Apache 2.0. So the database has to be TimescaleDB's Community build with
`timescaledb.license = 'timescale'`, and `SHOW timescaledb.license;` answers `timescale`
([installation.md §1](installation.md#1-the-database)). An Apache-only build, such as
`timescaledb-2-oss-postgresql-17` or Debian 13's `postgresql-17-timescaledb`, fails migration 004.

The licence permits free self-hosted use, and forbids offering the software to others as a
database service ([the licensing finding](findings/2026-08-25-timescaledb-licensing.md)). It
attaches to whoever ships TimescaleDB's binaries, which is why 1.0 does not bundle them and you
install TimescaleDB yourself, from your distribution or the TimescaleDB project's repository.
Native compression is the only Timescale-licensed feature 1.0 uses: rollups, retention and the job
that drives them are written in the core (`CLAUDE.md`, hard constraint 4;
[administration.md → Housekeeping](administration.md#housekeeping-retention-and-a-full-disk)).

## What is in 1.0, and what is not

[CAPABILITIES.MD](CAPABILITIES.MD) is the scope contract. `[V1]` there is the 1.x line, and a
`[V1]` row that needs Windows says **not in 1.0** beside it. Leaving those out, 1.0 has:

- **The object model** (§1): probe, group, device, sensor and channel, with inherited settings,
  tags, priority and comments; channel units, scaling, limits and spike filter; lookups (§1.2).
- **Six of PRTG's eight sensor states** (§2), with the two-step failure rule.
- **39 sensor types** (§3): ping, port, DNS, HTTP and REST, TLS, SNMP v1/v2c/v3 with a trap
  receiver, SSH, mail, PostgreSQL, MySQL and SQL Server, syslog, EXE/Script, Sensor Factory, and
  Core Health and Probe Health. The exact list is
  [the candidate's surface](runbook-field-test.md#appendix-the-candidates-surface), which a test
  holds against the build.
- **Scanning and alerting** (§4, §5): intervals, the retry policy, schedules, maintenance windows,
  pauses, dependencies; state and threshold triggers; email, webhook, Slack, Teams and program
  delivery; summarisation and acknowledgement.
- **The web UI and the API** (§6, §11, §12): the device tree, alarms, logs, sensor pages and live
  graphs, updated by push; REST with an OpenAPI document (`GET /api/v1/openapi.json`), a live
  stream, and `/metrics`.
- **Discovery** (§7): a ping sweep, identification, device templates, scheduled rediscovery, bulk
  operations.
- **Probes** (§8): local and remote, on Linux, over mTLS, approved by a person, with a disk spool.
- **Access** (§10): accounts and groups, per-object rights, API tokens, TOTP, an audit log, and
  device credentials encrypted at rest and never returned by the API.
- **The v1 target** (§13): 5,000 sensors at a 60-second interval on one box, with p95 dispatch
  jitter under a second; measured at 208 ms on two cores ([sizing.md](sizing.md)).

**Not in 1.0:**

- **Windows**: the four `windows.*` sensor types, a probe on Windows, and the MSI. Release 1.1.
- **`[V2]`, deferred and not abandoned**: flow monitoring (§3.9); maps, reports, libraries and
  tickets (§6); clustering (§8); LDAP and single sign-on (§10); the Unusual and Down (Partial)
  states (§2); speed, volume and change triggers (§5.1); the other delivery methods (§5.2); the
  virtualisation, cloud and IoT sensors (§3.12–§3.14). Their order is `TASKS.md`'s *Backlog — v2
  candidates*.
- **`[OUT]`, not built at all**: CAPABILITIES §15, and vendor-specific SNMP types (§3.16), which
  device templates with the SNMP Custom and Table sensors cover.

## Upgrading from an earlier build

**How**: install the new release the way you installed the old one
([installation.md → Upgrading](installation.md#upgrading)). Nothing in `/etc/ms` is overwritten,
and the new build checks your configuration first: the tarball with the old services still
running, a package after stopping them, leaving them stopped if it refuses. A candidate's package
spells its version `1.0.0~rc.3`, so that `1.0.0` upgrades it.

**Which items apply to you.** rc.1 and rc.2 differ only in packaging. From either, read *Before you
upgrade*, *Every probe host* and *After the upgrade*. From anything older, including every build
that says `0.1.0`, read *From a build older than rc.2* as well. From rc.2, the core's first start
applies migrations 071 to 084 (there is no 083) while `database.autoMigrate` is on, the default,
and the protocol between core and probe moves from 28 to 38.

### Before you upgrade

- **A core that reaches its own database by address with `database.ssl` on** (`A-74`): the
  certificate is now checked against that address. Make sure it lists the address as an IP
  subject alternative name, or give the core the name the certificate is for; otherwise the core
  cannot start ([administration.md → Upgrades](administration.md#upgrades)).
- **A probe that runs as root with a script directory** (`P-276`) no longer starts without
  `probe.processUid` and `probe.processGid`, or `allowScriptsAsRoot`. The packaged unit runs it as
  `ms-probe`, so this is a `User=root` drop-in or a probe started by hand. The installer's check
  runs as root and passes it; `ms-setup` then reads the unit's account and says the probe will
  refuse before it restarts it, and the restart fails (`H-41`)
  ([installation.md → Upgrading](installation.md#upgrading)).
- **`checkAbortGraceMs` under 1500** (`P-267`) is refused. Look in `/etc/ms/probe.json` and in any
  drop-in, and set it to 1500 or more, or remove it. A drop-in's value passes the installer's
  check and then stops the probe with exit 78 ([installation.md → Upgrading](installation.md#upgrading)).
- **A tarball installation with files of your own in `bin`, `libexec`, `etc` or `deploy`**
  under its prefix, or under `previous` (`H-39`): the installer replaces those directories
  whole, so it now refuses the upgrade before it changes anything, and names the file. Move it
  out of the prefix first. A prefix with anything in it and no release, `--prefix /usr/local`,
  is refused the same way, unless it holds only empty directories with a release's names
  (`app`, `bin`, `web`, `docs`, `etc`, `deploy`, `libexec`, `previous`), a filesystem's
  `lost+found` or what an interrupted install left
  ([installation.md → Upgrading](installation.md#upgrading)).
- **A clone of Core Health or Probe Health made before `P-302`** (`H-43`): save the thresholds it
  copied. The first start after migration 073 replaces them with this release's declaration, or
  clears them, and nothing keeps them after that. A read-only query lists them, with whether each
  differs from the type's own thresholds and the sensor it was cloned from where it can tell, and
  prints the body that sets each back; after the upgrade, send the ones that differ
  ([installation.md → Thresholds on a cloned health sensor](installation.md#thresholds-on-a-cloned-health-sensor)).
- **Then let the first start finish.** A migration reports itself every 15 seconds and can take
  minutes on a large installation; do not restart the core to hurry it
  ([a core that is still starting](administration.md#a-core-that-is-still-starting)). Before
  starting a service by hand, run `systemctl reset-failed ms-core ms-probe`
  ([installation.md §3](installation.md#3-the-connection)).

### Every probe host: ICMP needs this release's package (`H-37`)

On Debian and Ubuntu a probe's ICMP sensors (`icmp.ping`, `icmp.jitter`) read **Down** under its
unit until `ms-setup` from a build carrying `H-31` has run: this release, and not rc.2. Only that
setup opens `net.ipv4.ping_group_range` to the `ms-probe` group. **A remote probe installed from
an earlier build, and left on it, keeps reading Down.** RHEL 9 and its rebuilds open the range to
every group already ([installation.md → Before you start](installation.md#before-you-start)).

**The check**, on each probe host: `sysctl net.ipv4.ping_group_range` must include the id that
`getent group ms-probe` gives.

```bash
sysctl net.ipv4.ping_group_range      # the range: two numbers
getent group ms-probe                 # the third field is the id, which must lie inside it
```

**The fix**: upgrade every host that runs a probe to this release, the core's host included; its
installer runs `ms-setup`. On a host already on this release, run `sudo /opt/ms/libexec/ms-setup`
again, which restarts the services there. A range somebody set that leaves `ms-probe` out is left
as it is, and the setup says so: widen it in `/etc/sysctl.d`, then run `sysctl --system`. The
packages now depend on `ping` (`iputils-ping`, or `iputils` on RHEL), which only `apt` and `dnf`
fetch.

### After the upgrade

From rc.2 or anything older:

- **Clones made before `P-302`, and migration 073** (`H-42`;
  [installation.md → Upgrading](installation.md#upgrading)):
  - **Counters stored as totals stay totals.** 073 gives a cloned counter its width, so rates come
    from the next readings, but the totals already stored stay: a graph across the upgrade
    climbs, gaps for one scan, then reads far lower. A rate threshold the totals held in Down or
    Warning clears.
  - **Status lookups are named, not filled.** 073 logs how many channels lack the lookup their
    type declares, and the first 50 sensors holding them. The web UI lists them all under
    **Sensor types** → **Channels without the lookup their type declares**, as does
    `GET /api/v1/channels/without-lookup`. Each stays judged by nothing until you set it.
  - **A cloned health sensor's copied thresholds are replaced at the first start.** A clone of
    Core Health or Probe Health copied its source's thresholds without marking them as set by
    hand, and 073 lets the first start after it replace them with what the type declares, or
    clear them, which can raise an alarm or clear one. Set back the ones you saved before
    upgrading that differ from the type's own (above), each with the body the query printed,
    sent from a signed-in session. A copy a start of the earlier release had
    already replaced cannot be recovered from the clone; its source keeps its own
    ([installation.md → Thresholds on a cloned health sensor](installation.md#thresholds-on-a-cloned-health-sensor)).
- **A tarball installation has an uninstaller**, `sudo /opt/ms/libexec/ms-uninstall` (`H-39`),
  which removes what a package's purge removes and keeps what it keeps. It removes nothing while
  the `ms` or `ms-probe` package is installed, nor from a prefix holding anything in `bin`,
  `libexec`, `etc` or `deploy` that no release put there, nor a release kept inside an
  installation (`previous`, `rolled-back`), nor a prefix the installed units do not run from,
  such as a copy of another installation; `rm -rf` removes either of those. An installation
  from rc.2 or older has no copy until it is upgraded; to remove one without upgrading, run
  `sudo ./deploy/uninstall.sh` from this release's unpacked tarball ([uninstalling](installation.md#uninstalling)).
- **The start-up passes** (`P-333`, migration 077) bring stored rows up to a build's declarations
  at its first start, not at every restart. One renames existing channels to what their type
  declares and gives them its units (`P-402`, `P-404`); a name or unit a build takes away stays
  (`P-434`) ([administration.md → Upgrades](administration.md#upgrades)).
- **Core Health's `sensorsWithInvalidParams`** (`P-358`) counts sensors whose stored parameters
  this build's schema refuses. They keep running; read it after an upgrade and mend what the log
  names. A rise in `channelsCreatedOutsideDeclaration` right after an upgrade is version skew, and
  stops when every probe runs the core's version ([Core Health](administration.md#core-health--mscorehealth)).
- **A probe refused over its version before `U-35`** reads as one with nothing recorded until it
  is refused again (migration 074) ([installation.md → Upgrading](installation.md#upgrading)).
- **A probe registered before `P-326` is bound to a certificate** only at its next proven hello
  (migration 078). From then on, renewing its certificate is two steps, in order
  ([the certificate a probe is bound to](installation.md#the-certificate-a-probe-is-bound-to)).
- **The core's heartbeat goes through the proxy Node is told of again** (`A-75`)
  ([administration.md → Upgrades](administration.md#upgrades)).
- **Database sensors** (`A-74`): `db.mysql` verifies a device given as an IPv6 address; a
  PostgreSQL socket path facing a bounded credential set is decided by the core; a SQL Server
  failure names every address a name was tried at, so its message reads differently
  ([the target policy](administration.md#the-target-policy-every-sensor-that-connects-and-the-addresses-it-will-not)).
- **A device set to IPv4 or IPv6 is reached over that family alone** by its TLS, HTTP, SSH and
  database sensors too (`A-85`), as its port, mail and SNMP sensors always were. One set to `v6`
  whose name has only an A record now fails, saying `did not resolve to an IPv6 address`, where
  it connected over IPv4; one set to `v4` is no longer refused over an AAAA record. Set the device
  to `auto` to use either ([a device's IP version](administration.md#a-devices-ip-version)).
  Every address of the family is tried, under every policy: `port.tcp`, `port.range` and the
  mail sensors on a device set to a family tried only the first, and now pass one that does not
  answer for the next, as on `auto`. `port.tcp` says a name that did not resolve in the words
  the others use, in the `resolve` phase, in place of `could not connect to … — the device’s
  host name did not resolve`: `the device’s host name did not resolve to an address,
  connecting to …` where the probe resolves the name, and `the device’s host name did not
  resolve, connecting to …` under `none`, where its socket does (`to an IPv6 address` for a
  device set to a family, under either). The SSH sensors under `none` say the second, in place
  of `could not connect to …: getaddrinfo ENOTFOUND …`. Under `none` a resolver that does not
  answer is said to be not answering, where the sensors said the name did not resolve.
  A connection that fails at every address of a name now names each address with its code,
  where `port.tcp`, mail, SSH, TLS and HTTP said nothing after the colon; `port.tcp`'s connect
  failures carry the `connect` phase, and a connection a service resets before its banner is
  read says `… accepted the connection and then failed before its banner was read`, in no
  phase, in place of `could not connect to …`. A TLS connect failure, of one address or
  several, reads `could not connect to …` in place of `the TLS handshake with … failed`.
  `port.range` under `none` resolves the name once for the scan and fails one that does not
  resolve, where it read every port closed. On a macOS probe,
  whose resolver answers an IPv6 lookup with IPv4-mapped addresses (`::ffff:a.b.c.d`) for a
  name with only A records, a `v6` device fails as above and is no longer reached over IPv4.
- **`100.100.100.200`, Alibaba Cloud's metadata address, is refused** under the default target
  policy (`A-79`): a sensor on it fails its next scan, and `probe.targetPolicy: none` on its probe
  is the way back ([the target policy](administration.md#the-target-policy-every-sensor-that-connects-and-the-addresses-it-will-not)).
- **Two probe objects marked local become one** (migration 075, `P-382`): the one with an approved
  probe keeps the flag, then the one a probe connected to most recently, then the lowest id. Where
  both had an approved probe, that can be a remote one. The others can then be deleted, and the
  core stops treating them as the probe beside it. No API route or page shows which one kept it;
  the database does, so check before deleting any, and moving a wrongly kept flag has no tested
  path yet (`P-445`) ([installation.md → Upgrading](installation.md#upgrading)).
- **A probe whose memory is at its reserve holds its worker pool there** (`P-437`), rather than
  growing and shrinking it every second or two. Its log says *memory is holding the check pool
  back* once per hold and *memory has room for more workers again* when it ends. With
  `workerPoolSize` set, the pair is *workerPoolSize allows more workers than memory holds* and
  *memory has room for the workers the check pool holds again*. The line that ended a hold
  before, in both cases, *nothing is waiting for a worker; memory is no longer holding the check
  pool back*, is gone: match on the new ones if anything watched for it. The pool may sit a
  worker's worth (40 MiB) inside its reserve before it gives one back, and a few checks behind a
  large pool wait up to 200 ms before it grows for them
  ([a probe held back by memory](administration.md#a-probe-held-back-by-memory)).
- **Probe Health warns while its resolver gives checks up** (`P-441`): 100 in five minutes for
  want of an answer, from DNS not answering, puts it in Warning with the domains not answering
  in its message, where it stayed Up through any outage. A trigger on Probe Health's Warning now
  fires once for such an outage, beside the sensors that fail in it
  ([Probe Health](administration.md#probe-health--msprobehealth)).
- **A probe left on rc.2 keeps working, and its newer channels gap.** Core and probe negotiate down
  to the older version
  ([ADR-001 Decision 13](ADR-001-architecture.md#decision-13--protocol-versions-negotiate-down-they-do-not-gate-admission)).
  For a probe at 28, Probe Health channels that arrived after it gap, `lookupsInFlight` among them
  ([Probe Health](administration.md#probe-health--msprobehealth)), and on Debian and Ubuntu its
  ICMP sensors are Down (above). Bring the probes level.

### From a build older than rc.2

Each of these was in rc.1 and rc.2 already:

- **The names the core answers to** (`A-47`): a browser using a name not in `api.allowedHosts` gets
  421, so list those names before upgrading, and an `api.trustedProxies` range wider than /16 or
  /48 is refused ([installation.md → Upgrading](installation.md#upgrading);
  [the names the core answers to](administration.md#the-names-the-core-answers-to)). An address
  skips the login delay only once a login after the upgrade has recorded it
  ([wrong passwords](administration.md#wrong-passwords)).
- **Vouching** (`A-29`, migration 059): a Sensor Factory, Probe Health or Core Health sensor whose
  writer has since lost access goes Unknown at the first sweep
  ([a sensor that republishes what it reads](administration.md#a-sensor-that-republishes-what-it-reads-is-vouched-for-and-stops-when-that-lapses)).
- **Credentials** ([credentials for monitored devices](administration.md#credentials-for-monitored-devices)):
  - The installation vouches for every set in use at the first start, so nothing is withheld
    (`A-41`).
  - No upgrade changes who receives a secret, with one exception: a set whose targets name only
    addresses now reaches devices named by host name, once their probe speaks protocol 24, or 27
    for database sensors (`A-41c`, `A-62`; [Upgrades](administration.md#upgrades)).
  - A probe below protocol 22 is not sent a set that lists `hostKeys`. For a device given by name,
    a probe below 24 is not sent a set bounded by addresses, and one below 27 not such a database
    set. Their sensors read Unknown until the probe is upgraded.
  - A set written with a mistyped field holds a key no read returns (`A-43`); Core Health's
    **Credential sets to re-enter** counts them, and an audit export from before `A-43` may hold
    the mistyped value.
  - An HTTP transaction with a credential in its path or another header goes Down until edited
    (`A-42`).
- **A script sensor that sets a variable outside `MS_VAR_`** goes Down until renamed (`S-19`)
  ([script sensors](administration.md#script-sensors)).
- **The target policy** (`A-57`): a device on a link-local address that was Up reads Down, and so
  does a database sensor on a name that resolves to one (`A-62`). Set `probe.targetPolicy: none`
  on that probe, or give one device an exception, which needs protocol 28 (`A-64`;
  [one device's exception](administration.md#one-devices-exception-to-the-policy)). `A-70`
  changed four more things for the database sensors, each able to turn Up to Down, and made a
  connect timeout read the same on all three engines: **a trigger or report that matches the old
  words needs the new ones**
  ([the target policy](administration.md#the-target-policy-every-sensor-that-connects-and-the-addresses-it-will-not)).
- **A device given by address** (`A-71`): `tls.certificate`'s *Host name matches* can read 1, and
  the HTTP and TLS sensors no longer send the address as the TLS server name
  ([Upgrades](administration.md#upgrades)).
- **A probe whose protocol version flaps** (`A-72`, migration 069) holds its sensors instead of
  paging, and Probe Health gains `protocolFlap` and `resultsWithheld` ([Upgrades](administration.md#upgrades)).
- **`flowListener.enabled`** in `probe.json` passes the check with a warning, since a v1 build has
  no flow sensor type (`B-08`; [the flow collector](administration.md#the-flow-collector)).
- **A probe below protocol 20** reports its memory channels the old way and can miss a squeeze;
  upgrade it ([what a record's memory channels cover](administration.md#what-a-records-memory-channels-cover)).
- **The units** live in `/usr/lib/systemd/system`. The first upgrade to a build that puts them
  there keeps a unit you edited in `/etc/systemd/system` and names it; until you move the change
  into a drop-in and delete that unit, it overrides the release's whole
  (`H-21`; [the units are the release's](installation.md#the-units-are-the-releases)).
- **A public share link** made by a login since renamed or deleted stops opening. Share links
  belong to maps, which the 1.0 build does not construct
  ([what an account can see](administration.md#what-an-account-can-see)).

### Going back

A build refuses to start against a schema a newer build migrated. Take the migrations down with
the **new** build first, then install the old release
([going back, after a tarball upgrade](installation.md#going-back-after-a-tarball-upgrade), which
also says what taking back 064 and 073 does).

**A probe set to `probe.nameResolver`** (`P-432`): take the key out of `/etc/ms/probe.json` before
installing rc.2 or older on its host. Those builds refuse a key they do not know, and the probe
does not start ([the gate](administration.md#the-gate-a-lookup-helper-for-the-names-dns-answers-probenameresolver)).

## Known limits, and what comes next

- **Windows is release 1.1** (`H-10`): the four `windows.*` types, a probe on Windows, and the MSI
  with WinSW (`H-06`, `H-17`, `T-25`, `R-10`, `S-11`). Monitor Windows servers by ping, port,
  HTTP, TLS and SNMP meanwhile.
- **The field test is still to come** (`H-09`): a clean install on Ubuntu, monitoring 100 real
  devices for a week without intervention, which is 1.0's exit criterion
  ([PLAN.md](PLAN.md), Phase 10; [the runbook](runbook-field-test.md)). It waits on hardware.
- **Name resolution.** A probe looks up a device given by host name through a resolver of its own
  (`P-426`), which keeps each answer 30 s, serves an expired one for up to 5 minutes while the
  system's resolver does not answer, holds a name it does not answer rather than letting every
  check wait on it, and runs at most six `getaddrinfo` lookups at once, giving a lane to the
  zones that answer first
  ([how a probe resolves its devices' names](administration.md#how-a-probe-resolves-its-devices-names)).
  The answers it keeps now survive a restart (`P-438`): written to the probe's spool directory at
  stop and every minute, and read before the first scan, so a probe restarted in the middle of an
  outage answers the zones that answer from that scan, and Probe Health's `answersLoaded` says
  how many it read. And a zone none of whose names has answered from DNS, or with a lookup stuck
  lately, takes at most three of the four lanes for names with nothing kept, and never the last
  lane those share with refreshes, so a first start in the middle of one zone's outage, or a
  restart with no file to read, asks the zones that answer on the fourth from the first scan. A
  resolver that answers every lookup slowly, as one does behind a first nameserver that is down,
  is answering, not silent, and its zones keep every lane. Two zones silent at once can still
  take the four between them, which only the file covers. Measured
  at 5,000 sensors on 500 named devices, before
  ([the first finding](findings/2026-10-17-name-lookups-a-scan.md)) and through the resolver
  ([the second](findings/2026-10-18-name-lookups-through-the-resolver.md)): a resolver taking
  100 ms a lookup, or one zone in ten not answering on a running probe, no longer fails the
  answering devices' checks. Before `P-438`, a cold start in the middle of an outage failed about
  half the answering devices' sensors for one scan. A device given by address is not looked up
  at all. **`probe.nameResolver: gate`** (`P-432`), off by default, asks every name the hosts
  file does not give in a child process of the probe's, the lookup helper, whose lanes hold a
  zone that stops answering to 4 of its 6, so a cold start in the middle of one zone's outage
  answers the other zones from its first scan, with or without the file, and the probe's own
  thread pool is not the silent zone's while the helper is up. A helper that fails is replaced, rests after five
  failures in ten minutes while the probe resolves as `system` does, and raises one Probe Health
  Warning, `lookupHelperTrouble`; a zone that stops answering raises none of its own. Its name
  check asks each name's DNS servers first, as glibc would, and a name they answer within
  250 ms runs on the probe's own lanes, one they do not in the helper; the reply only decides
  where `getaddrinfo` runs and is never an answer. It is off, and every name goes to the
  helper, where the system's name settings are ones it cannot vouch for, and it stands down for
  an hour after three zones in ten minutes where it found silent names the helper answered.
  Probe Health reports what it routed where in eight more channels, at protocol 39
  ([the gate](administration.md#the-gate-a-lookup-helper-for-the-names-dns-answers-probenameresolver)).
  And in either mode Probe Health now warns once for the probe when its resolver gives up 100
  checks in five minutes for want of an answer, naming the domains not answering (`P-441`,
  `lookupsGivenUpRecently`). **Before `v1.0.0`**: add the gate's measurement, and the restart's
  (the cold start and the restart from the file), to this item.
- **Slipped to 1.0.1:**
  - `A-84`: when a probe's protocol flap ends, the core should push that probe its configuration
    and let go what the flap held, and no test has run that step. If Probe Health's
    `protocolFlap` clears and the held sensors still read Unknown, restart that probe.
  - `P-401`: a build check against one kind of defect, a database error caught inside a
    transaction without a savepoint, which loses that transaction's writes. The three known
    cases were fixed (`P-253`). Nothing for an operator to do.
- **Also open:**
  - The x86_64 `.deb` has not been installed on Ubuntu (`H-29`).
  - Two setup paths have run only in containers: the core's database password as an encrypted
    credential, and the ICMP setting across a reboot (`H-36`). Check whichever you use after the
    first reboot.
  - `dnf swap` between `ms` and `ms-probe`, either way, leaves the new package's services enabled
    and started as its setup says, a setup that failed part-way included, between this
    release's packages (`H-40`). From an `.rpm` of rc.2 or older it should end the same, but has
    not been run from one (`H-45`): afterwards, `systemctl is-enabled ms-probe` should say
    `enabled` (`systemctl enable ms-probe` if not), and the probe should be running only where
    the setup said it started the services; if the setup said it started them and
    `systemctl is-active ms-probe` says otherwise, `sudo systemctl start ms-probe`. A swap from
    `ms-probe` to `ms` on a probe's host is the core's first installation, which starts nothing,
    the probe included, until the core has a database password; then start both. A probe that
    serves a core elsewhere can be started at once with `sudo systemctl start ms-probe`; it
    keeps dialling the core in `/etc/ms/probe.json` until you change that file
    ([installation.md §2](installation.md#2-the-application)).
  - The two ways of watching the core from outside have run against a packaged core, but on the
    core's own host against 127.0.0.1, not from another machine (`H-25`;
    [watching the core from outside](administration.md#watching-the-core-from-outside)).

## Verified

**Verified:** `v1.0.0-rc.3` at `<commit, filled at the rc.3 cut>`, on `<date>`: the four smoke
tests of [runbook-field-test.md](runbook-field-test.md), with their results in the rc.3 record.
rc.2, for comparison, is `0a43b7bf`, cut 2026-10-04
([its record](findings/2026-10-04-v1-release-candidate-cut.md)).
