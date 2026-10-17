import {
  BUILT_IN_SENSOR_TYPES,
  checkedTarget,
  nameLookups,
  SensorCatalogue,
  type SensorType,
} from '@ms/sensors';
import { poolResolver, withResolverNotes } from '../../src/runner/resolve-client.js';
import type {
  CheckContext,
  CheckExecution,
  CheckRegistry,
  LookupCounters,
} from '../../src/runner/types.js';
import { fakeResolve } from './fake-names.js';

/**
 * A registry whose one check resolves its device's name the way SNMP does, through the real
 * catalogue and the real guard (`A-66`).
 *
 * **The resolution is the shipped one**: a `SensorCatalogue` hands the check its resolver and
 * the probe's target policy, and the check asks `checkedTarget` with SNMP's family and timeout,
 * so the lookup is bounded and counted by the same `resolveWithin` every transport waits in.
 *
 * **Its resolver is the probe's when the pool serves lookups** (`P-426`): the worker's client of
 * the `NameResolver` the test handed the pool, which answers with whatever `getaddrinfo` the test
 * handed it. Otherwise the worker resolves for itself with `fakeResolve`, by the name it is asked
 * (`fake-names.ts`). The registry reports `nameLookups`, as `catalogue-registry.ts` does.
 *
 * It also runs the three real listener types, whose senders are resolved the same way (`P-425`).
 */

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        fail(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * SNMP's resolution and nothing else of SNMP: one lookup a scan for a named device (`A-57`), over
 * IPv4, bounded by half of SNMP's own five-second timeout, then `delayMs` of waiting for an
 * answer that is not asked for, as `MODEL_CHECK_MS` models a round trip.
 */
const named: SensorType = {
  id: 'test.named',
  category: 'Test',
  costHint: 'light',
  declaresEveryChannel: true,
  paramsSchema: { type: 'object', additionalProperties: true, properties: {} },
  channels() {
    return [{ key: 'value', name: 'Value', unit: '#', isPrimary: true }];
  },
  async execute(context: CheckContext): Promise<CheckExecution> {
    const { target, params, signal } = context;
    await checkedTarget({
      host: target.host,
      ...(target.pinned === undefined ? {} : { pinned: target.pinned }),
      ...(target.policy === undefined ? {} : { policy: target.policy }),
      ...(target.resolve === undefined ? {} : { resolve: target.resolve }),
      family: target.ipVersion === 'v6' ? 6 : 4,
      timeoutMs: Number(params['timeoutMs'] ?? 5_000),
      signal,
      verb: 'query',
      doing: `querying ${target.host}:161 over SNMP`,
    });
    await abortable(Number(params['delayMs'] ?? 0), signal);
    return { channels: [{ key: 'value', value: 1 }], message: 'answered' };
  },
};

/** The listener types, whose sender is resolved as a check's own name is (`P-425`). */
const LISTENER_TYPES = ['snmp.trap', 'syslog.receiver', 'flow.netflow'];
const listeners = BUILT_IN_SENSOR_TYPES.filter((type) => LISTENER_TYPES.includes(type.id));
if (listeners.length !== LISTENER_TYPES.length) {
  throw new Error(`the built-in catalogue lacks one of ${LISTENER_TYPES.join(', ')}`);
}

const through = poolResolver();
const catalogue = new SensorCatalogue({
  resolve: through?.resolve ?? fakeResolve,
  targetPolicy: 'link-local',
}).register(named);
for (const type of listeners) catalogue.register(type);
catalogue.seal();

const registry: CheckRegistry = {
  execute(sensorType: string, context: CheckContext): Promise<CheckExecution> {
    return withResolverNotes(through, () => catalogue.execute(sensorType, context));
  },
  lookupCounters(): LookupCounters {
    return nameLookups.stats();
  },
};

export default registry;
