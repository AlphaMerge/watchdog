import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type { ObjectDetail, SensorTypeSummary } from '../src/api/types';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';

// The page opens a socket for its live state, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

/**
 * A saved edit of a sensor's parameters, on the page (`U-36`).
 *
 * A save asks the page to read the sensor again, and the page used to give way to *Loading the
 * object…* for the length of that read: the form went with it, and with the form its focus, its
 * *Saved* line and what the core said about lookups it kept. The page now keeps the object it
 * holds while the next is read, so the form, and what it says, stays.
 */

const TYPE: SensorTypeSummary = {
  id: 'snmp.custom',
  category: 'SNMP',
  costHint: 'medium',
  hasPreview: false,
  paramsSchema: { type: 'object', properties: { unit: { type: 'string', title: 'Unit' } } },
};

const sensor = (version: number, unit: string): ObjectDetail => ({
  id: 9,
  parentId: 4,
  kind: 'sensor',
  name: 'Uptime',
  tags: [],
  priority: 3,
  version,
  hasChildren: false,
  sensorType: 'snmp.custom',
  comments: '',
  inheritsTriggers: true,
  childCount: 0,
  createdAt: '2026-10-11T08:00:00.000Z',
  updatedAt: '2026-10-11T08:00:00.000Z',
  params: { unit },
  redactedParams: [],
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The sensor as the core holds it. */
let held = sensor(1, '');
/** Answers the read of the sensor that a save asked for, held until then. */
let release: () => void = () => undefined;
let reads = 0;

beforeEach(() => {
  held = sensor(1, '');
  release = () => undefined;
  reads = 0;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const [path = ''] = url.split('?');
    if (path === '/api/v1/objects/9') {
      if (init?.method === 'PATCH') {
        const sent = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
          params: { unit: string };
        };
        held = sensor(held.version + 1, sent.params.unit);
        return Promise.resolve(json({ ...held, lookupsKept: ['value'] }));
      }
      reads += 1;
      // The first read answers at once; the one a save asks for waits for the test.
      if (reads === 1) return Promise.resolve(json(held));
      const answer = held;
      return new Promise<Response>((resolve) => {
        release = () => {
          resolve(json(answer));
        };
      });
    }
    if (path === '/api/v1/sensor-types') return Promise.resolve(json({ items: [TYPE] }));
    if (path === '/api/v1/objects/9/channels') return Promise.resolve(json({ items: [] }));
    if (path === '/api/v1/lookups') return Promise.resolve(json({ items: [] }));
    return Promise.resolve(json({}, 404));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a saved edit, on the page (U-36)', () => {
  it('keeps the form, its focus and what it says through the read the save asks for', async () => {
    render(
      <MemoryRouter initialEntries={['/objects/9']}>
        <Routes>
          <Route path="/objects/:id" element={<ObjectDetailView />} />
        </Routes>
      </MemoryRouter>,
    );
    const unit = await screen.findByRole('textbox', { name: 'Unit' });
    const card = unit.closest('section');
    if (card === null) throw new Error('no Parameters card');
    const region = within(card).getByRole('status');
    expect(region.matches(':empty')).toBe(true);

    fireEvent.change(unit, { target: { value: 'C' } });
    const save = screen.getByRole('button', { name: 'Save parameters' });
    save.focus();
    fireEvent.click(save);

    // The save is answered and the page reads the sensor again; while it does, nothing gave way.
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(screen.queryByText('Loading the object…')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Unit' })).toBe(unit);
    expect(document.activeElement).toBe(save);

    release();
    await waitFor(() => {
      expect(region.textContent).toContain('One channel kept its lookup:');
    });
    expect(region.isConnected).toBe(true);
    expect(within(region).getByRole('listitem').textContent).toBe('Channel value');
    // The form starts again from the version saved: what was typed is what is stored.
    expect(unit).toHaveProperty('value', 'C');
    expect(save).toHaveProperty('disabled', true);
  });
});
