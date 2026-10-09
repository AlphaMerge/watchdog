import type { CheckContext, CheckExecution, SensorType } from '../../src/contract.js';

/** The shape the guide documents: one file, six members, secrets marked `writeOnly`. */
export const pingType: SensorType = {
  id: 'icmp.ping',
  category: 'Availability',
  costHint: 'light',
  declaresEveryChannel: true,
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 20, default: 4 },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000, default: 2_000 },
    },
  },
  channels() {
    return [
      { key: 'rtt', name: 'Response time', unit: 'ms', isPrimary: true },
      { key: 'loss', name: 'Packet loss', unit: '%' },
    ];
  },
  execute(_context: CheckContext): Promise<CheckExecution> {
    return Promise.resolve({ channels: [{ key: 'rtt', value: 1 }] });
  },
};

/** Carries a credential in its parameters — the case `writeOnly` exists for. */
export const snmpType: SensorType = {
  id: 'snmp.traffic',
  category: 'SNMP',
  costHint: 'medium',
  declaresEveryChannel: true,
  // Both go to the device the sensor is on, and nowhere a parameter chooses (`A-40`).
  secretDestinations: { community: [], 'auth.privKey': [] },
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['community'],
    properties: {
      community: { type: 'string', minLength: 1, writeOnly: true },
      port: { type: 'integer', minimum: 1, maximum: 65_535, default: 161 },
      timeout: { type: 'integer', minimum: 100, default: 5_000 },
      auth: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user: { type: 'string' },
          privKey: { type: 'string', writeOnly: true },
        },
      },
    },
  },
  channels() {
    return [
      { key: 'in', name: 'Traffic in', unit: 'kbit/s', isPrimary: true },
      { key: 'out', name: 'Traffic out', unit: 'kbit/s' },
    ];
  },
  execute(_context: CheckContext): Promise<CheckExecution> {
    return Promise.resolve({ channels: [] });
  },
};

export function exampleTypes(): readonly SensorType[] {
  return [pingType, snmpType];
}
