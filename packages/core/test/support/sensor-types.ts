import { coreHealth, probeHealth, SensorCatalogue, type SensorType } from '@ms/sensors';
import {
  catalogueSensorTypeGate,
  type SensorTypeGate,
} from '../../src/objects/sensor-type-gate.js';

/**
 * The two types the core's tests configure sensors with.
 *
 * Deliberately declare no schema defaults: several tests assert stored params exactly, and a
 * default silently appearing in the row would make them about Ajv rather than about the thing
 * under test. Defaults are covered where they belong, in `@ms/sensors`.
 */
const ping: SensorType = {
  id: 'icmp.ping',
  category: 'Availability',
  costHint: 'light',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 100 },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000 },
    },
  },
  channels: () => [
    { key: 'rtt', name: 'Response time', unit: 'ms', isPrimary: true },
    { key: 'loss', name: 'Packet loss', unit: '%' },
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

/**
 * Carries a credential two ways, which is the whole point of it being here.
 *
 * `community` as a `writeOnly` *parameter* is how a credentialed sensor looked before `A-05`,
 * and the redaction tests still need it. `credentialKinds` is how it looks after: the secret
 * lives on the device, inherited, and the core hands it to the check.
 */
const snmpTraffic: SensorType = {
  id: 'snmp.traffic',
  category: 'SNMP',
  costHint: 'medium',
  credentialKinds: ['snmp'],
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      community: { type: 'string', minLength: 1, writeOnly: true },
      port: { type: 'integer', minimum: 1, maximum: 65_535 },
      timeout: { type: 'integer', minimum: 100 },
    },
  },
  channels: () => [
    // Counters, as the real type declares them (`T-02`): the device reports octets since it was
    // last reset and the core stores the rate.
    { key: 'in', name: 'Traffic in', unit: 'octets/s', isPrimary: true, counter: { bits: 64 } },
    { key: 'out', name: 'Traffic out', unit: 'octets/s', counter: { bits: 64 } },
    // A declared lookup (M-06). A status code is not a measurement, and this is the shape a
    // real SNMP type has: two counters and one enumeration.
    { key: 'status', name: 'Interface status', lookup: 'ms.snmp.if-oper-status' },
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

/**
 * The one type the *core* evaluates rather than a probe (`T-21`).
 *
 * Here rather than imported from `@ms/sensors` for the reason the other two are: these tests
 * assert stored params exactly, and the real type's schema defaults would make them about Ajv.
 * What matters to the core is `evaluatedBy`, which is what keeps a factory out of every probe's
 * assignment list.
 */
const factory: SensorType = {
  id: 'core.factory',
  category: 'Custom',
  costHint: 'light',
  evaluatedBy: 'core',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      channels: { type: 'array' },
      maxAgeSeconds: { type: 'integer', minimum: 30, maximum: 86_400 },
    },
  },
  channels: () => [{ key: 'value', name: 'Value', unit: '', isPrimary: true }],
  execute: () => Promise.reject(new Error('a Sensor Factory is evaluated by the core')),
};

export function testCatalogue(): SensorCatalogue {
  const catalogue = new SensorCatalogue();
  catalogue.register(ping);
  catalogue.register(snmpTraffic);
  catalogue.register(factory);
  // The real one, unlike the three above: `ms.core.health` declares no parameters at all, so
  // there are no schema defaults to make a stored-params assertion about Ajv (`P-12`).
  catalogue.register(coreHealth);
  catalogue.register(probeHealth);
  return catalogue.seal();
}

export function testSensorTypes(): SensorTypeGate {
  return catalogueSensorTypeGate(testCatalogue());
}
