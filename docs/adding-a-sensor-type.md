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

### `evaluatedBy` (optional)

`'core'` means the **core** computes this sensor's readings and no probe ever receives it
(`T-21`). There is exactly one such type — `core.factory`, whose inputs are channel values the
core already holds — and there should stay that way. Reach for it only when a type's inputs are
things the core has and a probe does not; anything that talks to a device belongs on a probe.

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

### `execute(context)`

- **Honour `context.signal`.** Not advisory: a check that ignores it has its worker terminated,
  which costs strictly more than returning. If your work is a promise, race it against the
  signal; if it is a socket, close it on abort.
- **`await import()` anything heavy.** The core loads this catalogue for schemas and channel
  declarations and never calls `execute`. A top-level `import snmp from 'net-snmp'` would drag a
  native module into a process that has no use for it.
- **Return channel values, or throw.** A thrown error is a failed check, and a failed check
  records *no channel values* — a Down sensor does not report zero (CLAUDE.md). Do not return
  `{ channels: [] }` to mean failure; throw, and say what failed.
- **Errors carry context.** "ETIMEDOUT" alone is not a diagnosis. Say what you were connecting
  to and what phase you were in.

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

Three rules follow from how the redactor works:

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

The form (`U-08`) follows from the same annotation: a `writeOnly` parameter renders as
"set, write-only" with Replace and Clear, never as a filled input, and is omitted from the save
unless somebody deliberately changed it.

---

## What the catalogue checks when you register

All of these fail at startup, loudly, rather than at runtime:

| Check                                          | Why                                                             |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `id` is lowercase and dotted                   | it goes in a database column and a URL                          |
| `id` is not already registered                 | shadowing makes behaviour depend on registration order          |
| `paramsSchema` compiles                        | a broken schema would fail on the first sensor, not the first boot |
| no `writeOnly` inside a combinator             | it could not be reliably redacted                               |
| at most one `isPrimary` channel                | the one-primary-per-sensor index                                |
| no repeated channel key                        | `(sensor_id, key)` is unique                                    |
| the schema validates its own declared defaults | a `default` a `pattern` rejects is a field nobody can fill in   |

---

## Testing it

Tests go against the protocol simulator harness (`P-06`), never a live network target — a test
that needs the internet is a test that fails in CI on a bad day and teaches everyone to ignore it.

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
