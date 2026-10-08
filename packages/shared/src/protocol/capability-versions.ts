import type { ProbeCapabilities } from './capabilities.js';

/**
 * `@ms/shared/capability-versions` — the version each capability arrived in (`P-294`), and the
 * floor below which a peer is refused (`U-33`). Nothing else.
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

/**
 * The oldest peer version this build still understands.
 *
 * Still 1: a version-1 probe never sends results, so an older probe against this core simply
 * heartbeats. There is nothing to break, and forcing an upgrade in lockstep would defeat the
 * point of negotiating at all.
 *
 * **Here, beside the capability table, so the browser can read it** (`U-33`). The add-sensor form
 * says a probe's last hello was refused over its version, and decides that by the test the
 * handshake refuses by, rather than by a copy of this number.
 */
export const MIN_PROTOCOL_VERSION = 1;

/**
 * Whether two peers can hold a conversation at all (`P-178`).
 *
 * **Only the floor, since every feature is gated by capability.** This used to refuse a peer
 * *above* this build as well, on the reasoning that the newer end knows messages this one has
 * never seen and treating its silence as agreement is how a skew becomes a data-loss bug. That
 * was right when version numbers were compared inline at each send site. It is not right now:
 * every message that is not in every version is gated through `capabilitiesFor`, and each end
 * gates on the *negotiated* version — so the newer end never sends the older one a field it
 * cannot parse. The refusal had stopped protecting against anything and had started costing a
 * lockstep fleet upgrade on every bump.
 *
 * And the cost was not a clean refusal, which is what made it worth changing rather than
 * documenting. A probe that refuses the welcome destroys the socket and reconnects for ever;
 * the core meanwhile accepts the hello, opens a session, restores every sensor under that probe
 * to its last reading, computes and sends a full configuration push, and is hung up on — once a
 * minute, per probe, indefinitely, with nothing scanned. Bumping `PROTOCOL_VERSION` to add two
 * optional fields would have taken every deployed probe offline until the fleet caught up
 * (`P-168`), which is the failure the bump was made to prevent.
 *
 * A peer below `MIN_PROTOCOL_VERSION` is still refused: that is a genuine floor, not a feature.
 */
export function isProtocolCompatible(peerVersion: number): boolean {
  return Number.isInteger(peerVersion) && peerVersion >= MIN_PROTOCOL_VERSION;
}
