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
second-guess an absent optional.

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

Two rules follow from how the redactor works:

- **Hoist it to a plain property.** A `writeOnly` inside `oneOf`/`anyOf`/`allOf`/`items` cannot
  be redacted without evaluating which branch matched, and a redactor that guesses wrong either
  leaks the value or deletes a live one. The catalogue **refuses to register** such a type, at
  startup, rather than leaking at read time.
- **Nested objects are fine.** `auth.privKey` is found and removed correctly.

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

## Related

- `docs/ADR-001-architecture.md` — Decision 7, and why this is a plugin contract
- `docs/CAPABILITIES.MD` — which types are `[V1]`, `[V2]` and `[OUT]`
- `docs/TASKS.md` — `P-08`…`P-11` are the first four types; `P-06` is the harness
