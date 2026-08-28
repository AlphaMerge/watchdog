import type { LookupDefinition } from './definition.js';

/**
 * The lookups this build ships (`M-06`).
 *
 * TypeScript modules rather than JSON files in the tarball, for the reason migrations are:
 * "the tarball ships compiled JavaScript and nothing else, so [anything] that lives in a
 * [data] file is one more thing the packaging step can forget to copy". A missing built-in
 * lookup would surface as an SNMP sensor that never leaves Unknown. *Operator*-authored
 * lookups are JSON files under `<dataDir>/lookups` and override these by id — an operator
 * cannot recompile, and should not have to.
 *
 * Deliberately few. These are the two status codes RFC 2863 defines for every managed
 * interface on earth, so `D-xx` and Phase 4's SNMP sensors need them and they are not a guess
 * about a device nobody has. Anything device-specific belongs in the custom directory, where
 * being wrong costs the operator a file rather than a release.
 */

/** RFC 2863 `ifOperStatus`. What the interface is actually doing. */
const IF_OPER_STATUS: LookupDefinition = {
  id: 'ms.snmp.if-oper-status',
  name: 'Interface operational status',
  description: 'RFC 2863 ifOperStatus — the current operational state of an interface.',
  type: 'singleInt',
  // An unlisted code from an interface is a device speaking a dialect we do not know, which is
  // worth an operator's attention and is not, on its own, an outage.
  undefinedState: 'warning',
  entries: [
    { value: 1, state: 'up', text: 'up' },
    { value: 2, state: 'down', text: 'down' },
    { value: 3, state: 'warning', text: 'testing' },
    { value: 4, state: 'warning', text: 'unknown' },
    // Dormant is waiting for an external event — a dial-up line with nothing to carry. Not an
    // error, and not up either.
    { value: 5, state: 'warning', text: 'dormant' },
    { value: 6, state: 'down', text: 'not present' },
    { value: 7, state: 'down', text: 'lower layer down' },
  ],
};

/** RFC 2863 `ifAdminStatus`. What the interface has been told to do. */
const IF_ADMIN_STATUS: LookupDefinition = {
  id: 'ms.snmp.if-admin-status',
  name: 'Interface administrative status',
  description: 'RFC 2863 ifAdminStatus — the state an administrator has configured.',
  type: 'singleInt',
  undefinedState: 'warning',
  entries: [
    { value: 1, state: 'up', text: 'up' },
    // Administratively down is somebody's decision, not a fault. Reporting Down for it would
    // alarm on a port an operator switched off on purpose — the same mistake as alarming on a
    // paused sensor.
    { value: 2, state: 'warning', text: 'administratively down' },
    { value: 3, state: 'warning', text: 'testing' },
  ],
};

/**
 * Whether a probe is talking to the core (`P-13`).
 *
 * A lookup rather than a threshold on a 1/0 channel, because "not connected" is a *state* and
 * not a measurement — the same rule that keeps `ifOperStatus` out of a limit. It also makes the
 * one alarm for a lost probe read as a sentence rather than as "0 is below 0.5".
 */
const PROBE_LINK: LookupDefinition = {
  id: 'ms.probe.link',
  name: 'Probe link',
  description: 'Whether the core currently has a connection from this probe.',
  type: 'singleInt',
  undefinedState: 'warning',
  entries: [
    { value: 0, state: 'down', text: 'not connected' },
    { value: 1, state: 'up', text: 'connected' },
  ],
};

/**
 * How far a probe's protocol version is from the core's (`R-06`).
 *
 * **Outdated is a warning, not an outage**, and the distinction is the whole of `R-06`: an old
 * probe connects, heartbeats and behaves — and quietly cannot be sent some or all of its work.
 * That is worth an operator's attention and is not, on its own, a monitoring failure.
 * Incompatible is Down, because the link is refused and nothing under that probe is scanned.
 */
const PROBE_PROTOCOL: LookupDefinition = {
  id: 'ms.probe.protocol',
  name: 'Probe protocol skew',
  description: 'How the probe’s protocol version compares with the core’s.',
  type: 'singleInt',
  undefinedState: 'warning',
  entries: [
    { value: 0, state: 'up', text: 'same as the core' },
    { value: 1, state: 'warning', text: 'older than the core' },
    { value: 2, state: 'down', text: 'incompatible' },
    // **There is deliberately no code for "not yet known".** A lookup maps a *reading* to a
    // state, and a lookup has no Unknown to map to — rightly, because a reading exists by
    // definition. A probe this core has not spoken to since it started has no version recorded,
    // and the honest answer is no reading at all: the channel gaps, which is what absence looks
    // like everywhere else in this system. A fourth code would have had to be Warning, marking
    // every probe after an upgrade until it reconnected.
  ],
};

export const BUILT_IN_LOOKUPS: readonly LookupDefinition[] = [
  IF_OPER_STATUS,
  IF_ADMIN_STATUS,
  PROBE_LINK,
  PROBE_PROTOCOL,
];
