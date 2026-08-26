import type { MessageContext } from '../../src/notifications/placeholders.js';

/** A `MessageContext` with every field filled, for the transports that format one. */
export function messageContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    sensorId: 42,
    sensorName: 'Ping',
    deviceName: 'edge-router',
    groupName: 'Edge',
    probeName: 'Local probe',
    host: '192.0.2.7',
    location: '',
    comments: '',
    tags: [],
    priority: 3,
    state: 'down',
    previousState: 'up',
    message: 'no ICMP reply',
    lastValue: null,
    at: new Date('2026-08-26T15:00:00Z'),
    since: new Date('2026-08-26T14:58:00Z'),
    publicUrl: '',
    siteName: 'MonitoringSystem',
    ...overrides,
  };
}
