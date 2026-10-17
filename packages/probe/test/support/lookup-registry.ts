import { BroadcastChannel, threadId } from 'node:worker_threads';
import {
  checkedTarget,
  nameLookups,
  SensorCatalogue,
  systemResolve,
  type ResolvedAddress,
  type ResolveHost,
  type SensorType,
} from '@ms/sensors';
import type {
  CheckContext,
  CheckExecution,
  CheckRegistry,
  LookupCounters,
} from '../../src/runner/types.js';

/**
 * A registry whose one check resolves its device's name the way SNMP does, through the real
 * catalogue and the real guard, against a resolver the test owns (`A-66`).
 *
 * **The resolution is the shipped one**: a `SensorCatalogue` hands the check its resolver and
 * the probe's target policy, and the check asks `checkedTarget` with SNMP's family and timeout,
 * so the lookup is bounded and counted by the same `resolveWithin` every transport waits in.
 * Only the resolver is the test's, and it answers by the name it is asked:
 *
 * | Name | Answer |
 * | --- | --- |
 * | `answers*.test` | 192.0.2.10, at once |
 * | `fails*.test` | `ENOTFOUND`, at once |
 * | `hangs*.test` | never |
 * | `late-<ms>*.test` | 192.0.2.10 after `<ms>` |
 * | `sys-*.test` | `getaddrinfo` for `localhost`: the system resolver, from the hosts file |
 * | `lane-*.test` | whatever the test's main thread answers (`LOOKUP_LANES_CHANNEL`) |
 *
 * The last is for `test/perf/name-lookups.test.ts`, which answers every worker's lookups from
 * one place so that they queue behind one another as `getaddrinfo` calls queue on libuv's thread
 * pool. The registry reports `nameLookups`, as `catalogue-registry.ts` does.
 */

/** Where a `lane-*.test` lookup is asked, and `${LOOKUP_LANES_CHANNEL}:${threadId}` answers. */
export const LOOKUP_LANES_CHANNEL = 'ms-test-lookup-lanes';

/** What a worker asks of the lanes. */
export interface LaneRequest {
  readonly id: number;
  readonly thread: number;
  readonly host: string;
  readonly family: 0 | 4 | 6;
}

/** What a lane answers: addresses, or the code the resolver failed with. */
export type LaneReply =
  { readonly addresses: readonly ResolvedAddress[] } | { readonly code: string };

/** And the request it answers. */
export type LaneAnswer = LaneReply & { readonly id: number };

const ANSWER: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];

function notFound(host: string, code = 'ENOTFOUND'): Error {
  return Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code });
}

interface Lanes {
  readonly requests: BroadcastChannel;
  readonly waiting: Map<
    number,
    { resolve: (answers: readonly ResolvedAddress[]) => void; reject: (error: Error) => void }
  >;
  next: number;
}

let lanes: Lanes | undefined;

function openLanes(): Lanes {
  const requests = new BroadcastChannel(LOOKUP_LANES_CHANNEL);
  const replies = new BroadcastChannel(`${LOOKUP_LANES_CHANNEL}:${String(threadId)}`);
  const opened: Lanes = { requests, waiting: new Map(), next: 0 };
  replies.onmessage = (event: unknown) => {
    const answer = (event as { data: LaneAnswer }).data;
    const waiter = opened.waiting.get(answer.id);
    if (waiter === undefined) return;
    opened.waiting.delete(answer.id);
    if ('addresses' in answer) waiter.resolve(answer.addresses);
    else waiter.reject(notFound('the lane', answer.code));
  };
  // Neither keeps the worker alive: its port to the pool does.
  requests.unref();
  replies.unref();
  return opened;
}

function viaLanes(host: string, family: 0 | 4 | 6): Promise<readonly ResolvedAddress[]> {
  lanes ??= openLanes();
  const open = lanes;
  open.next += 1;
  const id = open.next;
  return new Promise((resolve, reject) => {
    open.waiting.set(id, { resolve, reject });
    const request: LaneRequest = { id, thread: threadId, host, family };
    open.requests.postMessage(request);
  });
}

const resolve: ResolveHost = (host, family) => {
  const name = host.toLowerCase();
  if (name.startsWith('sys-')) return systemResolve('localhost', family);
  if (name.startsWith('lane-')) return viaLanes(name, family);
  if (name.startsWith('answers')) return Promise.resolve(ANSWER);
  if (name.startsWith('fails')) return Promise.reject(notFound(host));
  if (name.startsWith('hangs')) return new Promise(() => undefined);
  const late = /^late-(\d+)/.exec(name);
  if (late !== null) {
    return new Promise((answered) => {
      setTimeout(() => {
        answered(ANSWER);
      }, Number(late[1]));
    });
  }
  return Promise.reject(notFound(host));
};

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

const catalogue = new SensorCatalogue({ resolve, targetPolicy: 'link-local' })
  .register(named)
  .seal();

const registry: CheckRegistry = {
  execute(sensorType: string, context: CheckContext): Promise<CheckExecution> {
    return catalogue.execute(sensorType, context);
  },
  lookupCounters(): LookupCounters {
    return nameLookups.stats();
  },
};

export default registry;
