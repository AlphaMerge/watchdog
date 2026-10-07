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

describe('whether a probe’s listener is running', () => {
  it('says nothing while a running listener has heard nothing: zero is not off', () => {
    expect(listenerNotice('flow', 'Berlin', RUNNING)).toBeNull();
  });

  it('names the listener, the probe and the setting when the counter is a gap', () => {
    const notice = listenerNotice('flow', 'Berlin', OFF) ?? '';
    expect(notice).toContain('The flow collector on probe “Berlin” is not running');
    expect(notice).toContain('Set flowListener.enabled to true');
    expect(notice).toContain('A probe on the v1 build has no flow collector');
    expect(notice).toContain('You can still create the sensor now.');
  });

  it('asks each listener’s own channel and names its own setting', () => {
    expect(listenerNotice('syslog', 'Berlin', OFF)).toContain('Set syslogListener.enabled to true');
    expect(listenerNotice('snmp-trap', 'Berlin', OFF)).toContain(
      'Set trapListener.enabled to true',
    );
    // Only flow has a build without it.
    expect(listenerNotice('syslog', 'Berlin', OFF)).not.toContain('v1');

    // One on and the others off, so a listener cannot be judged by another's counter.
    const onlyTraps = health({ connected: 1, scheduled: 3, trapReceived: 0, flowReceived: null });
    expect(listenerNotice('snmp-trap', 'Berlin', onlyTraps)).toBeNull();
    expect(listenerNotice('flow', 'Berlin', onlyTraps)).not.toBeNull();
  });

  it('does not call a listener off on a probe that has told the core nothing', () => {
    // Not connected: every channel is a gap, the listener's included.
    expect(
      listenerNotice('flow', 'Berlin', health({ connected: 0, flowReceived: null })),
    ).toBeNull();
    // Connected, and no report yet — or a probe too old to send one.
    expect(
      listenerNotice(
        'flow',
        'Berlin',
        health({ connected: 1, scheduled: null, flowReceived: null }),
      ),
    ).toBeNull();
    // Refused, or still loading.
    expect(listenerNotice('flow', 'Berlin', null)).toBeNull();
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
