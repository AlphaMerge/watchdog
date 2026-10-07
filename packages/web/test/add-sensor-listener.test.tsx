import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { versionFor } from '@ms/shared';
import type { ObjectRef, ProbeHealthView, SensorTypeSummary } from '../src/api/types';
import { AddSensor } from '../src/routes/AddSensor';
import {
  listenerNotice,
  probeAbove,
  readsListener,
  refusesProbe,
  type HealthAnswer,
} from '../src/routes/add-sensor-model';

/**
 * The add-sensor form saying a probe's listener is off (`B-08`).
 *
 * The form offered a flow sensor on any probe, and the operator learnt from the first scan's
 * error that `flowListener.enabled` was false. What the core answers below is the shape of
 * `GET /probes/{id}/health`: a listener's counters are numbers while it runs and `null` — a gap —
 * while it does not, and every channel but `connected` is a gap for a probe that is not there.
 */

const health = (channels: Record<string, number | null>): ProbeHealthView => ({
  at: '2026-10-02T10:00:00.000Z',
  probeId: 2,
  message: 'connected',
  // What the core says beside these channels (`P-255`): a report is what fills `scheduled`.
  numbersUnavailable:
    channels['connected'] !== 1
      ? { reason: 'not-connected' }
      : typeof channels['scheduled'] === 'number'
        ? null
        : { reason: 'no-heartbeat', connectedSeconds: 4 },
  // A current probe, so the version decides nothing here (`U-30`); none when it is not connected.
  protocolVersion: channels['connected'] === 1 ? 32 : null,
  channels,
});

/** A probe that has reported, with its flow collector running. */
const RUNNING = health({ connected: 1, scheduled: 12, flowReceived: 0, syslogReceived: 4 });
/** The same probe with every listener off: reported, and none of their counters in the report. */
const OFF = health({
  connected: 1,
  scheduled: 12,
  flowReceived: null,
  syslogReceived: null,
  trapReceived: null,
});

/** What the form would write under the type, or `null`. */
const say = (
  listener: string | undefined,
  given: HealthAnswer,
): ReturnType<typeof listenerNotice> => listenerNotice(listener, 'Berlin', given);
const text = (listener: string, given: ProbeHealthView): string => say(listener, given)?.text ?? '';

/** Every channel a gap, with the reason the core gives for it (`P-255`). */
const unavailable = (
  numbersUnavailable: ProbeHealthView['numbersUnavailable'],
  connected = 1,
): ProbeHealthView => ({
  ...health({ connected, scheduled: null, flowReceived: null, syslogReceived: null }),
  numbersUnavailable,
  // The core gives the version beside the reason, and they agree.
  ...(numbersUnavailable?.reason === 'protocol'
    ? { protocolVersion: numbersUnavailable.protocolVersion }
    : {}),
});

/** A probe that reported, at `protocolVersion`, with `channels` as its report left them. */
const reportedAt = (
  protocolVersion: number,
  channels: Record<string, number | null>,
): ProbeHealthView => ({
  ...health({ connected: 1, scheduled: 12, ...channels }),
  protocolVersion,
});

describe('whether a probe’s listener is running', () => {
  it('says nothing while a running listener has heard nothing: zero is not off', () => {
    expect(say('flow', RUNNING)).toBeNull();
  });

  it('names the listener, the probe and the setting when the counter is a gap', () => {
    expect(say('flow', OFF)?.kind).toBe('off');
    const notice = text('flow', OFF);
    expect(notice).toContain('The flow collector on probe “Berlin” is not running');
    expect(notice).toContain('Set flowListener.enabled to true');
    expect(notice).toContain('A probe on the v1 build has no flow collector');
    expect(notice).toContain('You can still create the sensor now.');
  });

  it('asks each listener’s own channel and names its own setting', () => {
    expect(text('syslog', OFF)).toContain('Set syslogListener.enabled to true');
    expect(text('snmp-trap', OFF)).toContain('Set trapListener.enabled to true');
    // Only flow has a build without it.
    expect(text('syslog', OFF)).not.toContain('v1');

    // One on and the others off, so a listener cannot be judged by another's counter.
    const onlyTraps = health({ connected: 1, scheduled: 3, trapReceived: 0, flowReceived: null });
    expect(say('snmp-trap', onlyTraps)).toBeNull();
    expect(say('flow', onlyTraps)?.kind).toBe('off');
  });

  it('never calls a listener off on a probe that has told the core nothing (B-08)', () => {
    for (const reason of [
      { reason: 'not-connected' as const },
      { reason: 'no-heartbeat' as const, connectedSeconds: 4 },
      { reason: 'protocol' as const, protocolVersion: 6, requiredVersion: 7 },
      { reason: 'not-reported' as const },
    ]) {
      const notice = say('flow', unavailable(reason, reason.reason === 'not-connected' ? 0 : 1));
      expect(notice?.kind, reason.reason).toBe('unknown');
      expect(notice?.text, reason.reason).not.toContain('is not running');
      expect(notice?.text, reason.reason).not.toContain('Set flowListener.enabled to true');
    }
    // Refused, or still loading: nothing at all, not even that there was something to learn.
    expect(say('flow', null)).toBeNull();
  });

  it('says "no heartbeat yet" apart from "too old", from the reason the core gives (U-29)', () => {
    // The first seconds of a link: an answer is on its way, and the sentence says it will come.
    const waiting = text('flow', unavailable({ reason: 'no-heartbeat', connectedSeconds: 4 }));
    expect(waiting).toBe(
      'Probe “Berlin” has connected and has not sent its first heartbeat yet, so whether its ' +
        'flow collector is running is not known yet. This updates when the heartbeat arrives.',
    );
    // No count of seconds: the form asks again on every change of the probe, and a sentence
    // that moved would be read out again each time (`B-12`).
    expect(
      text('flow', unavailable({ reason: 'no-heartbeat', connectedSeconds: 61 })),
      'the same sentence however long it has been',
    ).toBe(waiting);

    // Too old to report at all: no answer is coming, so the setting is named to check by hand.
    // The version named is the one the flow counter needs, not the one the core's own numbers
    // need (`U-30`): a probe moved up to 7 still could not say.
    const old = text(
      'flow',
      unavailable({ reason: 'protocol', protocolVersion: 6, requiredVersion: 7 }),
    );
    expect(old).toContain(
      'Probe “Berlin” is too old to report whether its flow collector is running',
    );
    expect(old).toContain('it speaks protocol 6, and reporting it needs protocol 23');
    expect(old).toContain('Check that flowListener.enabled is true');
    expect(old).toContain('A probe on the v1 build has no flow collector');
    expect(old).not.toContain('heartbeat');
    expect(waiting).not.toContain('too old');
    expect(waiting).not.toContain('protocol');
  });

  it('says why for the other reasons too, each in its own words (U-29)', () => {
    const gone = text('syslog', unavailable({ reason: 'not-connected' }, 0));
    expect(gone).toBe(
      'Probe “Berlin” is not connected, so whether its syslog listener is running cannot be ' +
        'checked. This updates when it connects.',
    );
    const silent = text('syslog', unavailable({ reason: 'not-reported' }));
    expect(silent).toBe(
      'Probe “Berlin” sends heartbeats without its own numbers, so whether its syslog listener ' +
        'is running cannot be checked. Check that syslogListener.enabled is true in that ' +
        'probe’s configuration file.',
    );
    // A reason a newer core gives that this build does not know: still no claim either way.
    const unheard = text('syslog', {
      ...unavailable(null),
      numbersUnavailable: {
        reason: 'sleeping',
      } as unknown as ProbeHealthView['numbersUnavailable'],
    });
    expect(unheard).toContain('has not reported its own numbers (sleeping)');
    expect(unheard).toContain('Check that syslogListener.enabled is true');

    // Four reasons, four sentences: none reads as another.
    const all = new Set([
      gone,
      silent,
      text('syslog', unavailable({ reason: 'no-heartbeat', connectedSeconds: 4 })),
      text('syslog', unavailable({ reason: 'protocol', protocolVersion: 6, requiredVersion: 7 })),
    ]);
    expect(all.size).toBe(4);
  });

  it('says it could not ask when the question went unanswered, and only a refusal is silence (U-29)', () => {
    const unanswered = say('flow', 'unanswered');
    expect(unanswered?.kind).toBe('unknown');
    expect(unanswered?.text).toContain(
      'Could not ask whether the flow collector on probe “Berlin”',
    );
    expect(unanswered?.text).not.toContain('is not running');
    expect(refusesProbe(403)).toBe(true);
    expect(refusesProbe(404)).toBe(true);
    // A core that is starting, any other server failure, and a core the browser cannot reach.
    for (const status of [503, 500, 502, 0])
      expect(refusesProbe(status), String(status)).toBe(false);
  });

  it('reads the reason rather than inferring it from `scheduled` (U-29)', () => {
    // A report in which `scheduled` is a gap is still a report: the listener is judged on its
    // own counter. And the reason decides "cannot tell" even when `scheduled` has a value.
    const reportedWithoutScheduled: ProbeHealthView = {
      ...health({ connected: 1, scheduled: null, flowReceived: null }),
      numbersUnavailable: null,
    };
    expect(say('flow', reportedWithoutScheduled)?.kind).toBe('off');
    const notYet: ProbeHealthView = {
      ...health({ connected: 1, scheduled: 12, flowReceived: null }),
      numbersUnavailable: { reason: 'no-heartbeat', connectedSeconds: 2 },
    };
    expect(say('flow', notYet)?.kind).toBe('unknown');
  });

  it('names the probe’s protocol when it reported at a version without the counter (U-30)', () => {
    // A probe at 22 reports everything else and leaves `flowReceived` out whatever its collector
    // is doing. Until `U-30` that read as "off", and pointed at a setting that could not help.
    const tooOld = say('flow', reportedAt(22, { flowReceived: null }));
    expect(tooOld?.kind).toBe('unknown');
    expect(tooOld?.text).toBe(
      'Probe “Berlin” is too old to report whether its flow collector is running: it speaks ' +
        'protocol 22, and reporting it needs protocol 23. Check that flowListener.enabled is ' +
        'true in that probe’s configuration file. A probe on the v1 build has no flow ' +
        'collector, whatever that setting says.',
    );
    expect(tooOld?.text).not.toContain('is not running');
    // The number the protocol itself gives, so this form cannot drift from it.
    expect(tooOld?.text).toContain(`needs protocol ${String(versionFor('flowCounters'))}.`);
  });

  it('judges the counter itself from the version that carries it, either way (U-30)', () => {
    // Collector off: reported at the version that carries the counter, and the counter a gap.
    expect(say('flow', reportedAt(23, { flowReceived: null }))?.kind).toBe('off');
    expect(say('flow', reportedAt(32, { flowReceived: null }))?.kind).toBe('off');
    // Collector on: the counter has a value, at the first version that carries it.
    expect(say('flow', reportedAt(23, { flowReceived: 0 }))).toBeNull();
    expect(say('flow', reportedAt(32, { flowReceived: 0 }))).toBeNull();
  });

  it('asks each listener’s own version, not flow’s (U-30)', () => {
    // The trap and syslog counters arrived at 13 (`P-64`), so a probe at 22 that left them out
    // has them off, and one at 12 cannot say.
    const at22 = reportedAt(22, { syslogReceived: null, trapReceived: null, flowReceived: null });
    expect(say('syslog', at22)?.kind).toBe('off');
    expect(say('snmp-trap', at22)?.kind).toBe('off');
    expect(say('flow', at22)?.kind).toBe('unknown');
    const at12 = text('syslog', reportedAt(12, { syslogReceived: null }));
    expect(at12).toContain('it speaks protocol 12, and reporting it needs protocol 13');
    expect(at12).not.toContain('v1 build');
  });

  it('puts the version before a heartbeat that has not come, since one will not help (U-30)', () => {
    const waitingAt20: ProbeHealthView = {
      ...unavailable({ reason: 'no-heartbeat', connectedSeconds: 4 }),
      protocolVersion: 20,
    };
    const said = text('flow', waitingAt20);
    expect(said).toContain('it speaks protocol 20, and reporting it needs protocol 23');
    expect(said).not.toContain('heartbeat');
    // Not connected: no version to judge, and the sentence is the connection's.
    expect(text('flow', unavailable({ reason: 'not-connected' }, 0))).toContain('is not connected');
  });

  it('says nothing for a type that reads no listener, or one this form does not know', () => {
    expect(listenerNotice(undefined, 'Berlin', OFF)).toBeNull();
    expect(listenerNotice('carrier-pigeon', 'Berlin', OFF)).toBeNull();
    expect(listenerNotice('toString', 'Berlin', OFF)).toBeNull();
    expect(readsListener('flow')).toBe(true);
    expect(readsListener(undefined)).toBe(false);
    expect(readsListener('carrier-pigeon')).toBe(false);
    expect(readsListener('constructor')).toBe(false);
  });

  it('finds the probe above the parent, and none where none was shown', () => {
    const root: ObjectRef = { id: 1, kind: 'root', name: 'Root' };
    const outer: ObjectRef = { id: 2, kind: 'probe', name: 'Berlin' };
    const group: ObjectRef = { id: 3, kind: 'group', name: 'Routers' };
    const device: ObjectRef = { id: 4, kind: 'device', name: 'edge-1' };
    expect(probeAbove(device, [root, outer, group])).toEqual(outer);
    expect(probeAbove(outer, [root])).toEqual(outer);
    // What a reader who cannot see the probe is given: the steps they can read.
    expect(probeAbove(device, [group])).toBeNull();
    expect(probeAbove(device, [])).toBeNull();
  });
});

const TYPES: SensorTypeSummary[] = [
  {
    id: 'flow.netflow',
    category: 'Flow',
    costHint: 'light',
    hasPreview: false,
    listener: 'flow',
    paramsSchema: { type: 'object', properties: {} },
  },
  {
    id: 'icmp.ping',
    category: 'Availability',
    costHint: 'light',
    hasPreview: false,
    paramsSchema: { type: 'object', properties: {} },
  },
];

const DEVICE = {
  id: 4,
  parentId: 3,
  kind: 'device',
  name: 'edge-1',
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: false,
  comments: '',
  inheritsTriggers: true,
  childCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const ANCESTORS: ObjectRef[] = [
  { id: 1, kind: 'root', name: 'Root' },
  { id: 2, kind: 'probe', name: 'Berlin' },
  { id: 3, kind: 'group', name: 'Routers' },
];

interface Core {
  ancestors?: ObjectRef[] | number;
  /** A number is a failure with that status; `'network'` is a fetch that rejects outright. */
  health?: ProbeHealthView | number | 'network';
}

/** A core that answers the four reads this form makes, and records which were asked. */
function stubCore(core: Core): { asked: string[] } {
  const asked: string[] = [];
  const answer = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const refuse = (status: number): Response =>
    answer(
      {
        error: {
          code:
            status === 403
              ? 'FORBIDDEN'
              : status === 503
                ? 'CORE_STARTING'
                : status >= 500
                  ? 'INTERNAL'
                  : 'OBJECT_NOT_FOUND',
          message: 'no',
        },
      },
      status,
    );

  vi.stubGlobal('fetch', (url: string) => {
    const path = url.replace(/^.*\/api\/v1/, '');
    asked.push(path);
    if (path === '/sensor-types') return Promise.resolve(answer({ items: TYPES }));
    if (path === '/objects/4') return Promise.resolve(answer(DEVICE));
    if (path === '/objects/4/ancestors') {
      const given = core.ancestors ?? ANCESTORS;
      return Promise.resolve(typeof given === 'number' ? refuse(given) : answer({ items: given }));
    }
    if (path === '/probes/2/health') {
      const given = core.health ?? OFF;
      if (given === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(typeof given === 'number' ? refuse(given) : answer(given));
    }
    return Promise.resolve(refuse(404));
  });
  return { asked };
}

async function open(core: Core): Promise<{ asked: string[] }> {
  const stub = stubCore(core);
  render(
    <MemoryRouter initialEntries={['/objects/4/add-sensor']}>
      <Routes>
        <Route path="/objects/:id/add-sensor" element={<AddSensor />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.getByLabelText('Sensor type')).toBeDefined();
  });
  return stub;
}

const pick = (typeId: string): void => {
  fireEvent.change(screen.getByLabelText('Sensor type'), { target: { value: typeId } });
};

/** The one live region under the type. It is in the document whether or not it says anything. */
const notice = (): HTMLElement => {
  const region = document.getElementById('sensor-type-listener');
  if (region === null) throw new Error('the form has no notice region under the type');
  return region;
};

/**
 * A socket that never opens. The form watches the probe it asked about (`B-12`,
 * `add-sensor-live.test.tsx`); these cases are about what it says when the type is chosen.
 */
class QuietSocket {
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  send(): void {}
  close(): void {}
}

describe('the add-sensor form on a probe whose flow collector is off', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', QuietSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says so under the type, in text the field is described by', async () => {
    await open({ health: OFF });
    pick('flow.netflow');

    await waitFor(() => {
      expect(notice().textContent).toContain('The flow collector on probe “Berlin” is not running');
    });
    expect(notice().textContent).toContain('flowListener.enabled');
    // WCAG 1.3.1 and 4.1.3: tied to the field it is about, and announced when it appears.
    expect(notice().getAttribute('role')).toBe('status');
    expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBe(
      'sensor-type-listener',
    );
    // A caution, not a refusal: the sensor can be created and the probe fixed afterwards.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Uplink flows' } });
    expect(screen.getByRole('button', { name: 'Create sensor' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('says nothing when the collector is running', async () => {
    const { asked } = await open({ health: RUNNING });
    pick('flow.netflow');
    await waitFor(() => {
      expect(asked).toContain('/probes/2/health');
    });
    // Past the answer, so this is "it said nothing" and not "it has not said it yet".
    await waitFor(() => {
      expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBeNull();
    });
    expect(notice().textContent).toBe('');
  });

  it('asks about no probe for a type that reads no listener, and takes the notice back', async () => {
    const { asked } = await open({ health: OFF });
    pick('icmp.ping');
    // Long enough for a request to have been made, had one been going to be.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked.filter((path) => path.includes('/health') || path.includes('/ancestors'))).toEqual(
      [],
    );

    pick('flow.netflow');
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });
    pick('icmp.ping');
    await waitFor(() => {
      expect(notice().textContent).toBe('');
    });
    expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBeNull();
  });

  it('tells a reader who cannot see the probe nothing about it', async () => {
    // What the core gives such a reader: the ancestors they can read, which leave the probe out.
    const hidden = await open({ ancestors: [{ id: 3, kind: 'group', name: 'Routers' }] });
    pick('flow.netflow');
    await waitFor(() => {
      expect(hidden.asked).toContain('/objects/4/ancestors');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hidden.asked.some((path) => path.includes('/probes/'))).toBe(false);
    expect(notice().textContent).toBe('');
  });

  it('says nothing when the probe’s health is refused', async () => {
    // 403 and 404 alike: both are the core telling this reader the probe is not theirs to see.
    for (const status of [403, 404]) {
      const refused = await open({ health: status });
      pick('flow.netflow');
      await waitFor(() => {
        expect(refused.asked).toContain('/probes/2/health');
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(notice().textContent, String(status)).toBe('');
      expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBeNull();
      cleanup();
    }
  });

  it('says it could not ask when the core is starting, rather than reading as "running" (U-29)', async () => {
    // A `503 CORE_STARTING` is not a refusal. Silence would mean the collector runs, and that
    // is what a core restart used to make of an "off" caution.
    const starting = await open({ health: 503 });
    pick('flow.netflow');
    await waitFor(() => {
      expect(starting.asked).toContain('/probes/2/health');
    });
    await waitFor(() => {
      expect(notice().textContent).toBe(
        'Could not ask whether the flow collector on probe “Berlin” is running: the core did ' +
          'not answer, so nothing is known about it either way.',
      );
    });
    expect(notice().getAttribute('role')).toBe('status');
    expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBe(
      'sensor-type-listener',
    );
    expect(notice().className).toContain('text-text-muted');
  });

  it('says it could not ask when the core cannot be reached at all (U-29)', async () => {
    const unreachable = await open({ health: 'network' });
    pick('flow.netflow');
    await waitFor(() => {
      expect(unreachable.asked).toContain('/probes/2/health');
    });
    await waitFor(() => {
      expect(notice().textContent).toContain('Could not ask whether the flow collector');
    });
    expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBe(
      'sensor-type-listener',
    );
  });

  it('treats any other server failure the same way (U-29)', async () => {
    await open({ health: 500 });
    pick('flow.netflow');
    await waitFor(() => {
      expect(notice().textContent).toContain('Could not ask whether the flow collector');
    });
  });
});

describe('the add-sensor form on a probe that has not reported (U-29)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', QuietSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says the probe has sent no heartbeat yet, as text the field is described by', async () => {
    await open({ health: unavailable({ reason: 'no-heartbeat', connectedSeconds: 4 }) });
    pick('flow.netflow');
    await waitFor(() => {
      expect(notice().textContent).toContain('has not sent its first heartbeat yet');
    });
    expect(notice().textContent).not.toContain('is not running');
    // WCAG 1.3.1 and 4.1.3, as for "off": tied to the field and announced when it appears.
    expect(notice().getAttribute('role')).toBe('status');
    expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBe(
      'sensor-type-listener',
    );
    // Not dressed as the caution "off" is, because it is not one; the sentence carries it all
    // (1.4.1), in the muted text colour that passes 4.5:1 in both themes (1.4.3).
    expect(notice().className).toContain('text-text-muted');
    expect(notice().className).not.toContain('text-warning-fg');
  });

  it('says a probe too old to report is that, and not that its heartbeat is late', async () => {
    await open({
      health: unavailable({ reason: 'protocol', protocolVersion: 6, requiredVersion: 7 }),
    });
    pick('flow.netflow');
    await waitFor(() => {
      expect(notice().textContent).toContain('is too old to report whether its flow collector');
    });
    expect(notice().textContent).not.toContain('heartbeat');
    expect(notice().className).toContain('text-text-muted');
  });

  it('dresses "off" as the caution it is', async () => {
    await open({ health: OFF });
    pick('flow.netflow');
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });
    expect(notice().className).toContain('text-warning-fg');
  });
});

describe('the add-sensor form on a probe too old to report its flow collector (U-30)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', QuietSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the protocol it speaks and the one it needs, not the setting as the cause', async () => {
    await open({ health: reportedAt(22, { flowReceived: null }) });
    pick('flow.netflow');
    await waitFor(() => {
      expect(notice().textContent).toContain(
        'it speaks protocol 22, and reporting it needs protocol 23',
      );
    });
    expect(notice().textContent).not.toContain('is not running');
    expect(notice().textContent).not.toContain('Set flowListener.enabled to true');
    // WCAG 1.3.1 and 4.1.3: tied to the field and announced, as every notice is. Not a caution,
    // so the muted colour (1.4.3), and the sentence carries the meaning on its own (1.4.1).
    expect(notice().getAttribute('role')).toBe('status');
    expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBe(
      'sensor-type-listener',
    );
    expect(notice().className).toContain('text-text-muted');
    expect(notice().className).not.toContain('text-warning-fg');
  });

  it('still calls the collector off on a probe new enough to carry it', async () => {
    await open({ health: reportedAt(23, { flowReceived: null }) });
    pick('flow.netflow');
    await waitFor(() => {
      expect(notice().textContent).toContain('The flow collector on probe “Berlin” is not running');
    });
    expect(notice().textContent).toContain('Set flowListener.enabled to true');
    expect(notice().className).toContain('text-warning-fg');
  });

  it('says nothing when a probe new enough to carry it has the collector on', async () => {
    const { asked } = await open({ health: reportedAt(23, { flowReceived: 0 }) });
    pick('flow.netflow');
    await waitFor(() => {
      expect(asked).toContain('/probes/2/health');
    });
    // Long enough for the answer to have been read, so this is "it said nothing" and not "it
    // has not said it yet".
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBeNull();
    expect(notice().textContent).toBe('');
  });
});
