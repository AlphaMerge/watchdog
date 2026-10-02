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
 * **Three answers, and only one of them is a notice.** A probe that is not connected, or one too
 * old to report its own numbers, gaps every channel — the listener's among them — and saying "off"
 * then would be a guess. The notice is shown only when the probe *has* reported and the
 * listener's counter is not in what it reported.
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
 * What to say under the type, or `null` to say nothing.
 *
 * `health` is `null` while it is loading and when it was refused: a reader who may not see the
 * probe learns nothing about it here, including that there was something to learn.
 */
export function listenerNotice(
  listener: string | undefined,
  probeName: string,
  health: ProbeHealthView | null,
): string | null {
  if (listener === undefined || health === null) return null;
  const spec = Object.hasOwn(LISTENERS, listener) ? LISTENERS[listener] : undefined;
  if (spec === undefined) return null;

  const { channels } = health;
  // **Only a probe that has reported can be said to have left something out.** `scheduled` is in
  // every report a probe has ever sent, and it is a gap in each case where the listener's own
  // gap means nothing: a probe that is not connected, the first seconds of a link, and a probe
  // too old to send a report at all.
  if (typeof channels['scheduled'] !== 'number') return null;
  if (typeof channels[spec.channel] === 'number') return null;

  return (
    `The ${spec.name} on probe “${probeName}” is not running, so this sensor would fail every ` +
    `scan until it is. Set ${spec.setting} to true in that probe’s configuration file and ` +
    `restart the probe.${spec.caveat === undefined ? '' : ` ${spec.caveat}`} You can still ` +
    'create the sensor now.'
  );
}
