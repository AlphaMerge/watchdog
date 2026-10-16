import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type { ObjectDetail } from '../src/api/types';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';

/** What the stream says of sensor 9, set by each test before the page renders. */
const live = vi.hoisted(() => ({ states: new Map<number, Stream.LiveState>() }));

vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'live', states: live.states, frames: 1 }),
}));

/**
 * Where its check failed, on a sensor's state line (`P-285`): between the cause and what the
 * check said, from the live stream, and nothing where the stream names nothing.
 */

const SENSOR: ObjectDetail = {
  id: 9,
  parentId: 4,
  kind: 'sensor',
  name: 'Load',
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: false,
  sensorType: 'ssh.load',
  comments: '',
  inheritsTriggers: true,
  childCount: 0,
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-17T08:00:00.000Z',
  params: {},
  redactedParams: [],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function answer(): void {
  vi.stubGlobal('fetch', (url: string) => {
    const path = url.replace(/^\/api\/v1/u, '').replace(/\?.*$/u, '');
    if (path === '/objects/9') return Promise.resolve(json(SENSOR));
    if (path === '/objects/9/channels') return Promise.resolve(json({ items: [] }));
    return Promise.resolve(
      json({ error: { code: 'NOT_FOUND', message: 'not here', context: {}, details: {} } }, 404),
    );
  });
}

function state(failure: Stream.LiveState['failure']): Stream.LiveState {
  return {
    sensorId: 9,
    sensorName: 'Load',
    path: [1, 4, 9],
    state: 'down',
    cause: 'scan',
    message: 'the connection to 192.0.2.7 was lost while running uptime',
    failure,
    at: '2026-10-17T08:05:00.000Z',
  };
}

function onPage(): void {
  render(
    <MemoryRouter initialEntries={['/objects/9']}>
      <Routes>
        <Route path="/objects/:id" element={<ObjectDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  live.states = new Map();
});

describe('where its check failed, on a sensor’s state line (P-285)', () => {
  it('is said between the cause and the check’s words, the host in the Host field’s face', async () => {
    live.states = new Map([[9, state({ phase: 'exec', target: '192.0.2.7:22' })]]);
    answer();
    onPage();
    const host = await screen.findByText('192.0.2.7:22');
    expect(host.className).toBe('font-mono');
    // In order: the cause, since when, where it failed, what the check said. The gaps between
    // them are the line's layout, not text.
    const line = host.parentElement?.parentElement?.parentElement;
    expect(line?.textContent).toMatch(
      /^scan· since .+· Failed while running its command on 192\.0\.2\.7:22— the connection to 192\.0\.2\.7 was lost while running uptime$/u,
    );
  });

  it('says nothing of where it failed when the stream names nothing', async () => {
    live.states = new Map([[9, state(null)]]);
    answer();
    onPage();
    await screen.findByText(/— the connection to 192\.0\.2\.7 was lost/u);
    expect(screen.queryByText(/Failed while|Failed in/u)).toBeNull();
  });
});
