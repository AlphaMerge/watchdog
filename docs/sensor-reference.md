# Sensor reference

**Generated from the catalogue by `scripts/docs/sensor-reference.mjs`. Do not edit.** `packages/core/test/build-hygiene.test.ts` fails when this file and the code disagree, which is the only way a reference like this stays true.

What a type is *for* is documented where its author wrote it, in `packages/sensors/src/types/`, and how to add one is `docs/adding-a-sensor-type.md`. What is here is the shape: the parameters an operator fills in, what they default to, the channels that come back, and what the type needs in order to run.

44 types in 12 categories.

- **Availability** — `dns.record`, `icmp.jitter`, `icmp.ping`, `port.range`, `port.tcp`
- **Custom** — `core.factory`, `exe.script`, `exe.script.advanced`
- **Database** — `db.mssql`, `db.mysql`, `db.postgresql`
- **Log** — `syslog.receiver`
- **Mail** — `mail.imap`, `mail.pop3`, `mail.roundtrip`, `mail.smtp`
- **Network** — `dns.blocklist`
- **SNMP** — `snmp.cpu`, `snmp.custom`, `snmp.custom.string`, `snmp.diskfree`, `snmp.memory`, `snmp.table`, `snmp.traffic`, `snmp.trap`, `snmp.uptime`
- **SSH** — `ssh.diskfree`, `ssh.load`, `ssh.meminfo`, `ssh.script`
- **System** — `ms.core.health`, `ms.probe.health`
- **Traffic** — `flow.netflow`
- **Web** — `http.advanced`, `http.content`, `http.request`, `http.transaction`, `rest.custom`, `tls.certificate`, `tls.security`
- **Windows** — `windows.cpu`, `windows.memory`, `windows.service`, `windows.volume` (not in 1.0 — release 1.1)

---

## Availability

### `dns.record`

cost: **light**

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `responseTime` | Response time | ms | **primary** |
| `records` | Records returned | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `name` | string | _(empty)_ | ≤ 255 chars |  |
| `recordType` | `A` · `AAAA` · `CNAME` · `MX` · `NS` · `PTR` · `SOA` · `SRV` · `TXT` | `"A"` |  |  |
| `resolver` | string | _(empty)_ | ≤ 64 chars |  |
| `expected` | string | _(empty)_ | ≤ 255 chars |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |

- **Name to look up** (`name`) — The name to resolve. Leave it empty to look up the device’s own host, which is what makes this sensor answer “can this probe still resolve this device”.
- **Resolver** (`resolver`) — The nameserver to ask, as an address. Empty uses the probe’s own system resolver, which is what every other sensor uses — so an empty one here is checking the thing the rest of your monitoring depends on. Naming a server instead watches that server.
- **Expected value** (`expected`) — Optional. The check fails unless one of the records matches this, ignoring case — “10.0.0.5” for an A record, “mail.example.com” for MX. Compared against every record returned, because a name with two addresses answers in either order.

### `icmp.jitter`

cost: **medium**

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `jitter` | Jitter | ms | **primary** |
| `rtt` | Response time | ms | — |
| `min` | Fastest reply | ms | — |
| `max` | Slowest reply | ms | — |
| `loss` | Packet loss | % | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `count` | integer | `20` | ≥ 5, ≤ 60 |  |
| `intervalSeconds` | number | `1` | ≥ 0.2, ≤ 10 |  |
| `packetSize` | integer | `32` | ≥ 8, ≤ 65500 |  |
| `timeoutMs` | integer | `60000` | ≥ 1000, ≤ 300000 |  |

- **Packets** (`count`) — Jitter is a property of the *gaps* between replies, so it needs a run of them — five packets give four gaps, which is not much of a sample. At the default spacing of one second, twenty packets take roughly twenty seconds; keep the scan interval well above that.
- **Seconds between packets** (`intervalSeconds`) — One second here, unlike `icmp.ping`’s 0.2 (`P-07`), and the difference is deliberate: jitter is a measurement of the network *over time*, and twenty packets spaced 0.2 s apart sample four seconds of it rather than twenty. Congestion that comes and goes on a ten-second cycle is invisible in a four-second window. Lower it to make the check cheaper, knowing that is the trade.
- **Timeout** (`timeoutMs`) — For the whole run, not per packet.

### `icmp.ping`

cost: **medium**

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `rtt` | Response time | ms | **primary** |
| `loss` | Packet loss | % | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `count` | integer | `4` | ≥ 1, ≤ 20 |  |
| `intervalSeconds` | number | `0.2` | ≥ 0.2, ≤ 10 |  |
| `packetSize` | integer | `32` | ≥ 8, ≤ 65500 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |

- **Packets** (`count`) — ICMP echo requests per check. At the default spacing of 0.2 s, a count of 4 takes about six-tenths of a second.
- **Seconds between packets** (`intervalSeconds`) — Ping’s own default is one second, which makes a four-packet check a three-second check — measured, that is 20 targets a second across 64 workers where 0.2 s gives 99, with identical reply counts (`P-07`). 0.2 is the floor: below it iputils needs CAP_NET_RAW and BSD needs the superuser. Windows has no such flag and ignores this.
- **Payload size** (`packetSize`) — Bytes of payload per packet, before the ICMP and IP headers.
- **Timeout** (`timeoutMs`) — Overall deadline for the whole run, in milliseconds.

### `port.range`

cost: **medium**

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `open` | Open ports | — | — |
| `closed` | Closed ports | — | — |
| `openPercent` | Open | % | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `ports` | string |  | ≥ 1 chars, ≤ 500 chars | **required** |
| `timeoutMs` | integer | `3000` | ≥ 100, ≤ 60000 |  |
| `concurrency` | integer | `8` | ≥ 1, ≤ 16 |  |

- **Ports** (`ports`) — A list, a range, or both — “22,80,443” or “8000-8010” or “22,8000-8010”. At most 64 in total.
- **Timeout per port** (`timeoutMs`) — A port a firewall *drops* takes this long; a port that is closed is refused immediately. A range of dropped ports therefore costs about this much in total, since they are tried a few at a time.
- **At once** (`concurrency`) — How many ports to try simultaneously. Higher finishes sooner and looks more like a scan to anything watching the far end.

### `port.tcp`

cost: **light**

Setting `banner` adds `bannerMatched`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `connectTime` | Connect time | ms | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer |  | ≥ 1, ≤ 65535 | **required** |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 120000 |  |
| `banner` | string | _(empty)_ | ≤ 200 chars |  |
| `bannerTimeoutMs` | integer | `3000` | ≥ 100, ≤ 30000 |  |

- **Port** (`port`) — The TCP port to connect to on this device.
- **Timeout** (`timeoutMs`) — How long to wait for the connection to complete. A filtered port — one a firewall drops rather than refuses — takes this long every scan, where a refused one comes back immediately.
- **Expected banner** (`banner`) — Optional. After connecting, wait briefly for the service to say something and check it contains this text — “OpenSSH”, “220 mail.example.com”. Matched as plain text ignoring case, not as a regular expression. Leave empty to check only that the port accepts a connection.
- **Banner wait** (`bannerTimeoutMs`) — How long to wait for the service to speak first. Only some do — HTTP does not — so a banner check against a silent protocol will always fail, and that is what it is telling you rather than a fault.

## Custom

### `core.factory`

cost: **light** · evaluated by the core, never by a probe

**The parameters declare the channels** — one per entry in `channels`.

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `channels` | array of object |  | ≥ 1 entries, ≤ 20 entries | **required** |
| `maxAgeSeconds` | integer | `600` | ≥ 30, ≤ 86400 |  |

- **Channels** (`channels`) — Each row is one channel and one formula. The first is the channel this sensor is judged by.
- **Ignore readings older than** (`maxAgeSeconds`) — A source sensor that stopped reporting leaves its last value behind for ever. Past this age it counts as absent — which makes the formula a gap rather than a number computed from something that stopped being true an hour ago.

### `exe.script`

cost: **medium** · runs in a child process

**The parameters name this sensor's channel** — see `valueName`, `unit`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `value` | Value | — | **primary** |
| `runtime` | Run time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `program` | string |  | ≥ 1 chars, ≤ 255 chars | **required** |
| `args` | array of string | _(none)_ | ≤ 20 entries |  |
| `env` | array of object | _(none)_ | ≤ 20 entries |  |
| `secret` | string |  | ≤ 2000 chars | **write-only** |
| `workingDirectory` | string | _(empty)_ | ≤ 500 chars |  |
| `timeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |
| `format` | `prtg` · `number` · `json` | `"prtg"` |  |  |
| `valueName` | string | `"Value"` | ≤ 60 chars |  |
| `unit` | string | _(empty)_ | ≤ 20 chars |  |

- **Program** (`program`) — The file to run, **inside this probe’s script directory** — a name, not a path. That directory is set on the probe and cannot be overridden here, because a sensor that could name any path would make creating a sensor the same thing as running any command as the account this probe holds its credentials in.
- **Arguments** (`args`) — Passed one per entry, never joined into a command line and never through a shell — so a space or a quote in an argument is just a character. `%host`, `%sensorid` and `%device` are substituted.
- **Environment** (`env`) — **Each name starts with `MS_VAR_`**, then capitals, digits and underscores — a variable like `BASH_ENV` or `NODE_OPTIONS` tells the interpreter to run code the sensor’s writer chose, so no other name reaches a script. The program gets **only** these, plus `PATH`, `LANG`, `LC_*` and `TZ` as this probe has them and the placeholders below. It does not inherit the rest of this probe’s environment, which holds whatever arrived through MS_* overrides — handing that to a script is how a credential leaves the machine.
- **Secret** (`secret`) — Passed to the program as `MS_SECRET` in its environment, for a script that needs an API key. Write-only: no API route returns it, to anyone. In the environment rather than an argument, because arguments are world-readable through `ps`. Changing the program, its arguments, its environment or its working directory clears the secret unless you enter it again: those decide where the script sends it.
- **Working directory** (`workingDirectory`) — A directory **inside this probe’s script directory**, named the way the program is. Empty runs the program in the directory it was found in, which is usually right.
- **Timeout** (`timeoutMs`) — The program is sent SIGTERM at this point and killed shortly after — and the whole process *group* is, so a script that backgrounds something does not outlive its own kill.
- **Output format** (`format`) — `prtg` reads `returncode:value:message`, which is what an existing PRTG EXE script already prints. `number` reads the whole of stdout as one number, which is what a one-line shell script naturally produces. `json` reads {"value":…,"message":…}.
- **Channel name** (`valueName`) — What to call the reading on the graph. The channel key is always `value`.

### `exe.script.advanced`

cost: **medium** · runs in a child process

**The parameters name this sensor's channel** — see `primaryChannel`, `primaryName`, `primaryUnit`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `runtime` | Run time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `program` | string |  | ≥ 1 chars, ≤ 255 chars | **required** |
| `args` | array of string | _(none)_ | ≤ 20 entries |  |
| `env` | array of object | _(none)_ | ≤ 20 entries |  |
| `secret` | string |  | ≤ 2000 chars | **write-only** |
| `workingDirectory` | string | _(empty)_ | ≤ 500 chars |  |
| `timeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |
| `primaryChannel` | string | `"value"` | ≥ 1 chars, ≤ 40 chars |  |
| `primaryName` | string | _(empty)_ | ≤ 60 chars |  |
| `primaryUnit` | string | _(empty)_ | ≤ 20 chars |  |

- **Program** (`program`) — The file to run, **inside this probe’s script directory** — a name, not a path. That directory is set on the probe and cannot be overridden here, because a sensor that could name any path would make creating a sensor the same thing as running any command as the account this probe holds its credentials in.
- **Arguments** (`args`) — Passed one per entry, never joined into a command line and never through a shell — so a space or a quote in an argument is just a character. `%host`, `%sensorid` and `%device` are substituted.
- **Environment** (`env`) — **Each name starts with `MS_VAR_`**, then capitals, digits and underscores — a variable like `BASH_ENV` or `NODE_OPTIONS` tells the interpreter to run code the sensor’s writer chose, so no other name reaches a script. The program gets **only** these, plus `PATH`, `LANG`, `LC_*` and `TZ` as this probe has them and the placeholders below. It does not inherit the rest of this probe’s environment, which holds whatever arrived through MS_* overrides — handing that to a script is how a credential leaves the machine.
- **Secret** (`secret`) — Passed to the program as `MS_SECRET` in its environment, for a script that needs an API key. Write-only: no API route returns it, to anyone. In the environment rather than an argument, because arguments are world-readable through `ps`. Changing the program, its arguments, its environment or its working directory clears the secret unless you enter it again: those decide where the script sends it.
- **Working directory** (`workingDirectory`) — A directory **inside this probe’s script directory**, named the way the program is. Empty runs the program in the directory it was found in, which is usually right.
- **Timeout** (`timeoutMs`) — The program is sent SIGTERM at this point and killed shortly after — and the whole process *group* is, so a script that backgrounds something does not outlive its own kill.
- **Primary channel** (`primaryChannel`) — The key of the channel this sensor is judged by. The program must return it every scan; the rest of what it returns becomes channels on their own the first time they appear. For a PRTG-format script this is the first channel’s name in lower case with spaces as underscores — “Free Space” is `free_space`.
- **Primary channel name** (`primaryName`) — Empty uses whatever the program calls it.

## Database

### `db.mssql`

cost: **medium** · credentials: `database`

**The parameters declare the channels** — one per entry in `extract`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `value` | Value | — | **primary** |
| `rows` | Rows returned | — | — |
| `queryTime` | Query time | ms | — |
| `connectTime` | Connect time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `database` | string | _(empty)_ | ≤ 128 chars |  |
| `query` | string |  | ≥ 1 chars, ≤ 8192 chars | **required** |
| `encrypt` | `prefer` · `require` · `disable` | `"prefer"` |  |  |
| `verifyTls` | boolean | `false` |  |  |
| `connectTimeoutMs` | integer | `10000` | ≥ 500, ≤ 120000 |  |
| `statementTimeoutMs` | integer | `30000` | ≥ 500, ≤ 300000 |  |
| `expectRows` | string | _(empty)_ | ≤ 32 chars |  |
| `extract` | array of object | _(none)_ | ≤ 10 entries |  |

- **Port** (`port`) — Zero uses 1433.
- **Database** (`database`) — The database to connect to. Point a monitoring account at the one it is watching and at nothing else — this sensor runs whatever query it is given, with whatever rights the credential has.
- **Query** (`query`) — One statement, run every scan. Anything the database can answer becomes a channel — replication lag, the oldest unprocessed row, how many connections are left. Make it cheap and make it read-only: it runs on every device this sensor is under, for ever.
- **Encryption** (`encrypt`) — `prefer` tries TLS and carries on without it, which is what a command-line client does and what almost every deployment is actually running. `require` refuses the downgrade.
- **Verify the certificate** (`verifyTls`) — Off by default here, unlike every other sensor, and for a reason worth knowing: almost every database server ships with a self-signed certificate nobody replaced. The connection is still encrypted; it is authenticated against nobody. Turn this on where the server has a certificate you actually issued.
- **Statement timeout** (`statementTimeoutMs`) — Asked of the **server**, not enforced by closing the socket — a client that gives up and hangs up leaves the query running, and a check that did that every sixty seconds would become the outage it was meant to warn about.
- **Expected rows** (`expectRows`) — The check fails when the row count is outside this — `1` for a query that must return exactly one, `1+` for at least one, `0` for a query that must return none, `1-10` for a range. Empty accepts anything. A query that quietly started returning nothing is a real failure that a response time reports as perfectly healthy.
- **Extra channels** (`extract`) — The first cell of the first row is always a channel. These are for the other columns of a query that answers several questions at once — one connection instead of five.

### `db.mysql`

cost: **medium** · credentials: `database`

**The parameters declare the channels** — one per entry in `extract`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `value` | Value | — | **primary** |
| `rows` | Rows returned | — | — |
| `queryTime` | Query time | ms | — |
| `connectTime` | Connect time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `database` | string | _(empty)_ | ≤ 128 chars |  |
| `query` | string |  | ≥ 1 chars, ≤ 8192 chars | **required** |
| `encrypt` | `prefer` · `require` · `disable` | `"prefer"` |  |  |
| `verifyTls` | boolean | `false` |  |  |
| `connectTimeoutMs` | integer | `10000` | ≥ 500, ≤ 120000 |  |
| `statementTimeoutMs` | integer | `30000` | ≥ 500, ≤ 300000 |  |
| `expectRows` | string | _(empty)_ | ≤ 32 chars |  |
| `extract` | array of object | _(none)_ | ≤ 10 entries |  |

- **Port** (`port`) — Zero uses 3306.
- **Database** (`database`) — The database to connect to. Point a monitoring account at the one it is watching and at nothing else — this sensor runs whatever query it is given, with whatever rights the credential has.
- **Query** (`query`) — One statement, run every scan. Anything the database can answer becomes a channel — replication lag, the oldest unprocessed row, how many connections are left. Make it cheap and make it read-only: it runs on every device this sensor is under, for ever.
- **Encryption** (`encrypt`) — `prefer` tries TLS and carries on without it, which is what a command-line client does and what almost every deployment is actually running. `require` refuses the downgrade.
- **Verify the certificate** (`verifyTls`) — Off by default here, unlike every other sensor, and for a reason worth knowing: almost every database server ships with a self-signed certificate nobody replaced. The connection is still encrypted; it is authenticated against nobody. Turn this on where the server has a certificate you actually issued.
- **Statement timeout** (`statementTimeoutMs`) — Asked of the **server**, not enforced by closing the socket — a client that gives up and hangs up leaves the query running, and a check that did that every sixty seconds would become the outage it was meant to warn about.
- **Expected rows** (`expectRows`) — The check fails when the row count is outside this — `1` for a query that must return exactly one, `1+` for at least one, `0` for a query that must return none, `1-10` for a range. Empty accepts anything. A query that quietly started returning nothing is a real failure that a response time reports as perfectly healthy.
- **Extra channels** (`extract`) — The first cell of the first row is always a channel. These are for the other columns of a query that answers several questions at once — one connection instead of five.

### `db.postgresql`

cost: **medium** · credentials: `database`

**The parameters declare the channels** — one per entry in `extract`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `value` | Value | — | **primary** |
| `rows` | Rows returned | — | — |
| `queryTime` | Query time | ms | — |
| `connectTime` | Connect time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `database` | string | _(empty)_ | ≤ 128 chars |  |
| `query` | string |  | ≥ 1 chars, ≤ 8192 chars | **required** |
| `encrypt` | `prefer` · `require` · `disable` | `"prefer"` |  |  |
| `verifyTls` | boolean | `false` |  |  |
| `connectTimeoutMs` | integer | `10000` | ≥ 500, ≤ 120000 |  |
| `statementTimeoutMs` | integer | `30000` | ≥ 500, ≤ 300000 |  |
| `expectRows` | string | _(empty)_ | ≤ 32 chars |  |
| `extract` | array of object | _(none)_ | ≤ 10 entries |  |

- **Port** (`port`) — Zero uses 5432.
- **Database** (`database`) — The database to connect to. Point a monitoring account at the one it is watching and at nothing else — this sensor runs whatever query it is given, with whatever rights the credential has.
- **Query** (`query`) — One statement, run every scan. Anything the database can answer becomes a channel — replication lag, the oldest unprocessed row, how many connections are left. Make it cheap and make it read-only: it runs on every device this sensor is under, for ever.
- **Encryption** (`encrypt`) — `prefer` tries TLS and carries on without it, which is what a command-line client does and what almost every deployment is actually running. `require` refuses the downgrade.
- **Verify the certificate** (`verifyTls`) — Off by default here, unlike every other sensor, and for a reason worth knowing: almost every database server ships with a self-signed certificate nobody replaced. The connection is still encrypted; it is authenticated against nobody. Turn this on where the server has a certificate you actually issued.
- **Statement timeout** (`statementTimeoutMs`) — Asked of the **server**, not enforced by closing the socket — a client that gives up and hangs up leaves the query running, and a check that did that every sixty seconds would become the outage it was meant to warn about.
- **Expected rows** (`expectRows`) — The check fails when the row count is outside this — `1` for a query that must return exactly one, `1+` for at least one, `0` for a query that must return none, `1-10` for a range. Empty accepts anything. A query that quietly started returning nothing is a real failure that a response time reports as perfectly healthy.
- **Extra channels** (`extract`) — The first cell of the first row is always a channel. These are for the other columns of a query that answers several questions at once — one connection instead of five.

## Log

### `syslog.receiver`

cost: **light** · fed by the `syslog` listener, not polled

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `messages` | Messages | — | **primary** |
| `emergency` | Emergency | — | — |
| `alert` | Alert | — | — |
| `critical` | Critical | — | — |
| `error` | Error | — | — |
| `warning` | Warning | — | — |
| `notice` | Notice | — | — |
| `informational` | Informational | — | — |
| `debug` | Debug | — | — |
| `senders` | Distinct senders | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `sourceIsDevice` | boolean | `true` |  |  |
| `match` | array of object | _(none)_ | ≤ 10 entries |  |
| `minSeverity` | `` · `emergency` · `alert` · `critical` · `error` · `warning` · `notice` · `informational` · `debug` | _(empty)_ |  |  |
| `retain` | integer | `3` | ≥ 0, ≤ 5 |  |

- **Only this device** (`sourceIsDevice`) — Counts only messages whose sender is the device this sensor sits under. Turn it off for a sensor watching a relay, which forwards other hosts’ messages under its own address — “which host said this” and “which host sent it to us” are different questions and only one of them is in the packet header. A device addressed by name is looked up on the probe, and one whose name resolves to nothing fails the check rather than counting nothing.
- **Match rules** (`match`) — A message must satisfy **all** of these to be counted. Empty counts everything. If this meant “any”, adding a second rule would widen the sensor, which is the opposite of what anybody typing one intends.
- **At least this severe** (`minSeverity`) — Ignores anything less severe. Emergency is the most severe and debug the least, so “warning” counts warnings, errors, criticals, alerts and emergencies.
- **Lines to show** (`retain`) — The most recent matching lines, in this sensor’s message, so an operator can see what arrived without opening anything else. This is not a log store and is not trying to be.

## Mail

### `mail.imap`

cost: **light** · credentials: `mail`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `unseen` | Unread | — | **primary** |
| `messages` | Messages | — | — |
| `recent` | Recent | — | — |
| `loginTime` | Login time | ms | — |
| `totalTime` | Total time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `security` | `none` · `starttls` · `tls` | `"starttls"` |  |  |
| `verifyTls` | boolean | `true` |  |  |
| `timeoutMs` | integer | `20000` | ≥ 1000, ≤ 300000 |  |
| `mailbox` | string | `"INBOX"` | ≤ 255 chars |  |

- **Port** (`port`) — Zero uses 143 for none/starttls and 993 for implicit TLS.
- **Encryption** (`security`) — `starttls` connects in the clear and upgrades, and **fails when the server does not offer it** rather than quietly continuing — a sensor that downgraded silently would report a healthy server while sending the password in plain text. `tls` is encrypted from the first byte. `none` is neither, and is only reasonable for a relay that takes no password at all.
- **Verify the certificate** (`verifyTls`) — On by default. Turning it off means the connection is encrypted against nobody in particular, so the sensor says so in its message on every scan rather than once here.
- **Timeout** (`timeoutMs`) — Per step of the conversation, not for the whole check. A mail server that has stopped answering looks exactly like one that is thinking, and only a deadline tells them apart.
- **Mailbox** (`mailbox`) — INBOX unless you are watching a folder something files into.

### `mail.pop3`

cost: **light** · credentials: `mail`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `messages` | Messages waiting | — | **primary** |
| `mailboxSize` | Mailbox size | B | — |
| `loginTime` | Login time | ms | — |
| `totalTime` | Total time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `security` | `none` · `starttls` · `tls` | `"starttls"` |  |  |
| `verifyTls` | boolean | `true` |  |  |
| `timeoutMs` | integer | `20000` | ≥ 1000, ≤ 300000 |  |

- **Port** (`port`) — Zero uses 110 for none/starttls and 995 for implicit TLS.
- **Encryption** (`security`) — `starttls` connects in the clear and upgrades, and **fails when the server does not offer it** rather than quietly continuing — a sensor that downgraded silently would report a healthy server while sending the password in plain text. `tls` is encrypted from the first byte. `none` is neither, and is only reasonable for a relay that takes no password at all.
- **Verify the certificate** (`verifyTls`) — On by default. Turning it off means the connection is encrypted against nobody in particular, so the sensor says so in its message on every scan rather than once here.
- **Timeout** (`timeoutMs`) — Per step of the conversation, not for the whole check. A mail server that has stopped answering looks exactly like one that is thinking, and only a deadline tells them apart.

### `mail.roundtrip`

cost: **heavy** · credentials: `mail`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `deliveryTime` | Delivery time | ms | **primary** |
| `sendTime` | Accepted by the relay in | ms | — |
| `polls` | Mailbox checks | — | — |
| `leftovers` | Older test messages found | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `from` | string |  | ≥ 3 chars, ≤ 320 chars | **required** |
| `to` | string |  | ≥ 3 chars, ≤ 320 chars | **required** |
| `smtpPort` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `smtpSecurity` | `none` · `starttls` · `tls` | `"starttls"` |  |  |
| `smtpAuth` | boolean | `false` |  |  |
| `readWith` | `imap` · `pop3` | `"imap"` |  |  |
| `readPort` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `readSecurity` | `none` · `starttls` · `tls` | `"starttls"` |  |  |
| `mailbox` | string | `"INBOX"` | ≤ 255 chars |  |
| `verifyTls` | boolean | `true` |  |  |
| `timeoutMs` | integer | `20000` | ≥ 1000, ≤ 60000 |  |
| `deliveryTimeoutMs` | integer | `120000` | ≥ 5000, ≤ 900000 |  |
| `pollSeconds` | integer | `5` | ≥ 1, ≤ 120 |  |

- **Send from** (`from`) — An address the relay will accept as a sender.
- **Send to** (`to`) — The address of the mailbox read below. It must be a mailbox nothing else uses — this sensor deletes what it finds of its own, and a human reading the same inbox will watch messages appear and vanish.
- **Authenticate to the relay** (`smtpAuth`) — Uses the mail credential on this device.
- **Read the mailbox with** (`readWith`) — IMAP where there is a choice: it can search the server-side for this check’s own token, where POP3 has to read the headers of every message in the mailbox to find one.
- **Step timeout** (`timeoutMs`) — For one step of one conversation, not for the delivery.
- **Give up waiting after** (`deliveryTimeoutMs`) — How long delivery may take before this counts as a failure. Greylisting alone is commonly five minutes, so set this above whatever your platform’s slowest legitimate path is — and keep the scan interval well above it in turn.
- **Check the mailbox every** (`pollSeconds`) — Every poll is a login. Five seconds resolves a fast delivery well and does not make this sensor the busiest client on the mail server.

### `mail.smtp`

cost: **light** · credentials: `mail`

Setting `to` adds `sendTime`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `totalTime` | Total time | ms | **primary** |
| `greetingTime` | Greeting | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `security` | `none` · `starttls` · `tls` | `"starttls"` |  |  |
| `verifyTls` | boolean | `true` |  |  |
| `timeoutMs` | integer | `20000` | ≥ 1000, ≤ 300000 |  |
| `requireAuth` | boolean | `false` |  |  |
| `from` | string | _(empty)_ | ≤ 320 chars |  |
| `to` | string | _(empty)_ | ≤ 320 chars |  |
| `subject` | string | `"Monitoring test message"` | ≤ 200 chars |  |

- **Port** (`port`) — Zero uses 587 for none/starttls and 465 for implicit TLS.
- **Encryption** (`security`) — `starttls` connects in the clear and upgrades, and fails when the server does not offer it rather than quietly continuing — a sensor that downgraded silently would report a healthy relay while sending the password in plain text.
- **Timeout** (`timeoutMs`) — Per step of the conversation, not for the whole check.
- **Authenticate** (`requireAuth`) — Log in with the mail credential on this device. Off by default, because plenty of internal relays accept mail from a known host with no account at all.
- **Test sender** (`from`) — Filled in together with the recipient below to actually put a message through — which is the difference between “the relay answers” and “the relay delivers”. Leave both empty to stop after the greeting.

## Network

### `dns.blocklist`

cost: **light**

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `listings` | Blocklists listing this address | — | **primary** |
| `checked` | Blocklists checked | — | — |
| `lookupTime` | Lookup time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `zones` | array of string |  | ≥ 1 entries, ≤ 12 entries | **required** |
| `address` | string | _(empty)_ | ≤ 45 chars |  |
| `resolver` | string | _(empty)_ | ≤ 45 chars |  |
| `timeoutMs` | integer | `5000` | ≥ 500, ≤ 60000 |  |

- **Blocklists** (`zones`) — The zones to ask, one per entry — zen.spamhaus.org, bl.spamcop.net, b.barracudacentral.org. Check each list’s terms before pointing a monitoring system at it: most refuse queries from public resolvers and several rate-limit by source address.
- **Address to check** (`address`) — Empty uses this device’s own host, which must then be an IPv4 address rather than a name. Fill it in when the address that sends mail is not the address this device is reached on — which is the usual arrangement behind NAT.
- **Resolver** (`resolver`) — Empty uses this probe’s own. Most blocklists refuse queries arriving from a public resolver, so a sensor answering “not listed” from 8.8.8.8 may be answering about the resolver’s quota rather than about this address.

## SNMP

### `snmp.cpu`

cost: **medium** · credentials: `snmp`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `load` | Processor load | % | **primary** |
| `loadMax` | Busiest processor | % | — |
| `processors` | Processors | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `version` | `v1` · `v2c` · `v3` | `"v2c"` |  |  |
| `community` | string |  | ≤ 255 chars | **write-only** |
| `username` | string |  | ≤ 255 chars |  |
| `level` | `noAuthNoPriv` · `authNoPriv` · `authPriv` | `"authPriv"` |  |  |
| `authProtocol` | `md5` · `sha` · `sha224` · `sha256` · `sha384` · `sha512` | `"sha"` |  |  |
| `authKey` | string |  | ≤ 255 chars | **write-only** |
| `privProtocol` | `des` · `aes` · `aes256b` · `aes256r` | `"aes"` |  |  |
| `privKey` | string |  | ≤ 255 chars | **write-only** |
| `context` | string |  | ≤ 255 chars |  |
| `port` | integer | `161` | ≥ 1, ≤ 65535 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |
| `retries` | integer | `1` | ≥ 0, ≤ 5 |  |
| `source` | `auto` · `hr` · `ucd` | `"auto"` |  |  |

- **SNMP version** (`version`) — v2c is what most devices speak and sends the community string in clear text. v3 is the only version with authentication and encryption. v1 has no bulk transfer and no 64-bit counters, so a busy interface wraps in minutes — use it only for a device that offers nothing else.
- **Community string** (`community`) — For v1 and v2c. Read-only access is enough; this never writes to a device.
- **User name** (`username`) — For v3. The USM user configured on the agent.
- **Security level** (`level`) — For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the values travel in clear text; noAuthNoPriv does neither.
- **Authentication protocol** (`authProtocol`) — For v3 at authNoPriv or authPriv. Must match the agent exactly.
- **Authentication key** (`authKey`) — For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.
- **Privacy protocol** (`privProtocol`) — For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants (Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong one fails as a decryption error.
- **Privacy key** (`privKey`) — For v3 at authPriv. At least eight characters, per RFC 3414.
- **Context name** (`context`) — For v3 against an agent that proxies several contexts. Usually left empty.
- **Port** (`port`) — The agent’s UDP port. 161 unless somebody has moved it. Changing it clears a community or key set on this sensor unless you enter it again.
- **Timeout** (`timeoutMs`) — Per attempt, not for the check. With retries set to 1 a check can take twice this long before it gives up.
- **Retries** (`retries`) — SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry absorbs ordinary packet loss; more mostly delays a genuine failure being reported.
- **Where to read it** (`source`) — `auto` walks hrProcessorLoad and falls back to UCD’s ssCpuIdle when the device has no HOST-RESOURCES-MIB. Force one only for a device that answers both and disagrees with itself.

### `snmp.custom`

cost: **medium** · credentials: `snmp`

**The parameters name this sensor's channel** — see `channelName`, `unit`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `value` | Value | — | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `version` | `v1` · `v2c` · `v3` | `"v2c"` |  |  |
| `community` | string |  | ≤ 255 chars | **write-only** |
| `username` | string |  | ≤ 255 chars |  |
| `level` | `noAuthNoPriv` · `authNoPriv` · `authPriv` | `"authPriv"` |  |  |
| `authProtocol` | `md5` · `sha` · `sha224` · `sha256` · `sha384` · `sha512` | `"sha"` |  |  |
| `authKey` | string |  | ≤ 255 chars | **write-only** |
| `privProtocol` | `des` · `aes` · `aes256b` · `aes256r` | `"aes"` |  |  |
| `privKey` | string |  | ≤ 255 chars | **write-only** |
| `context` | string |  | ≤ 255 chars |  |
| `port` | integer | `161` | ≥ 1, ≤ 65535 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |
| `retries` | integer | `1` | ≥ 0, ≤ 5 |  |
| `oid` | string |  | ≥ 1 chars, ≤ 255 chars | **required** |
| `mode` | `gauge` · `counter` | `"gauge"` |  |  |
| `channelName` | string | `"Value"` | ≥ 1 chars, ≤ 200 chars |  |
| `unit` | string | _(empty)_ | ≤ 50 chars |  |

- **SNMP version** (`version`) — v2c is what most devices speak and sends the community string in clear text. v3 is the only version with authentication and encryption. v1 has no bulk transfer and no 64-bit counters, so a busy interface wraps in minutes — use it only for a device that offers nothing else.
- **Community string** (`community`) — For v1 and v2c. Read-only access is enough; this never writes to a device.
- **User name** (`username`) — For v3. The USM user configured on the agent.
- **Security level** (`level`) — For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the values travel in clear text; noAuthNoPriv does neither.
- **Authentication protocol** (`authProtocol`) — For v3 at authNoPriv or authPriv. Must match the agent exactly.
- **Authentication key** (`authKey`) — For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.
- **Privacy protocol** (`privProtocol`) — For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants (Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong one fails as a decryption error.
- **Privacy key** (`privKey`) — For v3 at authPriv. At least eight characters, per RFC 3414.
- **Context name** (`context`) — For v3 against an agent that proxies several contexts. Usually left empty.
- **Port** (`port`) — The agent’s UDP port. 161 unless somebody has moved it. Changing it clears a community or key set on this sensor unless you enter it again.
- **Timeout** (`timeoutMs`) — Per attempt, not for the check. With retries set to 1 a check can take twice this long before it gives up.
- **Retries** (`retries`) — SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry absorbs ordinary packet loss; more mostly delays a genuine failure being reported.
- **OID** (`oid`) — The object to read, in numeric form — for example 1.3.6.1.2.1.25.3.3.1.2.1. Include the instance: a scalar ends in .0, and a table column needs its row index. Reading the column without one returns "no such object", because the column is not itself an object.
- **Reading type** (`mode`) — A gauge is stored as it is read — a temperature, a percentage, a queue depth. A counter only ever goes up and is stored as a *rate*: the difference between two readings over the time between them, which is what an Interface or Errors counter is for. Choosing counter for a gauge produces nonsense, so the sensor says when the device disagrees with this setting.
- **Channel name** (`channelName`) — What to call the reading — "Battery charge", "Inlet temperature".
- **Unit** (`unit`) — Shown on the axis and beside the value. For a counter this is the unit *per second*, since that is what gets stored: enter "octets" and the channel reads "octets/s".

### `snmp.custom.string`

cost: **medium** · credentials: `snmp`

**The parameters name this sensor's channel** — see `lookup`, `channelName`, `unit`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `value` | Value | — | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `version` | `v1` · `v2c` · `v3` | `"v2c"` |  |  |
| `community` | string |  | ≤ 255 chars | **write-only** |
| `username` | string |  | ≤ 255 chars |  |
| `level` | `noAuthNoPriv` · `authNoPriv` · `authPriv` | `"authPriv"` |  |  |
| `authProtocol` | `md5` · `sha` · `sha224` · `sha256` · `sha384` · `sha512` | `"sha"` |  |  |
| `authKey` | string |  | ≤ 255 chars | **write-only** |
| `privProtocol` | `des` · `aes` · `aes256b` · `aes256r` | `"aes"` |  |  |
| `privKey` | string |  | ≤ 255 chars | **write-only** |
| `context` | string |  | ≤ 255 chars |  |
| `port` | integer | `161` | ≥ 1, ≤ 65535 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |
| `retries` | integer | `1` | ≥ 0, ≤ 5 |  |
| `oid` | string |  | ≥ 1 chars, ≤ 255 chars | **required** |
| `pattern` | string | _(empty)_ | ≤ 500 chars |  |
| `mode` | `number` · `match` | `"number"` |  |  |
| `lookup` | string | _(empty)_ | ≤ 100 chars |  |
| `channelName` | string | `"Value"` | ≥ 1 chars, ≤ 200 chars |  |
| `unit` | string | _(empty)_ | ≤ 50 chars |  |

- **SNMP version** (`version`) — v2c is what most devices speak and sends the community string in clear text. v3 is the only version with authentication and encryption. v1 has no bulk transfer and no 64-bit counters, so a busy interface wraps in minutes — use it only for a device that offers nothing else.
- **Community string** (`community`) — For v1 and v2c. Read-only access is enough; this never writes to a device.
- **User name** (`username`) — For v3. The USM user configured on the agent.
- **Security level** (`level`) — For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the values travel in clear text; noAuthNoPriv does neither.
- **Authentication protocol** (`authProtocol`) — For v3 at authNoPriv or authPriv. Must match the agent exactly.
- **Authentication key** (`authKey`) — For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.
- **Privacy protocol** (`privProtocol`) — For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants (Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong one fails as a decryption error.
- **Privacy key** (`privKey`) — For v3 at authPriv. At least eight characters, per RFC 3414.
- **Context name** (`context`) — For v3 against an agent that proxies several contexts. Usually left empty.
- **Port** (`port`) — The agent’s UDP port. 161 unless somebody has moved it. Changing it clears a community or key set on this sensor unless you enter it again.
- **Timeout** (`timeoutMs`) — Per attempt, not for the check. With retries set to 1 a check can take twice this long before it gives up.
- **Retries** (`retries`) — SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry absorbs ordinary packet loss; more mostly delays a genuine failure being reported.
- **OID** (`oid`) — The object to read, in numeric form. Include the instance — a scalar ends in .0.
- **Pattern** (`pattern`) — A regular expression. With a capture group the first group is used — `Temp: ([0-9.]+)C` against "Temp: 41.5C" gives 41.5. Without one, the whole match is used. Leave it empty to use the whole string. Matching is done against the first 4 KB of what the device returned.
- **What to report** (`mode`) — `number` parses what the pattern found and reports it, failing the check if the text is not a number — for a device that reports a measurement as text. `match` reports 1 when the pattern matches and 0 when it does not, which is how to watch for a phrase.
- **Lookup** (`lookup`) — The id of a lookup that turns the reported number into a state and a phrase — for example ms.snmp.if-oper-status. Without one the reading is judged by limits, which is the wrong tool for a status code. A lookup this installation has not loaded is reported rather than fatal.

### `snmp.diskfree`

cost: **medium** · credentials: `snmp`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `percentUsed` | Disk used | % | **primary** |
| `free` | Free space | B | — |
| `used` | Used space | B | — |
| `total` | Total space | B | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `version` | `v1` · `v2c` · `v3` | `"v2c"` |  |  |
| `community` | string |  | ≤ 255 chars | **write-only** |
| `username` | string |  | ≤ 255 chars |  |
| `level` | `noAuthNoPriv` · `authNoPriv` · `authPriv` | `"authPriv"` |  |  |
| `authProtocol` | `md5` · `sha` · `sha224` · `sha256` · `sha384` · `sha512` | `"sha"` |  |  |
| `authKey` | string |  | ≤ 255 chars | **write-only** |
| `privProtocol` | `des` · `aes` · `aes256b` · `aes256r` | `"aes"` |  |  |
| `privKey` | string |  | ≤ 255 chars | **write-only** |
| `context` | string |  | ≤ 255 chars |  |
| `port` | integer | `161` | ≥ 1, ≤ 65535 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |
| `retries` | integer | `1` | ≥ 0, ≤ 5 |  |
| `mountPoint` | string |  | ≥ 1 chars, ≤ 255 chars | **required** |
| `matchMode` | `exact` · `startsWith` | `"exact"` |  |  |
| `storageIndex` | string | _(empty)_ | ≤ 128 chars |  |

- **SNMP version** (`version`) — v2c is what most devices speak and sends the community string in clear text. v3 is the only version with authentication and encryption. v1 has no bulk transfer and no 64-bit counters, so a busy interface wraps in minutes — use it only for a device that offers nothing else.
- **Community string** (`community`) — For v1 and v2c. Read-only access is enough; this never writes to a device.
- **User name** (`username`) — For v3. The USM user configured on the agent.
- **Security level** (`level`) — For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the values travel in clear text; noAuthNoPriv does neither.
- **Authentication protocol** (`authProtocol`) — For v3 at authNoPriv or authPriv. Must match the agent exactly.
- **Authentication key** (`authKey`) — For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.
- **Privacy protocol** (`privProtocol`) — For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants (Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong one fails as a decryption error.
- **Privacy key** (`privKey`) — For v3 at authPriv. At least eight characters, per RFC 3414.
- **Context name** (`context`) — For v3 against an agent that proxies several contexts. Usually left empty.
- **Port** (`port`) — The agent’s UDP port. 161 unless somebody has moved it. Changing it clears a community or key set on this sensor unless you enter it again.
- **Timeout** (`timeoutMs`) — Per attempt, not for the check. With retries set to 1 a check can take twice this long before it gives up.
- **Retries** (`retries`) — SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry absorbs ordinary packet loss; more mostly delays a genuine failure being reported.
- **Mount point** (`mountPoint`) — Matched against `hrStorageDescr` — “/”, “/var”, “C:\ Label:… ” on Windows. Compared whole, ignoring case and surrounding spaces; a device that decorates the description needs the “starts with” match below. Resolved on every scan, so this sensor follows the filesystem when the device renumbers its storage table.
- **How to match** (`matchMode`) — `exact` is the whole description. `startsWith` is for an agent that appends a label or a filesystem type — Windows reports “C:\ Label:System Serial Number 1234-5678”, where the only stable part is the front.
- **Storage index** (`storageIndex`) — Optional. A hint, checked before the walk, so an unchanged device costs one request instead of a walk of its storage table. It is never trusted on its own: if the row it names no longer has this mount point, the table is walked and the mount point wins.

### `snmp.memory`

cost: **medium** · credentials: `snmp`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `percentUsed` | Memory used | % | **primary** |
| `available` | Available memory | B | — |
| `used` | Used memory | B | — |
| `total` | Total memory | B | — |
| `swapPercentUsed` | Swap used | % | — |
| `swapAvailable` | Available swap | B | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `version` | `v1` · `v2c` · `v3` | `"v2c"` |  |  |
| `community` | string |  | ≤ 255 chars | **write-only** |
| `username` | string |  | ≤ 255 chars |  |
| `level` | `noAuthNoPriv` · `authNoPriv` · `authPriv` | `"authPriv"` |  |  |
| `authProtocol` | `md5` · `sha` · `sha224` · `sha256` · `sha384` · `sha512` | `"sha"` |  |  |
| `authKey` | string |  | ≤ 255 chars | **write-only** |
| `privProtocol` | `des` · `aes` · `aes256b` · `aes256r` | `"aes"` |  |  |
| `privKey` | string |  | ≤ 255 chars | **write-only** |
| `context` | string |  | ≤ 255 chars |  |
| `port` | integer | `161` | ≥ 1, ≤ 65535 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |
| `retries` | integer | `1` | ≥ 0, ≤ 5 |  |
| `countCacheAsAvailable` | boolean | `true` |  |  |

- **SNMP version** (`version`) — v2c is what most devices speak and sends the community string in clear text. v3 is the only version with authentication and encryption. v1 has no bulk transfer and no 64-bit counters, so a busy interface wraps in minutes — use it only for a device that offers nothing else.
- **Community string** (`community`) — For v1 and v2c. Read-only access is enough; this never writes to a device.
- **User name** (`username`) — For v3. The USM user configured on the agent.
- **Security level** (`level`) — For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the values travel in clear text; noAuthNoPriv does neither.
- **Authentication protocol** (`authProtocol`) — For v3 at authNoPriv or authPriv. Must match the agent exactly.
- **Authentication key** (`authKey`) — For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.
- **Privacy protocol** (`privProtocol`) — For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants (Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong one fails as a decryption error.
- **Privacy key** (`privKey`) — For v3 at authPriv. At least eight characters, per RFC 3414.
- **Context name** (`context`) — For v3 against an agent that proxies several contexts. Usually left empty.
- **Port** (`port`) — The agent’s UDP port. 161 unless somebody has moved it. Changing it clears a community or key set on this sensor unless you enter it again.
- **Timeout** (`timeoutMs`) — Per attempt, not for the check. With retries set to 1 a check can take twice this long before it gives up.
- **Retries** (`retries`) — SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry absorbs ordinary packet loss; more mostly delays a genuine failure being reported.
- **Count cache as available** (`countCacheAsAvailable`) — On by default, and it is the difference between a Linux box reading 35% used and the same box reading 64%. The kernel spends free memory on page cache deliberately and returns it under pressure, so cache is available memory. Turn this off only for a device where reclaiming the cache is genuinely not free.

### `snmp.table`

cost: **medium** · credentials: `snmp`

**The parameters declare the channels** — one per entry in `columns`.

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `version` | `v1` · `v2c` · `v3` | `"v2c"` |  |  |
| `community` | string |  | ≤ 255 chars | **write-only** |
| `username` | string |  | ≤ 255 chars |  |
| `level` | `noAuthNoPriv` · `authNoPriv` · `authPriv` | `"authPriv"` |  |  |
| `authProtocol` | `md5` · `sha` · `sha224` · `sha256` · `sha384` · `sha512` | `"sha"` |  |  |
| `authKey` | string |  | ≤ 255 chars | **write-only** |
| `privProtocol` | `des` · `aes` · `aes256b` · `aes256r` | `"aes"` |  |  |
| `privKey` | string |  | ≤ 255 chars | **write-only** |
| `context` | string |  | ≤ 255 chars |  |
| `port` | integer | `161` | ≥ 1, ≤ 65535 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |
| `retries` | integer | `1` | ≥ 0, ≤ 5 |  |
| `tableOid` | string |  | ≥ 1 chars, ≤ 255 chars | **required** |
| `columns` | array of object |  | ≥ 1 entries, ≤ 20 entries | **required** |
| `indexColumn` | string | _(empty)_ | ≤ 64 chars |  |
| `rowMatch` | string | _(empty)_ | ≤ 500 chars |  |
| `rowMatchMode` | `exact` · `contains` · `regex` | `"exact"` |  |  |
| `rowIndex` | string | _(empty)_ | ≤ 128 chars |  |

- **SNMP version** (`version`) — v2c is what most devices speak and sends the community string in clear text. v3 is the only version with authentication and encryption. v1 has no bulk transfer and no 64-bit counters, so a busy interface wraps in minutes — use it only for a device that offers nothing else.
- **Community string** (`community`) — For v1 and v2c. Read-only access is enough; this never writes to a device.
- **User name** (`username`) — For v3. The USM user configured on the agent.
- **Security level** (`level`) — For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the values travel in clear text; noAuthNoPriv does neither.
- **Authentication protocol** (`authProtocol`) — For v3 at authNoPriv or authPriv. Must match the agent exactly.
- **Authentication key** (`authKey`) — For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.
- **Privacy protocol** (`privProtocol`) — For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants (Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong one fails as a decryption error.
- **Privacy key** (`privKey`) — For v3 at authPriv. At least eight characters, per RFC 3414.
- **Context name** (`context`) — For v3 against an agent that proxies several contexts. Usually left empty.
- **Port** (`port`) — The agent’s UDP port. 161 unless somebody has moved it. Changing it clears a community or key set on this sensor unless you enter it again.
- **Timeout** (`timeoutMs`) — Per attempt, not for the check. With retries set to 1 a check can take twice this long before it gives up.
- **Retries** (`retries`) — SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry absorbs ordinary packet loss; more mostly delays a genuine failure being reported.
- **Table OID** (`tableOid`) — The table’s entry OID — 1.3.6.1.2.1.25.2.3.1 for hrStorageEntry, 1.3.6.1.2.1.2.2.1 for ifEntry. Every column below is read relative to this, so a column that lives in a different subtree — ifXTable beside ifTable — needs a second sensor.
- **Columns** (`columns`) — The columns to read from the chosen row. Each becomes a channel; the first is the one the sensor is judged by. Order is yours to set and is what the graph legend follows.
- **Naming column** (`indexColumn`) — The column that says what a row *is* — `3` for hrStorageDescr, `2` for ifDescr. Its value is matched against the one below to find the row, and it is shown in the sensor message every scan, which is how you tell you are still watching the right row. Leave it empty to pin the sensor to a row index instead.
- **Row value** (`rowMatch`) — What to look for in the naming column — “/var”, “GigabitEthernet0/1”. The first row that matches is the one this sensor reads, and it is resolved on every scan, so the sensor follows the row when the device renumbers its table.
- **How to match** (`rowMatchMode`) — `exact` compares the whole value, ignoring case and surrounding spaces. `contains` looks for the text anywhere in it. `regex` is a regular expression, matched against the first 4 KB of each row’s value.
- **Row index** (`rowIndex`) — The row’s index — `1`, or several arcs for a table indexed by an address. Used alone when no row value is given: fast, one request per scan, and wrong the moment the device renumbers the table with nothing to say so. Given *with* a row value it is only a hint, checked first so an unchanged table costs one request instead of a walk.

### `snmp.traffic`

cost: **medium** · credentials: `snmp`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `in` | Traffic in | octets/s | **primary**; 64-bit counter → rate |
| `out` | Traffic out | octets/s | 64-bit counter → rate |
| `total` | Traffic total | octets/s | 64-bit counter → rate |
| `status` | Interface status | — | lookup `ms.snmp.if-oper-status` |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `version` | `v1` · `v2c` · `v3` | `"v2c"` |  |  |
| `community` | string |  | ≤ 255 chars | **write-only** |
| `username` | string |  | ≤ 255 chars |  |
| `level` | `noAuthNoPriv` · `authNoPriv` · `authPriv` | `"authPriv"` |  |  |
| `authProtocol` | `md5` · `sha` · `sha224` · `sha256` · `sha384` · `sha512` | `"sha"` |  |  |
| `authKey` | string |  | ≤ 255 chars | **write-only** |
| `privProtocol` | `des` · `aes` · `aes256b` · `aes256r` | `"aes"` |  |  |
| `privKey` | string |  | ≤ 255 chars | **write-only** |
| `context` | string |  | ≤ 255 chars |  |
| `port` | integer | `161` | ≥ 1, ≤ 65535 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |
| `retries` | integer | `1` | ≥ 0, ≤ 5 |  |
| `ifIndex` | integer |  | ≥ 1, ≤ 2147483647 |  |
| `interfaceName` | string |  | ≤ 255 chars |  |
| `counterWidth` | `auto` · `64` · `32` | `"auto"` |  |  |

- **SNMP version** (`version`) — v2c is what most devices speak and sends the community string in clear text. v3 is the only version with authentication and encryption. v1 has no bulk transfer and no 64-bit counters, so a busy interface wraps in minutes — use it only for a device that offers nothing else.
- **Community string** (`community`) — For v1 and v2c. Read-only access is enough; this never writes to a device.
- **User name** (`username`) — For v3. The USM user configured on the agent.
- **Security level** (`level`) — For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the values travel in clear text; noAuthNoPriv does neither.
- **Authentication protocol** (`authProtocol`) — For v3 at authNoPriv or authPriv. Must match the agent exactly.
- **Authentication key** (`authKey`) — For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.
- **Privacy protocol** (`privProtocol`) — For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants (Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong one fails as a decryption error.
- **Privacy key** (`privKey`) — For v3 at authPriv. At least eight characters, per RFC 3414.
- **Context name** (`context`) — For v3 against an agent that proxies several contexts. Usually left empty.
- **Port** (`port`) — The agent’s UDP port. 161 unless somebody has moved it. Changing it clears a community or key set on this sensor unless you enter it again.
- **Timeout** (`timeoutMs`) — Per attempt, not for the check. With retries set to 1 a check can take twice this long before it gives up.
- **Retries** (`retries`) — SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry absorbs ordinary packet loss; more mostly delays a genuine failure being reported.
- **Interface index** (`ifIndex`) — The SNMP index of the interface (`ifIndex`). Fast — one request per scan — but not stable on every device: some renumber their interfaces across a reboot or a module change, after which this sensor is watching a different port with no sign that anything happened. Use the interface name instead where that is a risk.
- **Interface name** (`interfaceName`) — Matched against `ifName`, `ifDescr` and `ifAlias` — for example "GigabitEthernet0/1". Costs one walk of the interface table per scan and survives a device renumbering its indexes, which an index cannot. Given both, the name wins and the index is the hint used to check it first.
- **Counter width** (`counterWidth`) — `auto` uses the 64-bit counters and falls back to the 32-bit ones if the device has no `ifHCInOctets`. Force 32 only for a device that answers the 64-bit OIDs with something wrong; above about 20 Mbit/s they wrap faster than a scan interval and under-report.

### `snmp.trap`

cost: **light** · fed by the `snmp-trap` listener, not polled

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `count` | Traps | — | **primary** |
| `informs` | Informs | — | — |
| `unmatched` | Not matched | — | — |
| `dropped` | Missed | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `sourceIsDevice` | boolean | `true` |  |  |
| `rules` | array of object | _(none)_ | ≤ 20 entries |  |
| `warnOnDropped` | boolean | `true` |  |  |

- **Only this device** (`sourceIsDevice`) — On by default: the sensor counts only notifications whose sender is the device it sits under. Turn it off for a collector sensor that watches a whole subnet, and use the rules below to say which. A device addressed by name is looked up on the probe, and one whose name resolves to nothing fails the check rather than counting nothing.
- **Filter rules** (`rules`) — A notification counts when it matches *any* rule; with no rules at all, everything that got past “only this device” counts. Within one rule every field given must match, so adding a field always narrows.
- **Fail when notifications were missed** (`warnOnDropped`) — The probe’s listener holds a bounded buffer. If more arrived than it could keep before this sensor next scanned, the count is short by a known number — and a trap sensor quietly under-reporting the flood it exists to report is worse than a failed check. Leave this on unless a deliberate flood is normal for this device.

### `snmp.uptime`

cost: **light** · credentials: `snmp`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `uptime` | Uptime | s | **primary** |
| `agentUptime` | SNMP agent uptime | s | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `version` | `v1` · `v2c` · `v3` | `"v2c"` |  |  |
| `community` | string |  | ≤ 255 chars | **write-only** |
| `username` | string |  | ≤ 255 chars |  |
| `level` | `noAuthNoPriv` · `authNoPriv` · `authPriv` | `"authPriv"` |  |  |
| `authProtocol` | `md5` · `sha` · `sha224` · `sha256` · `sha384` · `sha512` | `"sha"` |  |  |
| `authKey` | string |  | ≤ 255 chars | **write-only** |
| `privProtocol` | `des` · `aes` · `aes256b` · `aes256r` | `"aes"` |  |  |
| `privKey` | string |  | ≤ 255 chars | **write-only** |
| `context` | string |  | ≤ 255 chars |  |
| `port` | integer | `161` | ≥ 1, ≤ 65535 |  |
| `timeoutMs` | integer | `5000` | ≥ 100, ≤ 60000 |  |
| `retries` | integer | `1` | ≥ 0, ≤ 5 |  |

- **SNMP version** (`version`) — v2c is what most devices speak and sends the community string in clear text. v3 is the only version with authentication and encryption. v1 has no bulk transfer and no 64-bit counters, so a busy interface wraps in minutes — use it only for a device that offers nothing else.
- **Community string** (`community`) — For v1 and v2c. Read-only access is enough; this never writes to a device.
- **User name** (`username`) — For v3. The USM user configured on the agent.
- **Security level** (`level`) — For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the values travel in clear text; noAuthNoPriv does neither.
- **Authentication protocol** (`authProtocol`) — For v3 at authNoPriv or authPriv. Must match the agent exactly.
- **Authentication key** (`authKey`) — For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.
- **Privacy protocol** (`privProtocol`) — For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants (Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong one fails as a decryption error.
- **Privacy key** (`privKey`) — For v3 at authPriv. At least eight characters, per RFC 3414.
- **Context name** (`context`) — For v3 against an agent that proxies several contexts. Usually left empty.
- **Port** (`port`) — The agent’s UDP port. 161 unless somebody has moved it. Changing it clears a community or key set on this sensor unless you enter it again.
- **Timeout** (`timeoutMs`) — Per attempt, not for the check. With retries set to 1 a check can take twice this long before it gives up.
- **Retries** (`retries`) — SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry absorbs ordinary packet loss; more mostly delays a genuine failure being reported.

## SSH

### `ssh.diskfree`

cost: **medium** · credentials: `ssh`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `percentUsed` | Disk used | % | **primary** |
| `free` | Free space | B | — |
| `used` | Used space | B | — |
| `total` | Total space | B | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `22` | ≥ 1, ≤ 65535 |  |
| `connectTimeoutMs` | integer | `15000` | ≥ 1000, ≤ 120000 |  |
| `commandTimeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |
| `path` | string | `"/"` | ≥ 1 chars, ≤ 1024 chars |  |

- **Connect timeout** (`connectTimeoutMs`) — The whole handshake — TCP, key exchange and authentication. Separate from the command timeout because a slow login and a slow script are different faults with different fixes.
- **Command timeout** (`commandTimeoutMs`) — How long one command may run. Reaching it fails the check and closes the channel, not the connection — the other sensors on this device are still using it.
- **Path** (`path`) — Any path on the filesystem to watch — “/”, “/var”, “/srv/data”. `df` reports the filesystem the path is on, so it need not be the mount point itself.

### `ssh.load`

cost: **medium** · credentials: `ssh`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `loadPerCpu` | Load per processor | — | **primary** |
| `load1` | Load average (1 min) | — | — |
| `load5` | Load average (5 min) | — | — |
| `load15` | Load average (15 min) | — | — |
| `processors` | Processors | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `22` | ≥ 1, ≤ 65535 |  |
| `connectTimeoutMs` | integer | `15000` | ≥ 1000, ≤ 120000 |  |
| `commandTimeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |

- **Connect timeout** (`connectTimeoutMs`) — The whole handshake — TCP, key exchange and authentication. Separate from the command timeout because a slow login and a slow script are different faults with different fixes.
- **Command timeout** (`commandTimeoutMs`) — How long one command may run. Reaching it fails the check and closes the channel, not the connection — the other sensors on this device are still using it.

### `ssh.meminfo`

cost: **medium** · credentials: `ssh`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `percentUsed` | Memory used | % | **primary** |
| `available` | Available memory | B | — |
| `used` | Used memory | B | — |
| `total` | Total memory | B | — |
| `swapPercentUsed` | Swap used | % | — |
| `swapAvailable` | Available swap | B | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `22` | ≥ 1, ≤ 65535 |  |
| `connectTimeoutMs` | integer | `15000` | ≥ 1000, ≤ 120000 |  |
| `commandTimeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |

- **Connect timeout** (`connectTimeoutMs`) — The whole handshake — TCP, key exchange and authentication. Separate from the command timeout because a slow login and a slow script are different faults with different fixes.
- **Command timeout** (`commandTimeoutMs`) — How long one command may run. Reaching it fails the check and closes the channel, not the connection — the other sensors on this device are still using it.

### `ssh.script`

cost: **medium** · credentials: `ssh`

**The parameters declare the channels** — one per entry in `channels`.

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `22` | ≥ 1, ≤ 65535 |  |
| `connectTimeoutMs` | integer | `15000` | ≥ 1000, ≤ 120000 |  |
| `commandTimeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |
| `command` | string |  | ≥ 1 chars, ≤ 4096 chars | **required** |
| `channels` | array of object |  | ≥ 1 entries, ≤ 20 entries | **required** |

- **Connect timeout** (`connectTimeoutMs`) — The whole handshake — TCP, key exchange and authentication. Separate from the command timeout because a slow login and a slow script are different faults with different fixes.
- **Command timeout** (`commandTimeoutMs`) — How long one command may run. Reaching it fails the check and closes the channel, not the connection — the other sensors on this device are still using it.
- **Command** (`command`) — Run by the login shell on the device, so a pipeline and a redirect work. It should print one reading per line — “queue:12” — or a bare number, or a JSON object; see the sensor documentation. Exiting non-zero fails the check with whatever it wrote to standard error, which is how a script refuses to answer rather than reporting a zero somebody would graph.
- **Channels** (`channels`) — What the script reports. The keys have to match what it prints; the first is the one the sensor is judged by. A script printing a key that is not here is reported in the message rather than ignored, which is how you find out the two have drifted apart.

## System

### `ms.core.health`

cost: **light** · evaluated by the core, never by a probe

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `ingestQueue` | Ingestion queue | readings | **primary**; default limits: warn above 40000, error above 100000 |
| `writeLatency` | Database write time (p95) | ms | — |
| `ingestRefused` | Readings refused | readings | 64-bit counter → rate |
| `cpu` | CPU | % | — |
| `memory` | Memory (resident) | MB | — |
| `heap` | Heap in use | MB | — |
| `memoryAvailable` | Memory available | % | default limits: error below 10, warn below 20 |
| `memoryAvailableBytes` | Memory available | MB | — |
| `memoryLimitUsage` | Memory used of its limit | % | default limits: warn above 80, error above 100 |
| `memoryLimit` | Memory limit | MB | — |
| `uptime` | Uptime | s | — |
| `rollupLag` | Rollup lag (worst tier) | s | default limits: warn above 3600, error above 86400 |
| `backfillQueue` | Rollup backfill queue | windows | — |
| `backfillParked` | Rollup backfills parked | windows | default limits: warn above 0 |
| `diskFree` | Free disk space | % | default limits: error below 10, warn below 20 |
| `diskFreeBytes` | Free disk space | MB | — |
| `databaseSize` | Database size | MB | — |
| `evictedChunks` | Chunks evicted early | chunks | 64-bit counter → rate; default limits: error above 0.00001 |
| `reapQueue` | Channels awaiting reap | channels | — |
| `notifyPending` | Notifications undelivered | notifications | — |
| `notifyOldest` | Oldest undelivered notification | s | default limits: warn above 900, error above 3600 |
| `notifyFailed` | Notifications given up on (1 h) | notifications | — |
| `streamCutoffs` | Live subscribers cut off | subscribers | 64-bit counter → rate |
| `streamCoalesced` | Live probe changes folded together | changes | 64-bit counter → rate |
| `streamEnded` | Live sockets signed out: session ended | sockets | 64-bit counter → rate |
| `streamExpired` | Live sockets signed out: expired | sockets | 64-bit counter → rate |
| `streamRevoked` | Live sockets signed out: token revoked | sockets | 64-bit counter → rate |
| `streamDisabled` | Live sockets signed out: account disabled | sockets | 64-bit counter → rate |
| `streamCheckFailures` | Live socket sign-in checks failed | checks | 64-bit counter → rate |
| `streamUnsure` | Live sockets closed to reconnect | sockets | 64-bit counter → rate |
| `streamChecksOutstanding` | Live socket sweep queries unanswered | queries | — |
| `streamEdgesUnvetted` | Live changes sent without a sign-in check | changes | 64-bit counter → rate |
| `streamWithheld` | Live sockets held back for a sign-in check | sockets | 64-bit counter → rate |
| `streamEdgesCoalesced` | Live changes sharing a sign-in check | changes | 64-bit counter → rate |
| `dependencyPauses` | Dependency pauses | sensors | 64-bit counter → rate |
| `probesDown` | Probes not connected | probes | — |
| `probesSilent` | Probes not delivering | probes | — |
| `alarmOverdue` | Alarm sweep overdue by | s | default limits: warn above 60, error above 300 |
| `alarmsFired` | Notification steps fired | steps | 64-bit counter → rate |
| `queriesRefused` | On-demand checks refused | queries | 64-bit counter → rate |
| `reportsDeferred` | Scheduled reports deferred | reports | 64-bit counter → rate |
| `reportsFailed` | Report runs failed | runs | 64-bit counter → rate |
| `reportsUndelivered` | Reports waiting to be delivered | reports | — |
| `reportFormatsWaiting` | Report formats waiting | formats | — |
| `reportFormatsRefused` | Report formats refused | formats | 64-bit counter → rate |
| `resultsFutureDated` | Results refused as future-dated | results | 64-bit counter → rate |
| `resultsPastDated` | Results refused as too old | results | 64-bit counter → rate |
| `resultsUnreadableTime` | Results dropped for an unreadable time | results | 64-bit counter → rate; default limits: warn above 0 |
| `clockBehind` | Clock behind the probes | s | default limits: warn above 60, error above 900 |
| `reactionsDeferred` | Alarm reactions waiting on a catch-up | sensors | — |
| `credentialsToReenter` | Credential sets to re-enter | sets | default limits: warn above 0 |
| `credentialsUnbounded` | Credential sets without targets | sets | — |
| `credentialsWithheld` | Sensors withheld for credentials | sensors | — |
| `lateRefusalWritesGivenUp` | Late-refusal record writes given up | writes | 64-bit counter → rate |
| `logDropped` | Log lines dropped | lines | default limits: warn above 0 |
| `logBacklog` | Log waiting to be written | MB | — |
| `hostsRefused` | Requests refused for an unknown Host | requests | — |
| `rateLimited` | Requests refused by the rate limit | requests | default limits: warn above 0 |
| `heartbeatFailures` | Heartbeats that did not arrive | requests | default limits: warn above 0 |
| `dbStatementTimeouts` | Database statements cancelled | statements | 64-bit counter → rate; default limits: warn above 0.00001 |
| `dbLockTimeouts` | Database lock waits given up | statements | 64-bit counter → rate; default limits: warn above 0.00001 |
| `dbOldestQuerySeconds` | Oldest database statement running | s | default limits: warn above 30 |

Takes no parameters.

### `ms.probe.health`

cost: **light** · evaluated by the core, never by a probe

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `connected` | Link to the core | — | **primary**; lookup `ms.probe.link` |
| `heartbeatAge` | Since last heartbeat | s | — |
| `delivering` | Sending results | — | lookup `ms.probe.delivery` |
| `resultAge` | Since last result | s | — |
| `checksCompleting` | Checks settling | — | lookup `ms.probe.checks` |
| `checksBehind` | Sensors behind schedule | sensors | — |
| `checksOutstanding` | Checks in flight | checks | — |
| `checkStalled` | Oldest check waiting | s | — |
| `protocol` | Protocol version skew | — | lookup `ms.probe.protocol` |
| `protocolFlap` | Protocol version changes in a flap | changes | default limits: warn above 1.5 |
| `reportsRefused` | Reports refused | reports | 64-bit counter → rate |
| `reportsForeign` | Reports on work never given to it (5 min) | reports | default limits: warn above 0.5 |
| `lateRefusals` | Refusals delivered late | results | 64-bit counter → rate |
| `resultsWithheld` | Results for sensors withheld | results | 64-bit counter → rate |
| `schedulerLag` | Scheduler lag (p95) | ms | default limits: warn above 1000, error above 5000 |
| `skippedTicks` | Ticks skipped | ticks | 64-bit counter → rate |
| `poolUsage` | Worker pool in use | % | default limits: warn above 80, error above 95 |
| `sessionsOpen` | Device sessions held | sessions | — |
| `sessionOverflows` | Sessions opened past the bound | sessions | 64-bit counter → rate; default limits: error above 0.5 |
| `sessionsEvicted` | Sessions closed when idle | sessions | 64-bit counter → rate |
| `sessionsOpened` | Sessions opened | sessions | 64-bit counter → rate |
| `poolCeiling` | Worker pool ceiling | workers | — |
| `poolMemoryCap` | Workers memory can hold | workers | — |
| `poolHeldBack` | Workers held back by memory | workers | — |
| `queued` | Checks waiting for a worker | checks | — |
| `checkWait` | Wait for a worker (p95) | ms | — |
| `deferred` | Checks deferred | checks | 64-bit counter → rate |
| `refused` | Checks refused | checks | 64-bit counter → rate |
| `timedOut` | Checks timed out | checks | 64-bit counter → rate |
| `workerCrashes` | Worker crashes | workers | 64-bit counter → rate |
| `poolState` | Worker pool | — | lookup `ms.probe.pool` |
| `discarded` | Checks discarded | checks | 64-bit counter → rate |
| `trapReceived` | Traps received | traps | 64-bit counter → rate |
| `trapRejected` | Traps rejected | traps | 64-bit counter → rate |
| `trapMalformed` | Traps malformed | traps | 64-bit counter → rate |
| `syslogReceived` | Syslog received | messages | 64-bit counter → rate |
| `syslogRejected` | Syslog rejected | messages | 64-bit counter → rate |
| `syslogMalformed` | Syslog malformed | messages | 64-bit counter → rate |
| `trapOverwritten` | Traps overwritten unread | traps | 64-bit counter → rate |
| `syslogOverwritten` | Syslog overwritten unread | messages | 64-bit counter → rate |
| `flowReceived` | Flows received | flows | 64-bit counter → rate |
| `flowRejected` | Flows rejected | flows | 64-bit counter → rate |
| `flowMalformed` | Flow datagrams malformed | datagrams | 64-bit counter → rate |
| `flowMissed` | Flows missed | flows | 64-bit counter → rate |
| `flowUndecodable` | Flow records with no template | records | 64-bit counter → rate |
| `flowOverwritten` | Flows overwritten unread | flows | 64-bit counter → rate |
| `scheduled` | Sensors scheduled | sensors | — |
| `childSlots` | Child process slots | processes | — |
| `childBusy` | Child processes running | processes | — |
| `childQueued` | Checks waiting for a child process | checks | — |
| `childDeferred` | Child checks deferred | checks | 64-bit counter → rate |
| `childRefused` | Child checks refused | checks | 64-bit counter → rate |
| `childTimedOut` | Child checks timed out | checks | 64-bit counter → rate |
| `childCrashes` | Child process crashes | processes | 64-bit counter → rate |
| `childStartupFailed` | Child checks not started | checks | 64-bit counter → rate |
| `childStartup` | Child process start-up (p95) | ms | — |
| `spoolDepth` | Results spooled | results | — |
| `spoolBytes` | Spool on disk | MB | — |
| `spoolDropped` | Results dropped | results | 64-bit counter → rate; default limits: error above 0.00001 |
| `spoolUnwritten` | Results not written | results | 64-bit counter → rate; default limits: error above 0.00001 |
| `spoolCorrupt` | Results unreadable | results | 64-bit counter → rate |
| `spoolStalled` | Spool stalled for | s | default limits: error above 0.5 |
| `clockJumps` | Clock jumps | jumps | 64-bit counter → rate |
| `resultsFutureDated` | Results refused as future-dated (5 min) | results | default limits: warn above 0.5 |
| `resultsPastDated` | Results refused as too old (5 min) | results | default limits: warn above 0.5 |
| `clockOffset` | Clock behind the core | s | default limits: warn below -60, warn above 60 |
| `sensorsFrozen` | Sensors frozen by the clock | sensors | default limits: error above 0.5 |
| `cpu` | CPU | % | — |
| `memory` | Memory (resident) | MB | — |
| `memoryAvailable` | Memory available | % | default limits: error below 10, warn below 20 |
| `memoryAvailableBytes` | Memory available | MB | — |
| `memoryLimitUsage` | Memory used of its limit | % | default limits: warn above 80, error above 100 |
| `memoryLimit` | Memory limit | MB | — |
| `uptime` | Uptime | s | — |
| `logDropped` | Log lines dropped | lines | default limits: warn above 0 |
| `logBacklog` | Log waiting to be written | MB | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `probeId` | integer |  | ≥ 1 |  |

- **Probe** (`probeId`) — Which probe this reports on. Left unset, it is the probe this sensor sits under — which is what an operator means every time but one, and the exception is a sensor deliberately placed elsewhere so that losing the probe does not also lose the view of it.

## Traffic

### `flow.netflow`

cost: **light** · fed by the `flow` listener, not polled

**The parameters declare the channels** — one per entry in `channels`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `bytes` | Traffic | B/s | **primary** |
| `packets` | Packets | /s | — |
| `flows` | Flows | /s | — |
| `tcp` | TCP | B/s | — |
| `udp` | UDP | B/s | — |
| `icmp` | ICMP | B/s | — |
| `other` | Other protocols | B/s | — |
| `hosts` | Distinct sources | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `sourceIsDevice` | boolean | `true` |  |  |
| `silenceIsIdle` | boolean | `false` |  |  |
| `warnOnDropped` | boolean | `true` |  |  |
| `channels` | array of object | _(none)_ | ≤ 10 entries |  |

- **Only this exporter** (`sourceIsDevice`) — Counts only flows exported by the device this sensor sits under. Turn it off for a sensor watching every exporter that reaches this probe, which is what you want on a single site-wide traffic sensor and not what you want on a per-router one. A device addressed by name is looked up on the probe, and one whose name resolves to nothing fails the check rather than reporting no flows.
- **Treat silence as an idle link** (`silenceIsIdle`) — Off by default, and deliberately. A flow exporter with nothing to report sends nothing at all — there is no heartbeat — so an interval with no flows is either an idle link or an exporter that has stopped, and nothing in what arrived can tell them apart. Left off, the check fails and says so. Turn it on for a link that is genuinely quiet much of the time, and accept that a stopped exporter will then read as zero.
- **Fail when the buffer overflowed** (`warnOnDropped`) — Flows that reached this probe but were overwritten before this sensor read them make every count short by an unknown amount. Failing is the honest reading; turn this off only for an exporter whose flood is expected and whose totals you do not act on.
- **Extra channels** (`channels`) — Your own channels, each counting the traffic that satisfies **all** of its rules — what `CAPABILITIES.MD` calls custom flow variants. Each reports bytes per second, beside the built-in channels rather than instead of them.

## Web

### `http.advanced`

cost: **medium** · credentials: `http`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `responseTime` | Response time | ms | **primary** |
| `timeToFirstByte` | Time to first byte | ms | — |
| `statusCode` | Status code | — | — |
| `size` | Response size | B | — |
| `redirects` | Redirects followed | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `scheme` | `http` · `https` | `"https"` |  |  |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `path` | string | `"/"` | ≤ 2048 chars |  |
| `expectStatus` | string | _(empty)_ | ≤ 32 chars |  |
| `followRedirects` | boolean | `true` |  |  |
| `verifyTls` | boolean | `true` |  |  |
| `timeoutMs` | integer | `10000` | ≥ 100, ≤ 300000 |  |
| `userAgent` | string | _(empty)_ | ≤ 200 chars |  |
| `method` | `GET` · `HEAD` · `POST` · `PUT` · `PATCH` · `DELETE` | `"GET"` |  |  |
| `body` | string | _(empty)_ | ≤ 16384 chars |  |
| `requestHeaders` | array of object | _(none)_ | ≤ 20 entries |  |
| `expectHeaders` | array of object | _(none)_ | ≤ 20 entries |  |

- **Port** (`port`) — Zero uses the scheme’s own — 80 for http, 443 for https.
- **Path** (`path`) — The path and query, starting with a slash. Point it at something cheap that still proves the application works — a health endpoint that touches the database beats the front page, which a cache can serve long after the application has stopped.
- **Expected status** (`expectStatus`) — Empty accepts any 2xx, and any 3xx when redirects are not being followed. Otherwise an exact code (404), a class (2xx) or a range (200-204) — a sensor that is *supposed* to see a 401 or a 404 is a real thing to watch, and it should be Up when it does.
- **Follow redirects** (`followRedirects`) — Up to five hops. A redirect that leaves this device is never followed whatever this says: the reading would stop being about the device the sensor sits under, and nothing on the graph would say so.
- **Verify the certificate** (`verifyTls`) — On by default. Turning it off means the connection is encrypted against nobody in particular, so the sensor says so in its message on every scan rather than once here.
- **User agent** (`userAgent`) — Empty sends this monitoring system’s own, which is what you want in a server log when somebody asks who is making these requests every minute.
- **Request body** (`body`) — Sent as-is. Set a Content-Type header below to match it.
- **Request headers** (`requestHeaders`) — Sent with the request. An Authorization header does *not* belong here — set an HTTP credential on the device instead, so a hundred sensors against one API rotate their token in one place rather than a hundred.
- **Expected response headers** (`expectHeaders`) — The check fails unless each of these is present and contains the text given. Leave a value empty to require only that the header is there. A cache that stopped setting Cache-Control reports as perfectly healthy by status code alone.

### `http.content`

cost: **medium**

**The parameters declare the channels** — one per entry in `extract`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `responseTime` | Response time | ms | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `scheme` | `http` · `https` | `"https"` |  |  |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `path` | string | `"/"` | ≤ 2048 chars |  |
| `expectStatus` | string | _(empty)_ | ≤ 32 chars |  |
| `followRedirects` | boolean | `true` |  |  |
| `verifyTls` | boolean | `true` |  |  |
| `timeoutMs` | integer | `10000` | ≥ 100, ≤ 300000 |  |
| `userAgent` | string | _(empty)_ | ≤ 200 chars |  |
| `mustContain` | string | _(empty)_ | ≤ 500 chars |  |
| `mustNotContain` | string | _(empty)_ | ≤ 500 chars |  |
| `extract` | array of object | _(none)_ | ≤ 10 entries |  |
| `maxBodyBytes` | integer | `524288` | ≥ 1024, ≤ 8388608 |  |

- **Port** (`port`) — Zero uses the scheme’s own — 80 for http, 443 for https.
- **Path** (`path`) — The path and query, starting with a slash. Point it at something cheap that still proves the application works — a health endpoint that touches the database beats the front page, which a cache can serve long after the application has stopped.
- **Expected status** (`expectStatus`) — Empty accepts any 2xx, and any 3xx when redirects are not being followed. Otherwise an exact code (404), a class (2xx) or a range (200-204) — a sensor that is *supposed* to see a 401 or a 404 is a real thing to watch, and it should be Up when it does.
- **Follow redirects** (`followRedirects`) — Up to five hops. A redirect that leaves this device is never followed whatever this says: the reading would stop being about the device the sensor sits under, and nothing on the graph would say so.
- **Verify the certificate** (`verifyTls`) — On by default. Turning it off means the connection is encrypted against nobody in particular, so the sensor says so in its message on every scan rather than once here.
- **User agent** (`userAgent`) — Empty sends this monitoring system’s own, which is what you want in a server log when somebody asks who is making these requests every minute.
- **Must contain** (`mustContain`) — Plain text the response has to contain, ignoring case. The cheapest useful check there is: a page that returns 200 with a stack trace in it is Up by every other measure.
- **Must not contain** (`mustNotContain`) — Plain text that fails the check when present — “Exception”, “Under maintenance”, “Database error”.
- **Numbers to extract** (`extract`) — Each becomes a channel. The pattern is a regular expression; its first capture group is the number, or the whole match when it captures nothing. The first entry is the channel the sensor is judged by.
- **Read at most** (`maxBodyBytes`) — How much of the response to read. Passing it fails the check rather than truncating: a pattern matched against half a document finds nothing and reports a value as missing, which is a far more confusing fault than “this page is bigger than this sensor will read”.

### `http.request`

cost: **medium**

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `responseTime` | Response time | ms | **primary** |
| `timeToFirstByte` | Time to first byte | ms | — |
| `statusCode` | Status code | — | — |
| `size` | Response size | B | — |
| `redirects` | Redirects followed | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `scheme` | `http` · `https` | `"https"` |  |  |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `path` | string | `"/"` | ≤ 2048 chars |  |
| `expectStatus` | string | _(empty)_ | ≤ 32 chars |  |
| `followRedirects` | boolean | `true` |  |  |
| `verifyTls` | boolean | `true` |  |  |
| `timeoutMs` | integer | `10000` | ≥ 100, ≤ 300000 |  |
| `userAgent` | string | _(empty)_ | ≤ 200 chars |  |
| `method` | `GET` · `HEAD` | `"GET"` |  |  |

- **Port** (`port`) — Zero uses the scheme’s own — 80 for http, 443 for https.
- **Path** (`path`) — The path and query, starting with a slash. Point it at something cheap that still proves the application works — a health endpoint that touches the database beats the front page, which a cache can serve long after the application has stopped.
- **Expected status** (`expectStatus`) — Empty accepts any 2xx, and any 3xx when redirects are not being followed. Otherwise an exact code (404), a class (2xx) or a range (200-204) — a sensor that is *supposed* to see a 401 or a 404 is a real thing to watch, and it should be Up when it does.
- **Follow redirects** (`followRedirects`) — Up to five hops. A redirect that leaves this device is never followed whatever this says: the reading would stop being about the device the sensor sits under, and nothing on the graph would say so.
- **Verify the certificate** (`verifyTls`) — On by default. Turning it off means the connection is encrypted against nobody in particular, so the sensor says so in its message on every scan rather than once here.
- **User agent** (`userAgent`) — Empty sends this monitoring system’s own, which is what you want in a server log when somebody asks who is making these requests every minute.
- **Method** (`method`) — HEAD is the cheapest and gives no size to measure. For POST and for custom headers, use HTTP Advanced.

### `http.transaction`

cost: **heavy** · credentials: `http`

**The parameters declare the channels** — one per entry in `steps`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `totalTime` | Transaction time | ms | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `scheme` | `http` · `https` | `"https"` |  |  |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `followRedirects` | boolean | `true` |  |  |
| `verifyTls` | boolean | `true` |  |  |
| `userAgent` | string | _(empty)_ | ≤ 200 chars |  |
| `timeoutMs` | integer | `10000` | ≥ 100, ≤ 300000 |  |
| `maxBodyBytes` | integer | `524288` | ≥ 1024, ≤ 8388608 |  |
| `steps` | array of object |  | ≥ 1 entries, ≤ 10 entries | **required** |

- **Port** (`port`) — Zero uses the scheme’s own — 80 for http, 443 for https.
- **Follow redirects** (`followRedirects`) — Up to five hops. A redirect that leaves this device is never followed whatever this says: the reading would stop being about the device the sensor sits under, and nothing on the graph would say so.
- **Verify the certificate** (`verifyTls`) — On by default. Turning it off means the connection is encrypted against nobody in particular, so the sensor says so in its message on every scan rather than once here.
- **User agent** (`userAgent`) — Empty sends this monitoring system’s own, which is what you want in a server log when somebody asks who is making these requests every minute.
- **Timeout per step** (`timeoutMs`) — Per step, not for the whole transaction — ten steps at ten seconds is a sensor that can take a hundred, so keep the scan interval well above the total.
- **Response bound** (`maxBodyBytes`) — How much of each response is read, for the content checks and the captures. Passing it fails the step rather than truncating: a token searched for in half a page is “not found”, which is a far more confusing fault than “this page is bigger than this sensor reads”.
- **Steps** (`steps`) — Run in order, sharing one cookie jar. The first step that fails ends the transaction — one outage is one alarm, and the steps after a failed login would all fail for the same reason.

### `rest.custom`

cost: **medium** · credentials: `http` · paths can be previewed against a pasted document

**The parameters declare the channels** — one per entry in `extract`.

Every sensor of this type has:

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `responseTime` | Response time | ms | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `scheme` | `http` · `https` | `"https"` |  |  |
| `port` | integer | `0` | ≥ 0, ≤ 65535 |  |
| `path` | string | `"/"` | ≤ 2048 chars |  |
| `expectStatus` | string | _(empty)_ | ≤ 32 chars |  |
| `followRedirects` | boolean | `true` |  |  |
| `verifyTls` | boolean | `true` |  |  |
| `timeoutMs` | integer | `10000` | ≥ 100, ≤ 300000 |  |
| `userAgent` | string | _(empty)_ | ≤ 200 chars |  |
| `method` | `GET` · `HEAD` · `POST` · `PUT` · `PATCH` · `DELETE` | `"GET"` |  |  |
| `body` | string | _(empty)_ | ≤ 16384 chars |  |
| `requestHeaders` | array of object | _(none)_ | ≤ 20 entries |  |
| `format` | `auto` · `json` · `xml` | `"auto"` |  |  |
| `maxBodyBytes` | integer | `1048576` | ≥ 1024, ≤ 8388608 |  |
| `extract` | array of object |  | ≥ 1 entries, ≤ 20 entries | **required** |
| `expect` | array of object | _(none)_ | ≤ 10 entries |  |

- **Port** (`port`) — Zero uses the scheme’s own — 80 for http, 443 for https.
- **Path** (`path`) — The path and query, starting with a slash. Point it at something cheap that still proves the application works — a health endpoint that touches the database beats the front page, which a cache can serve long after the application has stopped.
- **Expected status** (`expectStatus`) — Empty accepts any 2xx, and any 3xx when redirects are not being followed. Otherwise an exact code (404), a class (2xx) or a range (200-204) — a sensor that is *supposed* to see a 401 or a 404 is a real thing to watch, and it should be Up when it does.
- **Follow redirects** (`followRedirects`) — Up to five hops. A redirect that leaves this device is never followed whatever this says: the reading would stop being about the device the sensor sits under, and nothing on the graph would say so.
- **Verify the certificate** (`verifyTls`) — On by default. Turning it off means the connection is encrypted against nobody in particular, so the sensor says so in its message on every scan rather than once here.
- **User agent** (`userAgent`) — Empty sends this monitoring system’s own, which is what you want in a server log when somebody asks who is making these requests every minute.
- **Request body** (`body`) — Sent as-is. Set a Content-Type header below to match it.
- **Request headers** (`requestHeaders`) — Sent with the request. An Authorization header does *not* belong here — set an HTTP credential on the device instead, so a hundred sensors against one API rotate their token in one place rather than a hundred.
- **Response format** (`format`) — `auto` reads XML when the Content-Type says so, when the body opens with an XML declaration, or when it starts with a tag that is not HTML — which covers the appliance serving XML as application/octet-stream and the one serving it as JSON. Set it explicitly only where that guess is wrong.
- **Response bound** (`maxBodyBytes`) — How much of the response is read. Passing it fails rather than truncating, because half a document does not parse at all and “unexpected end of input” is a worse diagnosis than “this response is bigger than this sensor reads”.
- **Channels** (`extract`) — Each row is one channel. The first is the one the sensor is judged by. A path that finds nothing leaves a gap in its channel rather than a zero — a metric an API stopped publishing is missing data, not a reading of none.
- **Values that must be right** (`expect`) — Checked as text, and the check fails when one is wrong. This is where a status field belongs — “$.status must equal healthy” — because a status is not a number and a channel that encodes one as 1 and 0 loses what it said.

### `tls.certificate`

cost: **medium**

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `daysRemaining` | Days until expiry | days | **primary** |
| `daysSinceIssued` | Days since issued | days | — |
| `trusted` | Chain is trusted | — | — |
| `hostMatches` | Host name matches | — | — |
| `chainLength` | Certificates in chain | — | — |
| `handshakeTime` | Handshake time | ms | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `443` | ≥ 1, ≤ 65535 |  |
| `servername` | string | _(empty)_ | ≤ 255 chars |  |
| `timeoutMs` | integer | `10000` | ≥ 500, ≤ 120000 |  |

- **Server name (SNI)** (`servername`) — Empty uses the device’s host. Set it when the device is addressed by IP but serves a named certificate, which is most of the modern web — without a name to ask for, the server answers with whatever its default site is.

### `tls.security`

cost: **medium**

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `score` | Weakest accepted | — | **primary** |
| `tls10` | TLS 1.0 accepted | — | — |
| `tls11` | TLS 1.1 accepted | — | — |
| `tls12` | TLS 1.2 accepted | — | — |
| `tls13` | TLS 1.3 accepted | — | — |
| `versions` | Versions accepted | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `port` | integer | `443` | ≥ 1, ≤ 65535 |  |
| `servername` | string | _(empty)_ | ≤ 255 chars |  |
| `timeoutMs` | integer | `8000` | ≥ 500, ≤ 60000 |  |

- **Server name (SNI)** (`servername`) — Empty uses the device’s host.
- **Timeout per version** (`timeoutMs`) — Applied to each handshake separately. This sensor makes one per TLS version, so a wholly unreachable host costs four of these — set the scan interval in hours, not minutes. What it measures changes when somebody edits a configuration file, not from one minute to the next.

## Windows

**Not in 1.0, which is Linux-only.** These types run PowerShell’s CIM cmdlets from a probe *on* Windows, and 1.0 installs no probe there, so the v1 build profile leaves them out of its catalogue (`H-12`). They are release 1.1’s, once `T-25` has run them against Windows — none of their queries ever has.

### `windows.cpu`

cost: **medium** · credentials: `windows`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `total` | Total | % | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `host` | string | _(empty)_ | ≤ 253 chars |  |
| `authentication` | `Default` · `Negotiate` · `Kerberos` · `Basic` | `"Default"` |  |  |
| `timeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |
| `perCore` | boolean | `true` |  |  |

- **Machine** (`host`) — Empty uses this device’s own host. Set it only where the machine to query is not the one this device is reached on. `.`, `localhost` or a loopback address means this probe’s own machine, which needs no credential and no WinRM configured at all.
- **Authentication** (`authentication`) — `Default` negotiates — Kerberos in a domain, NTLM outside one — and is right almost everywhere. `Kerberos` refuses to fall back, which is what turns a silent downgrade into a failed check. `Basic` needs HTTPS on the far end. CredSSP is deliberately absent: it hands the credential to the monitored machine, so one compromised server would hold the account that reaches every other one.
- **Timeout** (`timeoutMs`) — Generous by the standards of the other transports, because starting PowerShell is expensive before anything is queried and a first WinRM connection negotiates authentication.
- **Per-core channels** (`perCore`) — A channel per logical processor as well as the total. Worth turning off on a machine with many cores, where the extra channels cost storage every scan and the total is what anybody looks at.

### `windows.memory`

cost: **medium** · credentials: `windows`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `availablePercent` | Available memory | % | **primary** |
| `available` | Available memory | B | — |
| `total` | Total memory | B | — |
| `virtualAvailablePercent` | Available virtual memory | % | — |
| `virtualAvailable` | Available virtual memory | B | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `host` | string | _(empty)_ | ≤ 253 chars |  |
| `authentication` | `Default` · `Negotiate` · `Kerberos` · `Basic` | `"Default"` |  |  |
| `timeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |

- **Machine** (`host`) — Empty uses this device’s own host. Set it only where the machine to query is not the one this device is reached on. `.`, `localhost` or a loopback address means this probe’s own machine, which needs no credential and no WinRM configured at all.
- **Authentication** (`authentication`) — `Default` negotiates — Kerberos in a domain, NTLM outside one — and is right almost everywhere. `Kerberos` refuses to fall back, which is what turns a silent downgrade into a failed check. `Basic` needs HTTPS on the far end. CredSSP is deliberately absent: it hands the credential to the monitored machine, so one compromised server would hold the account that reaches every other one.
- **Timeout** (`timeoutMs`) — Generous by the standards of the other transports, because starting PowerShell is expensive before anything is queried and a first WinRM connection negotiates authentication.

### `windows.service`

cost: **medium** · credentials: `windows`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `running` | Running | — | **primary** |
| `expected` | Running as configured | — | — |
| `processId` | Process id | — | — |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `host` | string | _(empty)_ | ≤ 253 chars |  |
| `authentication` | `Default` · `Negotiate` · `Kerberos` · `Basic` | `"Default"` |  |  |
| `timeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |
| `service` | string |  | ≥ 1 chars, ≤ 256 chars | **required** |

- **Machine** (`host`) — Empty uses this device’s own host. Set it only where the machine to query is not the one this device is reached on. `.`, `localhost` or a loopback address means this probe’s own machine, which needs no credential and no WinRM configured at all.
- **Authentication** (`authentication`) — `Default` negotiates — Kerberos in a domain, NTLM outside one — and is right almost everywhere. `Kerberos` refuses to fall back, which is what turns a silent downgrade into a failed check. `Basic` needs HTTPS on the far end. CredSSP is deliberately absent: it hands the credential to the monitored machine, so one compromised server would hold the account that reaches every other one.
- **Timeout** (`timeoutMs`) — Generous by the standards of the other transports, because starting PowerShell is expensive before anything is queried and a first WinRM connection negotiates authentication.
- **Service name** (`service`) — The service *name*, not its display name — `Spooler`, not `Print Spooler`. `Get-Service | Select Name, DisplayName` on the machine lists both. The display name is localised and changes with the machine’s language; the name does not.

### `windows.volume`

cost: **medium** · credentials: `windows`

| Channel | Name | Unit | Notes |
| --- | --- | --- | --- |
| `lowest` | Lowest free space | % | **primary** |

| Parameter | Type | Default | Bounds | |
| --- | --- | --- | --- | --- |
| `host` | string | _(empty)_ | ≤ 253 chars |  |
| `authentication` | `Default` · `Negotiate` · `Kerberos` · `Basic` | `"Default"` |  |  |
| `timeoutMs` | integer | `30000` | ≥ 1000, ≤ 300000 |  |
| `drives` | array of string | _(none)_ | ≤ 32 entries |  |
| `includeNetwork` | boolean | `false` |  |  |

- **Machine** (`host`) — Empty uses this device’s own host. Set it only where the machine to query is not the one this device is reached on. `.`, `localhost` or a loopback address means this probe’s own machine, which needs no credential and no WinRM configured at all.
- **Authentication** (`authentication`) — `Default` negotiates — Kerberos in a domain, NTLM outside one — and is right almost everywhere. `Kerberos` refuses to fall back, which is what turns a silent downgrade into a failed check. `Basic` needs HTTPS on the far end. CredSSP is deliberately absent: it hands the credential to the monitored machine, so one compromised server would hold the account that reaches every other one.
- **Timeout** (`timeoutMs`) — Generous by the standards of the other transports, because starting PowerShell is expensive before anything is queried and a first WinRM connection negotiates authentication.
- **Volumes** (`drives`) — Drive letters to watch — C:, D:. Empty watches every local fixed disk, which is what most machines want and what keeps a new volume from being invisible.
- **Include network drives** (`includeNetwork`) — Off by default. A mapped drive that comes and goes with a session produces a channel that gaps for reasons that have nothing to do with storage.
