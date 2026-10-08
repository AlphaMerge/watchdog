# Adding a sensor type

A sensor type is one file. It declares what it needs, what it produces, and how to run — and
nothing else in the system has to change. No switch statement, no frontend work, no migration.

This is ADR-001 Decision 7, and it is the decision the whole roadmap rests on: PRTG's value is
breadth, and we only reach breadth if adding the two-hundredth type is as cheap as the second.

---

## The shape

```ts
import type { CheckContext, CheckExecution, SensorType } from '@ms/sensors';

export const portType: SensorType = {
  id: 'net.port',
  category: 'Network',
  costHint: 'light',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['port'],
    properties: {
      port: { type: 'integer', minimum: 1, maximum: 65535 },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 60000, default: 5000 },
    },
  },

  channels() {
    return [{ key: 'connect', name: 'Connect time', unit: 'ms', isPrimary: true }];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { connect } = await import('./support/tcp.js');
    const ms = await connect(context.params, context.signal);
    return { channels: [{ key: 'connect', value: ms }], message: 'connected' };
  },
};
```

Put it in `packages/sensors/src/types/`, add it to `BUILT_IN_SENSOR_TYPES` in
`packages/sensors/src/index.ts`, and it exists: the API validates it, the form renders it, the
probe runs it.

---

## The members

### `id`

Lowercase, dotted, and **stable forever** — it is written into `sensor_config.type` on every
sensor anyone creates with it. Renaming one is a migration, not an edit.

### `category`

Groups the add-sensor picker. Reuse an existing string where one fits.

### `paramsSchema`

JSON Schema. It does three jobs at once, which is why it is worth writing carefully:

1. **Validates the API.** A sensor cannot be created with parameters this rejects.
2. **Generates the form.** The UI is built from this; there is no per-type frontend work.
3. **Marks the secrets.** See below — this is the part with teeth.

Set `additionalProperties: false` unless you have a specific reason not to. It turns a typo into
an error at the moment someone makes it, rather than a parameter that is silently ignored until
somebody wonders why the timeout setting does nothing.

Use `default` freely. Defaults are applied at validation time and **stored**, so a sensor's row
is complete regardless of which form or script created it, and `channels()` never has to
second-guess an absent optional. Make sure a `default` satisfies its own schema: a `default` of
`''` under a `pattern` that rejects the empty string is a parameter nobody can leave alone, and
the catalogue's "validates against its own declared defaults" test refuses to ship one.

**What the generated form draws.** Strings, numbers, integers, booleans, enums and objects that
declare their `properties` get a real control. Everything else — an array, a free-form object —
falls back to an editable JSON box (`forms/Control.tsx`). That fallback exists so a save can
never *delete* a parameter the form could not draw, and it round-trips correctly, but it is JSON
an operator types by hand. Prefer a shape with a control where one fits; reach for an array when
the parameter genuinely is a list (`snmp.table.columns`), and know that the form is the thing
with the gap, not your schema. `U-12` is the ticket to close it.

### `listener` (optional)

Names a probe-side listener that feeds this type instead of it polling (`T-06`). A type that sets
it is handed `CheckContext.received` — everything that listener collected for this sensor since
its last check — and is handed **nothing** when that listener is not running, which it must report
as a failed check rather than as a reading of zero. A receiver that was never switched on must not
look like a quiet network.

The division is fixed and worth following: the listener decodes and buffers, and the *type* does
all the deciding — filtering, counting, retention are `params`, so they are testable against a
fabricated batch with no socket in the test. `snmp.trap` is the worked example.

### `isolation` (optional)

`'process'` runs each of this type's checks in a **child process** rather than a pool worker
(`P-03`). The rule in CLAUDE.md is "if a check can hang, it runs in a child process", and that
understates the case: a worker thread is terminable and has its own heap limit, so hanging and
leaking are both survivable in the pool. What is *not* survivable there is a **hard crash** — a
segmentation fault in a native module, or an `abort()` from something a user's script loaded —
which takes the entire probe down, every sensor on it. A worker also cannot run as a different
OS user.

So: set it when your type executes code somebody else wrote. `exe.script` and
`exe.script.advanced` are the two that do. It costs about 21 ms of Node start-up per check
(`docs/findings/2026-08-27-process-runner-startup.md`), which is noise beside a script that runs
`df` and three to twenty times the cost of an ICMP check — hence opt-in per type rather than a
setting.

That start-up is not your check's time (`P-260`). The process loads the probe's catalogue first
and says when it is ready, and only then does `ctx.signal`'s timeout start, so `execute` gets the
whole of `ctx.timeoutMs` however slowly the probe started it. A process that has not loaded in
30 s is ended and reported as never started, not as your check timing out.

### `evaluatedBy` (optional)

`'core'` means the **core** computes this sensor's readings and no probe ever receives it
(`T-21`). Three types are: `core.factory`, whose inputs are channel values the core already holds;
`ms.core.health` (`P-12`), whose inputs are counters in the core's own memory; and
`ms.probe.health` (`P-13`). The first two share a reason — **the inputs are things the core has
and a probe does not**, so shipping them out to be read back would be absurd. Anything that talks
to a device belongs on a probe.

`ms.probe.health` is the interesting one, and its reason is stronger: **a probe cannot report its
own absence.** A sensor that ran on the probe would fall silent at exactly the moment it is meant
to raise an alarm. If you are ever tempted to write a sensor about the monitoring system itself,
that is the question to ask — does it still have to answer when the thing it watches is gone?

A core-evaluated type still writes `execute`, and it should reject with a sentence saying so:
that path is unreachable unless the assignment filter has broken, and a sensor that started being
scanned by a probe would otherwise report Down for ever with no explanation.

**A core-evaluated type has to say what it reads**, with `references` or `requires`, and the
catalogue refuses one that says neither (`A-29`). The reason is the same property that makes it
core-evaluated: its readings come from what the core already holds — other sensors' values, a
probe's health, the installation's own figures — and **a sensor republishes its readings to
everybody who can read the sensor**. A type that could name anything would be a way to read
anything the core holds from wherever an account can put a sensor.

### `references(params)` (optional)

The objects this sensor's parameters name, other than its own place in the tree. Called in the
core, with validated params, and must be pure. Each entry says where in the params it came from,
so a refusal can point at the field:

```ts
references(params) {
  const probeId = params['probeId'];
  return typeof probeId === 'number'
    ? [{ kind: 'object', objectId: probeId, expects: 'probe', param: 'probeId' }]
    : [{ kind: 'enclosing-probe', param: 'probeId' }];
},
```

`{ kind: 'object', objectId, expects }` is an object named by id; `expects` is the kind it has to
be, checked only once the writer is known to be able to read it. `{ kind: 'enclosing-probe' }` is
the probe the sensor sits under, whatever that is — Probe Health with no `probeId` names that
one, and it is a reference too, because rights can be granted on a device without any on the
probe above it.

`ObjectService` checks every reference on every write that leaves such a sensor behind — create,
an edit of its parameters, a created tree, a move and a clone — through the eyes of whoever wrote
it. **A hidden object and one that does not exist are refused in the same words**, so a
parameter is never a way to learn which ids exist. A rename is not checked; writing the parameters
is, all of them, because the writer is the one standing behind the sensor from then on. The
service never asks which type a sensor is — it asks the type — so a new type that names objects
is covered by declaring this and nothing else.

Leave out a reference its params cannot state — a formula that does not parse names nothing that
anybody could read out of it, and the sensor fails on its own for that.

**And again at every evaluation.** A grant taken away after the write would otherwise leave the
sensor publishing what its writer may no longer see, so the account that last vouched for it is
recorded on the sensor, and the sweep that evaluates it asks the same `references` and `requires`
again, through that account's eyes as they are now (`SensorVouching`). One it may no longer read
through — or whose account was deleted or disabled — is not evaluated: its channels gap and it
reads `unknown` with cause `access` (`docs/state-machine.md` §2, row 3a). **A sweep that
evaluates a core type calls `refusals` before it reads anything and `settle` after**, and
records nothing for a sensor refused; the three that exist show how. A type's `references` is
therefore asked on every sweep, which is one more reason it has to be pure and cheap.

### `requires` (optional)

A bar on writing one at all, for a type whose readings describe the whole installation rather
than anything in it. `'installation'` is read on the root — the bar `/core-health` and the
Prometheus scrape already have — and `ms.core.health` declares it. Checked where `references`
is.

### `recoveryHoldSeconds` (optional)

How long a return to Up must last before a state trigger's alarm over this sensor is over
(`M-18`). A Down inside the hold is the same outage, and resumes the alarm rather than paging
again. Absent means none, and the alarm ends at the return, which is right for almost every type:
their own two-step Down already confirms an outage. Set it only for a type whose outages come in
bursts the core samples between. `ms.probe.health` is the one that does, at 300: a probe killed
and restarted connects for seconds a round. A trigger can override it with its own
`recoveryHoldSeconds`. Whole seconds, up to a day.

### `paramProblems(params)` (optional)

What the schema cannot say (`A-42`). Return each problem as the JSON Pointer of the value at
fault and a sentence an operator can act on, or nothing. `SensorCatalogue.validate` calls it
once the schema passes, with defaults filled in, and every write goes through that call: a
create, an edit, a clone, a device template, a discovery. So a refusal here is a refusal
everywhere, and it reaches the API in the same shape as a schema's. It runs in the core, so keep
it pure.

A row written before your rule never passed it. If the rule is what makes a sensor safe to run,
enforce it in `execute` too, and refuse there in the same words, rather than quietly repairing
the parameters. `http.transaction` does both for a credential outside its `Authorization` header
and body.

### `costHint`

`light` | `medium` | `heavy`. Not a duration — a `heavy` check is heavy because of what it
*holds* (a spawned process, a large walk, an open connection), not because it is slow. A slow
`light` check is still light.

### `channels()`

Declared up front, before the sensor has ever run. This is what lets the core create the channels
at sensor-creation time, draw a named-but-empty graph before the first result, and know which
channel the sensor is judged by.

- **Exactly one `isPrimary`,** at most. It is the number shown in a list and the line in a
  summary graph. Two would make the one-primary-per-sensor index a coin toss.
- **Keys are stable within the sensor** and are what `execute` reports against. They are not
  display labels; `name` is.
- **Must be pure.** It runs in the core, which has no network access to your target and no
  business doing I/O to answer "what channels does this type have".
- **Must answer for anything your schema accepts.** A throw from `channels()` for parameters
  `paramsSchema` let through refuses that sensor's create or edit with a 400 naming your type, and
  logs a warning for you with every parameter's value cut out of the message (`P-305`). Put the
  rule in the schema instead, where the form can show it.
- **An edit re-declares what it changes** (`P-303`). When an edit to a sensor's parameters
  changes the `name`, `unit`, `lookup` or counter width `channels()` gives an existing channel,
  the channel is written to match; a channel the edit leaves alone keeps its row, including a
  lookup an operator pointed it at. An edit that would turn an existing channel from a `counter`
  into a gauge or back is refused, because the stored samples are rates on one side and raw
  values on the other: say in that parameter's description that it is fixed once the sensor
  exists, as `snmp.custom`'s `mode` does, and mark it `'x-createOnly': true` (`U-34`). The edit
  form then shows it read-only on an existing sensor, with the reason, instead of offering a
  change the core refuses. Inside an array, also name on the entry's schema the required property
  that says which entry it is — `'x-entryKey': 'column'` on `snmp.table`'s columns — so an entry
  is matched to what the sensor has by what it is, not where it sits, and one an edit adds stays
  open. The annotation is the warning; the refusal is still the core's, judged from the channels.
  Which channel is `isPrimary` moves with the edit too (`P-309`), once that channel has a row: a
  key the edit adds and makes primary becomes it on a later edit, not on its first reading. If
  `channels()` throws for what a sensor has stored, an edit cannot tell an operator's lookup from
  yours, so it leaves every lookup as it is and logs that, naming your type (`P-311`). A channel
  the edit no longer declares keeps its row and history; it is shown retired only if your type
  sets `declaresEveryChannel` (below).
- **`lookup` and `counter` may depend on parameters.** A channel the core first sees in a reading
  (a key a later build added, or one an edit added) gets them from `channels()` asked with that
  sensor's own stored parameters, not `{}` (`P-297`), so a column-per-channel type like
  `snmp.table` needs nothing more. If `channels()` throws for parameters a sensor has stored, the
  channel is created from your `{}` answer instead and may keep neither for good: the core warns
  naming your type and counts it on Core Health's `channelsCreatedUndeclared` (`P-306`). So answer
  every parameter set your schema has ever admitted.
- **`limits` on a channel declares default thresholds** (`S-18`). Almost no channel should have
  one: a threshold on a monitored device's response time depends on that device and belongs to the
  operator. Declare one only where the number means the same thing on every installation, which in
  practice means a channel about *this system* rather than about somebody's network. They are
  written when the channel is created, and each start brings existing channels up to what this
  build declares: a changed declaration replaces the old one, and a withdrawn one — the key
  declares no `limits` any more — is cleared (`P-291`). An operator who changes or clears them owns
  them from then on, and no start touches them again, because a default that came back after
  somebody removed it is worse than no default. **Only a type with `fixedChannels: true` may
  declare them** (`P-293`): see below. The catalogue refuses a declaration with no bound in it,
  one that is not a number, and one whose warning sits outside its error, at registration rather
  than at the first reading.

### `fixedChannels` (optional)

`true` says every sensor of this type has the same channels whatever its parameters, so
`channels({})` answers for all of them, declarations included. Set it on a type that declares
`limits`, and the catalogue refuses `limits` from a type that does not.

The reason is the start-up pass. It cannot ask a type with every sensor's parameters, so it asks
with `{}`, writes what that answer declares over every existing channel of the type, and clears a
declared limit on any key it does not declare. A type whose channels come from its parameters
answers `{}` with a placeholder (`ssh-script`'s `value`), so a limit it declared on a channel only
some parameters produce would be overwritten or cleared at the next start, and its alarm would
end without a word. Such a type declares none, which also tells the pass that any declared limit
on one of its channels is left over from an earlier build and can go.

A parameter that chooses *what* a sensor reports on and not *which* channels it has does not stop
a type being fixed: Probe Health's `probeId` is one. The catalogue holds the promise where it can.
At registration a fixed type must answer `{}`, and answer the same once its schema's defaults are
filled in. Each `channelsFor` after that, which is how every sensor gets its channels, throws if
the answer differs from `{}`'s. For a type without the flag, it throws on a channel with `limits`
that only real parameters produce, the one place such a channel is ever seen. Either refuses that
sensor's create or edit with a 400 naming the type, and logs a warning for you (`P-296`).

### `declaresEveryChannel` (optional)

`true` promises that every key `execute` reports is one `channels(params)` declares for the
parameters it ran with, on every path. Then a channel a sensor has and its stored parameters no
longer declare is one nothing will read again — an edit took it out, as removing a `snmp.table`
column does — and the core shows it as **retired** (`P-310`): `retired: true` on the channel, a
mark beside it on the sensor page, its row, settings and history kept. Putting the key back makes
it live again. Nothing is stored: it is worked out from your declaration on each read.

Leave it unset when your keys come from what the check ran into — a script's output
(`exe.script.advanced`, `ssh.script`), a query's columns — because a key your declaration does
not name is then one your readings may, and the core would call a channel that is still read
retired. Unset is safe: none of your channels is ever called retired, which is how every channel
looked before. The types that set it are listed in `retired-channels.test.ts`, each checked by
reading its `execute`; add yours there.

### `execute(context)`

- **Honour `context.signal`.** Not advisory: a check that ignores it has its worker terminated,
  which costs strictly more than returning. If your work is a promise, race it against the
  signal; if it is a socket, close it on abort. If it is a program, pass the signal to
  `runProgram` (`@ms/shared`) as `signal`, with a `graceMs` under the 2 s the runner gives a
  check after its abort: on Linux it ends the program's whole process group. Nothing else will
  in a pool worker — a terminated worker leaves a program in a group of its own running. A
  check process that dies outright has its groups ended by the runner afterwards (`P-266`), but
  with `SIGKILL` and no output, so the signal is still the path that says anything. The run then reads `outcome: 'timeout'` with `endedBy: 'signal'` and `endedAfterMs`,
  and `abortReason` and `endedHow` (`support/program-ended.ts`) say why and how, so the message
  can say which limit the program ran into and when (`P-262`; `exe-script-shared.ts` is the
  example). On Windows `runProgram` ends the program alone, not what it started.
- **`await import()` anything heavy.** The core loads this catalogue for schemas and channel
  declarations and never calls `execute`. A top-level `import snmp from 'net-snmp'` would drag a
  native module into a process that has no use for it.
- **Return channel values, or throw.** A thrown error is a failed check, and a failed check
  records *no channel values* — a Down sensor does not report zero (CLAUDE.md). Do not return
  `{ channels: [] }` to mean failure; throw, and say what failed.
- **Errors carry context.** "ETIMEDOUT" alone is not a diagnosis. Say what you were connecting
  to and what phase you were in.

### `preview(input)` (optional)

Almost no type has one. It exists for types whose **parameters contain a mapping language** —
paths into a document the device returns. `rest.custom` is the only one today: its `extract` array
is a list of JSONPath or XPath expressions, and writing those blind against an API you cannot see
is the part people give up on. `preview` runs those paths against a response the operator pasted
into the form and reports what each one selected (`U-13`).

- **Run the same functions `execute` runs.** This is the whole reason it is a member of the type
  rather than something the UI does: a preview that agreed with the check only most of the time is
  worse than no preview, because it certifies a path that does not work. `rest.custom`'s takes the
  same format guess, the same parser, the same path compiler, the same aggregate, the same scale
  and the same gap rule, and its tests are differential — they run both halves and compare the
  numbers.
- **No I/O.** It runs **in the core**, like `channels`, against a document that arrived in the
  request. A preview that fetched anything would be a second request path with the sensor's
  credentials in it, audited by nobody. It is `async` only so a type can still `await import()` a
  parser it would otherwise load into every probe.
- **Never throw.** The form this feeds has a half-typed path in it every few keystrokes, and a
  preview that went blank while somebody typed would be useless exactly when it is being used. A
  path that does not parse is reported on its own row; a document that does not parse sets
  `error` on the result.
- **Bound what comes back.** A wildcard over a large document selects more than anybody reads.
  `rest.custom` returns the first ten selections per row with the honest total beside them, and
  cuts each value at 200 characters.

Declaring it turns on `hasPreview` in the catalogue summary, and the UI shows the panel off that
flag — never off the type id. Nothing else is needed to wire it up.

---

## Secrets

A parameter that holds a credential is marked `writeOnly: true`:

```ts
properties: {
  community: { type: 'string', minLength: 1, writeOnly: true },
}
```

That single annotation is load-bearing. `ObjectService` strips those parameters from **every**
detail it hands out — API responses, audit rows, anything — while the stored value stays where
the probe can use it. The read instead carries `redactedParams: ['community']`, so a form can
show "set" without ever receiving the value.

Four rules follow from how the redactor works:

- **Hoist it to a plain property.** A `writeOnly` inside `oneOf`/`anyOf`/`allOf`/`items` cannot
  be redacted without evaluating which branch matched, and a redactor that guesses wrong either
  leaks the value or deletes a live one. The catalogue **refuses to register** such a type, at
  startup, rather than leaking at read time.
- **Nested objects are fine.** `auth.privKey` is found and removed correctly.
- **An update that does not mention it keeps it.** Because a read never returns the value,
  nothing outside the core can send one back — and `params` is *replaced* on update, not merged.
  So `carryWriteOnly` takes any `writeOnly` parameter a patch omits from what is stored (`U-08`).
  Sending the key with a value rotates it; sending it as `null` removes it, and the schema then
  decides whether this type may be without it. You get this for free; it is worth knowing because
  it means a client cannot delete a credential by accident, and cannot clear one by sending `""`.
- **Say where it is sent** (`A-40`). Every `writeOnly` parameter needs an entry in
  `secretDestinations`, naming the other parameters that choose where the secret goes — and the
  catalogue **refuses to register** a type that leaves one out. An update that changes any of
  them and does not send the secret again clears it, and the audit entry lists it under
  `secretsCleared`. Otherwise anyone with `write` on the sensor could keep a secret they were
  never shown and point it somewhere they can read. `[]` says no parameter chooses it: it goes
  to the device the sensor is on, which is what a sensor's own device credential should say.
  A destination must be a plain property that is not itself `writeOnly`.

  ```ts
  // exe.script: the program, told what its arguments, environment and directory say, decides
  // where MS_SECRET ends up — so changing any of them clears it unless it is entered again.
  secretDestinations: { secret: ['program', 'args', 'env', 'workingDirectory'] },
  ```

  Err towards naming a parameter. The cost of naming one too many is a secret re-entered; the
  cost of one too few is a secret sent somewhere its owner never chose.
- **Say where an inherited set is sent, too** (`A-41`). Every kind in `credentialKinds` needs a
  `kind:<id>` entry naming the parameters that choose where the core's set of that kind goes,
  beside the device's host and the probe, which are always part of it. The catalogue refuses a
  type that uses a kind and leaves it out, and one that names a kind it does not use. The core
  fingerprints the result: a write that changes it needs `write` on the object the set is stored
  on, and a probe is sent the set only while somebody who had that vouched for where it goes.
  `[]` says the host alone chooses it.

  ```ts
  // ssh.*: the host, and the port the sensor connects to on it.
  secretDestinations: { 'kind:ssh': ['port'] },
  // mail.roundtrip: two servers' ports, how each is secured, and which protocol reads it back.
  secretDestinations: {
    'kind:mail': ['readPort', 'readSecurity', 'readWith', 'smtpPort', 'smtpSecurity', 'verifyTls'],
  },
  ```

  Changing what a shipped type names changes every fingerprint of that type without anything
  having moved. The core notices at start-up and fingerprints what it had recorded again, keeping
  whoever vouched, so an upgrade does not withhold them.
- **Connect to `ctx.target.pinned` when there is one, and say that you do** (`A-41c`). A
  credential set can be bounded to addresses and ranges, and a device can be named by host name.
  The catalogue then resolves the name once, before `execute`, checks every address against the
  set's targets, and hands the check the one to use as `ctx.target.pinned`. A type that connected
  to `ctx.target.host` regardless would resolve the name a second time, and whoever runs its DNS
  could answer that lookup with another machine. So:

  - Pass the whole `ctx.target` to the shared transport, never its `host` alone: `snmpCheck`,
    `sshCheck`, `readCommon` (HTTP) and `readTransport` (mail) take it and pin for you.
  - A transport of your own connects to `pinned.address`, or gives its socket
    `lookup: pinnedLookup(host, pinned)` so that TLS still names the server by `host`.
  - List the kind in `pinnedKinds` only once every connection the type makes with that kind
    does this. A kind left out is simply not sent to a named device with address-only targets,
    which is the safe answer for a driver that resolves the name itself.

  ```ts
  credentialKinds: ['ssh'],
  pinnedKinds: ['ssh'],
  ```
- **Connect only to an address the target policy checked** (`A-57`). A probe refuses to connect
  to link-local and cloud instance-metadata addresses (`probe.targetPolicy`), and the check and
  the connection have to use one lookup, or whoever runs the device's DNS answers them
  differently. The shared transports do this for you. A type with a connection of its own calls
  `checkedTarget` (`support/checked-target.ts`) before it connects:

  ```ts
  const checked = await checkedTarget({
    ...guardOf(context.target), // the host, with the pin, the policy, its exception, the resolver
    timeoutMs,
    signal: context.signal,
    verb: 'connect to',
    doing: `connecting to ${host}:${String(port)}`,
  });
  const socket = connect({ host, port, ...lookupFor(host, checked) });
  ```

  `lookupFor` answers the socket's lookup with the checked addresses, so the name is never
  resolved again and TLS still names the server. A transport that takes an address and no
  lookup connects to one of `checked.addresses`. **A driver that resolves the name itself
  usually still takes the connection** (`A-62`): read its source for an option that accepts a
  socket and hand it one made with that lookup, as `support/db/socket.ts` does for `pg`
  (`stream`), `mysql2` (`stream`) and `tedious` (`connector`), leaving the driver the name so
  that TLS names it. Only a transport that can do none of these, as PowerShell cannot, calls
  `refuseBlockedAddress` for a device given as an address, handing it
  `context.target.policyException`, and is listed in `administration.md` as checked by address
  only. A refusal is an ordinary failed check; do not catch it. **Spread `guardOf`, never pick
  the policy out of the target by hand** (`A-64`): it also carries the device's exception to the
  policy, and a transport that passed the policy alone would refuse an address an administrator
  excepted. A transport that keeps a connection open between checks, as the SSH pool does, keys
  it by the exception too, so one opened under an exception is not reused once it is withdrawn.

The form (`U-08`) follows from the same annotation: a `writeOnly` parameter renders as
"set, write-only" with Replace and Clear, never as a filled input, and is omitted from the save
unless somebody deliberately changed it.

**The same annotation keeps a secret out of your messages** (`S-19`). A probe runs every check
through `SensorCatalogue.execute`, which replaces each value of a `writeOnly` parameter, and
of each secret field of the credentials the check was handed, with `••••••` in the message you
return and in the message of anything you throw — so quoting a driver's error or a script's
output verbatim is safe. Each value is also matched in the forms a server echoes a request back
in (`A-42`): percent-encoded, form-encoded, base64 (padded, unpadded and URL-safe), HTML-escaped
and JSON-escaped. An `http` credential adds basic authentication's `username:password` pair in
base64.

It does not catch a secret that was split, truncated, hashed, re-cased, encoded twice or in hex,
or base64-encoded inside a longer string. Values under four characters are left alone. If your
type builds one of those, scrub it yourself before it reaches a message.

**Scrub what a server sends back before your type reads it**, not only what it reports. A
capture carried into a later request, or a content check whose pass or fail the sensor's state
reveals, can carry an echoed secret as surely as a message can. `http.transaction` passes every
response through `scrubberOf(context)` as it arrives.

**Scrub before you clip** (`S-21`). The catalogue's scrub looks for whole values, so a secret your
type cuts in two is two strings it no longer finds, and the half before the cut stays in the
message. A type that cuts somebody else's words to fit a message, such as the last lines of
stderr or the first 200 characters of a document, cuts `scrubberOf(context)(text)`, never `text`.
`context.scrub` is the catalogue's scrub; `scrubberOf` reads it and does nothing when a test
calls your type directly.

**A value an operator typed never goes into a script** (`S-21`). Quoting it is a bet on every
character the interpreter treats as a quote, and PowerShell ends a single-quoted string at four
more than U+0027. A Windows type filters with `queryCim(…, { field, equals })`, which carries the
value in `MS_WIN_MATCH`, where the script reads it as a variable.

---

## What the catalogue checks when you register

All of these fail at startup, loudly, rather than at runtime:

| Check                                          | Why                                                             |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `id` is lowercase and dotted                   | it goes in a database column and a URL                          |
| `id` is not already registered                 | shadowing makes behaviour depend on registration order          |
| `paramsSchema` compiles                        | a broken schema would fail on the first sensor, not the first boot |
| no `writeOnly` inside a combinator             | it could not be reliably redacted                               |
| `x-createOnly` only on a leaf property (no object or array type, no `properties` or `items`), never behind a combinator or under `$defs`, `definitions`, `additionalProperties`, `patternProperties`, `prefixItems` or a tuple's `items`, never on a `writeOnly` one, and inside an array only where the entry's `x-entryKey` names a required property of it | the form locks one control: it has no control to lock elsewhere, could not tell when it applies, has no value to show, or could not tell a stored entry from an added one (`U-34`) |
| every `writeOnly` has a `secretDestinations` entry, naming visible properties | a secret stays with where it is sent (`A-40`) |
| every kind in `credentialKinds` has a `kind:<id>` entry, and no other kind does | an inherited set goes only where somebody vouched (`A-41`) |
| every kind in `pinnedKinds` is one of `credentialKinds` | a promise about a set the type is never sent is a typo (`A-41c`) |
| at most one `isPrimary` channel                | the one-primary-per-sensor index                                |
| `limits` only on a `fixedChannels` type, which answers `{}` and the same with its defaults | a start keeps declared limits in step from `{}`, which speaks for every sensor only then (`P-293`) |
| no repeated channel key                        | `(sensor_id, key)` is unique                                    |
| the schema validates its own declared defaults | a `default` a `pattern` rejects is a field nobody can fill in   |
| `evaluatedBy: 'core'` declares `references` or `requires` | its readings are the core's own data, republished (`A-29`) |
| `recoveryHoldSeconds` is whole seconds, 0 to 86,400 | a typo would be an alarm that never ends, or ends at the return it was meant to hold (`M-18`) |

---

## Testing it

Tests go against the protocol simulator harness, never a live network target — a test that needs
the internet is a test that fails in CI on a bad day and teaches everyone to ignore it.

The harness is **`@ms/simulators`** (`P-06`), a `devDependency` of every package that has tests.
It binds real sockets and speaks real protocols, so what you assert is what would happen on a
network — there is no interception layer that a redirect or a framing bug could slip past:

| Import | What it gives you |
| ------ | ----------------- |
| `HttpSimulator` | Routes with scripted status, headers, body — and **latency**: `delayMs` (no answer yet), `bodyDelayMs` (head now, body later), `dripMs` (a slow trickle), `hang`, `reset`. A route may be a *sequence*, which is how "fails twice then succeeds" is written. Records every request. |
| `TestSnmpAgent` | A v1/v2c agent that misbehaves on request: never answers, loses the first datagram, walks *backwards*, returns a subtree with no end. |
| `TestSshServer` | A real SSH server that refuses a password, presents an unexpected host key, or hangs on a command. |
| `MuteSshServer` | An SSH port that accepts a connection and never speaks, so the handshake waits out its connect timeout. `next()` hands over the connection accepted next and a promise of its closing. |
| `smtpServer` / `pop3Server` / `imapServer` | One shared mailbox, so a round trip is a real round trip. Each can refuse at the step that matters. |
| `sendUdp` / `sendTcp` | A syslog sender: RFC 3164 and 5424, both of RFC 6587's TCP framings, and `splitAt` to break a frame across two packets. |
| `installFakePowerShell` | A PowerShell that is not PowerShell, for the Windows transport. |
| `listen` / `close` | Bind on an ephemeral port and shut down cleanly. Never pick a port number. |

**Reach for the misbehaviour switches.** They are the reason the harness exists: what is worth
asserting about a check is what it does when a server accepts a connection and then refuses, or
answers the headers and thinks for four seconds — and none of that is reachable against something
behaving normally.

Cover at least:

- the happy path, asserting channel **keys and values**;
- a failure, asserting it throws and reports which phase it failed in;
- **abort**: start a check, abort the signal, assert it returns promptly;
- schema rejection of the obvious bad parameter.

If the type runs code somebody else wrote, set `isolation: 'process'` (`P-03`) — the mechanism
exists now and `costHint` is not a substitute for it.

**Mutate your own tests before you believe them.** Every ticket in this repository has done it and
it has repeatedly found tests that pass against broken code — change the sign of a comparison,
delete a guard, make a gap a zero, and check that something fails. A test that survives is a test
that was not asserting what its name claims. Two real examples: a syslog severity floor test where
"keep the severe ones" and "keep the mild ones" both counted two out of three, and a `parseMeminfo`
test asserting a value of 0, where multiplying by 1024 is still 0.

**Then run it against something real.** The simulator proves the parsing; a live target proves the
things a simulator cannot — a hostname that does not resolve where an address would, a credential
rotation that produces an empty delta, a resolver that retries four times behind your back. Live
verification has found a defect in most of the tickets in this repository, and none of them were
reachable from a unit test.

---

## Credentials that belong to the device

A password, community string or key for the **monitored device** does not go in `paramsSchema`.
It goes in a credential set on the device or the group above it, and every sensor underneath
inherits it — set once for a rack, rotated in one place (`A-05`, `CAPABILITIES.MD §10`).

Declare which kinds your type needs, and they arrive decrypted in `ctx.credentials`:

```ts
export const snmpUptime: SensorType = {
  id: 'snmp.uptime',
  credentialKinds: ['snmp'],
  // ...
  async execute(context: CheckContext): Promise<CheckExecution> {
    const snmp = context.credentials['snmp'];
    if (snmp === undefined) {
      // Say which kind is missing. The alternative is an authentication failure twenty seconds
      // later that reads like the device is broken.
      throw new Error('no SNMP credentials are set on this device or any group above it');
    }
    // ...
  },
};
```

- **Declared, not inferred.** The core decrypts exactly these kinds for exactly these sensors and
  sends them to the probe that owns them. A type that did not say would have to be sent
  everything, so every probe would hold every credential in the installation to run a Ping.
- **A missing kind is absent, not an error.** Whether the check can run without it is your
  judgement — you are the one placed to name what is missing.
- **`writeOnly` in `paramsSchema` still exists** and is still right for a secret that belongs to
  *this sensor* rather than to the device. If two sensors on the same device would hold the same
  value, it is a credential set.

## Shared transports

Some protocols are too big to re-derive per type, so they live once under
`packages/sensors/src/support/` and a type imports what it needs from inside `execute`.

What exists, and which ticket built it:

| Directory | For | Built by |
| --- | --- | --- |
| `support/snmp/` | v1/v2c/v3 sessions, pooled per device; traps | `T-01`, `T-06` |
| `support/ssh/` | connections pooled per device, host-key verification | `T-07` |
| `support/http/` | one request with the redirect rules, two timings, a body bound | `P-09`, `T-13` |
| `support/tls/` | handshakes, chain and name checks, version probing | `T-11` |
| `support/mail/` | one line-oriented connection; SMTP, POP3 and IMAP over it | `T-17` |
| `support/db/` | one driver interface; PostgreSQL, MySQL and SQL Server behind it | `T-18` |
| `support/syslog/` | RFC 3164/5424 parsing and the UDP/TCP receivers | `T-20` |
| `support/script/` | resolving a program name inside the probe's script directory | `T-19` |
| `support/pattern.ts` | an operator-supplied regex, run under a watchdog | `T-03` |
| `support/json-path.ts` | a bounded JSONPath **and** XPath over a response tree | `T-16`, `T-24` |
| `support/xml.ts` | XML into a plain object tree the path module reads | `T-24` |
| `support/windows/` | one PowerShell shell-out; the wrapper, the envelope, the credential | `T-09` |

Three of those are worth knowing about even if you never call them. `support/pattern.ts` exists
because **JavaScript has no interruptible regular expression**: once `exec` is running nothing
stops it, not `ctx.signal` and not a timer, and `(a+)+$` against forty characters takes 86 seconds
— measured. It runs matches inside a `node:vm` with a timeout, which *can* interrupt one, at a
cost of about 100 µs a match. If your type takes a pattern from an operator, use it rather than
`new RegExp`. And `support/json-path.ts` stops short of JSONPath's filter expressions on purpose:
the reference implementation evaluates JavaScript in them, which would put an operator-supplied
expression inside a probe.

The third is `support/xml.ts`, and the thing to know is that it is **one path language, not
two**. A path beginning with `/` is read as an XPath location path and translated to the same
steps `selectPath` walks, so a type that already takes a JSON path takes an XML one for free —
`parseXml` produces a plain object tree and everything downstream is unchanged. Two properties of
that tree are load-bearing. Every *element* is an array, so a document with one `<result>` and a
document with five have the same shape — otherwise a path works for months and breaks the first
morning the list is short. An *attribute* is not, because an attribute is single-valued; it lives
under an `@_` prefix rather than beside the children, so `<r name="x"><name>y</name></r>` keeps
both reachable. `parseXml` validates before it parses — the
library is lenient and would build a tree from a truncated response, which is exactly the case a
check meets when a bound or a dropped connection cuts one off.

**SNMP** (`support/snmp/`, built by `T-01`) is the worked example:

```ts
async execute(context: CheckContext): Promise<CheckExecution> {
  const { readCredentials, withSnmp, numberOf } = await import('../support/snmp/index.js');
  const credentials = readCredentials(context.params);

  return withSnmp(
    { host: context.target.host, port: Number(context.params['port'] ?? 161) },
    credentials,
    { timeoutMs: Number(context.params['timeoutMs'] ?? 5000) },
    async (session) => {
      const [varbind] = await session.get([String(context.params['oid'])], context.signal);
      const value = varbind === undefined ? null : numberOf(varbind);
      if (value === null) throw new Error(`${context.target.host} has no value at that OID`);
      return { channels: [{ key: 'value', value }] };
    },
  );
}
```

Four things it gives you that are easy to get wrong alone:

- **`snmpParamsSchema(own, required)`** composes your parameters with the credential and
  transport ones. Use it rather than copying the fields — every secret in it has to stay a plain
  property, because the catalogue refuses a `writeOnly` inside a combinator, and the natural
  shape for SNMP credentials *is* a union.
- **`withSnmp` pools the session per device** and always releases it. Forty sensors on one router
  share one UDP socket instead of opening forty.
- **Abort cancels the request, not the session** — which is why you must not call `close()` on a
  session you borrowed.
- **`Counter64` is a `bigint` and an `OctetString` is a `Buffer`.** `numberOf` and `stringOf`
  convert when you want them to; neither returns `0` for a missing value, because a Down sensor
  records no value at all.

## A worked example, start to finish

`T-23` asks this guide to prove the claim it opens with — that a new type is one file and half a
day. So here is one, added while writing this section: **`dns.blocklist`**, which asks a set of
DNS blocklists whether a device's address is on any of them. A mail relay that lands on Spamhaus
stops delivering to half the internet and does it silently, while every other sensor on the host
stays green.

The whole of it is `packages/sensors/src/types/dns-blocklist.ts` plus two lines of registration
and one test file. Nothing else changed: no migration, no API route, no frontend work. Read the
file itself for the real thing — what follows is what it exercises of this guide.

**The parameters are the interview.** `zones` is required and bounded at twelve, so one sensor is
one small burst rather than a scan. `address` defaults to empty and falls back to the device's own
host, because the address that *sends mail* is usually not the address the device is *reached on*
behind NAT — and the description says exactly that instead of leaving somebody to find out.
`resolver` is there because most blocklists refuse queries from public resolvers, so a sensor
answering "not listed" through 8.8.8.8 may be answering about the resolver's quota.

**The channel is a count, not a verdict.** `listings` is the primary, and "alarm if we are on any
list" is an upper error limit of zero — which an operator can see and change. A sensor that went
Down on its own when listed would be a threshold baked into a file, invisible and uneditable.

**The failure and the reading are different things.** Being listed is a reading. A *lookup* that
fails is a failure — and if every lookup fails the check fails, because reporting zero listings
would be reporting "we are on no lists" on the strength of no evidence at all. That is the
CLAUDE.md rule about no-data not being zero, in the shape this particular type takes.

**The reversal has its own exported function and its own test**, because `192.0.2.42` becoming
`42.2.0.192` is the one piece here that is easy to get backwards, and getting it backwards
produces a sensor that cheerfully answers "not listed" for ever.

**Writing it found two bugs, and neither was where you would look.**

The first was the timeout: a test asking for 700 ms waited nine seconds. Node's `Resolver`
**retries four times by default and `timeout` is per try**, so a check configured for five
seconds takes twenty. A monitoring check has its own deadline and its own scan interval; retrying
inside one turns a configured timeout into a number that means nothing. `tries: 1` is now in the
file with that paragraph above it, and the test that found it now asserts the elapsed time so the
retry cannot come back. If you are writing a type over any Node protocol client, go and look for
its retry default before you trust its timeout.

The second was found by the *live* run and not by any test, which is the whole argument for doing
one. Pointed at two zones — one real, one fictional — the sensor reported "on none of 2
blocklists". `NXDOMAIN` is the protocol's way of saying "not listed" **and also what a zone that
does not exist answers**, so a typo in a list name is a sensor that reports clean for ever. It now
confirms an unlisted answer by asking whether the zone itself exists, one extra lookup per clean
zone. Note the shape of that mistake: it is the same shape as the reversal bug the exported
function guards against — *a sensor that always answers the reassuring thing* — and the type's own
docstring warned about the reversal while walking straight into the other one.

**The tests are against a simulator, and the simulator is forty lines.** `node:dgram` answering
DNS by hand: a header, the question echoed back, `NXDOMAIN` or a synthetic `A` record. The
alternative is querying a real blocklist, which CLAUDE.md forbids and which would also mean a
test that fails whenever Spamhaus rate-limits the build machine. Ten tests, covering the happy
path, a listing, a partial failure, a total failure, the wrong kind of address, an overridden
address, and abort.

**Cost, honestly.** The type is about 190 lines including the comments that explain *why*; the
test file is about 200 including its simulator. Both were written in one sitting. The bounded
part of the claim holds: nothing outside those two files and the two-line registration had to
change, and the guide's list of what to cover is what made it quick, because none of the
decisions had to be invented.

---

## Related

- `docs/ADR-001-architecture.md` — Decision 7, and why this is a plugin contract
- `docs/CAPABILITIES.MD` — which types are `[V1]`, `[V2]` and `[OUT]`
- `docs/TASKS.md` — `P-08`…`P-11` are the first four types; `P-06` is the harness
- `packages/sensors/src/types/dns-blocklist.ts` — the worked example above, in full
