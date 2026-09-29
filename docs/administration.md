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

### What an account can see

**An object an account may not read is absent** — from the tree and its search, the alarms, the
state log, the notification log, a map's sensor lists, the live stream and every count and total
beside them. Not greyed out and not counted: a total that included it would say how many sensors
are down in a branch the account was never shown.

**The containers above a granted branch are outside it.** An account granted `Customer A` sees
`Customer A` and everything in it, and never the probe or the root above it — so its tree starts
at the branches it was granted rather than at the root, its breadcrumbs start there too, and the
overview counts those branches. A grant made inside a hole it cannot see is a starting point of
its own.

A few consequences are worth knowing before somebody reports them as bugs:

- **A scope naming an object the account cannot read is refused**, not answered with an empty
  list: `?objectId=` on the alarms or the state log, `?parentId=` on the tree, a stream
  subscription to one object. Serving the visible part of a hidden branch would answer "which of
  my sensors are under object 4711", which is a question about a branch the account cannot see.
- **A trigger, a discovery run or a rediscovery schedule in a branch the account cannot see is not
  found.** Asked for by its own id, it gets the same 404, in the same words, as an id nobody has
  used, so trying ids says nothing about another branch. One the account can see but may not
  change is refused, and the refusal names the object it belongs to.
- **Something inherited from a hidden container is shown, and the container is not named.** A
  trigger defined on the probe above a customer's branch fires for the customer's sensors, and
  the triggers tab lists it "from an object outside your view". A pause inherited from above, a
  dependency on a master in somebody else's branch and a template preview's `%probe` say the same.
  A pause's *message* is shown as written: it becomes the state of every sensor the pause holds,
  and it was written for the people whose sensors those are.
- **The installation's own health is not a branch's.** Core Health, notification health and
  `/metrics` need `read` on the root; the list of probes needs an administrator; a probe's health
  needs `read` on that probe.
- **A public share link shows what its maker can see, now.** Somebody with the URL needs no
  login, so the link carries the rights of the account that made it: a tile on an object that
  account cannot see is drawn as unavailable, and a map's designer refuses a new tile on one.
  Revoking the maker's grant narrows every link it made. Disabling or deleting the account
  stops every link it made from opening at all: a stranger gets what a revoked link gets, and not
  the map's name, titles or background either. Re-enabling the account brings its links back, so
  revoke a link that should stay dead. A link made before this rule existed, by a login that has
  since been renamed or deleted, stops opening after the upgrade for the same reason: nobody is
  left to see through. Make a new one.
- **Deleting or moving an object needs `write` on everything beneath it.** A delete destroys the
  subtree and a move carries it, so `write` on a device is not enough when a sensor beneath it
  was carved `none`, or granted only `read`. The refusal says there is something beneath that
  the account may not change, and never what or how much. An administrator, or a grant that
  closes the hole, is how such a subtree is deleted or moved.
- **A clone copies what its maker can see.** A hole beneath the source is left out and not
  counted. The copy keeps the source's own grants, every group's, so a hole carved for somebody
  else is still a hole in the copy. A clone made in place lands in the source's parent, and needs
  `write` there as a clone into any other parent does.
- **A pause or a setting on a container still reaches into its holes**, as every inherited value
  does. It stores nothing on the hidden objects. Acknowledging or forcing an error on the
  container is not inherited: it is written onto each sensor, and reaches only the sensors its
  caller can see.
- **Acknowledging or forcing a drill on a container does to each sensor only what naming that
  sensor would allow.** Forcing and releasing need `write` on the sensor itself. Acknowledging and
  clearing need `write`, or `read` on an account allowed to acknowledge. So a sensor granted to
  you only as `read`, beneath a device you may write, is left as it is. The answer lists it under
  `skipped`, and a request that would leave everything you can see there is refused. A hidden
  sensor is never listed. **A pause is no precedent for this.** It is state on the container that
  everything beneath it inherits, and nothing is written onto the sensors, so pausing that device
  does pause the `read` sensor with it. A `read` grant under a container somebody may write
  therefore keeps the sensor from being edited, forced, or deleted or moved with the container.
  It keeps the sensor from being acknowledged unless the account has the opt-in. It does not keep
  it from being paused. To keep a sensor out of a writer's hands entirely, carve it `none`.
- **An object's history leaves out its grant entries** for anybody but an administrator. They say
  which groups may see the object and who decided so, which is what the grants list says, and
  that list is an administrator's. `full` on an object is the right to change it, not to read who
  else may.
- **The history of a deleted sensor is visible to administrators only.** Nothing records which
  branch it was in, so there is no grant left to read it through.
- **A change of grant reaches an open page at the next state change.** The live stream checks for
  one each time it has something to deliver, and a page whose view has changed is told to start
  again — which it does, on its own, with what it may see now.

### Sessions, and screens left open

A browser session ends after **12 hours without a request**, and **7 days** after signing in
however active it is. Both are settings, in their own section, and both apply to every session in
the installation:

```json
{ "sessions": { "idleTimeoutMinutes": 720, "absoluteTimeoutHours": 168 } }
```

The idle timeout may be 5 minutes to 30 days, and the absolute one 1 hour to 90 days.
`config check` refuses an idle timeout longer than the absolute one, since the absolute one would
then always arrive first. A logout, a password change (which ends the account's other sessions),
a revoked token and a disabled account each take effect on the next request. The browser keeps
the cookie for as long as the absolute timeout allows. The core decides when the session ends.

**And on an open page, within seconds.** A page's live updates arrive over a WebSocket that is
signed in once, when it opens, and the core keeps asking whether what opened it still
authenticates: before it delivers each state change, and every five seconds when nothing changes.
When the answer is no, the socket is closed with `4401` and the page goes to the login form and
says why. Nothing that changed after the logout is sent. Core Health counts these by reason
(`streamEnded`, `streamExpired`, `streamRevoked`, `streamDisabled`), and `streamCheckFailures`
counts checks that could not be made. **A check that fails closes nothing**: a database that
blinked is not a reason to sign everybody out, so a climbing `streamCheckFailures` means sockets
are not being checked.

**An open stream is not activity.** The stream asking does not extend the session. If it did, a
browser left on a dashboard would never time out, and the idle timeout would mean nothing for the
unattended screen it exists for. A page that makes requests of its own keeps its session: the
alarm list asks again after each change, and a sensor's page re-reads its channels every 15
seconds. A page that makes none for the idle timeout, such as a tree on a quiet installation, is
signed out, and every page is signed out at the absolute timeout. A script uses an API token,
which has neither.

#### A wall display

1. **Give it an account of its own**, `readonly`, in a group granted `read` on the branch it shows.
   The screen is signed in and unattended, and whoever walks up to it has that account.
2. **Show the alarm list, or a sensor's page, rather than the tree.** Both ask the core for
   something on their own, so the idle timeout never ends the display's session, and only the
   absolute timeout does. Set `sessions.absoluteTimeoutHours` to how often somebody is willing
   to sign the screen in again: `720` is monthly.
3. **For a tree, the idle timeout has to outlast the quiet.** A tree asks for nothing while
   nothing changes, so set `sessions.idleTimeoutMinutes` longer than the quietest stretch you
   expect. A weekend is `4320` (three days). This applies to every browser in the installation,
   so an unattended office desk stays signed in as long. Prefer step 2 if you can.
4. Run `config check`, restart the core, and **sign the display in again**. Its browser keeps the
   cookie only as long as the absolute timeout allowed when it signed in, so a session started
   before the change can still end on the old schedule.

In a build that has maps (`H-12`), a map's **public share link** needs no session at all, and is
the better answer for a screen that shows one.

### API tokens

A token carries **the rights of the account that owns it, never more**, and can be given less. It
is shown once, at creation, and no route can read it back afterwards. Revoke by deleting it;
there is no expiry to wait for.

Tokens authenticate with `Authorization: Bearer …` and are not subject to the CSRF header
requirement — that applies to cookie-authenticated writes, because a cookie is what a browser
attaches on its own. The exemption is for a request a token actually authenticated. HTTP Basic or
Negotiate credentials that an authenticating proxy forwards are something a browser also attaches
on its own, so a write carrying them is checked like any other.

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


### A sensor that republishes what it reads is vouched for, and stops when that lapses

Three sensor types publish readings that are somebody else's: a **Sensor Factory** computes from
other sensors' channels, a **Probe Health** sensor reports a probe's health, and a **Core Health**
sensor the installation's own figures. Everybody who can read the sensor sees what it publishes, so
the system holds each one to the account that stands behind it (`A-29`):

- **Writing one checks what it names.** Creating one, editing its parameters, moving it and
  cloning it are refused when it names something the account doing so cannot read — a sensor in a
  formula, the probe a Probe Health sensor reports on (the one it sits under, if it names none).
  A Core Health sensor needs `read` on the root. The refusal reads the same for an object that is
  hidden and one that does not exist, so it never says which ids exist. Renaming one checks
  nothing.
- **That account vouches for it from then on, and is checked again at every sweep.** When it can
  no longer read everything the sensor names — a grant revoked or carved to `none`, a group
  membership removed, an object moved out of its view — or the account is **deleted or
  disabled**, the sensor stops being evaluated. It reads **Unknown**, its graphs gap, and its
  message says why without naming what it cannot read: *"Not evaluated: the account that vouched
  for this sensor can no longer read everything it names…"*. An account merely locked out keeps
  vouching, for the reason its reports keep running.
- **It does not page as Down.** Nothing measured has failed, and one grant edit must not become
  one alarm for every sensor that account wrote. A Down trigger stays quiet, and an alarm
  already sent is held rather than recovered — nobody is told "back to normal" about a sensor that
  simply stopped being looked at. A trigger on **Unknown** does fire, as it does when a probe is
  lost; its template's summary window collects them.
- **What depends on it is not let go, and not downed** (`M-23`). A dependency master that was
  Down keeps its dependents paused until it is evaluated again. Its pause view says it is holding,
  with no release time. Vouched for again, it holds while it is still Down, and releases after the
  configured dependency delay once it is not. A Sensor Factory whose every channel reads a
  withheld sensor is withheld too, down the chain, with *"Not evaluated: every channel it computes
  reads a sensor that is itself not being evaluated…"*, and it names nothing. A factory that can
  still compute a channel computes it, with a gap for the rest.
- **One gap remains** (`M-26`). A factory reading a sensor under a probe that is lost, or whose
  clock is behind, runs out of readings after its maximum age, and goes **Down**. It pages
  alongside the probe's Probe Health: a known second alarm, until `M-26` makes it Unknown.
- **To start it again**, save its parameters as an account that can read everything it names —
  an administrator, usually — or give the original account its access back. Either takes effect
  at the next sweep, within thirty seconds. The state log shows the transition with cause `access`.

The system itself vouches for what it writes, and so does a discovery run — its sensors come from
a template somebody with the server's file system installed.

**With `api.requireAuthentication` off, the installation vouches for everything** (`A-45`). The
authorisation layer is off, so nobody's grants apply to any reader, and there is nothing a sensor
could republish that they could not read already. A write vouches as the installation even when
the account making it has logged in, and the audit log still names that account. A sensor an
account already vouches for, from migration 059 or from a time the layer was on, is not checked
while the layer stays off: nothing is withheld for its voucher. Switch the layer on and each of
those is held to its account again from the next sweep. Expect several to go **Unknown** at
once then, one for each sensor whose account can no longer read what it names, or has been
deleted or disabled. Each message says how to vouch for it again.

**On upgrade** (migration 059) every existing sensor is assigned the account that last created it
or wrote its parameters, from the audit log, directly or through one of its tokens. That account
is then checked at the first sweep, so **a factory written by somebody who has since lost access
goes Unknown right after the upgrade** — which is the point: it had been publishing what they could
no longer see. A sensor the audit log cannot tie to a live account — written by the system, by an
account since deleted, or inside a clone, which is recorded under the clone's top object — is
vouched for by the installation, and goes on as before. Save one again to put an account behind
it. On an installation with `api.requireAuthentication` off, the accounts it assigns are recorded
and not checked until the layer is switched on.
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

**An inherited set goes only where somebody who may write its owner vouched for** (`A-41`). The
owner is the object the set is stored on. Where a sensor sends it is the probe, the device's host
and address family, and whichever of the sensor's parameters its type says choose the listener
(the port, for SNMP). Without this, anybody with `write` on one device under the group could
point it at a machine of their own and be sent the group's community at the next scan. So:

- **A write that brings a set somewhere new is refused unless its writer has `write` on the
  owner.** That covers changing a device's host or address family, creating, moving or cloning a
  device or a sensor under the set, changing a sensor's port, and deleting a set so that an
  ancestor's takes over. The 403 names the kind and the owner, never the secret.
- **Writing a set vouches for everything beneath that it reaches.** Whoever may write the group
  may send its credentials anywhere under it; that is what storing them there means.
- **What was vouched for is checked again at every configuration a probe is sent.** A sensor
  whose voucher has lost `write` on the owner, or been disabled or deleted, is not sent to its
  probe at all, and reads **Unknown** with a message saying why and what to do — not Down from a
  failed login. A grant, group or account change pushes configuration, so the next one stops
  carrying it. Saving the sensor again, as an account with `write` on the owner, sends it again.
- **A discovery run** vouches as the account that started it, and a scheduled rediscovery as the
  account that last wrote its rule. A sensor it cannot vouch for is left out of the device and
  listed among the run's problems; the rest is made. **Deleting a rule fails its runs** with
  "its rule was deleted": one still going is stopped, and one that finished creates nothing when
  somebody asks to provision it (409 `DISCOVERY_RUN_FAILED`). Nobody stands behind those
  addresses any more; start a new run to provision them.
- **Upgrading changes nothing.** The first start of this version records the installation as
  voucher for every set in use, in one transaction, before any probe is configured. A later
  release that changes which parameters a type says choose the listener moves every such
  fingerprint at once. Its first start carries a record over only when the old rule, applied to
  the sensor as it is now, gives the fingerprint that was recorded. A record that fails that
  check stays withheld until somebody vouches for it again. The audit log gets one
  `credential.adopted` entry per kind, with how many were carried and how many were left
  withheld.

**`write` on the object a set is stored on is trust with that set.** Anyone with it may send the
set to any address they can put a device at, as they always could. Store a set as low in the
tree as its devices allow, and grant `write` there with that in mind. `A-41b` will let a set name
the addresses it may go to.

**Secrets in a sensor's own parameters stay with its device** (`A-41`, by `A-40`'s rule). An SNMP
community or key, or a script's secret, set on the sensor rather than inherited, is cleared when
the device's host or address family changes, when the sensor or its device moves or is cloned to
another probe, and when a sensor moves or is cloned onto another device — each with an audit entry
naming what was cleared. The price is that **renumbering a device means entering those again**;
an inherited set carries over, because its owner's writer vouches for it.

**Between probes**, a set goes with the device. Moving a device to another probe sends its
credentials to that probe, which is why that probe is part of where they go: the same private
address behind another probe is another machine, and needs its own voucher.

**A credential set holds only the fields its kind declares** (`A-43`). A write naming any other
field is refused with a 400 that names it, and nothing is stored. Before this, a secret sent
under a mistyped name (`comunity` for `community`) was stored as a *public* field, in the clear,
and every read returned it. A set written that way still holds the key, but no read returns it,
to the API or to a probe. Core Health's **Credential sets to re-enter** counts such sets, and at
start-up the core log names each one by kind and object id, never by key or value. Re-enter the
set, rotating the secret if it was one: the write replaces the public fields, and the key goes
with them. **Audit entries written before `A-43` may hold such a value**, in the `credential.set`
entry's public fields, and nothing rewrites them. Treat an audit export from before then as
holding whatever was mistyped.

**A check's message does not carry its secrets** (`S-19`). A message is often somebody else's
words — a script's last lines of output, a driver's error, a server's banner — and it reaches the
state log, notifications and reports. So before any result leaves the probe, every exact value of
a write-only parameter of the sensor and of a secret credential field (a password, a private key,
a community) is replaced by `••••••` in it, for every sensor type. Know its limits: it matches
**exact** values only, so a secret the script printed base64-encoded, split, or partly is not
caught; and it skips values **shorter than four characters**, which would otherwise turn ordinary
words into markers. A secret that short is not much of one.

## Script sensors

The EXE/Script sensors run a program the operator put in the probe's **script directory**
(`probe.scriptDir`; empty, the default, runs nothing). The directory is the boundary: a sensor
names a file inside it, never a path, and whoever may add a sensor may therefore run only what
somebody with the server's file system chose to deploy. What a sensor writer controls is the
arguments and the variables — so treat both as untrusted input in every script you deploy.

- **A sensor sets only `MS_VAR_*` variables.** Any other name is refused by the API, because
  variables such as `BASH_ENV`, `PS4` with `SHELLOPTS`, and `NODE_OPTIONS` make bash or node run
  code of the writer's choosing before the script's first line — measured, as the account the
  probe runs as. A script also receives `MS_HOST`, `MS_SENSOR_ID`, `MS_SECRET` when a secret is
  set, `PATH`, and the probe's own `LANG`, `LC_*` and `TZ`; nothing else of the probe's
  environment.
- **The working directory is inside the script directory too**, named as the program is. Empty
  runs the program where it lives.
- **A sensor's secret stays with where it is sent** (`A-40`). Changing the program, its
  arguments, its environment or its working directory clears the secret unless you enter it
  again, and the audit entry says so. Those decide where a script sends `MS_SECRET`, so keeping
  it would let anyone with `write` on the sensor point a secret they were never shown at a
  listener of their own.
- **Scripts run as the probe's account**, which holds the probe's identity and the credentials the
  core sends it. `probe.processUid`/`processGid` run them as another account instead, but need the
  probe to have `CAP_SETUID`, which the shipped unit does not grant.

**On upgrade**, a script sensor that already sets a variable outside `MS_VAR_` is not rewritten —
renaming a variable changes what its script sees. It goes **Down** with a message naming the
variable, and saving it refuses the name until it is renamed; rename it in the sensor and in the
script together.

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
| `backfillParked` | **Any value above zero is a warning.** A backfill failed three times and is parked; the sensor's message says why. See [a backfill that keeps failing](#a-backfill-that-keeps-failing) |
| `diskFree` | Errors below 10%. See below — a full disk costs retention |
| `memoryAvailable` | What the core's *machine* has left — `MemAvailable` on Linux, the lowest of the last 30 s. Warns below 20%, errors below 10%: `P-206` watched a machine go from 8.5% to a kernel kill in six seconds. On the default installation the local probe's copy reads the same machine; this is the one that matters when every probe is remote and nothing else is watching the database host. A gap where the machine claims more available than total, as a probe's does. **On a single-host install this is the one that alarms** (`M-21`): the local probe's own `memoryAvailable` gaps, so a squeeze is one sensor Down rather than two |
| `memoryLimitUsage` | The core's working set against its own ceiling — `MemoryMax=8G` in `ms-core.service`. Warns above 80%, and the warning is the one to act on: at 100% the kernel kills the core. See [a service at its memory ceiling](#a-service-at-its-memory-ceiling). A gap where there is no limit, on cgroup v1 and on Windows |
| `evictedChunks` | **Any value above zero is an error.** Data was dropped early to stay on disk |
| `logDropped` | **Any value above zero is a warning.** Log lines the core could not write since the last reading, because the journal stopped taking them and 8 MiB were already waiting. With a local probe, its lines too: one journal, one alarm. See [a journal that is not keeping up](#a-journal-that-is-not-keeping-up). `logBacklog` beside it is what is waiting, in MB, with no limit |
| `notifyOldest` | Notifications queued and undelivered. 15 minutes warns; an hour means nobody is being told anything |
| `alarmOverdue` | The alarm sweep is not running. Everything downstream of it is silently stale |
| `probesDown` | Probes not connected. Their sensors are not being checked |

### Probe Health — `ms.probe.health`

| Channel | Watch it because |
| --- | --- |
| `connected` | The link to the core. For a probe that has not connected since the core started, nothing is recorded until the two-minute delivery grace has run out (`M-22`) |
| `schedulerLag` | Checks starting later than scheduled. Warns at 1 s, errors at 5 s — this is the first sign of an overloaded probe |
| `poolUsage` | Worker pool saturation, sampled at the heartbeat rather than averaged — on a bursty workload it under-reads badly (4.7% measured while every worker was saturated once a second, `findings/2026-09-04-live-probe-check.md`), so do not size down from a low reading. Warns at 80%. Since `P-34` the probe raises its own ceiling from the checks it was assigned, so sustained saturation means either `workerPoolSize` is pinned or the workload outgrew what a probe derives for itself — see the troubleshooting runbook, and note that a pool below its floor accumulates rather than refusing |
| `poolCeiling`, `poolMemoryCap`, `poolHeldBack` | How far the worker pool may grow, and whether memory is what stops it (`P-236`). `poolCeiling` is the ceiling in force; `poolMemoryCap` is how many workers the memory the probe may use can hold; `poolHeldBack` is how many the ceiling would allow and memory does not. No limits: memory holding the pool back is not an outage by itself, and when it costs checks, `poolUsage` and `refused` are the alarm. Read these to see that the remedy is memory rather than `workerPoolSize` — see [a probe held back by memory](#a-probe-held-back-by-memory). A gap for a probe older than protocol 19, and `poolMemoryCap` also where memory cannot be read |
| `deferred` | Checks the pool could not start. **Backpressure is counted, never silent** |
| `sessionOverflows` | **Any value above zero is an error.** SNMP or SSH sessions were opened past the pool's bound because every existing one was in use — the pools do that rather than fail a check, and sustained overflow is a probe heading for `EMFILE`. Lengthen `idleMs`, move devices to another probe, or raise the bound |
| `sessionsOpen` | Device sessions held right now. No threshold — how many is a property of your catalogue, not of health |
| `sessionsEvicted` | Sessions closed for being idle. Climbing in step with the sessions opened means `idleMs` is shorter than your scan interval, so every check pays a handshake it need not — expensive on SSH |
| `spoolStalled` | **Any value above zero is an error.** The link is up and the spool is not moving — results are accumulating for a reason nothing else reports |
| `spoolDropped` | **Any value above zero is an error.** Results were lost because the spool filled |
| `logDropped` | **Any value above zero is a warning.** Log lines the probe could not write since the last record — see [a journal that is not keeping up](#a-journal-that-is-not-keeping-up). **A gap on the local probe**, whose lines Core Health counts, and on a probe older than protocol 21. `logBacklog` is what is waiting, in MB, on every probe |
| `memoryAvailable` | What the probe's *machine* has left, which `memory` — the probe's own share — cannot tell you. The probe `P-206` lost was the largest process on its VM, and was killed because a lint run and PostgreSQL had taken the rest. Warns below 20%, errors below 10%. Read every 2 s on the probe's own timer, because the fall from 8.5% to a kill took six, and each record is the lowest since the record before — see [what a record's memory channels cover](#what-a-records-memory-channels-cover). A gap for a probe older than protocol 17, on any platform but Linux and Windows, and where the machine claims more available than it has in total — a container whose `/proc/meminfo` is virtualised (`lxcfs`, OpenVZ) can (`P-224`). The machine's figure, not the probe's own ceiling — that is the next row. **A gap on the local probe** (`M-21`): its machine is the core's, and Core Health's `memoryAvailable` above carries the same reading with the same limits, so one squeeze on a single-host install is one alarm, on Core Health. The local probe's message still names the figure when it is below 20%. Only a probe flagged local at approval is treated this way; one on the core's host that is not flagged still reports both |
| `memoryLimitUsage` | The probe's working set against the ceiling its own unit sets — `MemoryMax=6G` in `ms-probe.service`, whatever the machine has left. Warns above 80%. **Act on the warning**: at 100% the kernel kills the probe, and what follows is a link that drops, not a reading — see [a service at its memory ceiling](#a-service-at-its-memory-ceiling). Measured against the working set, not `memory.current`, because page cache fills a cgroup to its ceiling harmlessly. A gap where there is no limit, on cgroup v1 (RHEL 8 by default) and on Windows. `memoryLimit` beside it is the ceiling in MB |
| `clockJumps` | The host's clock moved. Scheduling is monotonic, but data is wall-clock |
| `clockOffset` | How far the probe's clock is behind the core's, in seconds; negative is ahead. Measured by the core from the send time on every heartbeat and batch, the smallest of five minutes, so a delayed message cannot make a probe look behind. **Warns beyond a minute either way.** A gap until the session has sent one. See [a probe whose clock is wrong](#a-probe-whose-clock-is-wrong) |
| `sensorsFrozen` | **Any value above zero is an error**, so a frozen probe reads Down as a lost one does (`M-22`). Sensors whose last result is later than the probe's clock reads now, so they can accept nothing it sends until it catches up. They read Unknown meanwhile, like a lost probe's. The alarm when NTP pulls a fast clock back, which leaves `clockOffset` near zero |
| `resultsFutureDated`, `resultsPastDated` | **Any value above zero is a warning.** The core refused this probe's results in the last five minutes because no clock could have stamped them: more than 15 minutes ahead of the core, or older than anything is kept. Counted on the core, per probe, so the warning clears five minutes after the clock is put right. See [a probe whose clock is wrong](#a-probe-whose-clock-is-wrong) |
| `reportsRefused` | Everything the core refused from this probe because it was not the probe's to report: a result for a sensor not under it, an answer to a query put to another probe, a message about another probe's discovery run. A counter with no limit, because most refusals are ordinary — a probe whose spool still holds results for sensors that were moved away from it or deleted. See [a probe reporting on work it was not given](#a-probe-reporting-on-work-it-was-not-given) |
| `reportsForeign` | **Any value above zero is a warning.** The part of the above no correct probe sends: work that was never this probe's. A count over the last five minutes, so it sees the first report after a restart or a reconnect and clears five minutes after the last one |

### What a record's memory channels cover

`memoryAvailable`, `memoryAvailableBytes` and `memoryLimitUsage` are the worst the probe read in
the span a record stands for (`P-219`). The core records Probe Health every 30 s, and from
protocol 20 the probe's heartbeats split time between them exactly:

- **Each heartbeat reports the lowest since the last one the core acknowledged.** A heartbeat
  lost as the link dropped is carried by the next, and an outage by the first after it.
- **Each record takes every heartbeat since the record before.** So every reading lands in a
  record, whatever the heartbeat interval, and a squeeze is never missed between records. It shows
  in two when it lasted across the moment between them, because it was low in both.
- **Delivery is at least once, so a reading can land in two records** (`P-245`). The probe sends
  a low again until the core's acknowledgement of it arrives. If that acknowledgement is lost as
  the link drops, or is still unread because the probe stalled for a heartbeat interval or more,
  the next heartbeat carries the low again and the next record repeats it. A Warning or Down it
  caused then lasts one record longer, or comes back for one record. A low that did not happen is
  never recorded.
- **A heartbeat no record takes is let go** (`P-245`). That is one that arrived while the probe
  had no Probe Health sensor, while its sensor was withheld or named no probe, while the core was
  still waiting for the probe after a start, or during a sweep that failed. Those channels are a
  gap for that span. A low from then is never carried into a later record, which would give it
  a time it did not happen at.
- **A low arrives up to one heartbeat late**, in the record after the heartbeat that carried it.
  This is not a fault.
- **At a heartbeat longer than 30 s, every other record has no heartbeat of its own**, and those
  three channels are a gap in it: the line breaks. Repeating the previous heartbeat would present
  a reading nobody took as new. Keep the heartbeat at 30 s or less (the default is 10 s) if you
  want an unbroken line.
- **A probe older than protocol 20** sends the lowest of its last 30 s, and the core records the
  latest one it has, as before. At a heartbeat that does not divide 30 s, such as 20 s, a squeeze
  can fall between the two heartbeats consecutive records read, and be in neither. Upgrade the
  probe.

A scrape of `/metrics` shows the latest heartbeat, not the record.

**A health reading the core cannot use is a gap on its channel, and the link stays up**
(`P-224`). A probe's numbers arrive on its heartbeat, and the core checks each against the
protocol's bounds. One out of range, such as an available percentage over 100, is dropped: its
channel gaps, the rest of the heartbeat is kept, and the core logs *probe sent health readings the
core cannot use* once per field per connection, naming the probe and the value. Before `P-224`
the core refused the whole heartbeat and closed the link, and because the probe sends the same
worst-of-thirty-seconds reading every time, it reconnected into the same refusal indefinitely. A
field the core does not know at all is still refused. That is a version skew, and the probe strips
such fields for an older core before sending.

These thresholds ship as **defaults, not policy**. They are written once when the channel is
created and never again — change or clear one and it is yours from then on, because a default
that reappeared after somebody deliberately removed it would be worse than no default at all.

### A probe whose clock is wrong

A probe stamps every result with its own clock, and the core cannot measure again what the probe
measured. So the core checks each stamp against its own clock and refuses what no clock could have
produced, readings and state together. It never moves a stamp: a reading at a time nobody
measured it would be a guess, and a gap is what this system shows instead.

| The probe's clock is | Its results are | What says so |
| --- | --- | --- |
| Ahead of the core's by more than 15 minutes | **Refused** (`P-99`). Stored, one would freeze its sensor: nothing no newer than it is accepted afterwards, so a result stamped 2030 would stop the sensor until 2030 | `resultsFutureDated` on that probe's Probe Health, and on Core Health for the whole fleet. One log line a batch, naming the probe's GID and the span of the stamps |
| Behind by more than anything is kept: the longest of the four retentions and `stateDays`, ten years by default | **Refused** (`P-231`). A device with no RTC that boots at 1970, or a VM restored from an old snapshot. No genuine replay is that old | `resultsPastDated`, the same way |
| Behind by less, and always was | **Stored, at the wrong time.** The readings land in the past, where the rollup tiers take them only where they hold nothing | `clockOffset`, beyond a minute |
| Stepped back, by any amount: an RTC reset at boot, NTP pulling a fast clock back | **Dropped** for as long as the clock reads earlier than each sensor's last result, because a result no newer than a sensor's last one is taken for a duplicate. Those sensors read **Unknown**, cause `probe`, exactly as a lost probe's do, until the clock passes where it was or is put right (`P-232`) | `sensorsFrozen`, and `clockOffset` unless the step brought the clock back to the right time |
| Ahead by less than 15 minutes | Stored as stamped | Nothing. Ordinary NTP drift |

**The fix is the probe host's clock** (chrony or `systemd-timesyncd` on Linux, `w32time` on
Windows), not anything on the core. The warning clears five minutes after the last refused
batch, the window the two channels count over. The refused results are not recovered: they were
measured at times nothing can place.

The bound behind is deliberately that long. A probe's spool is bounded by size, not age, so a
probe cut off for a month replays a month. Past the raw retention, its readings still fill the
rollup tiers where they are empty, and its states still count towards uptime. A shorter bound
would throw that away at the door.

### A lost or frozen probe, and who is told

A probe that loses its link, stops sending results or has its clock step back leaves every
sensor it carries **Unknown**, cause `probe`. Its Probe Health reads **Down** in all three cases.
The notifications follow one rule (`M-22`): **a trigger that covers the probe's Probe Health
hears about the probe once, from that sensor, and not once per sensor the probe carries.**

| The trigger | While the probe is away | When it is back |
| --- | --- | --- |
| On Down, covering Probe Health | One notification, for Probe Health | One recovery |
| On Unknown, covering Probe Health | One notification, for Probe Health, saying which probe and how many sensors: *probe Site A is lost: the 312 sensors it carries are Unknown, held as this one alarm* | One recovery: *probe Site A is answering again: its sensors are no longer held* |
| On Up, covering Probe Health | Nothing | One notification, for Probe Health, not one per sensor |
| Not covering Probe Health, such as a team's trigger on a group below the probe | One per sensor, as before | One per sensor |
| Any, on a probe with no Probe Health, or one that is paused or withheld (`A-29`) | One per sensor, as before | One per sensor |
| Any, when Probe Health is paused or withheld during the loss | The one alarm is cancelled, and from then on one per sensor, as if it had been paused first (`M-24`) | One per sensor |

A sensor that was Down before its probe went resumes where it was: no second page, and no
recovery until it really recovers.

- **Acknowledging Probe Health** stops the one alarm's escalation and repeats, as acknowledging
  any sensor stops its alarm's. When the acknowledgement lapses or is cleared, they resume where
  they stopped (`M-24`).
- **Moving a lost probe's devices to a live probe**, or deleting them, ends the one alarm on
  Unknown with a recovery that says why: *probe Site A is still lost, but none of its sensors are
  held now: they were moved off it or deleted*. The alarm on Down stands: Probe Health is still
  Down (`M-24`).
- **A probe lost while it carries nothing** raises nothing on Unknown: there is nothing held. When
  sensors are moved, created or cloned under it, they are held from that moment and the one
  alarm is raised for them, as if they had been there all along (`M-24`).

- **A trigger covers a sensor when it applies to it**: on the sensor itself or on anything above
  it. A trigger on the root covers every probe's Probe Health.
- **For a team to get the one alarm**, rather than one per sensor, give it a Probe Health it
  covers. A Probe Health that names the probe (its *Probe* parameter) can sit in the team's own
  group.
- **The Unknown notification is about Probe Health**, which the UI shows as Down. Its status reads
  `unknown` and its message explains; nothing else, not the history, uptime, the API or the UI,
  ever shows Probe Health as Unknown for it.
- **A sensor withheld for want of a voucher** (Unknown, `A-29`) is not held by any of this. It
  is not its probe's doing, and the trigger over it reaches whoever can vouch for it.
- **Across a core restart** a probe that is still away stays held from the first moment, and
  nothing is sent twice. For the first two minutes (the delivery grace) a probe that has not
  reconnected yet is neither marked lost nor read by Probe Health. One that redials inside that
  time was never lost, and nobody is told anything. The cost is that a probe genuinely dead
  when the core starts is named two minutes later. A recovery that follows a restart carries Probe Health's own message
  rather than the one above.

### A probe reporting on work it was not given

A probe may report on the sensors under its own probe object, answer the queries put to it, and
progress the discovery runs dispatched to it. The core refuses anything else where it arrives,
and writes nothing (`P-228`). Before that, any approved probe could store readings to, declare
channels on and turn Down any sensor in the installation, answer another probe's query, and plant
hosts in — and finish, and so provision — another probe's discovery run.

| What was refused | Counted as | Why |
| --- | --- | --- |
| A result for a sensor that no longer exists | `reportsRefused` | A spool draining after a delete. Ordinary |
| A result for a sensor that was once under this probe | `reportsRefused` | The sensor, its device or a group above it was moved to another probe while this one's spool still held results. Ordinary, and never a warning: an administrator moving sensors must not raise an alarm on the probe they moved them from |
| A result for a sensor that was never under this probe, or for one the core evaluates itself (Probe Health, Core Health, a Sensor Factory) | `reportsForeign` as well | No correct probe sends one |
| An answer to a query put to another probe | `reportsForeign` as well | Likewise. The caller keeps waiting for the real answer |
| A message about a discovery run dispatched to another probe | `reportsForeign` as well | Likewise |

**Whether a sensor was once under a probe is read from the audit log**: every move records the
probe it left, in the move's own transaction, and the core follows a sensor's history back
through each move of it or of anything above it. So it depends on the audit retention
(`retention.auditDays`, 730 days by default). A spool older than the retention would read as
foreign — far longer than any spool, which is bounded by size.

**The results are refused, not recovered.** Ownership is decided when a result arrives, not when
it was measured, so what a probe measured before a sensor was moved away from it is not kept.
The gap is one spool's length on the moved sensors, and the new probe fills from the move on.

**When `reportsForeign` warns**, the probe is sending what it was never given. The log has one
line a batch, `a probe reported on sensors that were never under it; refused`, naming the GID,
the probe object and up to twenty of the sensor ids. The usual causes are a probe host restored
from another probe's backup, or two probe objects whose GIDs were swapped when one was re-pointed.
Neither is fixed on the core: find the host, and re-enrol it if its identity is not its own.

A probe cannot enrol under a name the core reports its own results under (`factory`,
`core-health`, `probe-health`). One that offers one is given a fresh identity.

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
  again. **After five starts inside ten minutes systemd refuses the sixth** (`P-215`): the unit is
  `failed`, and `systemctl status ms-probe` says *start request repeated too quickly*. Measured on
  a real systemd, a probe killed before it could connect was killed five times 5.7 s apart and
  refused 28 s after the first kill. The slower loop measured in `P-213`, 10–14 s a round, gets
  there in about a minute, and any loop under two minutes a round gets there.
  `systemctl show -p NRestarts ms-probe` counts the rounds it took. The core shows the probe Down
  with "Link to the core is 0", and `memoryLimitUsage` as a gap, not as 100%.
- **One or two alarms, not one.** The core sweeps Probe Health every thirty seconds, and a probe
  that connects for a few seconds each round can be seen Up between two outages. Five rounds are
  enough for that to happen once, so expect one alarm or two; before the start limit it was one
  every round, 36–45 an hour. Bringing it to one is `M-18`.
- **Then it is started again after a cool-down** (`H-23`): 10 minutes, doubling on each retry that
  crashes again, to 4 hours. A probe whose cause has gone, a burst of work that has passed, comes
  back by itself; before `H-23` it stayed `failed` until somebody reset it, which for a remote
  probe meant a visit. See [When a service keeps crashing](#when-a-service-keeps-crashing),
  including what it costs in alarms until `M-18`.
- **Raising the ceiling, then starting it again, ends it.** If the unit is already `failed`:

  ```
  systemctl set-property ms-probe MemoryMax=8G
  systemctl reset-failed ms-probe
  systemctl start ms-probe
  ```

  If it is still going round, the next restart comes up under the new ceiling by itself.
- **Your own starts count too.** Every start inside the ten minutes counts toward the five,
  whether systemd made it or you did: measured, after a `reset-failed` five `systemctl restart`s in
  a row succeed and the sixth is refused with *start request repeated too quickly*. So when you are
  editing a configuration and restarting to try it, or have just installed or upgraded (which
  start the services themselves), run `systemctl reset-failed ms-core ms-probe` before the next
  start rather than waiting ten minutes. It clears the count and changes nothing else.
- **The core behaves the same way, and says nothing while it does.** A core killed at its ceiling
  on every start ends in `failed` too, and is started again on the same schedule. Between retries,
  since the core is what raises alarms, nothing in this system reports it. Only the host's own
  monitoring, or a check from another machine, will notice; this project ships neither.

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

### A probe held back by memory

**The probe grows its worker pool only as far as its memory holds** (`P-236`). The ceiling it
derives from its checks (`P-34`) knows nothing about memory: checks that wait out their timeout,
against a device or a network that has stopped answering, make it enormous. Measured, 5,000
`port.tcp` checks against a port that never answered wanted about 540 workers at 35–40 MiB each;
the probe grew until the kernel killed it, six times in six minutes, and the start limit left it
`failed` (`docs/findings/2026-09-29-probe-starvation-b.md`).

The pool now stops at what memory holds: the memory left under the probe's ceiling, less a reserve
of 10% of the ceiling or 256 MiB, whichever is larger, divided by 40 MiB a worker. Past that,
checks wait in the queue and are refused and counted when it is full, and the probe stays up.
Probe Health says so in its message — *memory holds the pool at 77 workers, 179 short of its
ceiling* — and the probe logs *memory is holding the check pool back* once per episode, with the
numbers it used. If memory runs short while the pool is large, workers are given up as they finish
their checks, never in the middle of one.

What to do depends on why the pool wanted so many:

- **Checks are hanging.** A device or a network down makes every check against it wait out its
  timeout, and the pool fills with workers waiting. The refusals end when the target answers or
  its sensors are paused. More memory would only let the probe hold more workers waiting.
- **The workload is genuinely that large.** Raise the ceiling, `systemctl set-property ms-probe
  MemoryMax=…`, or move sensors to another probe.

**Where the probe has no memory ceiling of its own, it measures the machine's instead**, and then
it competes with everything else on the host: the reserve is its only protection, and something
else growing can still take what it counted on. That is cgroup v1 (RHEL 8 by default), a unit
whose `MemoryMax` was removed, and Windows, where WinSW sets no limit. **On Linux, keep a
`MemoryMax` on `ms-probe`** — the shipped unit sets 6 GiB — so the probe is bounded by memory that
is its own.

**`workerPoolSize` set to anything non-zero is obeyed, not capped.** It is your statement of how
much memory the probe may use. If it is more than memory holds, the probe logs *workerPoolSize
allows more workers than memory holds* once per episode and grows past it anyway, and
`poolMemoryCap` shows the number it would have stopped at.

### A journal that is not keeping up

**A service never waits for its log** (`P-216`). Both write to standard output, which systemd
hands to the journal. When the journal stops taking lines — journald stalled, a disk full under
it, a host starved of CPU — the lines wait in the service, up to 8 MiB each, and past that they are
dropped and counted. `logDropped` on Core Health and Probe Health warns on the first one. Before
this a stalled journal made the service hold everything it logged, for as long as the stall
lasted, and said nothing.

When a service exits it writes what is waiting first, and waits up to two seconds for a stalled
journal to take it, so the line that says why it stopped is the last one in the journal, not lost.
That covers a stop, a crash, and a configuration it refuses (exit 78); it cannot cover a
`SIGKILL`.

**On a single host both services share one journal**, so a stall makes both drop at once. Core
Health counts the local probe's lines with its own, and the local probe's `logDropped` gaps: one
journal, one alarm. A probe on a host of its own has its own journal and its own warning.

`logDropped` counts the lines dropped since the last reading, whether or not that reading was
recorded. So a sensor added to a probe, or released after being withheld, starts from its own
first interval, not from everything dropped before it existed. The first reading after a probe
reconnects is a gap: what it dropped while away fell in no reading (`P-250`).

What to look at, in order:

- **`journalctl --disk-usage` and the disk under `/var/log/journal`.** A full disk stops the
  journal.
- **`systemctl status systemd-journald`.** A journald that is itself starved or restarting.
- **The host's load.** A machine that cannot schedule journald cannot schedule the services
  either; `schedulerLag` and the watchdog restarts will be saying so too.

A refused check is logged once per episode, not once per check: the first line names the sensor,
its type and the queue's bound, then *still refusing checks at a full queue* every 30 s with the
count, and *no longer refusing checks* once 30 s pass without one. `refused` on Probe Health has
every one.

### A core that is still starting

A core does not report itself running until it can serve, and there are things it will wait for
rather than fail on (`P-215`, `P-222`; [findings](findings/2026-09-28-start-exits.md)). **Core
Health cannot tell you about any of them**, because the core is not up yet: the service log and
`systemctl status ms-core` are the only places they show. Every wait keeps systemd waiting on
purpose, so the unit sits in `activating` rather than failing and restarting.

**Waiting for PostgreSQL.** A database that is not there *yet* is waited for, up to five minutes a
round:

```
Status: "waiting for PostgreSQL at db.example.com:5432/monitoring: PostgreSQL is starting up or recovering (attempt 7, 41 s)"
```

Every attempt is logged with its reason. After five minutes the core exits, and systemd starts it
again five seconds later, which waits another five minutes. A database that stays down is
therefore waited for indefinitely, in five-minute rounds, at most two starts in any ten minutes,
which never reaches the unit's start limit. A host name that does not resolve *is* waited for,
because at boot it may not be published yet, so check that the name in the log is the one you
meant. What the database *refuses* is not waited for; see the table below.

**Waiting for the migration lock.** Every migration run takes one lock first, so that two cores
starting together cannot both migrate. If another session holds it, the core says whose it is:

```
Status: "waiting for the migration lock, held by PostgreSQL session 81234 (ms-core from 10.0.0.5, idle for 3140 s), 45 s so far"
```

The holder is almost always an `ms-core migrate` run in progress, which you should let finish, or
the session of a core whose host died in the middle of an upgrade. PostgreSQL keeps that one
until TCP keepalive notices, about two hours by default. If the session is `idle` and its client is
a machine that is down, end it with `SELECT pg_terminate_backend(<pid>);`, and the core carries on
by itself.

**Applying a migration.** An upgrade migrates the schema at start-up when `database.autoMigrate`
is set, which it is by default. A migration reports itself every fifteen seconds for as long as it
runs, however long that is:

```
Status: "applying migration 51 (report-pdf), 340 s so far"
```

A migration on a large installation can legitimately take many minutes. Let it finish. **Do not
restart or kill the core to hurry it**: every migration but the first-install ones runs in a
single transaction, so killing the core rolls that transaction back and the next start begins the
same migration again from nothing.

**If the elapsed time keeps climbing and nothing else is happening, the migration is almost
certainly waiting for a lock.** Changing a table needs that table to itself, and a single open
transaction anywhere — a `psql` session someone left in `BEGIN`, a long `pg_dump`, a report
query — holds it off indefinitely. Find what is in the way:

```sql
SELECT waiting.pid                   AS core_pid,
       blocker.pid                   AS blocking_pid,
       blocker.usename,
       blocker.application_name,
       blocker.client_addr,
       now() - blocker.xact_start    AS transaction_open_for,
       blocker.state,
       left(blocker.query, 80)       AS last_statement
FROM pg_stat_activity waiting
CROSS JOIN LATERAL unnest(pg_blocking_pids(waiting.pid)) AS b(pid)
JOIN pg_stat_activity blocker ON blocker.pid = b.pid
WHERE waiting.application_name = 'ms-core';
```

An `idle in transaction` session with a long `transaction_open_for` is the usual answer. Ask
whoever owns it to commit or roll back. If they can't be found and you are sure it holds nothing
you need, end it with `SELECT pg_terminate_backend(<blocking_pid>);`. The migration continues by
itself the moment the lock is free, with no restart needed.

**Waiting for a listen address.** A listener configured on a specific address (`api.host`,
`probeEndpoint.host`, the probe's syslog and trap listeners) waits up to five minutes a round for
this host to have that address. At boot a DHCP lease on a second interface, a VLAN, a bridge or a
virtual IP can arrive after `network-online.target`. The wildcard and loopback defaults never wait.

### What a start failure does

**The rule: the units' start limit is only safe if everything a restart could fix is waited for
where it happens, or classed as transient.** Five starts inside ten minutes leave a unit `failed`,
and a `failed` core is silent (`P-215`). So nothing that fixes itself may cost a start, and nothing
a person must fix may be restarted into: it stops at once, and the next start is yours. This table
is the one place that says which is which. The code that decides is
`packages/core/src/db/wait.ts` for the database and `packages/shared/src/lifecycle/` for the rest.

| At start-up                                                                                                 | What the service does                           | What you see                                          |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| PostgreSQL not listening, recovering, shutting down, out of connection slots, or its socket file absent     | Waits, five minutes a round                     | `waiting for PostgreSQL at …` in `systemctl status`   |
| PostgreSQL's host unreachable, dropping packets, or closing the connection before answering                 | Waits, five minutes a round                     | the same, with *the connection timed out* or similar  |
| The database host name does not resolve, or the resolver is not up                                          | Waits, five minutes a round                     | the same; check the name is the one you meant         |
| PostgreSQL's certificate not valid *yet* (a clock not set at boot)                                          | Waits, five minutes a round                     | the same                                              |
| Another session holds the migration lock                                                                    | Waits, for as long as it is held                | `waiting for the migration lock, held by …`           |
| A migration running                                                                                         | Waits, for as long as it runs                   | `applying migration N (name), … s so far`             |
| A configured listen address this host does not have yet                                                     | Waits, five minutes a round                     | `waiting for <address> to be assigned to this host …` |
| A configuration file that is invalid                                                                        | Stops, exit 78, no restart                      | `Configuration error: …`, unit `failed`               |
| PostgreSQL refuses the password (including none configured), the user, the database name or its permission | Stops, exit 78, no restart                      | `Configuration error: PostgreSQL at … refused …`      |
| PostgreSQL's certificate untrusted, expired or for another name, or TLS on where the server has none        | Stops, exit 78, no restart                      | `Configuration error: …`                              |
| The schema is behind with `autoMigrate` off, newer than this build, or an applied migration was edited      | Stops, exit 78, no restart                      | `Configuration error: …`                              |
| Anything else — a port in use, a missing permission, a crash, a failure nobody has classified | Exits 1; systemd restarts it, up to the limit; then it is started again after a cool-down | `fatal: …`; after five in ten minutes, `failed` until [the retry](#when-a-service-keeps-crashing) |

**After exit 78, fix the cause and start the service**: `sudo systemctl start ms-core` works,
because the refusal used one start of the five. After a unit is `failed` with *start request
repeated too quickly*, or whenever you have restarted it several times while trying something,
clear the count first:

```
sudo systemctl reset-failed ms-core ms-probe
sudo systemctl start ms-core ms-probe
```

### When a service keeps crashing

**A service the start limit stopped is started again** (`H-23`). Both units name
`ms-recover@.service` in `OnFailure=`, so when one enters `failed`, `/opt/ms/bin/ms-recover`
looks at why:

- **Stopped by the start limit** — five starts inside ten minutes, *start request repeated too
  quickly* — it schedules one start after a cool-down: 10 minutes, then 20, 40, 80 and 160, and
  every 4 hours after that for as long as the service keeps crashing. The count starts again once
  the service has stayed up for an hour after a retry. The first cool-down is the start limit's own
  ten minutes, so a retry never lands in the window that just filled.
- **Anything else is left for you.** A configuration the service refused (`Configuration error:`,
  exit 78) is never restarted, so it never reaches the limit and fails differently; starting it
  again would read the same file and refuse again. A stop you asked for is yours, even one that
  timed out and left the unit `failed`. A unit you have disabled is left down too.

**If you change `RestartSec` in a drop-in, keep it at a second or more.** `ms-recover` tells a
crash loop the start limit stopped from a stop or a refusal by how long systemd waited between the
service's process exiting and the unit failing: `RestartSec` for the one, under two milliseconds
for the others, on every distribution this supports. Below a second it cannot tell them apart, so
it leaves the service down and says why in the journal, and `ms-setup` warns about it when it
installs.

Each decision is one line in the journal, with the time of the next start and how to cancel it:

```
journalctl -u 'ms-recover*'
systemctl list-timers 'ms-recover-*'
```

**To keep a crashing service down while you work on it**, disable it, or cancel the pending
start. When it is fixed, `reset-failed` and start it, and enable it again if you disabled it:

```
sudo systemctl stop ms-recover-ms-probe-retry.timer    # this retry only
sudo systemctl disable ms-probe                        # no more until you enable it
```

**Until `M-18`, a service that keeps crashing re-alarms at each retry.** Each retry is a new loop
of up to five starts, and a probe that connects for a few seconds each round can be seen Up
between two outages, which is an alarm or two a loop. A probe that never stops crashing therefore
raises 4–11 alarms on its first day, over ten loops, and up to 6 on each day after, over six
(`probe-restart-scenario.test.ts`, over every phase), where the start limit alone raised one or
two in total. That breaks *one outage, one alarm*, and it is accepted for now because the
alternative is worse: a remote probe that stays down until somebody travels to it. Each pair at
least says something true, that it came back and died again. `M-18`'s flap suppression is what
makes it one.

**Why not `RestartSteps=`.** systemd 254 can back off by itself, but Debian 12 and RHEL 9 ship
252, and it backs off only while the start limit is not hit, which would mean giving up the limit
and the alarm bound it buys.

### What a stop does

`systemctl stop` sends `SIGTERM`, and the service drains inside `service.shutdownTimeoutMs`
(20 s by default) and exits 0. It tells systemd that budget as it starts to stop, so a raised
budget holds even past the unit's `TimeoutStopSec`. You do not need a drop-in for it. On Windows
there is no such message: keep `stoptimeout` in the WinSW file above the budget.

A probe stops scheduling first. Checks already running get 5 s in the process runner and then
5 s in the worker pool to finish and be spooled. What outlives that is abandoned: the check's
process is ended, and the result spool's closing line counts it under `abandoned`. A check that
the stop cut off is not spooled. Spooling it would give the core a Down for every sensor that
was mid-check at every restart. The spool closes last, so every result that did finish is on disk
before the process exits.

`shutdown budget exhausted` in the journal, with exit 1, means some part of the drain did not
finish in time. The line before it names the hook.

### Prometheus

`/metrics`, outside `/api/v1` because that is the path every scraper config, service-discovery
rule and Helm chart already assumes. **It is guarded explicitly**, because authentication only
covers `/api/` — the app shell has to be public — so a route outside that prefix would otherwise
be public too, and the scrape body is a map of the installation: every queue depth, the sensor
counts per probe, the probe names.

A scraper authenticates with an API token, which is what `authorization` in a `scrape_config` is
for. While the core is still starting it answers **503** rather than an empty body, because an
empty body is recorded as every series vanishing at once.

**A reading the core does not have is an absent series, never a zero** (`P-223`). That covers
`ms_core_disk_free_percent` on a core whose database is on another host, the memory-limit series
where there is no cgroup ceiling, and the five report series on a core that runs no reporting. A
disk-low alert therefore stays quiet on such a core rather than firing for ever. If a series
going missing should page someone, write that rule with `absent()`.

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

### A backfill that keeps failing

Readings that arrive behind the rollups, such as a probe draining its spool after an outage, are
queued for a **backfill**: the housekeeper rebuilds the buckets they fall in, for the channels
that were late and no others, a day and 250 channels per transaction. Inside the source's
retention a bucket is recomputed; past it, where raw data may hold only the late readings, only
buckets that do not exist yet are written.

A backfill that fails is tried again on the next two passes. After the third failure it is
**parked**: `backfillParked` on Core Health goes to Warning, the sensor's message carries the
error, and the entry is tried again an hour later and then once a day. A parked backfill no
longer holds compression and retention back, so one window that cannot be written does not fill
the disk. The price is that if retention reaches its window before a retry succeeds, the retry
only fills buckets that are missing.

Fix what the message names, which is most often the disk or the database refusing writes. Then
wait for the next retry, or bring every parked one forward to the next pass:

```sql
UPDATE rollup_backfill SET retry_at = now() WHERE retry_at IS NOT NULL;
```

To give one up instead, find it and delete it. The summarised graphs for its window then leave
out the late readings, which stay in raw data until retention drops them:

```sql
SELECT id, from_time, to_time, channel_ids, attempts, last_error
FROM rollup_backfill WHERE retry_at IS NOT NULL;

DELETE FROM rollup_backfill WHERE id = 42;
```

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
probe-channel certificates, with a manifest that names the TimescaleDB version that took the
dump. **A restore needs that same version** on the host it goes to, and `ms-restore` refuses
before it writes anything when the host has another — the runbook says how to install the right
one. **Rehearse the restore onto a host that is not the one it came from** — restoring over the original proves almost nothing, because the data, the key and the
certificates are all already there and a restore that quietly did nothing would pass.

The archive decrypts every monitored-device credential in the installation. Store it where the
database's own storage is stored, and no more widely.

---

## Upgrades

Covered in [`docs/installation.md`](installation.md#upgrading). The two things worth repeating:

- **The new build reads your configuration before anything is replaced or restarted.** From the
  tarball, a renamed or newly-required setting stops the upgrade with nothing changed and the old
  version still running. A package has to unpack first, so it stops the services before it does,
  and a refusal leaves them stopped, saying so. Either way, no old process runs on new files.
- **The units are the release's, in `/usr/lib/systemd/system`.** Change them only with drop-ins —
  `systemctl edit`, `systemctl set-property` — which no upgrade touches.
- **A build refuses to start against a schema migrated by a newer build.** That refusal is
  correct. Install the matching release rather than migrating backwards.

---

## Reverse proxies

The API listens on loopback by default. Behind a proxy, two settings tell the core about it:

```json
{
  "api": {
    "allowedOrigins": ["https://ms.example.com"],
    "trustedProxies": ["loopback"]
  }
}
```

**`api.trustedProxies`** lists the proxy's own addresses: `loopback` for a proxy on the same host,
otherwise its address or a CIDR range such as `10.0.4.0/28`. The core believes `X-Forwarded-For`
and `X-Forwarded-Proto` from those addresses and ignores them from everyone else. Leave it empty
behind a proxy and the core sees every browser as the proxy, arriving over plain HTTP:

- **The session cookie is never marked `Secure`, and HSTS is never sent**, although browsers reach
  the proxy over HTTPS.
- **The login throttle counts every browser as one address.** Twenty wrong passwords from anybody
  then refuse everybody's login for fifteen minutes.
- The rate limit, the session list and the log record the proxy's address, not the browser's.

While the list is empty, the core logs a warning, once, the first time a request carries
`X-Forwarded-For`, naming the address it came from.

**List the proxy, not the network the browsers are on.** A browser inside a trusted range can write
its own `X-Forwarded-For` and be counted as whatever address it names, which defeats the throttle.
For that reason `uniquelocal` and `linklocal` are refused. The proxy has to send both headers,
and forward the live stream's WebSocket. In nginx:

```nginx
location / {
    proxy_pass         http://127.0.0.1:8080;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
}
```

**`api.allowedOrigins`** lists the origins browsers use, and is needed when the proxy rewrites
`Host`, as that one does. The core compares the browser's `Origin` with the request's `Host` on
every write and on the live stream's handshake, and a proxy that rewrites `Host` makes those differ
for a request that is not cross-site at all. Without this key every write from such a deployment is
refused, and every page's live updates with it. Full origins, with a scheme: not a bare hostname,
and not a wildcard. A proxy that passes `Host` through (`proxy_set_header Host $host`) needs no
entry. A bad value in either key is refused at startup, not at the first request.

The stream's handshake has been checked since `A-36`. Before that, a page on another port of the
same host, or on a sibling subdomain, could open the stream with the operator's cookie and read
everything the operator could see. An installation behind a proxy that rewrites `Host` has
needed `allowedOrigins` to sign in at all, so this changes nothing for it. The exception is an
installation with authentication off that only ever reads: it now needs the key for live updates.

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

