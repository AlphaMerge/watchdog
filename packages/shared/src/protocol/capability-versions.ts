import type { ProbeCapabilities } from './capabilities.js';

/**
 * `@ms/shared/capability-versions` — the version each capability arrived in, and nothing else
 * (`P-294`).
 *
 * **Its own file so the browser can read it.** The rest of `protocol/` is service code: the
 * message schemas pull in `ajv`, and `capabilities.ts` reads them. The add-sensor form needs only
 * the numbers, to say which version a listener's counter arrived in, and it used to write them
 * out by hand beside a comment. So the table lives here, with no import that survives
 * compilation, and `capabilities.ts` reads it like every other gate does. `capability-versions
 * .test.ts` holds the compiled file to that.
 *
 * Ordered oldest first, and the order is load-bearing: `missingCapabilities` reports in this
 * order so an operator reads "cannot be sent sensors" before "cannot run discovery", which is
 * the order in which they would care. A record rather than a list of pairs, so the type checker
 * refuses a table that leaves a capability out or names one that does not exist.
 */
const SINCE = {
  configPush: 3,
  discoverySweep: 4,
  identification: 5,
  approval: 6,
  healthReporting: 7,
  onDemandQuery: 8,
  listenerCounters: 13,
  chunkedPushFinal: 16,
  resultSendTime: 16,
  machineMemory: 17,
  memoryLimit: 18,
  poolMemory: 19,
  memorySinceLastReport: 20,
  logOutput: 21,
  credentialHostKeys: 22,
  flowCounters: 23,
  credentialAddressPinning: 24,
  flowOverwritten: 25,
  listenerOverwritten: 26,
  databaseAddressPinning: 27,
  targetPolicyException: 28,
  childStartup: 29,
  workerStartup: 30,
  listenerEarlier: 31,
  scriptGroups: 31,
  unsendableReadings: 32,
} as const satisfies Readonly<Record<keyof ProbeCapabilities, number>>;

/** Every capability with the version it arrived in, oldest first. */
export const INTRODUCED: readonly (readonly [keyof ProbeCapabilities, number])[] = Object.entries(
  SINCE,
) as [keyof ProbeCapabilities, number][];

/** The version a peer must speak for one capability — the number the gates used to inline. */
export function versionFor(capability: keyof ProbeCapabilities): number {
  return SINCE[capability];
}
