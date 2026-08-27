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

## The six members

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

---

## Testing it

Tests go against the protocol simulator harness (`P-06`), never a live network target — a test
that needs the internet is a test that fails in CI on a bad day and teaches everyone to ignore it.

Cover at least:

- the happy path, asserting channel **keys and values**;
- a failure, asserting it throws and reports which phase it failed in;
- **abort**: start a check, abort the signal, assert it returns promptly;
- schema rejection of the obvious bad parameter.

If the type shells out, it belongs in a child process, not a worker (`P-03`) — set
`costHint: 'heavy'` and say so in review.

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

## Related

- `docs/ADR-001-architecture.md` — Decision 7, and why this is a plugin contract
- `docs/CAPABILITIES.MD` — which types are `[V1]`, `[V2]` and `[OUT]`
- `docs/TASKS.md` — `P-08`…`P-11` are the first four types; `P-06` is the harness
