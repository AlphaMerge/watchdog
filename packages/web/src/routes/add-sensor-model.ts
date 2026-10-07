import type { ObjectRef, ProbeHealthView } from '../api/types';

/**
 * Whether the probe a new sensor would run on has the listener its type reads from (`B-08`).
 *
 * **A listener sensor on a probe whose listener is off fails every scan**, and until this the
 * first anybody heard of it was that failure: the form offered `flow.netflow` on any probe, and
 * the operator learnt from the first scan's error that `flowListener.enabled` was false.
 *
 * **Read from what the core already has.** A probe reports a listener's counters in its heartbeat
 * only while that listener runs, and Probe Health gaps the channels otherwise — "no-data is not
 * zero" doing its job. So `GET /probes/{id}/health` already answers this, under the probe's own
 * `read` right, and no field was added to the protocol to ask it a second way.
 *
 * **Three answers: running, off, and cannot tell.** A probe that is not connected, or one too
 * old to report its own numbers, gaps every channel — the listener's among them — and saying "off"
 * then would be a guess. "Off" is said only when the probe *has* reported and the listener's
 * counter is not in what it reported. Otherwise the form says why it cannot tell (`U-29`), so that
 * saying nothing means the listener runs.
 */

interface ListenerSpec {
  /** A Probe Health channel that has a value exactly while the listener runs. */
  readonly channel: string;
  /** What the form calls it. */
  readonly name: string;
  /** The key in the probe's configuration file that turns it on. */
  readonly setting: string;
  /** Where the setting alone is not the whole answer. */
  readonly caveat?: string;
}

/** By the `listener` a sensor type declares, which is what the catalogue publishes. */
const LISTENERS: Readonly<Record<string, ListenerSpec>> = {
  flow: {
    channel: 'flowReceived',
    name: 'flow collector',
    setting: 'flowListener.enabled',
    // `H-12`: a v1 probe warns and binds nothing whatever the setting says (`B-07`).
    caveat: 'A probe on the v1 build has no flow collector, whatever that setting says.',
  },
  syslog: { channel: 'syslogReceived', name: 'syslog listener', setting: 'syslogListener.enabled' },
  'snmp-trap': {
    channel: 'trapReceived',
    name: 'SNMP trap listener',
    setting: 'trapListener.enabled',
  },
};

/** Whether this type reads from a probe listener this form knows how to ask about. */
export function readsListener(listener: string | undefined): boolean {
  return listener !== undefined && Object.hasOwn(LISTENERS, listener);
}

/**
 * The probe a sensor under `parent` would run on: the one at or above it.
 *
 * `null` when there is none in what the caller was given — which is also what a reader who cannot
 * see the probe gets, because the core leaves it out of the ancestors.
 */
export function probeAbove(parent: ObjectRef, ancestors: readonly ObjectRef[]): ObjectRef | null {
  if (parent.kind === 'probe') return parent;
  // Probes do not nest, so there is at most one.
  return ancestors.find((step) => step.kind === 'probe') ?? null;
}

/**
 * What the form says under the type (`B-08`, `U-29`).
 *
 * - **`off`**: the probe reported, and the listener's counter is not in what it reported. A
 *   caution: the sensor would fail every scan until the listener is turned on.
 * - **`unknown`**: the probe's own numbers are missing, so its listener's are too, and nothing
 *   can be said of the listener either way. The sentence says why, from the reason the core
 *   gives (`numbersUnavailable`, `P-255`), because the reasons ask different things of the
 *   reader: a probe with no heartbeat yet is seconds from an answer, and one too old to report
 *   will never give one.
 */
export interface ListenerNotice {
  readonly kind: 'off' | 'unknown';
  readonly text: string;
}

type NumbersUnavailable = NonNullable<ProbeHealthView['numbersUnavailable']>;

/**
 * What to say under the type, or `null` to say nothing.
 *
 * `health` is `null` while it is loading and when it was refused: a reader who may not see the
 * probe learns nothing about it here, including that there was something to learn.
 *
 * **Silence means the listener is running**, and only that. Until `U-29` the form inferred a
 * report from `scheduled` being a number and said nothing for a probe that had not reported, so
 * silence meant "running" or "cannot tell", and the reader could not know which.
 */
export function listenerNotice(
  listener: string | undefined,
  probeName: string,
  health: ProbeHealthView | null,
): ListenerNotice | null {
  if (listener === undefined || health === null) return null;
  const spec = Object.hasOwn(LISTENERS, listener) ? LISTENERS[listener] : undefined;
  if (spec === undefined) return null;

  // **Read, not inferred** (`U-29`). The core says why a probe's numbers are missing, and a probe
  // that has not reported has said nothing about its listener: the sentence is why.
  if (health.numbersUnavailable !== null) {
    return { kind: 'unknown', text: cannotTell(health.numbersUnavailable, spec, probeName) };
  }
  if (typeof health.channels[spec.channel] === 'number') return null;

  return {
    kind: 'off',
    text:
      `The ${spec.name} on probe “${probeName}” is not running, so this sensor would fail every ` +
      `scan until it is. Set ${spec.setting} to true in that probe’s configuration file and ` +
      `restart the probe.${caveat(spec)} You can still create the sensor now.`,
  };
}

/**
 * Why nothing can be said of the listener: one sentence a reason.
 *
 * **No number that moves.** `no-heartbeat` carries how long the probe has been connected, and it
 * is left out: the form asks again whenever the probe changes, and a count in the sentence would
 * be new text in the live region at each ask, read out again for a probe that had not changed
 * (`B-12`). The protocol versions do not move, so those are named.
 *
 * Where waiting will answer it, the sentence says so: the form asks again when the probe connects
 * and when it sends its first report (`U-24`). Where waiting will not, it names the setting to
 * check by hand.
 */
function cannotTell(missing: NumbersUnavailable, spec: ListenerSpec, probeName: string): string {
  const whether = `whether its ${spec.name} is running`;
  const check = `Check that ${spec.setting} is true in that probe’s configuration file.${caveat(spec)}`;
  // Widened to a string, so that a reason none of the cases knows — from a core newer than this
  // build — still reaches the last sentence rather than reading as one it is not.
  const reason: string = missing.reason;
  if (reason === 'no-heartbeat') {
    return (
      `Probe “${probeName}” has connected and has not sent its first heartbeat yet, so ` +
      `${whether} is not known yet. This updates when the heartbeat arrives.`
    );
  }
  if (missing.reason === 'protocol') {
    return (
      `Probe “${probeName}” is too old to report ${whether}: it speaks protocol ` +
      `${String(missing.protocolVersion)}, and reporting it needs protocol ` +
      `${String(missing.requiredVersion)}. ${check}`
    );
  }
  if (reason === 'not-connected') {
    return (
      `Probe “${probeName}” is not connected, so ${whether} cannot be checked. This updates ` +
      'when it connects.'
    );
  }
  if (reason === 'not-reported') {
    return (
      `Probe “${probeName}” sends heartbeats without its own numbers, so ${whether} cannot be ` +
      `checked. ${check}`
    );
  }
  // A reason this build does not know: still no claim either way.
  return (
    `Probe “${probeName}” has not reported its own numbers (${reason}), so ${whether} cannot ` +
    `be checked. ${check}`
  );
}

function caveat(spec: ListenerSpec): string {
  return spec.caveat === undefined ? '' : ` ${spec.caveat}`;
}
