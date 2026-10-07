import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS, type CloseLike, type SocketLike } from '../src/api/stream';
import type { ObjectRef, ProbeHealthView, SensorTypeSummary } from '../src/api/types';
import { AddSensor } from '../src/routes/AddSensor';

/**
 * The add-sensor form's listener notice following the probe while the form is open (`B-12`).
 *
 * `B-08` read the notice once, when the type was chosen. A form stays open for as long as
 * somebody takes to fill it in, and in that time a probe restarted with its collector on left
 * "is not running" standing, and a probe that dropped left a sentence about a setting nobody
 * could vouch for any longer. The state stream is the prompt and `GET /probes/{id}/health` is
 * still the answer.
 *
 * **The prompt is the probe's own frame** (`U-24`). `B-12` could only listen for a sensor under
 * the probe changing state; the form now watches the probe itself, and the core says when its
 * link came or went or its report changed. The two cases `B-12` wrote down as not doable on that
 * stream are the last two here.
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

/** The probe connected and not yet heard from: the first seconds of a link. */
const CONNECTED = health({ connected: 1, scheduled: null, flowReceived: null });
/** A probe that has reported, with its flow collector running. */
const RUNNING = health({ connected: 1, scheduled: 12, flowReceived: 0 });
/** The same probe with the collector off: reported, and no flow counter in the report. */
const OFF = health({ connected: 1, scheduled: 12, flowReceived: null });
/** The probe gone: every channel but `connected` is a gap. */
const DROPPED = health({ connected: 0, scheduled: null, flowReceived: null });

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

/** The core's answer to the watch: it stands. The first word on the subscription. */
const WATCHING = { type: 'watching', probeId: 2 };

/**
 * The probe's link came or went, or its report changed. The id and nothing else: what is true
 * now is asked of the probe's own route.
 */
const changed = (): unknown => ({ type: 'probe', probeId: 2 });

/** What the form watches: the probe, and not every sensor beneath it. */
const WATCH = JSON.stringify({ subscribe: { probeId: 2 } });

interface Core {
  /** What `GET /probes/2/health` answers now; a number is a refusal with that status. */
  health: ProbeHealthView | number;
  /** Set to hold the next health answer back until `release` is called. */
  hold: boolean;
  release: () => void;
  readonly asked: string[];
  readonly healthAsked: () => number;
  readonly ancestors: ObjectRef[];
}

function stubCore(first: ProbeHealthView, ancestors: ObjectRef[] = ANCESTORS): Core {
  const asked: string[] = [];
  const answer = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const refuse = (status: number): Response =>
    answer({ error: { code: 'FORBIDDEN', message: 'no' } }, status);

  const core: Core = {
    health: first,
    hold: false,
    release: () => undefined,
    asked,
    healthAsked: () => asked.filter((path) => path === '/probes/2/health').length,
    ancestors,
  };

  vi.stubGlobal('fetch', (url: string) => {
    const path = url.replace(/^.*\/api\/v1/, '');
    asked.push(path);
    if (path === '/sensor-types') return Promise.resolve(answer({ items: TYPES }));
    if (path === '/objects/4') return Promise.resolve(answer(DEVICE));
    if (path === '/objects/4/ancestors') return Promise.resolve(answer({ items: core.ancestors }));
    if (path === '/probes/2/health') {
      const given = core.health;
      const response = (): Response => (typeof given === 'number' ? refuse(given) : answer(given));
      if (!core.hold) return Promise.resolve(response());
      core.hold = false;
      return new Promise<Response>((resolve) => {
        core.release = () => {
          resolve(response());
        };
      });
    }
    return Promise.resolve(refuse(404));
  });
  return core;
}

/** Every socket the form opened, oldest first. */
let sockets: DrivenSocket[] = [];

/** A socket the test drives by hand, standing in for the browser's `WebSocket`. */
class DrivenSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: ((event: CloseLike) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor() {
    sockets.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    act(() => {
      this.onopen?.();
    });
  }
  deliver(frame: unknown): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }
  /** Closed from the far end, as a restarting core closes it. */
  drop(): void {
    act(() => {
      this.onclose?.({ code: 1006, reason: '' });
    });
  }
}

/** Long enough for a re-ask the form has scheduled to have gone out. */
async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 300));
  });
}

async function open(): Promise<void> {
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
}

const pick = (typeId: string): void => {
  fireEvent.change(screen.getByLabelText('Sensor type'), { target: { value: typeId } });
};

const notice = (): HTMLElement => {
  const region = document.getElementById('sensor-type-listener');
  if (region === null) throw new Error('the form has no notice region under the type');
  return region;
};

const describedBy = (): string | null =>
  screen.getByLabelText('Sensor type').getAttribute('aria-describedby');

/** The form open on a flow sensor, the probe's first answer in, and a socket not yet open. */
async function chosen(core: Core): Promise<DrivenSocket> {
  await open();
  pick('flow.netflow');
  await waitFor(() => {
    expect(core.healthAsked()).toBe(1);
  });
  await waitFor(() => {
    expect(sockets.length).toBe(1);
  });
  const socket = sockets[0];
  if (socket === undefined) throw new Error('no socket opened');
  return socket;
}

/**
 * The form open on a flow sensor, its stream live, and the probe asked about twice: once when the
 * type was chosen and once when the core said the watch stands (`U-26`). Every count below starts
 * from that second request, so a case never races the one the watch itself prompts.
 */
async function watching(core: Core): Promise<DrivenSocket> {
  const socket = await chosen(core);
  socket.open();
  socket.deliver(WATCHING);
  await waitFor(
    () => {
      expect(core.healthAsked()).toBe(2);
    },
    { timeout: 3_000 },
  );
  // The answer to it is in, and it is the one the form had.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return socket;
}

describe('the add-sensor form’s listener notice while the form is open', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    sockets = [];
    vi.stubGlobal('WebSocket', DrivenSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes the notice back when the probe comes back with its collector on', async () => {
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('The flow collector on probe “Berlin” is not running');
    });
    // The probe itself, and not its branch: no snapshot of every sensor it scans (`U-24`).
    expect(socket.sent).toEqual([WATCH]);

    // The watch standing was asked about once (`U-26`), and is not asked about again.
    await settled();
    expect(core.healthAsked(), 'the watch standing is one request').toBe(2);

    core.health = RUNNING;
    socket.deliver(changed());
    await waitFor(() => {
      expect(notice().textContent).toBe('');
    });
    expect(describedBy()).toBeNull();
    expect(notice().className).toBe('sr-only');
    expect(core.healthAsked()).toBe(3);

    // What stands while the next answer is on its way is the last answer, not the first: the
    // sentence that was taken back does not come back for the length of a request.
    const written: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) written.push(record.type);
    });
    observer.observe(notice(), { childList: true, characterData: true, subtree: true });
    core.hold = true;
    socket.deliver(changed());
    await waitFor(() => {
      expect(core.healthAsked()).toBe(4);
    });
    expect(notice().textContent).toBe('');
    await act(async () => {
      core.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    observer.disconnect();
    expect(written, 'the sentence that was taken back was written again').toEqual([]);
  });

  it('takes "off" back when the probe drops, and says it cannot tell instead (U-29)', async () => {
    // Nothing can be said of a listener on a probe that is gone. Until `U-29` the form said
    // nothing at all, which read the same as a listener that runs.
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });

    core.health = DROPPED;
    socket.deliver(changed());
    await waitFor(() => {
      expect(notice().textContent).toBe(
        'Probe “Berlin” is not connected, so whether its flow collector is running cannot be ' +
          'checked. This updates when it connects.',
      );
    });
    expect(describedBy()).toBe('sensor-type-listener');
  });

  it('puts the notice up when the probe comes back with its collector off, and leaves focus alone', async () => {
    const core = stubCore(RUNNING);
    const socket = await watching(core);
    await settled();
    expect(notice().textContent).toBe('');

    // Somebody is typing the name when the probe restarts.
    const name = screen.getByLabelText('Name');
    name.focus();
    expect(document.activeElement).toBe(name);

    core.health = OFF;
    socket.deliver(changed());
    await waitFor(() => {
      expect(notice().textContent).toContain('The flow collector on probe “Berlin” is not running');
    });
    // WCAG 4.1.3: said in the region that was already in the document, which announces it;
    // 1.3.1: tied to the field; 1.4.1: a sentence, not a colour; and focus stays where it was.
    expect(notice().getAttribute('role')).toBe('status');
    expect(describedBy()).toBe('sensor-type-listener');
    expect(notice().textContent).toContain('flowListener.enabled');
    expect(document.activeElement).toBe(name);
    // Still a caution: what was typed is kept and the sensor can be created.
    fireEvent.change(name, { target: { value: 'Uplink flows' } });
    expect(screen.getByRole('button', { name: 'Create sensor' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('leaves the sentence standing while it asks again, so it is announced once', async () => {
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });

    // Everything written into the live region from here on: a screen reader reads each out.
    const written: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) written.push(record.type);
    });
    observer.observe(notice(), { childList: true, characterData: true, subtree: true });

    // The probe's link moved and the collector is as it was. The answer is held
    // back, so "while it asks" is a moment the test stands in.
    core.hold = true;
    socket.deliver(changed());
    await waitFor(() => {
      expect(core.healthAsked()).toBe(3);
    });
    expect(notice().textContent).toContain('is not running');
    expect(describedBy()).toBe('sensor-type-listener');

    await act(async () => {
      core.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(notice().textContent).toContain('is not running');
    observer.disconnect();
    expect(written, 'the same sentence was written again').toEqual([]);
  });

  it('asks once for a burst: a link that flaps is one request once it stops', async () => {
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });

    core.health = DROPPED;
    for (let edge = 1; edge <= 40; edge += 1) socket.deliver(changed());
    await waitFor(() => {
      expect(notice().textContent).toContain('is not connected');
    });
    await settled();
    expect(core.healthAsked(), 'one request for forty frames').toBe(3);
  });

  it('says nothing once the probe’s health is refused', async () => {
    // The reader's right to the probe was taken away while the form was open.
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });

    core.health = 403;
    socket.deliver(changed());
    await waitFor(() => {
      expect(notice().textContent).toBe('');
    });
    expect(describedBy()).toBeNull();

    // And the sentence is not brought back by the next ask being on its way.
    core.hold = true;
    socket.deliver(changed());
    await waitFor(() => {
      expect(core.healthAsked()).toBe(4);
    });
    expect(notice().textContent).toBe('');
    await act(async () => {
      core.release();
      await Promise.resolve();
    });
  });

  it('asks again when the stream comes back after the core was away', async () => {
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });

    core.health = RUNNING;
    socket.drop();
    // What it last knew stands while there is nobody to ask.
    expect(notice().textContent).toContain('is not running');
    await waitFor(
      () => {
        expect(sockets.length).toBe(2);
      },
      { timeout: 3_000 },
    );
    const second = sockets[1];
    if (second === undefined) throw new Error('no second socket');
    second.open();
    expect(second.sent).toEqual([WATCH]);
    second.deliver(WATCHING);
    await waitFor(() => {
      expect(notice().textContent).toBe('');
    });
    expect(core.healthAsked()).toBe(3);
  });

  it('opens no socket for a type that reads no listener, and closes it when one is unchosen', async () => {
    const core = stubCore(OFF);
    await open();
    pick('icmp.ping');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets.length).toBe(0);

    pick('flow.netflow');
    await waitFor(() => {
      expect(sockets.length).toBe(1);
    });
    const socket = sockets[0];
    if (socket === undefined) throw new Error('no socket opened');
    socket.open();
    socket.deliver(WATCHING);
    expect(socket.closed).toBe(false);

    pick('icmp.ping');
    await waitFor(() => {
      expect(socket.closed).toBe(true);
    });
    // A frame that was already on its way asks nothing: nobody is watching.
    socket.deliver(changed());
    await settled();
    expect(core.healthAsked()).toBe(1);
    expect(sockets.length).toBe(1);
  });

  it('opens no socket for a reader who cannot see the probe', async () => {
    const core = stubCore(OFF, [{ id: 3, kind: 'group', name: 'Routers' }]);
    await open();
    pick('flow.netflow');
    await waitFor(() => {
      expect(core.asked).toContain('/objects/4/ancestors');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets.length).toBe(0);
    expect(core.healthAsked()).toBe(0);
  });

  it('follows a probe with no sensor the reader can see when its collector comes on (U-24)', async () => {
    // Exactly a probe getting its first sensor. On `B-12`'s stream nothing under it could change
    // state, so no frame ever came and the sentence read when the type was chosen stood for as
    // long as the form was open. Nothing is delivered here but the probe's own frames.
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('The flow collector on probe “Berlin” is not running');
    });
    const name = screen.getByLabelText('Name');
    name.focus();

    // The operator sets `flowListener.enabled` and restarts the probe: the link goes…
    core.health = DROPPED;
    socket.deliver(changed());
    await waitFor(() => {
      expect(core.healthAsked()).toBe(3);
    });
    await waitFor(() => {
      expect(notice().textContent).toContain('is not connected');
    });
    // …comes back, and has not reported yet (`U-29`)…
    core.health = CONNECTED;
    socket.deliver(changed());
    await waitFor(() => {
      expect(core.healthAsked()).toBe(4);
    });
    await waitFor(() => {
      expect(notice().textContent).toContain('has not sent its first heartbeat yet');
    });
    // …and reports with its collector running.
    core.health = RUNNING;
    socket.deliver(changed());
    await waitFor(() => {
      expect(core.healthAsked()).toBe(5);
    });
    expect(notice().textContent).toBe('');
    expect(describedBy()).toBeNull();
    expect(document.activeElement).toBe(name);
    // Never a subscription to the branch: the one thing sent is the watch.
    expect(socket.sent).toEqual([WATCH]);
  });

  it('hears the first report of a probe that reconnected after the form had already asked (U-24)', async () => {
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });
    const name = screen.getByLabelText('Name');
    name.focus();

    // The probe restarts with its collector still off. The link drops and comes back, and the
    // form asks before the probe has reported: connected, and nothing can be said of a listener
    // yet, so "off" goes — correctly — and the form says why it cannot tell (`U-29`).
    core.health = DROPPED;
    socket.deliver(changed());
    core.health = CONNECTED;
    socket.deliver(changed());
    await waitFor(() => {
      expect(notice().textContent).toContain('has not sent its first heartbeat yet');
    });
    await settled();
    const askedBeforeTheReport = core.healthAsked();
    expect(
      notice().textContent,
      '"off" is not said of a probe that has not reported',
    ).not.toContain('is not running');

    // Its first report arrives, without the collector. `B-12` had nothing to prompt it here.
    core.health = OFF;
    socket.deliver(changed());
    await waitFor(() => {
      expect(notice().textContent).toContain('The flow collector on probe “Berlin” is not running');
    });
    expect(core.healthAsked()).toBe(askedBeforeTheReport + 1);
    expect(notice().getAttribute('role')).toBe('status');
    expect(describedBy()).toBe('sensor-type-listener');
    expect(document.activeElement).toBe(name);
  });

  it('asks nothing for a frame about a probe it is not watching', async () => {
    const core = stubCore(OFF);
    const socket = await watching(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });
    core.health = RUNNING;
    socket.deliver({ type: 'probe', probeId: 3 });
    await settled();
    expect(core.healthAsked()).toBe(2);
    expect(notice().textContent).toContain('is not running');
  });

  it('hears a change that fell between its own request and the watch standing (U-26)', async () => {
    // The form read the probe when the type was chosen: collector off. The watch is not standing
    // yet — the socket is still connecting — when the probe restarts with its collector on.
    // No frame says so, because nobody was watching, and until this the sentence stood for as
    // long as the form was open.
    const core = stubCore(OFF);
    const socket = await chosen(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('The flow collector on probe “Berlin” is not running');
    });
    const name = screen.getByLabelText('Name');
    name.focus();

    core.health = RUNNING;
    // The socket opening is not the watch standing: nothing is asked for it.
    socket.open();
    await settled();
    expect(core.healthAsked(), 'asked before the core said the watch stands').toBe(1);
    expect(notice().textContent).toContain('is not running');

    socket.deliver(WATCHING);
    await waitFor(() => {
      expect(notice().textContent).toBe('');
    });
    expect(describedBy()).toBeNull();
    expect(document.activeElement).toBe(name);
    // Once: the watch standing is one request, however long the form then stays open.
    await settled();
    expect(core.healthAsked()).toBe(2);
    expect(socket.sent).toEqual([WATCH]);
  });

  it('asks once when the watch stands, and writes nothing when the answer is the one it had (U-26)', async () => {
    const core = stubCore(OFF);
    const socket = await chosen(core);
    await waitFor(() => {
      expect(notice().textContent).toContain('is not running');
    });

    // Everything written into the live region from here on: a screen reader reads each out.
    const written: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) written.push(record.type);
    });
    observer.observe(notice(), { childList: true, characterData: true, subtree: true });

    core.hold = true;
    socket.open();
    socket.deliver(WATCHING);
    await waitFor(
      () => {
        expect(core.healthAsked()).toBe(2);
      },
      { timeout: 3_000 },
    );
    // While it asks, the sentence stands and is still tied to the field.
    expect(notice().textContent).toContain('is not running');
    expect(describedBy()).toBe('sensor-type-listener');
    await act(async () => {
      core.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(notice().textContent).toContain('is not running');
    await settled();
    observer.disconnect();
    expect(written, 'the same sentence was written again').toEqual([]);
    expect(core.healthAsked(), 'the watch standing was asked about more than once').toBe(2);
  });
});
