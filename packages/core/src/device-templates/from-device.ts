import type { DeviceTemplate, SensorSpec, TemplateMatch } from './definition.js';

/** One sensor as the object tree holds it, which is all this needs to know about it. */
export interface DeviceSensorRow {
  readonly name: string;
  readonly sensorType: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** True when this sensor is its device's master object, so the template keeps that (`D-05`). */
  readonly isMaster?: boolean;
}

export interface FromDeviceOptions {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly sensors: readonly DeviceSensorRow[];
  /** What the new template should match. Empty matches everything — see below. */
  readonly match?: TemplateMatch;
  /** Kinds this sensor type needs a credential for, so the spec can say so. */
  readonly credentialKindsFor: (sensorType: string) => readonly string[];
}

/**
 * A template made from a device somebody already set up (`D-03`).
 *
 * **The feature exists because writing a template by hand is the hard way round.** An operator
 * who has spent an afternoon getting a switch monitored properly has already made every decision
 * a template encodes; asking them to write it out again in JSON is asking them to make a
 * transcription error.
 *
 * **The match rule is not inferred, and that is deliberate.** It would be easy to guess one from
 * the device's own fingerprint — same vendor, same OID prefix — and it would be wrong about half
 * the time: the operator knows whether this template is for *this model*, *this vendor* or *every
 * switch*, and nothing in the device says which. So the default matches nothing until somebody
 * says what it is for, and the API asks. A template that matched everything by accident would
 * put a Cisco sensor set on every printer in the estate.
 */
export function templateFromDevice(options: FromDeviceOptions): DeviceTemplate {
  const sensors: SensorSpec[] = [];
  const seen = new Set<string>();

  for (const row of options.sensors) {
    const params = stripEmpty(row.params);
    const key = `${row.sensorType}:${JSON.stringify(params)}`;
    // Two identical sensors on one device is somebody's mistake, and copying it into a template
    // would repeat it on every device the template ever matches.
    if (seen.has(key)) continue;
    seen.add(key);

    const credentials = options.credentialKindsFor(row.sensorType);
    sensors.push({
      type: row.sensorType,
      name: row.name,
      ...(Object.keys(params).length === 0 ? {} : { params }),
      // The *first* kind, because a spec carries one and every type in this system declares at
      // most one that it genuinely cannot work without. A type declaring two would need the
      // spec to grow a list, and there is no such type to test it against.
      ...(credentials[0] === undefined ? {} : { credential: credentials[0] }),
      // Carried across, because it is one of the decisions the operator already made on this
      // device and the whole point of saving one is not having to make them again.
      ...(row.isMaster === true ? { master: true } : {}),
    });
  }

  return {
    id: options.id,
    name: options.name,
    description:
      options.description ??
      `Saved from a device with ${String(sensors.length)} sensors. Edit the match rule to say ` +
        'which devices it should apply to.',
    // Matches nothing until an operator says what it is for: `kind: []` is an empty list of
    // allowed kinds, so no fingerprint satisfies it. Better than matching everything.
    match: options.match ?? { kind: [] },
    sensors,
    tags: ['auto-discovered'],
  };
}

/**
 * Drops parameters that are absent or empty.
 *
 * A saved sensor carries every parameter its schema has a default for, so a template built from
 * one would pin all of them — and a later release changing a default would then not reach any
 * device created from that template. What is worth keeping is what somebody actually set.
 *
 * **Redaction happens before this, and the note that used to sit here was wrong** (`P-56`). It
 * said a monitored device's credentials live in the vault and never appear in `params`. They do
 * appear: `exe.script`'s `secret` and every SNMP type's `community`/`authKey`/`privKey` are
 * `writeOnly` entries in their own `paramsSchema`, stored in `sensor_config.params` and read back
 * from there at check time. `sensorsOfDevice` now strips them through the catalogue, so what
 * arrives here already carries no secret — which is a property of that caller, not of the object
 * model, and the difference is what made the old note dangerous.
 */
function stripEmpty(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
