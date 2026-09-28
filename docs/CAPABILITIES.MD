# PRTG Capability Inventory

Reference specification for the MonitoringSystem project. This document catalogues what
PRTG Network Monitor does, so we know precisely what we are building toward. It is a
_description of PRTG_, not a description of our implementation — see `PLAN.md` for what
we actually build and in what order.

**Scope markers** used throughout:

| Marker  | Meaning                                                          |
| ------- | ---------------------------------------------------------------- |
| `[V1]`  | In scope for v1 "core parity"                                    |
| `[V2]`  | Deferred to a later release                                      |
| `[OUT]` | Deliberately out of scope — PRTG-specific, or not worth the cost |

`[V1]` covers the 1.x line, not 1.0 alone. **1.0 is Linux-only** (decided 2026-09-28, `H-10`), so
a `[V1]` row that needs Windows says **not in 1.0 … 1.1** beside its marker, and its work is
`TASKS.md`'s *Release 1.1 — Windows*. A count of `[V1]` rows is the 1.x scope; for 1.0, leave those
out.

Sources: the Paessler PRTG Manual (`paessler.com/manuals/prtg`) and Paessler Helpdesk KB,
researched 2026-08-24. Where two Paessler pages disagree, both figures are given.

---

## 1. The core object model

PRTG's entire product is built on one tree:

```
Root
 └── Probe            execution host — runs the actual checks
      └── Group       organisational container (nestable)
           └── Device an IP address or DNS name + credentials
                └── Sensor   one check against that device
                     └── Channel  one numeric/string series produced by that check
```

| Capability                                                 | Notes                                                                                                                                             | Scope  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Root → Probe → Group → Device → Sensor → Channel hierarchy | Nestable groups; every object has an ID, name, tags, priority, comments                                                                           | `[V1]` |
| Setting inheritance down the tree                          | Any inheritable setting resolves to the nearest ancestor that defines it; child may override, and reverting to "inherit" discards the local value | `[V1]` |
| Same host as multiple Device objects                       | Deliberately allowed, so one host can carry several credential sets / sensor sets                                                                 | `[V1]` |
| Tags + inherited parent tags                               | Free-form labels, case-insensitive, used for filtering and library rules                                                                          | `[V1]` |
| Priority (1–5 stars)                                       | Sorts objects in lists; 5-star maps appear in the Home menu                                                                                       | `[V1]` |
| Object comments                                            | Free-text note per object, available as a notification placeholder                                                                                | `[V1]` |

### 1.1 Channels

A channel is the unit that actually holds data and drives sensor state.

| Capability                                                 | Scope                                             |
| ---------------------------------------------------------- | ------------------------------------------------- |
| Multiple channels per sensor (e.g. Traffic In / Out / Sum) | `[V1]`                                            |
| Primary channel (shown in lists and mini-graphs)           | `[V1]`                                            |
| Unit (bytes, bit/s, %, ms, count, custom)                  | `[V1]`                                            |
| Scaling multiplication / division factors                  | `[V1]`                                            |
| Decimal places (auto / all / fixed)                        | `[V1]`                                            |
| Upper + lower **error** limits → sensor **Down**           | `[V1]`                                            |
| Upper + lower **warning** limits → sensor **Warning**      | `[V1]`                                            |
| Custom limit messages appended to the sensor message       | `[V1]`                                            |
| Show/hide in graphs; show/hide in tables                   | `[V1]`                                            |
| Line colour and line width                                 | `[V2]`                                            |
| Value mode for absolute values (average / min / max)       | `[V2]`                                            |
| Data display mode (absolute vs % of a defined maximum)     | `[V2]`                                            |
| Spike filter (discard readings outside min/max)            | `[V1]`                                            |
| Vertical axis scaling (automatic / manual)                 | `[V2]`                                            |
| Recommended ceiling of ~50 channels per sensor             | Paessler states >50 is "not officially supported" | —   |

### 1.2 Lookups

Lookups translate raw integers into human-readable text **and** a sensor state, so a
device returning `1` displays "Toner Low" and turns the sensor Warning.

| Capability                | Notes                                                                                                  | Scope  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| Lookup definition files   | PRTG uses XML `.ovl` files in `\lookups`, with `\lookups\custom` overriding built-ins by matching `id` | `[V1]` |
| `SingleInt` lookups       | One value → one state + text                                                                           | `[V1]` |
| `Range` lookups           | `from`/`to` numeric range → state + text                                                               | `[V1]` |
| `BitField` lookups        | Individual bits rendered as separate simultaneous states                                               | `[V2]` |
| `Boolean` lookups         | On/off rendered as a switch                                                                            | `[V2]` |
| `undefinedState` fallback | State applied to values not listed                                                                     | `[V1]` |
| `desiredValue`            | Used when computing "coverage" percentages                                                             | `[V2]` |

---

## 2. Sensor states and state machine

Eight states, colour-coded. Six of them are `[V1]`; **Down (Partial)** needs clustering and
**Unusual** needs historic baselining, so both are `[V2]`:

| State                                | Meaning                                                                                     | Scope  |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| **Up** (green)                       | Last scan succeeded, data received                                                          | `[V1]` |
| **Warning** (yellow)                 | Problem detected, may soon go Down; also raised by channel warning limits                   | `[V1]` |
| **Down** (red)                       | Unreachable, or the sensor detected an error. No channel data recorded                      | `[V1]` |
| **Down (Acknowledged)** (bright red) | A user acknowledged the alarm; no further notifications fire                                | `[V1]` |
| **Down (Partial)** (green/red)       | Cluster only — nodes disagree about the sensor's state                                      | `[V2]` |
| **Unusual** (orange)                 | Reading deviates from the historic pattern for this weekday/time. Configurable, disableable | `[V2]` |
| **Paused** (blue)                    | Manually, by schedule, or by dependency                                                     | `[V1]` |
| **Unknown** (grey)                   | No data yet, or a communication error                                                       | `[V1]` |

Transition rules:

- **Two-step failure**: the first failed scan sets **Warning**, the second consecutive failure
  sets **Down**. This suppresses alarms from momentary blips. `[V1]`
- The two-step rule does **not** apply to states produced by channel limits or lookups — those
  take effect immediately. `[V1]`
- The behaviour is configurable per sensor via the "if a sensor query fails" setting
  (`errorintervalsdown`). Paessler's recommended default is _warning for one interval, then down_. `[V1]`
- A paused sensor collects no data, does not change state, and fires no notifications. The
  paused state survives a core-server restart. `[V1]`

---

## 3. Sensor catalogue

PRTG ships **250+ sensor types**. It groups them by monitored technology: General, Backup &
Replication, Bandwidth, Cloud Service, Custom, Database Server, eHealth (DICOM/HL7),
EXE/Script, Hardware Parameter, IoT/IIoT, Linux/Unix/macOS, Mail Server, SNMP,
Storage & File Server, Virtual Server, Web Server, Windows WMI/PerfCounter, VoIP & QoS,
and Various Server/Applications.

We do not chase 250. v1 targets roughly **40 sensor types** covering the technologies that
account for most real deployments.

### 3.1 Connectivity `[V1]`

| Sensor               | Description                                                       |
| -------------------- | ----------------------------------------------------------------- |
| Ping                 | ICMP echo; availability + round-trip time                         |
| Ping Jitter          | Latency variance across repeated echoes                           |
| Port                 | TCP connect check against one port                                |
| Port Range           | TCP connect across a range of ports                               |
| DNS                  | Resolves a record; validates the resolved value and response time |
| DNS Blocklist        | Asks a set of DNSBLs whether this device's address is listed. Added by `T-23` as its worked example — not a PRTG sensor, and cheap enough to be worth having |
| Traceroute Hop Count | Hop count to a target `[V2]`                                      |

### 3.2 Web / HTTP `[V1]`

| Sensor             | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| HTTP               | GET a URL; status code + load time                                        |
| HTTP Advanced      | Custom method, headers, POST body, auth, redirect and response validation |
| HTTP Content       | Fetch and match a content string / extract numeric values                 |
| HTTP Transaction   | Multi-step scripted request sequence with per-step validation             |
| HTTP Push Data     | Inbound webhook — external systems POST values to us `[V2]`               |
| HTTP Full Web Page | Full browser-style page load including sub-resources `[V2]`               |
| REST Custom        | Call a REST endpoint, parse JSON or XML into channels via JSONPath or XPath |

### 3.3 TLS / certificates `[V1]`

| Sensor                 | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| SSL/TLS Certificate    | Validity, expiry countdown, chain, hostname match                |
| SSL/TLS Security Check | Offered protocol versions and cipher suites, flagged by weakness |

### 3.4 SNMP `[V1]`

| Sensor                   | Description                                                                   |
| ------------------------ | ----------------------------------------------------------------------------- |
| SNMP Traffic             | Interface in/out counters, with 32/64-bit counter handling and wrap detection |
| SNMP Custom              | Arbitrary numeric OID                                                         |
| SNMP Custom String       | Arbitrary string OID, with regex extraction and lookup mapping                |
| SNMP Custom Table        | Walk a table, one sensor per row or channels per column                       |
| SNMP CPU Load            | CPU utilisation                                                               |
| SNMP Memory              | Memory usage                                                                  |
| SNMP Disk Free           | Storage table free space                                                      |
| SNMP System Uptime       | Device uptime, with restart detection                                         |
| SNMP Library (`.oidlib`) | Import a MIB-derived OID library and generate sensors from it `[V2]`          |
| SNMP Trap Receiver       | Listen for traps/informs, filter, count and alert `[V1]`                      |

SNMP v1, v2c and v3 (auth + priv) are all required. Note Paessler's scaling caveat: v3 is
limited by per-request crypto cost and does not scale simply by adding CPU.

### 3.5 Windows `[V1]` (subset, not in 1.0 — 1.1) / `[V2]` (rest)

| Sensor                                                  | Description                           | Scope                                           |
| ------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| Windows CPU Load                                        | CPU utilisation                       | `[V1]` — not in 1.0: needs a Windows probe, 1.1 |
| WMI Memory                                              | Memory usage                          | `[V1]` — not in 1.0: needs a Windows probe, 1.1 |
| WMI Volume                                              | Logical disk free space / usage       | `[V1]` — not in 1.0: needs a Windows probe, 1.1 |
| WMI Service                                             | Named service running state           | `[V1]` — not in 1.0: needs a Windows probe, 1.1 |
| WMI Event Log                                           | Event log entries matching filters    | `[V2]`                                          |
| WMI Custom / WMI Custom String                          | Arbitrary WQL query                   | `[V2]`                                          |
| PerfCounter Custom                                      | Arbitrary Windows performance counter | `[V2]`                                          |
| Windows Process / Print Queue / Pagefile / Network Card | Windows-native specifics              | `[V2]`                                          |

**Not in 1.0**, which is Linux-only: these four run PowerShell's CIM cmdlets from a probe *on*
Windows, and 1.0 installs no probe there. They stay in the tree and in the full build, the v1 build
profile leaves them out of 1.0's catalogue (`H-12`), and they come back in 1.1 once `T-25` has run
them against Windows — none of their queries ever has.

Implementation note: there is no maintained WMI client for Node. Windows checks go through a
PowerShell `Get-CimInstance` shell-out from a probe running on Windows (`T-09`) — one such probe
reaches many Windows machines, since `-CimSession` is WinRM, but an installation with no Windows
probe cannot monitor Windows at all. `ADR-001` question 3 records why an in-house WinRM client
was not the answer for v1.

### 3.6 Linux / Unix / macOS over SSH `[V1]`

| Sensor           | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| SSH Script       | Run a remote script, parse structured stdout into channels |
| SSH Disk Free    | Free space per mount                                       |
| SSH Load Average | 1/5/15-minute load                                         |
| SSH Meminfo      | Memory usage                                               |
| SSH INodes Free  | Free inodes `[V2]`                                         |
| SSH Remote Ping  | Ping executed from the remote host `[V2]`                  |

### 3.7 Mail `[V1]`

| Sensor               | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| SMTP                 | Connect and greet an SMTP server                                |
| POP3 / IMAP          | Connect and optionally authenticate                             |
| SMTP&IMAP Round Trip | Send a test message, wait for delivery, measure end-to-end time |
| SMTP&POP3 Round Trip | Same, via POP3 — pulled into v1 by `T-17`, since one sensor does both |

### 3.8 Databases `[V1]`

| Sensor                         | Description                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------- |
| PostgreSQL                     | Connect, run a query, first result cell and further columns as channels, server-side statement timeout |
| MySQL / MariaDB                | As above                                                                      |
| Microsoft SQL                  | As above                                                                      |
| Oracle SQL / Oracle Tablespace | As above `[V2]`                                                               |

### 3.9 Bandwidth and traffic analysis

| Sensor               | Description                                       | Scope   |
| -------------------- | ------------------------------------------------- | ------- |
| NetFlow v5           | Flow collector with per-protocol/host channels    | `[V2]`  |
| NetFlow v9 / IPFIX   | Template-based flow collection                    | `[V2]`  |
| jFlow v5 / sFlow     | Juniper / sFlow variants                          | `[V2]`  |
| Custom flow variants | User-defined channel/filter rules per flow sensor | `[V2]`  |
| Packet Sniffer       | Passive capture and traffic classification        | `[OUT]` |

Flow is `[V2]` because the Node ecosystem has no maintained NetFlow/IPFIX collector — this
is a build-it-ourselves subsystem, not a library integration.

### 3.10 Log and event ingestion

| Sensor             | Description                                                          | Scope  |
| ------------------ | -------------------------------------------------------------------- | ------ |
| Syslog Receiver    | RFC 3164/5424 over UDP/TCP; filter rules; message counts as channels | `[V1]` |
| SNMP Trap Receiver | See §3.4                                                             | `[V1]` |

### 3.11 Script / custom `[V1]`

| Sensor              | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| EXE/Script          | Run a local executable/script; parse simple `value:message` output |
| EXE/Script Advanced | Same, but the script emits structured multi-channel output         |
| REST Custom         | See §3.2                                                           |

PRTG has no dedicated Python sensor — Python runs through EXE/Script.

### 3.12 Virtualisation and containers `[V2]`

VMware Host Performance / Virtual Machine / Datastore (SOAP + REST), Hyper-V Host /
Virtual Machine / Virtual Network Adapter / Cluster Shared Volume, Citrix XenServer,
Proxmox VE (cluster health, node performance, VM/container status), Docker Container Status.

### 3.13 Cloud and SaaS `[V2]`

AWS EC2 / EBS / ELB / RDS / Alarm / Cost, Azure SQL Database and Storage Account,
Microsoft 365 Service Status and Mailbox, Cisco Meraki License and Network Health.

### 3.14 IoT / industrial `[V2]`

MQTT (subscribe and evaluate), OPC UA, Modbus TCP/RTU.

### 3.15 Composite and meta sensors

| Sensor               | Description                                                                                                                      | Scope  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Sensor Factory**   | Virtual sensor whose channels are formulas over other sensors' channels (`channel(id,ch) + channel(id,ch)`), with its own limits | `[V1]` |
| **Business Process** | Weighted rollup of many sensors into a single service-level status                                                               | `[V2]` |
| **Cluster Health**   | Health of the monitoring cluster                                                                                                 | `[V2]` |
| **Core Health**      | Health of the core server (CPU, memory, queue depth, config age)                                                                 | `[V1]` |
| **Probe Health**     | Probe status, connection health, lag                                                                                             | `[V1]` |
| **System Health**    | Health of the monitored host                                                                                                     | `[V2]` |

### 3.16 Vendor-specific SNMP sensors `[OUT for v1]`

PRTG ships dozens of pre-canned vendor sensors (Cisco, Dell, HPE, NetApp, IBM, Juniper,
QNAP, Synology, Fujitsu, SonicWall, APC, Rittal, Poseidon…). We reproduce this class through
**device templates + SNMP Custom/Table sensors** rather than hardcoded types — a much better
cost/coverage ratio, and it lets users add their own vendors.

---

## 4. Scanning, scheduling and control

| Capability                                             | Notes                                                                                                                                                                                                                                   | Scope  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Per-sensor scanning interval                           | PRTG offers 30s, 1m, 5m, 10m, 15m, 30m, 1h, 4h, 6h, 12h, 24h. Root default is 1 minute                                                                                                                                                  | `[V1]` |
| Interval inheritance from parent                       | `[V1]`                                                                                                                                                                                                                                  |
| "If a sensor query fails" retry policy                 | Options run from _set down immediately_ through _warn for N intervals then down_; recommended default is 1 warning interval                                                                                                             | `[V1]` |
| Per-sensor timeout                                     | `[V1]`                                                                                                                                                                                                                                  |
| **Schedules**                                          | Reusable named time patterns, assigned as an inheritable setting. Two authoring modes: a weekday × hour time-table grid, and a period list in `ww:hh:mm-ww:hh:mm` form (e.g. `fr:19:30-mo:06:05`) that states whether the periods are the monitored times or the suspended ones. Each carries its own time zone, so office hours move with daylight saving. During inactive periods, monitoring, notifications **and** reports pause | `[V1]` |
| **Maintenance windows**                                | One-time pause with start/end datetime, on any object. Nothing is paused until it starts; cancelled at any point — before or during — by resuming the object                                                                             | `[V1]` |
| **Manual pause**                                       | Indefinite, or 5m / 15m / 1h / 3h / 1d presets, or a custom end time, with an optional pause message                                                                                                                                    | `[V1]` |
| Hierarchical pause cascade                             | Pausing a group pauses everything beneath it; children paused by cascade cannot be individually resumed                                                                                                                                 | `[V1]` |
| Simulated error state                                  | Force a sensor Down to test notification chains                                                                                                                                                                                         | `[V1]` |
| **Dependencies**                                       | A sensor pauses when its master object goes Down (or is itself paused by dependency). Modes: _use parent_, _select object_, _master object for parent device_. The master must be a sensor, and a dependency that would form a loop is refused. Auto-discovery sets the device's Ping sensor as master by default | `[V1]` |
| Dependency delay after recovery                        | Keeps dependents paused briefly after the master recovers, to avoid flap storms                                                                                                                                                         | `[V1]` |
| Manual/schedule pauses do not cascade _via dependency_ | Only a genuine Down status triggers dependent pausing                                                                                                                                                                                   | `[V1]` |

---

## 5. Alerting and notification

### 5.1 Notification triggers

Triggers are configured on any object and inherited downward; a child's trigger tab shows
both its own and every inherited trigger.

| Trigger               | Settings                                                                                                                                                                                                                               | Scope  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **State trigger**     | Which state (Down / Warning / Unusual / Down Partial / Up / Unknown); initial latency in seconds; initial notification; escalation latency; escalation notification; repeat interval in minutes; recovery notification on return to Up | `[V1]` |
| **Threshold trigger** | Channel, condition (above / below / equal / not equal), value, latency, trigger notification, clear notification                                                                                                                       | `[V1]` |
| **Speed trigger**     | Channel, condition, value, unit scale (bit…Tbit or Byte…TB), time base (s/m/h/d), latency, trigger + clear notification                                                                                                                | `[V2]` |
| **Volume trigger**    | Channel, volume threshold, scale, period (hour/day/week/month), notification                                                                                                                                                           | `[V2]` |
| **Change trigger**    | Fires when a monitored value changes (sensor-type dependent)                                                                                                                                                                           | `[V2]` |

Inheritance accumulates: a child's triggers add to its ancestors' rather than replacing them, so
a trigger on the root and one on a device both fire. One flag opts out of it.

| Capability                       | Notes                                                                                                                                                                                                                                                                                        | Scope  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Per-object trigger inheritance   | An object can be fenced off from its ancestors' triggers entirely: its own still apply, and so do those of everything beneath it, but nothing from above. This is the only way to say "keep monitoring this, but do not notify about it" — a lab, a staging rack, a customer being onboarded | `[V1]` |

### 5.2 Notification templates

A template defines _what is sent and how_. PRTG's setup chain is:
delivery settings → per-user contacts → templates → triggers on objects.

| Delivery method                                                     | Scope                                       |
| ------------------------------------------------------------------- | ------------------------------------------- |
| Email (SMTP; HTML / plain / custom text; priority; sender override) | `[V1]`                                      |
| Execute HTTP action (generic webhook — covers most integrations)    | `[V1]`                                      |
| Slack message                                                       | `[V1]`                                      |
| Microsoft Teams message                                             | `[V1]`                                      |
| Execute program / script                                            | `[V1]`                                      |
| Assign ticket                                                       | `[V2]` — the ticket system itself is `[V2]` |
| Send push notification to a mobile app                              | `[V2]`                                      |
| SMS / pager (provider list or custom URL)                           | `[V2]`                                      |
| Send syslog message                                                 | `[V2]`                                      |
| Send SNMP trap                                                      | `[V2]`                                      |
| Add entry to event log                                              | `[OUT]`                                     |
| Amazon SNS                                                          | `[V2]`                                      |
| MQTT publish                                                        | `[V2]`                                      |
| OPC UA                                                              | `[OUT]`                                     |

Template features:

| Capability                                                                                                      | Notes                                                                                                                                                                                                                               | Scope  |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Placeholder substitution                                                                                        | `%sensor`, `%device`, `%group`, `%probe`, `%status`, `%laststatus`, `%lastmessage`, `%lastvalue`, `%datetime`, `%since`, `%linksensor`, `%priority`, `%comments`, `%objecttags`, `%host`, `%location`, `%sitename`…                 | `[V1]` |
| Recipients as users, user groups, or raw addresses                                                              | `[V1]`                                                                                                                                                                                                                              |
| Template activation schedule                                                                                    | With "collect and send when reactivated" vs "discard" for suppressed notifications                                                                                                                                                  | `[V1]` |
| **Summarisation modes**                                                                                         | 1) always immediate; 2) first down then summarise; 3) first down and up then summarise (**default**); 4) all downs immediate, summarise others; 5) all downs and ups immediate; 6) always summarise. Window configurable in minutes | `[V1]` |
| Summarisation limits                                                                                            | ~1000 chars per summary message, max 25 notifications per message, overflow splits into multiple messages                                                                                                                           | `[V1]` |
| Methods never summarised                                                                                        | Slack, Teams, HTTP action, execute program, assign ticket always send immediately                                                                                                                                                   | `[V1]` |
| Send test notification                                                                                          | `[V1]`                                                                                                                                                                                                                              |
| "Used by" reverse lookup                                                                                        | `[V1]`                                                                                                                                                                                                                              |
| Per-group access rights on templates                                                                            | `[V2]`                                                                                                                                                                                                                              |
| SMTP config: relay, port, auth (none/SMTP/SASL), TLS negotiation, sender + HELO ident, primary + fallback relay | `[V1]`                                                                                                                                                                                                                              |

### 5.3 Acknowledgement

| Capability                                                                       | Scope  |
| -------------------------------------------------------------------------------- | ------ |
| Acknowledge a Down alarm → state becomes Down (Acknowledged), notifications stop | `[V1]` |
| Acknowledge until: indefinitely / 5m / 15m / 1h / 3h / 1d / specific datetime    | `[V1]` |
| Acknowledgement message stored as the sensor's last message                      | `[V1]` |
| Expiry reverts to plain Down and notifications resume                            | `[V1]` |
| Pause-then-resume clears the acknowledgement                                     | `[V1]` |
| Withdraw an acknowledgement directly, for the one it was applied to by mistake   | `[V1]` |
| Permission to acknowledge grantable to read-only users                           | `[V1]` |

---

## 6. Views, dashboards and reporting

| Capability              | Notes                                                                                                                                                                                                                                                                                                   | Scope  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Device tree**         | Live status tree with per-object rollup colouring                                                                                                                                                                                                                                                       | `[V1]` |
| **Alarms view**         | All sensors in Down / Down (Partial) / Down (Acknowledged) / Warning / Unusual, globally or scoped to a branch, filterable                                                                                                                                                                              | `[V1]` |
| **Logs**                | All past activity: status changes (up/down/warning/unusual/paused/acknowledged), system events (reports, cluster, auto-discovery, notifications), and object history (config changes, deletions)                                                                                                        | `[V1]` |
| **Sensor detail page**  | Live graph, channel table, historic tabs (2 days / 30 days / 365 days), log, settings, notification triggers                                                                                                                                                                                            | `[V1]` |
| **Live graphs**         | Auto-refreshing, per-channel toggles                                                                                                                                                                                                                                                                    | `[V1]` |
| **Maps / dashboards**   | Drag-and-drop designer producing an HTML page: status icons, live graphs, data tables, sensor lists, connector lines, geo maps, custom HTML, background images. Publicly shareable by URL; 5-star maps surface in the Home menu                                                                         | `[V2]` |
| **Libraries**           | Alternate device-tree views assembled from filter rules (by type, status, tag) across unrelated branches. Library sensors don't double-count against the licence                                                                                                                                        | `[V2]` |
| **Reports**             | Templates (graph + data table, data table only, graph only, sensor list, installation report, top-100 highest/lowest, top-10/100 uptime comparison)                                                                                                                                                     | `[V2]` |
| Report scheduling       | One-off "run now", or hourly / daily / weekly / monthly / quarterly / annual                                                                                                                                                                                                                            | `[V2]` |
| Report time spans       | Day/week/month/quarter/year with custom start and end; >500 days is rejected and auto-shortened to 365; 40–500 day spans force ≥60-minute averaging                                                                                                                                                     | `[V2]` |
| Report output           | HTML, PDF, CSV, XML; delivery by store, store+email, or email only; optional ZIP                                                                                                                                                                                                                        | `[V2]` |
| Report security context | Report runs under a named user's visibility scope                                                                                                                                                                                                                                                       | `[V2]` |
| **Ticket system**       | User tickets (manual, assigned to a user/group, with priority and comments), ToDo tickets (system-generated: discovery finished, new probe connected, update available, report ready, system errors), notification tickets (from the Assign Ticket delivery method). Lifecycle Open → Resolved → Closed | `[V2]` |
| Geographical maps       | `[V2]`                                                                                                                                                                                                                                                                                                  |
| Top-10 / top-N lists    | `[V2]`                                                                                                                                                                                                                                                                                                  |

---

## 7. Discovery and provisioning

| Capability                          | Notes                                                                                                     | Scope  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| **Auto-discovery, 3 stages**        | 1) ping sweep for live hosts, 2) identify each host via SNMP/WMI/other, 3) create the matching sensor set | `[V1]` |
| IP range scanning                   | PRTG supports up to 65,536 addresses per discovery (which can run for days)                               | `[V1]` |
| Discovery levels                    | Ping only, standard, detailed — with a time estimate per level before starting (`D-06`)                    | `[V1]` |
| **Device templates**                | Named recommended sensor sets per device class; built-in plus user-authored                               | `[V1]` |
| Scheduled rediscovery               | Hourly / daily / weekly, optionally auto-creating newly appeared devices. Off by default                  | `[V1]` |
| Discovery run summary               | Scanned, found, identified, created, errors — one sentence and the table under it (`D-08`)                 | `[V1]` |
| Discovery results logged as tickets | `[V2]` — the summary above is the v1 answer to the same need: a run says what it did without a ticket queue |
| Bulk edit / clone / move objects    | Pause, resume, move, clone, delete, set and revert a setting over a selection; per-object outcome (`D-09`)   | `[V1]` |
| Import/export of configuration      | `[V2]`                                                                                                    |

---

## 8. Distributed monitoring

| Capability                   | Notes                                                                                                                                                                                                                                                                                                            | Scope  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Local probe**              | Created automatically on the core server; does all monitoring in single-server setups                                                                                                                                                                                                                            | `[V1]` |
| **Remote probes**            | Run on separate hosts to reach isolated networks. The probe dials **out** to the core (default TCP 23560 classic / 23562 multi-platform), so no inbound firewall rule to the remote site is needed                                                                                                               | `[V1]` |
| TLS on the probe channel     | PRTG offers TLS 1.2/1.3 security levels                                                                                                                                                                                                                                                                          | `[V1]` |
| Probe identity + approval    | Each probe gets a GID; the core holds one or more access keys the probe must present, an allowed-source-IP list, and a deny-by-GID list to revoke a single probe. Done in `R-01`: an unapproved probe is welcomed, heartbeats and receives **no configuration**, so it waits in a queue rather than being trusted for connecting; the key it presents afterwards is its own, issued once at approval | `[V1]` |
| Buffering across disconnects | PRTG caches up to 500,000 results **in RAM only** — a probe restart during the outage loses them. Our design should improve on this with a disk-backed spool                                                                                                                                                     | `[V1]` |
| Cross-platform probes        | PRTG's newer "multi-platform" probes run on Linux; classic probes are Windows-only                                                                                                                                                                                                                               | `[V1]` — Linux in 1.0; a probe on Windows is not in 1.0: 1.1 (`R-10`) |
| **Failover cluster**         | 1 primary master + up to 4 failover nodes (5 total). Active-active: every node monitors everything independently and keeps its own database, so load scales _up_ with node count. Config is edited on the master only and pushed in real time. Only the acting master sends notifications. Inter-node port 23570 | `[V2]` |
| Cluster caveats              | The admin password is not synchronised; remote probes connect only to the primary master; multi-platform probes can't be cluster remote probes; monitoring gaps from node outages are not backfilled                                                                                                             | —      |

---

## 9. Data storage and retention

| Capability                      | PRTG's approach                                                                                               | Scope                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Configuration store             | A single XML file (`PRTG Configuration.dat`) plus `.old` and rolling auto-backups                             | `[V1]` (we use a database instead) |
| Monitoring database             | Proprietary files under `\Monitoring Database`, plus a precomputed graph cache                                | `[V1]`                             |
| Raw data retention              | Raw, unaveraged data retained up to **40 days**                                                               | `[V1]`                             |
| Averaging intervals             | 15/30/60s, 2–60 minutes, 2–24 hours                                                                           | `[V1]`                             |
| Forced averaging on long spans  | 40–500 day ranges force ≥60-minute averages; >500 days is capped at 365                                       | `[V1]`                             |
| Log storage                     | Plain text per component (`core`, `probe`, `sensors`, `webserver`, `audit`) plus a recent-events log database | `[V1]`                             |
| Report and ticket storage       | `\Report PDFs`, `\Ticket Database`                                                                            | `[V2]`                             |
| System information cache        | Hardware, process, service inventory                                                                          | `[V2]`                             |
| Purging / housekeeping settings | Configurable retention per data class                                                                         | `[V1]`                             |

---

## 10. Users, access control and security

| Capability                                       | Notes                                                                                                                                                                                                                                                                    | Scope         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Local user accounts                              | Login name, display name (≤240 chars), email, password                                                                                                                                                                                                                   | `[V1]`        |
| Read/write vs read-only account types            | Read-only users cannot join admin groups, cannot use tickets, cannot see stored credentials — enforced at account level regardless of group                                                                                                                              | `[V1]`        |
| User groups + one primary group per user         | Access to tree, libraries, maps and reports is granted **per group**, not per user                                                                                                                                                                                       | `[V1]`        |
| Object access rights: none / read / write / full | Write adds editing, object creation/deletion, alarm acknowledgement, notification management; full adds editing that object's group rights                                                                                                                               | `[V1]`        |
| Access-right inheritance up the tree             | Resolve at the nearest ancestor that defines the right; explicit beats inherited; highest right wins across multiple groups                                                                                                                                              | `[V1]`        |
| Credential vaults inherited per object           | Windows, Linux/SSH, SNMP, VMware, database credential sections set once at group/device level                                                                                                                                                                            | `[V1]`        |
| **API tokens**                                   | Per-user token; PRTG additionally supports a legacy `username`+`passhash` pair                                                                                                                                                                                           | `[V1]`        |
| Password hashing + MFA                           | PRTG does not document TOTP MFA; we add it                                                                                                                                                                                                                               | `[V1]` (TOTP) |
| **LDAP / Active Directory**                      | PRTG requires the core to be a domain member, supports only one domain, only whole AD groups (no individual users), no nested groups, no trusted/child domains, with hourly membership cache refresh. We should do better: plain LDAP bind, any directory, nested groups | `[V2]`        |
| **Single sign-on**                               | PRTG supports OIDC / OAuth 2.0 against Entra ID and Okta. SAML is not documented as supported                                                                                                                                                                            | `[V2]`        |
| Audit log of configuration changes               | `[V1]`                                                                                                                                                                                                                                                                   |
| Secrets encrypted at rest                        | PRTG stores credentials in the config XML; we encrypt them                                                                                                                                                                                                               | `[V1]`        |

---

## 11. HTTP API

PRTG exposes `/api/*.xml` and `/api/*.json` endpoints, authenticated with `username`+`passhash`
or an `apitoken` query parameter.

| Endpoint class                        | Examples                                                                                                                 | Scope  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| Live data                             | `getobjectstatus`, `getsensordetails`, `table.json` (multi-object listings with filters, sorting, paging)                | `[V1]` |
| Live graphs                           | Rendered graph images by object and time span                                                                            | `[V2]` |
| Historic data                         | `historicdata.json?id=&avg=&sdate=&edate=&usecaption=` — `avg=0` returns raw. PRTG rate-limits this to 5 requests/minute | `[V1]` |
| Object manipulation                   | `setobjectproperty`, pause/resume, acknowledge alarm, add/delete sensor, duplicate object                                | `[V1]` |
| Push endpoints                        | Inbound HTTP Push Data sensors                                                                                           | `[V2]` |
| Custom sensors + custom notifications | Documented extension points                                                                                              | `[V1]` |

Deliberate improvements over PRTG's API for our build: a coherent REST resource model, an
OpenAPI document, cursor pagination, and a WebSocket/SSE stream for live state — rather than
`.htm`-suffixed RPC endpoints and polling.

---

## 12. User interfaces

| Interface                                                   | Scope                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Web GUI (device tree, alarms, logs, sensor pages, setup)    | `[V1]`                                                                     |
| Live-updating status via push rather than full-page polling | `[V1]` (improvement over PRTG)                                             |
| Map/dashboard designer                                      | `[V2]`                                                                     |
| Mobile apps (iOS/Android) with push notifications           | `[OUT]` — a responsive web UI plus webhook/Slack notifications covers this |
| Desktop app / MultiBoard                                    | `[OUT]`                                                                    |

---

## 13. Scale and sizing targets

PRTG's published guidance, which sets our performance bar:

| Sensors  | Cores | RAM   | Disk     | Remote probes |
| -------- | ----- | ----- | -------- | ------------- |
| ≤ 500    | 4     | 4 GB  | 100 GB   | < 30          |
| ≤ 1,000  | 6     | 6 GB  | 500 GB   | < 30          |
| ≤ 2,500  | 8     | 8 GB  | 750 GB   | < 60          |
| ≤ 5,000  | 8     | 12 GB | 1,000 GB | < 60          |
| ≤ 10,000 | 10–12 | 16 GB | 1,500 GB | < 80          |

Beyond ~10,000 sensors Paessler tells customers to deploy a second core server.

Other published limits and caveats:

- Scanning interval guidance: 1 minute up to ~2,000 sensors, 5 minutes above that.
- Per-cluster sensor ceiling: Paessler's own pages give **2,500** (KB) and **5,000**
  (system requirements) — the two disagree. Each cluster node roughly halves per-node capacity.
- Classic remote probe: ≤200 sensors on 2 cores; 2,000–5,000 on 6 cores.
- Multi-platform probe: up to 10,000 sensors on 6 cores / 1 GB RAM.
- WMI: ~120 sensors per probe at 60s intervals (≈600 at 300s).
- VMware: Paessler's pages give both ~30 and ~300 per probe at 60s — again inconsistent.
- Packet sniffing: only recommended below ~50 Mbit/s of steady traffic.
- Fewer than 30 user accounts, fewer than 30 remote probes per installation.
- Fewer than 50 channels per sensor.

**Our v1 target**: 5,000 sensors at a 60-second interval on a single 8-core / 16 GB box,
with p95 check-dispatch jitter under 1 second. We should beat PRTG's per-box numbers
because we are not paying for a Delphi-era single-threaded core.

---

## 14. Licensing

PRTG licenses **per sensor**, not per device. Editions: Trial (unlimited, 30 days, then
degrades to Freeware), Freeware (permanently free, capped at 100 sensors), and Commercial
subscription tiers differentiated by sensor count. `[OUT]` — not applicable to us, but the
sensor-count model is worth noting because it shapes how PRTG users build their trees
(they consolidate aggressively to save licence units; we have no reason to make them).

---

## 15. Explicit non-goals

| Not building                                          | Why                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Packet sniffing / deep packet inspection              | Requires promiscuous capture, poor fit for a Node process, low value relative to flow data |
| The full 250-sensor catalogue                         | Long tail is vendor MIB wrappers — device templates plus SNMP Custom cover it generically  |
| eHealth (DICOM / HL7) sensors                         | Narrow vertical                                                                            |
| Desktop and native mobile clients                     | Responsive web UI plus push integrations                                                   |
| Windows event log write-back as a notification target | Platform-specific, superseded by webhooks                                                  |
| PRTG configuration file compatibility                 | We use a real database; import tooling is `[V2]` at most                                   |
