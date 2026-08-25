import { SensorCatalogue, type SensorType } from '@ms/sensors';
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

/** Carries a credential in `community`, which is the whole point of it being here. */
const snmpTraffic: SensorType = {
  id: 'snmp.traffic',
  category: 'SNMP',
  costHint: 'medium',
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
    { key: 'in', name: 'Traffic in', unit: 'kbit/s', isPrimary: true },
    { key: 'out', name: 'Traffic out', unit: 'kbit/s' },
    // A declared lookup (M-06). A status code is not a measurement, and this is the shape a
    // real SNMP type has: two counters and one enumeration.
    { key: 'status', name: 'Interface status', lookup: 'ms.snmp.if-oper-status' },
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

export function testCatalogue(): SensorCatalogue {
  const catalogue = new SensorCatalogue();
  catalogue.register(ping);
  catalogue.register(snmpTraffic);
  return catalogue.seal();
}

export function testSensorTypes(): SensorTypeGate {
  return catalogueSensorTypeGate(testCatalogue());
}
