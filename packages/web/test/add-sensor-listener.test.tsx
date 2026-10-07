import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectRef, ProbeHealthView, SensorTypeSummary } from '../src/api/types';
import { AddSensor } from '../src/routes/AddSensor';
import { listenerNotice, probeAbove, readsListener } from '../src/routes/add-sensor-model';

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
  given: ProbeHealthView | null,
): ReturnType<typeof listenerNotice> => listenerNotice(listener, 'Berlin', given);
const text = (listener: string, given: ProbeHealthView): string => say(listener, given)?.text ?? '';

/** Every channel a gap, with the reason the core gives for it (`P-255`). */
const unavailable = (
  numbersUnavailable: ProbeHealthView['numbersUnavailable'],
  connected = 1,
): ProbeHealthView => ({
  ...health({ connected, scheduled: null, flowReceived: null, syslogReceived: null }),
  numbersUnavailable,
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
    const old = text(
      'flow',
      unavailable({ reason: 'protocol', protocolVersion: 6, requiredVersion: 7 }),
    );
    expect(old).toContain(
      'Probe “Berlin” is too old to report whether its flow collector is running',
    );
    expect(old).toContain('it speaks protocol 6, and reporting it needs protocol 7');
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
  health?: ProbeHealthView | number;
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
      { error: { code: status === 403 ? 'FORBIDDEN' : 'OBJECT_NOT_FOUND', message: 'no' } },
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
    const refused = await open({ health: 403 });
    pick('flow.netflow');
    await waitFor(() => {
      expect(refused.asked).toContain('/probes/2/health');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notice().textContent).toBe('');
    expect(screen.getByLabelText('Sensor type').getAttribute('aria-describedby')).toBeNull();
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
