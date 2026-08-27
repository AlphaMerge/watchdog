import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from './messages.js';

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
];

/** Plain English for each capability, for a message an operator reads rather than greps. */
const DESCRIPTION: Readonly<Record<keyof ProbeCapabilities, string>> = {
  configPush: 'be sent sensors to scan',
  discoverySweep: 'run a discovery sweep',
  identification: 'identify what it found',
  approval: 'be held for approval before it scans',
};

export function capabilitiesFor(peerVersion: number): ProbeCapabilities {
  const has = (since: number): boolean => Number.isInteger(peerVersion) && peerVersion >= since;
  return {
    configPush: has(3),
    discoverySweep: has(4),
    identification: has(5),
    approval: has(6),
  };
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
    // **The newer end is the one that has to accommodate**, so a peer from the future is refused
    // rather than guessed at. It knows messages this build has never seen, and treating its
    // silence about them as agreement is how a version skew becomes a data-loss bug.
    return {
      kind: 'incompatible',
      peerVersion,
      ownVersion: PROTOCOL_VERSION,
      reason:
        `speaks protocol ${String(peerVersion)}, which is newer than this build ` +
        `(${String(PROTOCOL_VERSION)}) — upgrade this end`,
    };
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
  }
}
