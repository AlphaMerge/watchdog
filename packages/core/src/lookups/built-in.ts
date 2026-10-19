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

/**
 * Whether a probe's worker pool is still running checks (`P-62`).
 *
 * **The alarm for a probe that is up and monitoring nothing.** The pool latches itself off after
 * repeated worker start failures and runs nothing until the probe restarts — while the link stays
 * connected, heartbeats keep arriving, and `poolBusy` reads 0, which is indistinguishable from a
 * quiet night. Meanwhile every sensor under that probe holds its last state for ever: the core
 * re-evaluates on an arriving result, and the only routes to Unknown are an unreachable probe and
 * a sensor that has never been scanned. So without this, the failure mode is an installation
 * reporting that everything is Up while nothing is being checked.
 *
 * A lookup rather than a threshold, for the reason `PROBE_LINK` gives: this is a state, and "1 is
 * above 0.5" is not a sentence anybody can act on.
 */
const PROBE_POOL: LookupDefinition = {
  id: 'ms.probe.pool',
  name: 'Probe worker pool',
  description: 'Whether this probe’s worker pool is still able to run checks.',
  type: 'singleInt',
  undefinedState: 'warning',
  entries: [
    { value: 0, state: 'up', text: 'running' },
    { value: 1, state: 'down', text: 'failed; this probe cannot run checks until it is restarted' },
  ],
};

/**
 * Whether a connected probe is still sending results (`P-74`).
 *
 * **The alarm for a probe that is up and answering and monitoring nothing.** A sensor's state is
 * re-evaluated when a result arrives; nothing ages one out. So a fault that stops results without
 * dropping the link leaves every sensor under that probe frozen in its last state, for ever, with
 * no alarm — a monitoring system reporting that everything is fine because nobody asked.
 *
 * A lookup rather than a threshold, for `PROBE_LINK`'s reason: this is a state. And Down rather
 * than Warning, because a probe that is not delivering is not monitoring, which is the same
 * outcome as a probe that is gone — the difference is only that this one is still answering the
 * phone, which is exactly what makes it harder to notice.
 */
const PROBE_DELIVERY: LookupDefinition = {
  id: 'ms.probe.delivery',
  name: 'Probe delivery',
  description: 'Whether this probe is still sending results for the sensors it was assigned.',
  type: 'singleInt',
  undefinedState: 'warning',
  entries: [
    { value: 0, state: 'down', text: 'connected but sending no results' },
    { value: 1, state: 'up', text: 'delivering' },
  ],
};

/**
 * Whether a probe is getting back the checks it dispatches (`P-76`).
 *
 * **Warning rather than Down, and the distinction is the whole ticket.** `ms.probe.delivery` is
 * Down because a probe delivering nothing is monitoring nothing. This one fires when the probe is
 * delivering — other checks are completing — and some of what it dispatched is not coming back.
 * The probe is working; part of what it carries is not being checked. Down would overstate it and
 * would collide with the case that genuinely is one.
 */
const PROBE_CHECKS: LookupDefinition = {
  id: 'ms.probe.checks',
  name: 'Probe check flow',
  description: 'Whether checks this probe dispatched are settling.',
  type: 'singleInt',
  undefinedState: 'warning',
  entries: [
    { value: 0, state: 'warning', text: 'checks were dispatched and are not coming back' },
    { value: 1, state: 'up', text: 'checks are settling' },
  ],
};

/**
 * How a probe resolves names (`P-432`): `probe.nameResolver`, and whether gate mode's lookup
 * helper rests. **Every entry Up**, and Up for a value it does not list: a mode is a setting, not
 * a fault, and a resting helper is `ms.probe.lookup-helper`'s to alarm on, once. This is the
 * record of which mode ran, read raw by the field test.
 */
const PROBE_NAME_RESOLVER: LookupDefinition = {
  id: 'ms.probe.name-resolver',
  name: 'Probe name resolver',
  description:
    'How this probe resolves names: its probe.nameResolver, and whether its lookup helper rests.',
  type: 'singleInt',
  undefinedState: 'up',
  entries: [
    { value: 1, state: 'up', text: 'system' },
    { value: 2, state: 'up', text: 'gate' },
    {
      value: 3,
      state: 'up',
      text: 'gate, with its lookup helper resting: names are asked as with system',
    },
  ],
};

/**
 * Whether gate mode's lookup helper is in trouble (`P-432` §1.13): the probe's latch, set when
 * the helper was not up for 30 s, failed three times in ten minutes, ran out of memory, or rests,
 * and cleared after ten minutes up with no loss, or at the probe's restart after a skew. **The
 * gate's one alarm, and a Warning**: names are still answered, as with `system` while it rests. A
 * zone that stops answering never sets it.
 */
const PROBE_LOOKUP_HELPER_TROUBLE: LookupDefinition = {
  id: 'ms.probe.lookup-helper',
  name: 'Probe lookup helper',
  description:
    'Whether the lookup helper of a probe with probe.nameResolver set to gate is answering.',
  type: 'singleInt',
  undefinedState: 'warning',
  entries: [
    { value: 0, state: 'up', text: 'answering' },
    {
      value: 1,
      state: 'warning',
      text: 'failing: not up for 30 s, 3 failures in 10 minutes, out of memory, or resting (until a restart, after a skew); read the probe log’s lookup helper lines',
    },
  ],
};

/**
 * The state of gate mode's lookup helper (`P-432` S6). **Every entry Up**: its trouble is the
 * latch's to alarm on, once (`ms.probe.lookup-helper`), so a restart or a rest is said here in
 * words and raises nothing more.
 */
const PROBE_LOOKUP_HELPER_STATE: LookupDefinition = {
  id: 'ms.probe.lookup-helper-state',
  name: 'Probe lookup helper state',
  description: 'What the lookup helper of a probe with probe.nameResolver set to gate is doing.',
  type: 'singleInt',
  undefinedState: 'up',
  entries: [
    { value: 1, state: 'up', text: 'up' },
    { value: 2, state: 'up', text: 'starting' },
    { value: 3, state: 'up', text: 'not answering: its lookups are asked as if it were down' },
    { value: 4, state: 'up', text: 'restarting' },
    { value: 5, state: 'up', text: 'resting: names are asked as with system' },
    { value: 6, state: 'up', text: 'stopping' },
  ],
};

/**
 * Gate mode's name check (`P-432` S6, §1.10). **Every entry Up**: off, unproven or stood down, the
 * check sends its names to the lookup helper, which answers them, so none of these is an outage;
 * the field test reads it raw.
 */
const PROBE_NAME_CHECK: LookupDefinition = {
  id: 'ms.probe.name-check',
  name: 'Probe name check',
  description:
    'Whether the name check of a probe with probe.nameResolver set to gate decides where its lookups run.',
  type: 'singleInt',
  undefinedState: 'up',
  entries: [
    { value: 0, state: 'up', text: 'resting: names are asked as with system' },
    { value: 1, state: 'up', text: 'on' },
    {
      value: 2,
      state: 'up',
      text: 'off for this system’s resolver settings or platform: the probe’s start log says why',
    },
    { value: 3, state: 'up', text: 'not proven: no DNS server has answered it yet' },
    { value: 4, state: 'up', text: 'stood down after misses: the probe log says which zones' },
    { value: 5, state: 'up', text: 'walks off at a DNS server' },
  ],
};

export const BUILT_IN_LOOKUPS: readonly LookupDefinition[] = [
  IF_OPER_STATUS,
  IF_ADMIN_STATUS,
  PROBE_LINK,
  PROBE_PROTOCOL,
  PROBE_POOL,
  PROBE_DELIVERY,
  PROBE_CHECKS,
  PROBE_NAME_RESOLVER,
  PROBE_LOOKUP_HELPER_TROUBLE,
  PROBE_LOOKUP_HELPER_STATE,
  PROBE_NAME_CHECK,
];
