import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, type ProbeHealthReport } from './messages.js';

/**
 * What a peer at a given protocol version can actually be asked to do (`R-06`).
 *
 * **The version numbers were scattered, and that is the bug this exists to prevent.** Before
 * this, `probe-endpoint.ts` compared against a bare `3` to decide whether to push configuration
 * and a bare `4` or `5` to decide whether to send a sweep, with the meaning of each number in a
 * comment beside it. Adding a version meant finding every such comparison, and the cost of
 * missing one is not a crash — it is a probe that connects, heartbeats, and quietly does
 * nothing. So the map from version to capability lives here, once, and every gate reads it.
 *
 * **Compatible is not the same as current.** `isProtocolCompatible` answers whether the two ends
 * can hold a conversation at all; this answers what that conversation can contain. A protocol-2
 * probe is compatible — it connects, it heartbeats, nothing misbehaves — and it will never
 * receive a sensor to scan, which is the failure `R-06` exists to make visible.
 */
export interface ProbeCapabilities {
  /** Can be sent assignments at all. Below this a probe connects and scans nothing. */
  configPush: boolean;
  /** Can run a network sweep — `D-01`'s discovery stage. */
  discoverySweep: boolean;
  /** Can run identification — `D-02`'s second stage. */
  identification: boolean;
  /** Understands approval, so it can wait in a queue rather than assuming it is trusted. */
  approval: boolean;
  /**
   * Reports its own scheduler, pool and spool numbers on the heartbeat (`P-13`).
   *
   * Below this, Probe Health still works — the core knows whether the link is up, how old the
   * last heartbeat is and what protocol the probe speaks — and it says in its message that the
   * rest is unavailable because the probe is too old to send it. A missing capability is
   * reported in words, never as a channel that quietly reads zero.
   */
  healthReporting: boolean;
  /**
   * Answers an on-demand query — a check run *now*, with an API call waiting (`R-09`).
   *
   * The gate matters more here than for the others because a person is looking at a spinner: a
   * probe too old for this must be told so immediately, not left to a timeout that looks
   * identical to a device that will not answer.
   */
  onDemandQuery: boolean;
  /**
   * Understands `final` on a chunked configuration push, and stamps its version only on the
   * message that carries it (`P-168`).
   *
   * **Gated because the field itself is the hazard.** Every core→probe schema carries
   * `additionalProperties: false`, so a probe that does not know `final` does not ignore it —
   * it rejects the whole message, closes the connection on a protocol violation, reconnects and
   * rejects it again. `P-166` added the field without a version, which wedged every probe that
   * had not been upgraded in lockstep. Below this, the core omits it and the probe keeps the
   * older behaviour of stamping on the first message; `P-153`'s heartbeat reconciliation is
   * what covers those.
   */
  chunkedPushFinal: boolean;
  /**
   * Stamps each results batch with the probe's own clock at the moment it was sent (`P-169`).
   *
   * What makes "is this a replay?" answerable in **one** clock. The core compares `sentAt`
   * against the newest result in the batch — both the probe's — so a probe host whose clock is
   * wrong is judged against itself and a replay is a replay whatever the skew. Below this the
   * core falls back to comparing the batch against its own clock, which is `P-146`'s original
   * test and carries `P-146`'s original skew problem.
   */
  resultSendTime: boolean;
  /**
   * Reports how much memory its *machine* has left, beside its own resident memory (`P-208`).
   *
   * The first health field added since `P-178` negotiated a newer probe down instead of refusing
   * it, and so the first one that must be stripped rather than sent: the core's health schema is
   * `additionalProperties: false`, and an older core would reject every heartbeat that carried it.
   * Below this the two channels gap and Probe Health's message says why.
   */
  machineMemory: boolean;
}

/**
 * The version each capability arrived in.
 *
 * Ordered oldest first, and the order is load-bearing: `missingCapabilities` reports in this
 * order so an operator reads "cannot be sent sensors" before "cannot run discovery", which is
 * the order in which they would care.
 */
const INTRODUCED: readonly (readonly [keyof ProbeCapabilities, number])[] = [
  ['configPush', 3],
  ['discoverySweep', 4],
  ['identification', 5],
  ['approval', 6],
  ['healthReporting', 7],
  ['onDemandQuery', 8],
  ['chunkedPushFinal', 16],
  ['resultSendTime', 16],
  ['machineMemory', 17],
];

/** Plain English for each capability, for a message an operator reads rather than greps. */
const DESCRIPTION: Readonly<Record<keyof ProbeCapabilities, string>> = {
  configPush: 'be sent sensors to scan',
  discoverySweep: 'run a discovery sweep',
  identification: 'identify what it found',
  approval: 'be held for approval before it scans',
  healthReporting: 'report its own scheduler and pool health',
  onDemandQuery: 'run a check on demand',
  chunkedPushFinal: 'be told which message completes a configuration push',
  resultSendTime: 'say when it sent a batch, so a replay can be told from live data',
  machineMemory: 'report how much memory its machine has left',
};

export function capabilitiesFor(peerVersion: number): ProbeCapabilities {
  const has = (since: number): boolean => Number.isInteger(peerVersion) && peerVersion >= since;
  return {
    configPush: has(3),
    discoverySweep: has(4),
    identification: has(5),
    approval: has(6),
    healthReporting: has(7),
    onDemandQuery: has(8),
    chunkedPushFinal: has(16),
    resultSendTime: has(16),
    machineMemory: has(17),
  };
}

/**
 * The heartbeat's health with every field this peer's version does not know taken out (`P-208`).
 *
 * The heartbeat's own gate, and the only one it has needed: before `P-178` a probe never met a
 * core older than itself, so no health field was ever gated. One function rather than a condition
 * at the send, so the next health field is added here beside this one rather than found missing
 * when an older core starts rejecting heartbeats.
 */
export function healthForPeer(health: ProbeHealthReport, peerVersion: number): ProbeHealthReport {
  if (capabilitiesFor(peerVersion).machineMemory) return health;
  const {
    memoryAvailablePercent: _memoryAvailablePercent,
    memoryAvailableMb: _memoryAvailableMb,
    ...older
  } = health;
  return older;
}

/** The version a peer must speak for one capability — the number the gates used to inline. */
export function versionFor(capability: keyof ProbeCapabilities): number {
  const found = INTRODUCED.find(([name]) => name === capability);
  // Unreachable while INTRODUCED covers the interface, which the type system enforces at the
  // point of the table rather than here.
  return found?.[1] ?? PROTOCOL_VERSION;
}

/** Everything this peer cannot do, oldest capability first, in words rather than numbers. */
export function missingCapabilities(peerVersion: number): string[] {
  const capabilities = capabilitiesFor(peerVersion);
  return INTRODUCED.filter(([name]) => !capabilities[name]).map(([name]) => DESCRIPTION[name]);
}

/**
 * What to tell an operator about a peer's version.
 *
 * A discriminated union rather than a boolean and a string, because the three cases are acted on
 * differently and collapsing them is exactly how the middle one gets lost: `incompatible` closes
 * the link, `outdated` keeps it and withholds features, and `current` is silence.
 */
export type ProtocolSkew =
  /**
   * Nothing has been recorded for this peer yet — it has not connected since this core started
   * keeping the version. Distinct from `incompatible` on purpose: a stored zero is an absence
   * of evidence, and reading it as "speaks protocol 0" would put a red mark against every probe
   * an upgrade carried over before any of them reconnected.
   */
  | { kind: 'unknown' }
  | { kind: 'current'; peerVersion: number }
  | { kind: 'outdated'; peerVersion: number; ownVersion: number; missing: string[] }
  /**
   * The peer speaks a *newer* protocol than this build (`P-178`).
   *
   * Not `incompatible`, which is what it used to be: the pair simply speaks this end's version,
   * because the newer end gates its sends on the negotiated one. Not `outdated` either — that
   * says the peer is behind, and here it is ahead, so an operator reading "cannot run discovery"
   * about a probe newer than their core would go looking in the wrong place. The thing to
   * upgrade is this end, and this says so.
   */
  | { kind: 'ahead'; peerVersion: number; ownVersion: number }
  | { kind: 'incompatible'; peerVersion: number; ownVersion: number; reason: string };

export function describeSkew(peerVersion: number): ProtocolSkew {
  if (!Number.isInteger(peerVersion) || peerVersion < MIN_PROTOCOL_VERSION) {
    return {
      kind: 'incompatible',
      peerVersion,
      ownVersion: PROTOCOL_VERSION,
      reason:
        `speaks protocol ${String(peerVersion)}, which is older than the oldest this build ` +
        `understands (${String(MIN_PROTOCOL_VERSION)})`,
    };
  }
  if (peerVersion > PROTOCOL_VERSION) {
    // **The newer end accommodates, rather than being refused** (`P-178`). It knows messages this
    // build has never seen and will not send them: it gates on the negotiated version, which is
    // this build's. So the pair speaks what this end speaks, and what an operator needs to know
    // is that upgrading *this* end would unlock more — not that their probe is broken.
    return { kind: 'ahead', peerVersion, ownVersion: PROTOCOL_VERSION };
  }
  const missing = missingCapabilities(peerVersion);
  if (missing.length === 0) return { kind: 'current', peerVersion };
  return { kind: 'outdated', peerVersion, ownVersion: PROTOCOL_VERSION, missing };
}

/**
 * One line an operator can act on, for the log and for the API.
 *
 * Names the version on both ends every time. "Probe is outdated" is not something anybody can do
 * anything with; "speaks protocol 2, core speaks 6, so it cannot be sent sensors to scan" is.
 */
export function explainSkew(skew: ProtocolSkew): string {
  switch (skew.kind) {
    case 'unknown':
      return 'has not connected since this core started recording protocol versions';
    case 'current':
      return `speaks protocol ${String(skew.peerVersion)}, the same as this build`;
    case 'incompatible':
      return skew.reason;
    case 'outdated':
      return (
        `speaks protocol ${String(skew.peerVersion)}, this build speaks ` +
        `${String(skew.ownVersion)}, so it cannot ${skew.missing.join(', nor ')}`
      );
    case 'ahead':
      return (
        `speaks protocol ${String(skew.peerVersion)}, which is newer than this build ` +
        `(${String(skew.ownVersion)}); the pair speaks ${String(skew.ownVersion)} until this ` +
        `end is upgraded`
      );
  }
}
